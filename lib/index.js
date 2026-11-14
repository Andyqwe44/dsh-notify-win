/**
 * dsh-notify-win — DeepSeek Harness host plugin.
 *
 * Notifies the user on Windows 11 when:
 *   - a root agent goes idle        -> a notification that reflects WHY the
 *     turn stopped: completed, output-token ceiling, blocked pre-step, LLM
 *     failure (with the provider-neutral code and retry count), or cancel
 *   - an answer is needed (approval request, or the model asked a direct
 *     question via ask_user_question) -> "question" notification
 *   - context compaction succeeds or fails
 *
 * Each event independently chooses three effects — a native Win11 toast, a
 * QQ-style unread badge blinking on the DSH taskbar button, and the taskbar
 * flash (FlashWindowEx warm pulse) — and whether the attention effects start
 * when the event fires or only after the toast times out unanswered. The
 * defaults keep the toast and replace the warm pulse with the badge. Every
 * toast, the identity registration, click-to-focus, the flash and the badge
 * are owned by the resident .NET helper (./dsh-toast-question.exe). The plugin
 * requires the .NET 10 Desktop Runtime; there is no PowerShell path.
 *
 * This is a host-plane plugin: it consumes harness lifecycle events and the
 * subprocess service. Its Config schema is how DSH renders the settings page
 * (lib/client.js); it registers no service and no tool.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, join } from 'node:path'
import os from 'node:os'
import { DEFAULTS, Config, FILE_WRITE_TOOLS, attentionSettings, resolveEffects } from './config.js'

const QUESTION_EXE_PATH = fileURLToPath(new URL('./dsh-toast-question.exe', import.meta.url))

/**
 * Provider-neutral failure codes -> zh hint. Codes not listed fall back to
 * the provider message. Kept in sync with dsh-llm's error taxonomy:
 * RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE are retryable by
 * default; the rest are terminal for one request.
 */
const ERROR_HINTS = {
  RATE_LIMIT: '接口限流',
  SERVER: '服务端错误',
  TIMEOUT: '请求超时',
  TRANSPORT: '网络传输失败',
  EMPTY_RESPONSE: '模型返回空响应',
  CONTEXT_WINDOW_EXCEEDED: '上下文超出模型窗口',
  QUOTA: '额度或余额不足',
  AUTH: '认证失败',
  INVALID_CREDENTIAL: '凭证无效',
  MISSING_CREDENTIAL: '缺少凭证',
  ACCOUNT_TOKEN_INVALID: '账号令牌失效',
  STREAM_CLOSED: '响应流提前断开',
  IMAGE_OFFLOAD_REQUIRED: '图片超出上限，待自动重试',
  NO_ADAPTER: '模型适配器不可用',
  UNKNOWN_MODEL: '未知模型',
  INVALID_CONFIG: '模型配置无效',
  UNSUPPORTED_OPTION: '模型不支持该选项',
  ABORTED: '请求被取消',
  UNKNOWN: '未知错误',
}

/** Turn-end reasons that are durable history markers, never live stops. */
const HISTORICAL_STOP_REASONS = new Set(['interrupted', 'forked'])

// Module-level pending state: shared across hot-reload fibers so a single
// question can never be toasted more than once, even if an old plugin instance
// is still alive during a reload.
let pendingSession = null
let pendingQuestion = null
let pendingAnswer = null
const lastBySession = new Map()
// Stop-reason tracking, shared across hot-reload fibers for the same reason:
// a reload landing between `turn/end` and the `idle` transition must not lose
// the reason and mis-report a failed turn as "completed".
const turnEndBySession = new Map()
const retryBySession = new Map()
// Newest toast answer, offered to the browser half for a few seconds so it can
// drive the official question card (the only answerer the runtime honours). A
// third-party client plugin cannot win the `user-questions/request` waterfall:
// the runtime bridges it to the browser, where the official card is registered
// first and settles it without calling next().
let latestToastAnswer = null
// The resident helper of the current plugin fiber. Module-level so a hot reload
// can stop the instance it is replacing instead of leaking one .NET process per
// edit.
let activeHelper = null

/** Answer batch identity used for comparing what the toast sent with what the agent got. */
const normalizeAnswers = (answers) => {
  if (!Array.isArray(answers)) return []
  return answers
    .map((item) => ({
      id: String(item?.id ?? ''),
      selected: Array.isArray(item?.selected) ? item.selected.map(String).sort() : [],
      custom: typeof item?.custom === 'string' ? item.custom.trim() : '',
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

/** Human-readable answer preview for the confirmation toast. */
const summarizeAnswers = (answers) => {
  if (!Array.isArray(answers)) return ''
  return answers
    .map((item) => {
      const custom = typeof item?.custom === 'string' ? item.custom.trim() : ''
      if (custom.length > 0) return custom
      const selected = Array.isArray(item?.selected) ? item.selected.filter(Boolean) : []
      return selected.join('、')
    })
    .filter((text) => text.length > 0)
    .join('；')
}

/**
 * One toast line of the model's streaming text. The receipt shows a single
 * line filled to the toast width instead of the first sentence: markdown
 * list/heading markers are stripped, the text is folded to one source line,
 * and anything past the toast width is cut and marked with "…" (one
 * full-width cell) so the reader knows the line continues.
 */
const RECEIPT_LINE_COLUMNS = 42
const ELLIPSIS_COLUMNS = 2

/** Columns one character occupies in the toast body font (CJK/emoji = 2). */
const charColumns = (ch) => {
  const cp = ch.codePointAt(0)
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  return wide ? 2 : 1
}

/** Display width of `text` in half-width columns. */
const textColumns = (text) => {
  let columns = 0
  for (const ch of text) columns += charColumns(ch)
  return columns
}

/** Fit `text` into one toast line, adding "…" only when something was cut. */
const fitReceiptLine = (text) => {
  if (textColumns(text) <= RECEIPT_LINE_COLUMNS) return text
  let kept = ''
  let used = 0
  for (const ch of text) {
    const columns = charColumns(ch)
    if (used + columns > RECEIPT_LINE_COLUMNS - ELLIPSIS_COLUMNS) break
    kept += ch
    used += columns
  }
  return `${kept.trimEnd()}…`
}

/** First visible source line of a reply, and whether that line is complete. */
const receiptLine = (raw) => {
  const text = String(raw).replace(/\r/g, '').replace(/^\s+/, '')
  const newline = text.indexOf('\n')
  const line = (newline >= 0 ? text.slice(0, newline) : text)
    .replace(/^[#>*\-]+\s*/, '')
    .replace(/^\d+[.、)]\s*/, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
  return { line: line.length > 0 ? line : null, complete: newline >= 0 }
}

/**
 * Own the resident .NET toast helper for one plugin fiber.
 *
 * The helper is a child of the DSH host: the plugin starts it when it is
 * applied, talks to it over the child's stdin/stdout (newline-delimited JSON),
 * and shuts it down when the plugin is disposed. If DSH dies first, the pipes
 * close and the helper exits on EOF, so there is never an orphan process.
 *
 * @param subprocess - the host subprocess seam.
 * @param onAnswer - called with `{ id, sessionId, answers }` when the user submits.
 * @param onCancel - called with `{ id, sessionId }` when the user cancels.
 * @param logPath - optional file for helper-side diagnostics.
 */
const createToastHelper = ({ subprocess, onAnswer, onCancel, logPath = '' }) => {
  let handle = null
  let ready = false
  let starting = null
  let probe = null
  let runtimeMissing = false
  let stopping = false
  let buffer = ''
  let waiters = []

  const settleReady = (value) => {
    ready = value
    for (const waiter of waiters.splice(0)) waiter(value)
  }

  const waitForReady = (timeoutMs) => new Promise((resolve) => {
    if (ready) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => resolve(false), timeoutMs)
    waiters.push((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })

  const handleLine = (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message?.ev === 'ready') {
      settleReady(true)
      return
    }
    if (message?.ev === 'answer') {
      onAnswer(message)
      return
    }
    if (message?.ev === 'cancel') onCancel(message)
  }

  const spawnHelper = async () => {
    let child
    try {
      child = subprocess.spawn({
        argv: logPath.length > 0
          ? [QUESTION_EXE_PATH, '--serve', '--log', logPath]
          : [QUESTION_EXE_PATH, '--serve'],
        cwd: os.tmpdir(),
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' },
        // The helper lives as long as the plugin; the grace is only used if the
        // host has to terminate it.
        graceMs: 5000,
      })
    } catch {
      return false
    }
    if (child.stdout === null || child.stdout === undefined || child.stdin === null || child.stdin === undefined) {
      // A provider without piped stdio cannot host the resident protocol.
      try {
        child.terminate()
      } catch {}
      return false
    }
    handle = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (line.length > 0) handleLine(line)
      }
    })
    const current = child
    current.done.then(() => {
      if (handle === current) {
        handle = null
        settleReady(false)
      }
    }).catch(() => {
      if (handle === current) {
        handle = null
        settleReady(false)
      }
    })
    const ok = await waitForReady(5000)
    if (!ok) {
      try {
        current.terminate()
      } catch {}
      if (handle === current) handle = null
    }
    return ok
  }

  /**
   * Whether a .NET 10 Desktop runtime is installed. Checked on disk first so a
   * missing runtime never launches the apphost's install dialog at DSH startup;
   * the `--check` spawn below is only the final liveness probe.
   */
  const desktopRuntimePresent = async () => {
    const roots = [
      process.env.DOTNET_ROOT,
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'dotnet'),
      join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'dotnet'),
    ].filter((root) => typeof root === 'string' && root.length > 0)
    for (const root of roots) {
      try {
        const versions = await readdir(join(root, 'shared', 'Microsoft.WindowsDesktop.App'))
        if (versions.some((version) => /^10\./.test(version))) return true
      } catch {
        // try the next install root
      }
    }
    return false
  }

  /** Start the helper (or reuse the live one). False means it cannot run. */
  const ensure = async () => {
    if (stopping) return false
    if (handle !== null && ready) return true
    if (probe === null) {
      probe = (async () => {
        if (!(await desktopRuntimePresent())) {
          runtimeMissing = true
          return false
        }
        try {
          const check = subprocess.spawn({
            argv: [QUESTION_EXE_PATH, '--check', '1'],
            cwd: os.tmpdir(),
            stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
            graceMs: 5000,
          })
          const outcome = await check.done
          if (outcome?.exitCode !== 0) {
            runtimeMissing = true
            return false
          }
          return true
        } catch {
          runtimeMissing = true
          return false
        }
      })()
    }
    if (!(await probe)) return false
    if (starting !== null) return starting
    starting = spawnHelper().finally(() => {
      starting = null
    })
    return starting
  }

  const send = (message) => {
    if (handle === null || !ready) return false
    try {
      handle.stdin.write(`${JSON.stringify(message)}\n`)
      return true
    } catch {
      return false
    }
  }

  const stop = async () => {
    if (stopping) return
    stopping = true
    try {
      send({ op: 'shutdown' })
    } catch {}
    const child = handle
    handle = null
    ready = false
    if (child === null) return
    const exited = await Promise.race([
      child.done.then(() => true).catch(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
    ])
    if (!exited) {
      try {
        child.terminate()
      } catch {}
    }
  }

  return { ensure, send, stop, isReady: () => ready, runtimeMissing: () => runtimeMissing }
}

const plugin = {
  name: 'dsh-notify-win',
  inject: ['subprocess', 'webServer'],
  // DSH reads `runtime.Config` from the default export to build the settings
  // form and to validate/apply live writes.
  Config,
  apply(ctx, config) {
    // Live config: `eventPolicy`/`attention` arrive as volatile references that
    // the loader updates in place when the settings page writes a value. The
    // proxy unwraps those refs on every read, so the rest of the plugin keeps
    // reading plain `cfg.xxx` values and always sees the current settings.
    const unwrap = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function'
      ? value.get()
      : value)
    const cfg = new Proxy({ ...DEFAULTS, ...(config ?? {}) }, {
      get(target, key) { return unwrap(Reflect.get(target, key)) },
    })
    // Per-session dedup: each project (session) notifies independently, so two
    // projects finishing back-to-back never collapse into one toast, while a
    // single session's rapid idle transitions (spurious wake/idle) still stay
    // quiet. A 1.5s floor between ANY two toasts also bounds an approval
    // burst that cannot be attributed to one session.

    /** Root sessions only: skip subagents so delegation noise stays silent. */
    const isRootSession = (session) => {
      try {
        const depth = session?.header?.delegationDepth
        return depth === undefined || depth === 0
      } catch {
        return true
      }
    }

    const isRootAgent = (agent) => isRootSession(agent?.session)

    const sessionIdOf = (session) => {
      const id = session?.id ?? session?.header?.id
      return id === undefined ? null : String(id)
    }

    /** Bound a provider message so it fits a toast body. */
    const truncate = (text, max) => {
      const value = typeof text === 'string' ? text.trim() : ''
      if (value.length <= max) return value
      return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`
    }

    /** Substitute {name} placeholders; an absent value renders as empty text. */
    const fillTemplate = (template, vars) =>
      String(template).replace(/\{(\w+)\}/g, (_match, key) =>
        vars[key] === undefined || vars[key] === null ? '' : String(vars[key]))

    // ------------------------------------------------------------------
    // Turn-end reason -> notification. The turn/end event carries the only
    // authoritative "why did the agent stop" facts; `agent/status` carries
    // no reason, so the reason is cached per session when turn/end is
    // appended (it always precedes the idle transition).
    // ------------------------------------------------------------------
    const describeError = (failure, retry) => {
      const code = typeof failure?.code === 'string' && failure.code.length > 0 ? failure.code : 'UNKNOWN'
      const message = truncate(failure?.message, 180)
      // Prefer the stable hint; fall back to the provider message.
      const hint = ERROR_HINTS[code] ?? (message.length > 0 ? message : code)
      let body = fillTemplate(cfg.errorBody, { hint, message, code, reason: 'error' })
      if (cfg.includeErrorCode !== false && !body.includes(code)) body += `（${code}）`
      if (typeof retry?.retry === 'number' && retry.retry > 0) {
        body += typeof retry.maxRetries === 'number'
          ? fillTemplate(cfg.retrySuffix, { retry: retry.retry, retryMax: retry.maxRetries })
          : fillTemplate(cfg.retrySuffixUnbounded, { retry: retry.retry })
      }
      return {
        kind: 'alert',
        title: cfg.errorTitle,
        body,
        reason: 'error',
        event: 'error',
        code,
        retry: retry?.retry,
        retryMax: retry?.maxRetries,
      }
    }

    /** A failed compaction is a stop in its own right: the summary never landed. */
    const describeCompactionFailure = (error) => {
      const message = truncate(typeof error === 'string' ? error : String(error ?? ''), 180)
      return {
        kind: 'alert',
        title: cfg.compactionFailedTitle,
        body: fillTemplate(cfg.compactionFailedBody, { message, hint: message }),
        reason: 'compaction',
        event: 'error',
      }
    }

    /**
     * Map one turn/end reason (plus the latest retry facts) to a notification
     * descriptor. Returns null when this stop must stay silent.
     * @param reason - TurnEndReason recorded from the session log.
     * @param retry - latest llm/retry facts for the turn, when any.
     */
    const describeStop = (reason, retry) => {
      switch (reason?.kind) {
        case 'completed':
          return { kind: 'done', title: cfg.doneTitle, body: cfg.doneBody, reason: 'completed', event: 'done' }
        case 'max-tokens':
          if (cfg.notifyOnError === false) return null
          return { kind: 'alert', title: cfg.maxTokensTitle, body: cfg.maxTokensBody, reason: 'max-tokens', event: 'error' }
        case 'blocked':
          if (cfg.notifyOnError === false) return null
          return { kind: 'alert', title: cfg.blockedTitle, body: cfg.blockedBody, reason: 'blocked', event: 'error' }
        case 'error':
          if (cfg.notifyOnError === false) return null
          return describeError(reason.error, retry)
        case 'aborted': {
          const cause = reason.reason?.kind
          // Disposal cancels the driver right before the registries drop the
          // agent; toasting "done" there would fire on every shutdown.
          if (cause === 'disposed') return null
          if (cfg.notifyOnCancel === false) return null
          if (cause === 'hook') {
            return {
              kind: 'notice',
              title: cfg.cancelledTitle,
              body: fillTemplate(cfg.hookCancelledBody, {
                message: truncate(reason.reason?.reason, 120),
              }),
              reason: 'aborted',
              event: 'cancelled',
              code: 'hook',
            }
          }
          return {
            kind: 'notice',
            title: cfg.cancelledTitle,
            body: cfg.cancelledBody,
            reason: 'aborted',
            event: 'cancelled',
            code: typeof cause === 'string' ? cause : 'unknown',
          }
        }
        default: {
          // `interrupted`/`forked` are durable history markers (resume / fork
          // seeds) and never describe a live stop, so they stay silent.
          if (reason?.kind === undefined || HISTORICAL_STOP_REASONS.has(reason.kind)) return null
          if (cfg.notifyOnError === false) return null
          return {
            kind: 'alert',
            title: cfg.unknownStopTitle,
            body: fillTemplate(cfg.unknownStopBody, { reason: String(reason.kind) }),
            reason: String(reason.kind),
            event: 'error',
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // Project label: git remote origin repository name, else cwd folder
    // name. Resolved once per session and cached.
    // ------------------------------------------------------------------
    const gitDirOf = async (cwd) => {
      const dotGit = join(cwd, '.git')
      let info
      try {
        info = await stat(dotGit)
      } catch {
        return undefined
      }
      if (info.isDirectory()) return dotGit
      // Worktree or submodule: .git is a file containing "gitdir: <path>".
      try {
        const text = await readFile(dotGit, 'utf8')
        const m = text.match(/gitdir:\s*(.+)/)
        if (m) return m[1].trim()
      } catch {}
      return undefined
    }

    const projectLabel = async (session) => {
      try {
        const cwd = session?.header?.cwd
        if (typeof cwd !== 'string' || cwd.length === 0) return undefined
        const gitDir = await gitDirOf(cwd)
        if (gitDir !== undefined) {
          try {
            const config = await readFile(join(gitDir, 'config'), 'utf8')
            const m = config.match(/\[remote\s+"origin"\]\s*\n?[^\[]*?url\s*=\s*(.+)/i)
            if (m) {
              const url = m[1].trim()
              const name = basename(url).replace(/\.git\s*$/, '').trim()
              if (name.length > 0 && name !== '.') return name
            }
          } catch {}
        }
        const name = basename(cwd)
        if (name.length > 0) return name
      } catch {}
      return undefined
    }

    const labelCache = new Map()
    const projectLabelFor = async (session) => {
      const id = session?.id ?? session?.header?.id
      if (id !== undefined && labelCache.has(id)) return labelCache.get(id)
      const label = await projectLabel(session)
      if (id !== undefined) labelCache.set(id, label)
      return label
    }

    /**
     * Keep the helper's badge-blink settings in sync with the live config.
     * Called before every notification, so a settings change applies from the
     * next event without a plugin reload (the helper itself cannot read the
     * config).
     */
    let lastAttentionKey = ''
    const syncAttentionConfig = () => {
      const settings = attentionSettings(cfg)
      const key = `${settings.blinkIntervalMs}|${settings.blinkMaxMinutes}`
      if (key === lastAttentionKey) return true
      const sent = helper.send({
        op: 'config',
        blinkIntervalMs: settings.blinkIntervalMs,
        blinkMaxMinutes: settings.blinkMaxMinutes,
      })
      if (sent) lastAttentionKey = key
      return sent
    }

    /**
     * Effect-only dispatch: the event has no toast, so the helper starts the
     * configured attention effects right away. `timing` is ignored here (there
     * is no toast to wait for).
     */
    const dispatchAttention = async (eventKey, effects) => {
      if (!(await helper.ensure())) {
        const hint = helper.runtimeMissing()
          ? 'install the .NET 10 Desktop Runtime'
          : 'the resident toast helper failed to start'
        console.error(`[dsh-notify-win] attention dropped: ${hint}`)
        return
      }
      syncAttentionConfig()
      helper.send({
        op: 'attention',
        kind: eventKey,
        effects: {
          blink: effects.blink === true,
          flash: effects.flash === true,
          timing: 'immediate',
        },
      })
    }

    /**
     * Send one notification under the live policy.
     * @returns the toast id when a question toast reached the helper, else null.
     */
    const notify = async (kind, title, body, session, questions = null, meta = {}, helperId = '') => {
      // One policy row per event; `meta.event` names it (falling back to the
      // notification kind for older call sites).
      const eventKey = meta.event ?? (kind === 'question' ? 'question' : 'done')
      const effects = resolveEffects(cfg, eventKey)
      if (!effects.toast && !effects.blink && !effects.flash) return null
      const now = Date.now()
      const key = session?.id ?? session?.header?.id ?? '\u0000any'
      // Per-session dedup: different sessions notify independently (each
      // project's completion always surfaces), while a single session's rapid
      // idle transitions (spurious wake/idle) stay quiet.
      if (now - (lastBySession.get(key) ?? 0) < cfg.dedupMs) return null
      lastBySession.set(key, now)
      let finalBody = body
      if (cfg.showProject !== false) {
        const label = await projectLabelFor(session)
        if (label !== undefined && label.length > 0) finalBody = `${label}：${body}`
      }
      const sessionId = session?.id ?? session?.header?.id
      // While a question toast is still pending, do not re-toast the same
      // question (the agent loop can re-emit the same ask while waiting, and
      // some re-emissions may carry incomplete arguments).
      if (kind === 'question' && pendingQuestion &&
          pendingQuestion.sessionId === sessionId) return null
      if (!effects.toast) {
        // No toast for this event: the attention effects are the notification.
        pendingAnswer = null
        dispatchAttention(eventKey, effects).catch((error) => {
          console.error('[dsh-notify-win] attention failed:', error)
        })
        return null
      }
      pendingSession = sessionId ? String(sessionId) : null
      pendingQuestion = sessionId && Array.isArray(questions) && questions.length > 0
        ? { sessionId: String(sessionId), questions, helperId }
        : null
      // A new notification must not inherit a stale toast answer from an
      // earlier interaction (e.g. an unread action from a previous toast).
      pendingAnswer = null
      // Awaited: the question path needs the toast id back, because only a
      // question whose toast really showed up may be tracked (and therefore
      // settled from the toast while no page is visible).
      return await runNotify(kind, title, finalBody, questions, sessionId ? String(sessionId) : '', meta, helperId, effects)
        .catch((error) => {
          console.error('[dsh-notify-win] notify failed:', error)
          return null
        })
    }

    // ------------------------------------------------------------------
    // Toast answer receipts: one proof per submitted toast answer. A proof is
    // only marked "delivered" once the tool call that carried the question has
    // actually returned the answer to the agent; "spoken" then carries the
    // model's first sentence, which is the displayable evidence that the whole
    // round trip reached the model.
    // ------------------------------------------------------------------
    const proofs = new Map()
    // Tools currently waiting on a user answer, keyed by call id. Used to tell
    // a real answer from a stale toast whose question was already settled.
    const activeAsks = new Map()
    let questionSeq = 0

    // ------------------------------------------------------------------
    // Answering a question without the renderer.
    //
    // `user-questions/request` is a forwarded waterfall: the official question
    // card in the page is its only answerer, and the harness registers the
    // forwarder that hands the request to that page before any plugin loads.
    // A toast answer therefore waits for the page to click the card — and
    // Chromium throttles a hidden window's timers, so an answer picked in the
    // toast while DSH is minimized can sit for a minute until the window is
    // restored. The listener registered further down is PREPENDED, so it runs
    // before the forwarder, and while every page is hidden it answers the
    // waterfall itself; the toast is then the only surface, and nothing is
    // lost by not rendering a card. A page that becomes visible again gets the
    // request handed to the official card, so the in-window flow is unchanged.
    // A question that was already on the card when the window was minimized
    // still settles from the toast: the answer also stays parked, so the stale
    // card retires by itself when the page wakes. `pageReported` keeps a
    // deployment whose page has not reported yet (or a stale client) on the
    // old card path.
    // ------------------------------------------------------------------
    /** Pages that reported themselves visible: client id -> last report. */
    const visiblePages = new Map()
    let pageReported = false
    let visibilityRoute = false
    /** Questions the host watches: hold id -> held request. */
    const heldQuestions = new Map()
    let holdSeq = 0
    /** The question toast currently on screen, so a hold starts only when the
     * user really can answer it: { sessionId, id, at }. */
    let lastQuestionToast = null

    /** Live pages; a client that stops heartbeating (crash) expires. */
    const livePageCount = () => {
      const now = Date.now()
      for (const [client, at] of visiblePages) {
        if (now - at > 20000) visiblePages.delete(client)
      }
      return visiblePages.size
    }

    /** True when a page exists that could render a card, but none is visible. */
    const pageHidden = () => visibilityRoute && pageReported && livePageCount() === 0

    /**
     * Enter the official card chain for one held request. Idempotent: the toast
     * may still settle the request afterwards, and the first settlement wins.
     */
    const handOverQuestion = (held) => {
      if (held.handed === true) return
      held.handed = true
      // The forwarder owns the request from here; a toast answer that arrives
      // later is parked for the page exactly like before — unless every page is
      // hidden, in which case the toast still answers (see routeToastAnswer).
      // The forwarding promise can reject (the card's close button cancels the
      // request), and that rejection is the question's outcome.
      Promise.resolve()
        .then(() => held.next())
        .then((value) => held.settle(true, value), (error) => held.settle(false, error))
    }

    /** A page can render cards again: every held request goes to its card. */
    const handOverHeldQuestions = () => {
      if (pageHidden()) return
      for (const held of [...heldQuestions.values()]) handOverQuestion(held)
    }

    /** The held request whose questions this answer batch names, if any. */
    const matchHeldQuestion = (sessionId, answers) => {
      if (heldQuestions.size === 0) return null
      const ids = new Set(answers.map((item) => String(item?.id ?? '')))
      for (const held of heldQuestions.values()) {
        if (held.sessionId !== sessionId) continue
        if (ids.size !== held.qids.size) continue
        if (![...ids].every((id) => held.qids.has(id))) continue
        return held
      }
      return null
    }

    /**
     * Route one toast answer to the question the host watches.
     * @returns `{ hostAnswered, park }` — `park` keeps the answer for the page,
     *   which either clicks the official card or retires a card that the host
     *   already answered (both are the answer this batch carries).
     */
    const routeToastAnswer = (sessionId, answers) => {
      const held = matchHeldQuestion(sessionId, answers)
      if (held === null) return { hostAnswered: false, park: true }
      // Not handed over: the host owns the request and there is no card.
      if (held.handed !== true) {
        held.settle(true, { answers })
        return { hostAnswered: true, park: false }
      }
      // The card exists, but no page can render it right now: settle here and
      // keep the answer so the card retires when the page wakes.
      if (pageHidden()) {
        held.settle(true, { answers })
        return { hostAnswered: true, park: true }
      }
      // A visible page can click its own card; that path reports the delivered
      // answer back through the forwarder's promise.
      return { hostAnswered: false, park: true }
    }

    /** Take one question over from the card until the toast answers it. */
    const holdQuestion = (request, next) => new Promise((resolve, reject) => {
      holdSeq += 1
      const signal = request.signal
      const held = {
        id: `hold-${holdSeq}`,
        sessionId: sessionIdOf(request.agent?.session),
        qids: new Set((Array.isArray(request.questions) ? request.questions : [])
          .map((question) => String(question?.id ?? ''))),
        next,
        signal,
        handed: false,
        settled: false,
        onAbort: null,
        settle: null,
      }
      held.settle = (ok, value) => {
        if (held.settled) return
        held.settled = true
        signal?.removeEventListener?.('abort', held.onAbort)
        heldQuestions.delete(held.id)
        if (ok) resolve(value)
        else reject(value)
      }
      held.onAbort = () => {
        held.settle(false, signal?.reason ?? new Error('the question was aborted before it was answered'))
      }
      signal?.addEventListener?.('abort', held.onAbort, { once: true })
      heldQuestions.set(held.id, held)
      if (!pageHidden()) handOverQuestion(held)
    })

    // Approval requests keep DSH's own approval panel on screen; the toast is
    // only a remote control for it. Its answer is parked for the browser half,
    // exactly like a question answer, and that half clicks allow/reject in the
    // panel. `approvalToasts` maps the toast id to the session so the parked
    // answer can be routed and retired.
    const APPROVAL_ALLOW = '允许一次'
    const APPROVAL_DENY = '拒绝'
    const approvalToasts = new Map()
    let approvalSeq = 0

    const receiveToastAnswer = (message) => {
      const id = String(message?.id ?? '')
      const approval = approvalToasts.get(id)
      if (approval !== undefined) {
        const answers = Array.isArray(message?.answers) ? message.answers : []
        const label = String(answers[0]?.selected?.[0] ?? '')
        const decision = label === APPROVAL_DENY ? 'rejected' : label === APPROVAL_ALLOW ? 'allowed-once' : null
        latestToastAnswer = {
          kind: 'approval',
          id,
          sessionId: approval.sessionId,
          decision,
          at: Date.now(),
        }
        if (approval.timer === null) {
          approval.timer = setTimeout(() => {
            if (!approvalToasts.has(id)) return
            helper.send({ op: 'status', id, state: 'manual' })
            if (latestToastAnswer !== null && latestToastAnswer.id === id) latestToastAnswer = null
          }, Math.max(5000, Number(cfg.answerPendingTimeoutMs) || 30000))
        }
        return
      }
      const sessionId = message?.sessionId ? String(message.sessionId) : ''
      const answers = Array.isArray(message?.answers) ? message.answers : []
      if (id.length === 0 || sessionId.length === 0) return
      const qids = new Set(answers.map((item) => String(item?.id ?? '')))
      let live = false
      for (const ask of activeAsks.values()) {
        if (ask.sessionId !== sessionId) continue
        if (![...qids].every((qid) => ask.qids.has(qid))) continue
        live = true
        break
      }
      if (!live) {
        helper.send({ op: 'status', id, state: 'stale' })
        return
      }
      // While every page is hidden the host settles the request itself instead
      // of waiting for a throttled renderer to click the card. When a page can
      // render, the browser half polls the parked answer and clicks the
      // official card instead (a host-answered card still gets the parked
      // answer so it retires when the page wakes).
      const routed = routeToastAnswer(sessionId, answers)
      if (routed.park) latestToastAnswer = { kind: 'question', id, sessionId, answers, at: Date.now() }
      const proof = {
        id,
        sessionId,
        answers,
        stage: 'parked',
        text: '',
        timer: null,
      }
      proof.timer = setTimeout(() => {
        if (proof.stage !== 'parked') return
        proof.timer = null
        proofs.delete(id)
        helper.send({ op: 'status', id, state: 'timeout' })
        if (latestToastAnswer !== null && latestToastAnswer.id === id) latestToastAnswer = null
      }, Math.max(5000, Number(cfg.answerPendingTimeoutMs) || 30000))
      proofs.set(id, proof)
    }

    const cancelToastAnswer = (message) => {
      const id = String(message?.id ?? '')
      if (id.length === 0) return
      const approval = approvalToasts.get(id)
      if (approval !== undefined) {
        // Cancelling does not decide the approval: DSH's own panel is already
        // on screen and stays the authority.
        if (approval.timer !== null) clearTimeout(approval.timer)
        approvalToasts.delete(id)
        return
      }
      const proof = proofs.get(id)
      if (proof === undefined) return
      if (proof.timer !== null) clearTimeout(proof.timer)
      proofs.delete(id)
    }

    const helper = createToastHelper({
      subprocess: ctx.get('subprocess'),
      onAnswer: receiveToastAnswer,
      onCancel: cancelToastAnswer,
      logPath: typeof cfg.helperLog === 'string' ? cfg.helperLog : '',
    })

    const previousHelper = activeHelper
    activeHelper = helper
    ctx.effect(() => {
      helper.ensure().then((ok) => {
        if (!ok) {
          const hint = helper.runtimeMissing()
            ? 'install the .NET 10 Desktop Runtime'
            : 'the resident toast helper failed to start'
          console.error(`[dsh-notify-win] toast helper unavailable: ${hint}`)
          return
        }
        // Tell the helper how fast the taskbar badge blinks before the first
        // event can fire.
        syncAttentionConfig()
      }).catch((error) => {
        console.error('[dsh-notify-win] toast helper failed:', error)
      })
      return () => {
        if (activeHelper === helper) activeHelper = null
        void helper.stop()
      }
    }, 'dsh-notify-win: resident toast helper')
    if (previousHelper !== null && previousHelper !== helper) void previousHelper.stop()

    /**
     * Effects carried by the model's first-line receipt. The receipt toast is
     * itself optional: when it is off, a configured blink/flash still announces
     * the answer.
     */
    const receiptEffects = () => {
      const effects = resolveEffects(cfg, 'receipt')
      return {
        toast: effects.toast,
        blink: effects.blink === true,
        flash: effects.flash === true,
        timing: effects.timing === 'immediate' ? 'immediate' : 'after-timeout',
      }
    }

    /**
     * Settle the proof attached to a question call once its tool result is known.
     * Returns true when the toast supplied the answer (the receipt pipeline owns
     * the flow from here); false when the answer came from the DSH UI, in which
     * case the helper is told to retire the toast and stop its flash.
     */
    const settleProof = (sid, questions, result) => {
      if (sid === null) return false
      const qids = new Set((Array.isArray(questions) ? questions : []).map((question) => String(question?.id ?? '')))
      let settled = false
      for (const proof of proofs.values()) {
        if (proof.stage !== 'parked' || proof.sessionId !== sid) continue
        if (!proof.answers.every((item) => qids.has(String(item.id)))) continue
        settled = true
        if (proof.timer !== null) clearTimeout(proof.timer)
        proof.timer = null
        if (result?.isError === true) {
          proofs.delete(proof.id)
          helper.send({
            op: 'status',
            id: proof.id,
            state: 'failed',
            detail: truncate(result?.error?.message ?? '工具执行失败', 160),
          })
          continue
        }
        const actual = result?.value?.answers
        const same = JSON.stringify(normalizeAnswers(proof.answers)) === JSON.stringify(normalizeAnswers(actual))
        const detail = summarizeAnswers(Array.isArray(actual) ? actual : proof.answers)
        // The toast answer is the truth we promised to report: if the agent
        // received something else (a manual UI answer, or another client won the
        // race), say so instead of confirming the wrong choice.
        if (!same) {
          proofs.delete(proof.id)
          helper.send({ op: 'status', id: proof.id, state: 'mismatch', detail })
          continue
        }
        // No intermediate "delivered" toast: the user asked for one receipt
        // only — the model's own first line. The pending toast stays up while
        // the agent works, then the spoken toast replaces it.
        proof.stage = 'waiting-text'
        proof.text = ''
        proof.timer = setTimeout(() => {
          if (proof.stage !== 'waiting-text') return
          proof.timer = null
          proofs.delete(proof.id)
          const { line } = receiptLine(proof.text)
          if (line !== null) helper.send({ op: 'status', id: proof.id, state: 'spoken', detail: fitReceiptLine(line), effects: receiptEffects() })
        }, Math.max(10000, Number(cfg.answerSpeechTimeoutMs) || 90000))
      }
      return settled
    }

    /**
     * The turn is over: whatever text it produced has already been streamed.
     * A line without a trailing newline still counts — it is the model's answer,
     * just short enough that it never filled a toast line. A turn with no
     * visible text stays silent: this plugin now shows exactly one receipt,
     * and it cannot invent one the model did not write.
     */
    const finalizeSpeech = (sid) => {
      for (const proof of proofs.values()) {
        if (proof.sessionId !== sid || proof.stage !== 'waiting-text') continue
        if (proof.timer !== null) clearTimeout(proof.timer)
        proof.timer = null
        proofs.delete(proof.id)
        const { line } = receiptLine(proof.text)
        if (line !== null) helper.send({ op: 'status', id: proof.id, state: 'spoken', detail: fitReceiptLine(line), effects: receiptEffects() })
      }
    }

    /**
     * Send one notification and report the question toast it owns.
     * @returns the toast id when a question toast was sent, otherwise null.
     */
    const runNotify = async (kind, title, body, questions = null, sessionId = '', meta = {}, helperId = '', effects = null) => {
      // The resident .NET helper is the only notification implementation.
      // Nothing is spawned per notification; every toast is one JSON line on
      // the child's stdin. If the helper cannot run, the notification is
      // dropped after an explicit log (the .NET runtime is a hard dependency).
      if (!(await helper.ensure())) {
        const hint = helper.runtimeMissing()
          ? 'install the .NET 10 Desktop Runtime'
          : 'the resident toast helper failed to start'
        console.error(`[dsh-notify-win] notification dropped: ${hint}`)
        return null
      }
      syncAttentionConfig()
      const policy = effects === null
        ? { blink: false, flash: false, timing: 'after-timeout' }
        : {
          blink: effects.blink === true,
          flash: effects.flash === true,
          timing: effects.timing === 'immediate' ? 'immediate' : 'after-timeout',
        }

      if (Array.isArray(questions) && questions.length > 0 && sessionId) {
        let id = helperId
        if (id.length === 0) {
          questionSeq += 1
          id = `q-${Date.now().toString(36)}-${questionSeq}`
        }
        const sent = helper.send({
          op: 'question',
          id,
          sessionId,
          title,
          body,
          questions,
          duration: cfg.questionToastDuration,
          effects: policy,
        })
        if (!sent) {
          console.error('[dsh-notify-win] failed to send the question to the toast helper')
          return null
        }
        return id
      }

      const sent = helper.send({
        op: 'notify',
        kind,
        title,
        body,
        duration: cfg.doneToastDuration,
        reason: meta.reason,
        code: meta.code,
        retry: meta.retry,
        retryMax: meta.retryMax,
        effects: policy,
      })
      if (!sent) console.error('[dsh-notify-win] failed to send the notification to the toast helper')
      return null
    }

    // Browser-side client polls this endpoint after a toast click focuses the
    // installed Edge PWA. The first read consumes the pending session and any
    // toast-selected answer so a normal refresh does not replay them.
    const webServer = ctx.get('webServer')
    if (webServer !== undefined) {
      ctx.effect(() => {
        const disposeSession = webServer.register({
          kind: 'exact',
          path: '/dsh-notify/session',
          handler: (_req, res) => {
            const sessionId = pendingSession
            pendingSession = null
            // pendingAnswer is deliberately NOT consumed here: answer delivery
            // is owned by /dsh-notify/pending-answer (polled by the current
            // client), so an older tab/client cannot steal and mis-submit it.
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ sessionId, answer: null }))
          },
        })
        // Polled by the client on an interval: picks up a toast answer even
        // when the DSH window is already focused (so no window focus event
        // fires). Only the answer is consumed; the session is left for the
        // click-to-focus / load path so we do not switch sessions proactively.
        const disposeAnswerPoll = webServer.register({
          kind: 'exact',
          path: '/dsh-notify/pending-answer',
          handler: (req, res) => {
            const url = new URL(req.url ?? '/', 'http://dsh-notify.local')
            // Peek: tells the browser half that an answer is waiting and which
            // session/card it belongs to, without consuming it. The client
            // switches to that session first, then takes the answer below.
            if (url.searchParams.get('peek') === '1') {
              const fresh = latestToastAnswer !== null && Date.now() - latestToastAnswer.at < 60000
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({
                available: fresh,
                kind: fresh ? latestToastAnswer.kind : null,
                id: fresh ? latestToastAnswer.id : null,
                sessionId: fresh ? latestToastAnswer.sessionId : null,
              }))
              return
            }
            // One-shot pickup of the newest toast answer (consumed on read, so
            // two tabs cannot both click the card). An optional id makes the
            // pickup atomic with the peek: if another answer replaced it, the
            // caller gets available=false and retries instead of driving the
            // wrong card.
            if (url.searchParams.get('latest') === '1') {
              const expected = url.searchParams.get('id')
              const fresh = latestToastAnswer !== null && Date.now() - latestToastAnswer.at < 60000
              if (!fresh || (expected !== null && expected !== latestToastAnswer.id)) {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ available: false }))
                return
              }
              const answer = latestToastAnswer
              latestToastAnswer = null
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({
                available: true,
                kind: answer.kind,
                id: answer.id,
                sessionId: answer.sessionId,
                answers: answer.answers ?? null,
                decision: answer.decision ?? null,
              }))
              return
            }
            // Legacy per-call pickup is no longer used; the browser half reads
            // ?latest=1 above. Kept as a no-answer response for old clients.
            const call = url.searchParams.get('call')
            if (call !== null) {
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ answers: null }))
              return
            }
            // Only the current client (which sends ?v=2) may consume the
            // answer. Older HMR-stale timers without the marker are ignored so
            // they cannot steal and mis-submit a toast answer.
            if (url.searchParams.get('v') !== '2') {
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ answer: null }))
              return
            }
            const answer = pendingAnswer
            pendingAnswer = null
            if (answer) pendingQuestion = null
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ answer }))
          },
        })
        const disposeAnswer = webServer.register({
          kind: 'exact',
          path: '/dsh-notify/answer',
          handler: async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://dsh-notify.local')
            let answer = null
            if (req.method === 'POST') {
              // New batch format from the custom toast window:
              // { "sessionId": "...", "answers": [{ "id", "selected", "custom" }] }
              const chunks = []
              for await (const chunk of req) chunks.push(chunk)
              const raw = Buffer.concat(chunks).toString('utf8')
              try {
                const data = JSON.parse(raw)
                if (data && typeof data.sessionId === 'string' && Array.isArray(data.answers)) {
                  answer = { sessionId: data.sessionId, answers: data.answers }
                } else if (data && typeof data.sessionId === 'string' && data.cancel === true) {
                  answer = { sessionId: data.sessionId, cancel: true }
                }
              } catch {
                answer = null
              }
            } else {
              // Legacy single-answer query format (kept for manual/CLI tests).
              const option = url.searchParams.get('option') ?? ''
              const custom = url.searchParams.get('custom') ?? ''
              answer = {
                sessionId: url.searchParams.get('session'),
                answers: [{
                  id: url.searchParams.get('qid'),
                  selected: option ? [option] : [],
                  custom: custom || undefined,
                }],
              }
            }
            // Hand the toast answer to the browser half: it is the only side
            // that can settle the official question card, which in turn settles
            // the `user-questions/request` waterfall. The host-side
            // `userQuestions.answer()` refuses a question that is still in
            // flight, and a plugin listener is queued behind the official card.
            // A question the host watches (no page can render its card) is
            // settled right here instead: there is no renderer to wake.
            let via = 'page'
            if (answer?.sessionId && Array.isArray(answer.answers)) {
              const routed = routeToastAnswer(String(answer.sessionId), answer.answers)
              if (routed.hostAnswered) via = 'host'
              if (routed.park) {
                latestToastAnswer = {
                  id: typeof answer.id === 'string' ? answer.id : `http-${Date.now().toString(36)}`,
                  sessionId: String(answer.sessionId),
                  answers: answer.answers,
                  at: Date.now(),
                }
              }
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true, via }))
          },
        })
        // The browser half reports whether it managed to drive the official
        // card. A failure is not a delivery: the host only turns it into a
        // "answer in DSH" hint and keeps waiting for the real tool result.
        const disposeAck = webServer.register({
          kind: 'exact',
          path: '/dsh-notify/answer-ack',
          handler: async (req, res) => {
            let data = null
            if (req.method === 'POST') {
              const chunks = []
              for await (const chunk of req) chunks.push(chunk)
              try {
                data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              } catch {
                data = null
              }
            }
            const proof = data && proofs.get(String(data.id ?? ''))
            if (proof !== undefined && proof.stage === 'parked' && data.ok !== true) {
              helper.send({ op: 'status', id: proof.id, state: 'manual' })
            }
            const approval = data && approvalToasts.get(String(data.id ?? ''))
            if (approval !== undefined) {
              if (approval.timer !== null) clearTimeout(approval.timer)
              approval.timer = null
              if (data.ok !== true) {
                helper.send({ op: 'status', id: String(data.id), state: 'manual' })
              }
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          },
        })
        // The page reports whether it can render a question card. Chromium
        // throttles a hidden window's timers, so the host answers a pending
        // question itself while no page is visible; the first visible report
        // hands every held request back to the official card. `visibilityRoute`
        // tells the question listener that a real report path exists: without
        // this route a deployment keeps the old card-only behavior.
        const disposeVisibility = webServer.register({
          kind: 'exact',
          path: '/dsh-notify/visibility',
          handler: async (req, res) => {
            let data = null
            if (req.method === 'POST') {
              const chunks = []
              for await (const chunk of req) chunks.push(chunk)
              try {
                data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              } catch {
                data = null
              }
            }
            const clientId = typeof data?.clientId === 'string' && data.clientId.length > 0
              ? data.clientId
              : 'page'
            const visible = data?.visible === true
            pageReported = true
            if (visible) visiblePages.set(clientId, Date.now())
            else visiblePages.delete(clientId)
            if (visible) handOverHeldQuestions()
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true, held: heldQuestions.size }))
          },
        })
        visibilityRoute = true
        // Diagnostics: lets a bug report say whether the host or the page owns
        // the next question, without reading DSH's console.
        const disposeState = webServer.register({
          kind: 'exact',
          path: '/dsh-notify/state',
          handler: (_req, res) => {
            const now = Date.now()
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              pagesReported: pageReported,
              pagesVisible: livePageCount(),
              pageHidden: pageHidden(),
              pages: [...visiblePages].map(([id, at]) => ({ id, ageMs: now - at })),
              held: [...heldQuestions.values()].map((held) => ({
                id: held.id,
                sessionId: held.sessionId,
                questions: held.qids.size,
                handed: held.handed === true,
              })),
              questionToast: lastQuestionToast === null
                ? null
                : { id: lastQuestionToast.id, ageMs: Date.now() - lastQuestionToast.at },
            }))
          },
        })
        return () => {
          disposeSession()
          disposeAnswerPoll()
          disposeAnswer()
          disposeAck()
          disposeVisibility()
          disposeState()
        }
      }, 'dsh-notify-win: pending session/answer routes')
    }

    // One session/event feed drives stop-reason tracking and compaction
    // notifications. `turn/end` is appended before the idle transition that
    // follows it, so caching the reason here is what lets the idle toast say
    // WHY the agent stopped instead of always claiming success.
    ctx.on('session/event', (session, event) => {
      const sid = sessionIdOf(session)
      if (sid === null) return
      if (!isRootSession(session)) return

      switch (event?.type) {
        // A new turn starts with a clean retry slate.
        case 'turn/start':
          retryBySession.delete(sid)
          return
        case 'turn/end':
          turnEndBySession.set(sid, { reason: event.data?.reason, consumed: false })
          finalizeSpeech(sid)
          return
        // Durable retry records: the latest one is the closest available
        // signal for "retries exhausted" because the failing turn/end itself
        // carries only the underlying failure code.
        case 'llm/retry': {
          const data = event.data ?? {}
          retryBySession.set(sid, {
            retry: typeof data.retry === 'number' ? data.retry : undefined,
            maxRetries: typeof data.maxRetries === 'number' ? data.maxRetries : undefined,
          })
          return
        }
        case 'compaction/end': {
          if (event.data?.error) {
            if (cfg.notifyOnError === false) return
            const descriptor = describeCompactionFailure(event.data.error)
            notify(descriptor.kind, descriptor.title, descriptor.body, session, null, descriptor)
            return
          }
          if (pendingQuestion?.sessionId === sid) return
          notify('compact', cfg.compactTitle, cfg.compactBody, session, null, { event: 'compact' })
          return
        }
        default:
          return
      }
    })

    // The model's first visible line after the tool result is the receipt the
    // user asked for: it can only exist if the answer really reached the agent
    // and the model responded to it. Reasoning deltas are ignored. The receipt
    // fires as soon as that line is complete, or once it is already longer
    // than the toast can show (so a line without a break still appears).
    ctx.on('agent/assistant-stream', ({ agent, frame } = {}) => {
      if (frame?.type !== 'chunk') return
      const chunk = frame.chunk
      if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string' || chunk.text.length === 0) return
      const sid = sessionIdOf(agent?.session)
      if (sid === null) return
      for (const proof of proofs.values()) {
        if (proof.sessionId !== sid || proof.stage !== 'waiting-text') continue
        proof.text += chunk.text
        const { line, complete } = receiptLine(proof.text)
        if (line === null) continue
        if (!complete && textColumns(line) <= RECEIPT_LINE_COLUMNS) continue
        if (proof.timer !== null) clearTimeout(proof.timer)
        proof.timer = null
        proofs.delete(proof.id)
        helper.send({ op: 'status', id: proof.id, state: 'spoken', detail: fitReceiptLine(line), effects: receiptEffects() })
      }
    })

    // The agent loop reports idle only when no driver remains scheduled or
    // active, but idle alone does not say WHY: read the cached turn/end reason
    // to distinguish a real finish from truncation, failure, or cancellation.
    ctx.on('agent/status', (payload) => {
      if (payload?.status !== 'idle') return
      if (!isRootAgent(payload?.agent)) return
      const session = payload?.agent?.session
      const sid = sessionIdOf(session)
      if (sid !== null) finalizeSpeech(sid)
      // While a question is still waiting for the user, the agent can look
      // idle and re-emit idle events; suppress toasts so they do not pile up
      // until the question is actually answered.
      if (sid !== null && pendingQuestion?.sessionId === sid) return

      const entry = sid === null ? undefined : turnEndBySession.get(sid)
      let reason
      if (entry === undefined) {
        // No turn/end observed (an agent resumed already idle): preserve the
        // historical behaviour of treating that as a completed task.
        reason = { kind: 'completed' }
      } else if (entry.consumed) {
        // A second idle for the turn already reported: stay quiet.
        return
      } else {
        entry.consumed = true
        reason = entry.reason
      }

      const retry = sid === null ? undefined : retryBySession.get(sid)
      if (sid !== null) retryBySession.delete(sid)
      const descriptor = describeStop(reason, retry)
      if (descriptor === null) return
      notify(descriptor.kind, descriptor.title, descriptor.body, session, null, descriptor)
    })

    // A decision is waiting for the user (approval/request is a waterfall).
    // DSH's own approval panel stays the authority; the toast is a remote
    // control for it. The toast answer is parked for the browser half, which
    // clicks allow/reject in that panel (exactly like a question answer), so
    // the GUI keeps showing the request while the toast is open.
    const approvalReason = (request) => {
      const localized = request?.displayReason
      if (localized !== undefined && typeof localized === 'object') {
        for (const key of ['zh', 'en']) {
          const text = localized[key]
          if (typeof text === 'string' && text.length > 0) return text
        }
      }
      return typeof request?.reason === 'string' && request.reason.length > 0
        ? request.reason
        : cfg.questionBody
    }

    /** Show the toast half of an approval; null means DSH's panel is the only path. */
    const sendApprovalToast = async (request) => {
      const sid = sessionIdOf(request?.agent?.session)
      if (sid === null) return null
      if (!(await helper.ensure())) return null
      syncAttentionConfig()
      const effects = resolveEffects(cfg, 'approval')
      const id = `a-${Date.now().toString(36)}-${++approvalSeq}`
      const reason = approvalReason(request)
      const tool = typeof request?.toolName === 'string' && request.toolName.length > 0
        ? `工具：${request.toolName}`
        : ''
      approvalToasts.set(id, { sessionId: sid, timer: null })
      const sent = helper.send({
        op: 'question',
        id,
        sessionId: sid,
        title: cfg.questionTitle,
        body: reason,
        questions: [{
          id: 'approval',
          question: reason,
          detail: tool,
          options: [{ label: APPROVAL_ALLOW }, { label: APPROVAL_DENY }],
          noCustom: true,
        }],
        duration: cfg.approvalToastDuration,
        approval: true,
        effects: {
          blink: effects.blink === true,
          flash: effects.flash === true,
          timing: effects.timing === 'immediate' ? 'immediate' : 'after-timeout',
        },
      })
      if (!sent) {
        approvalToasts.delete(id)
        return null
      }
      return id
    }

    const answerApproval = async (request, next) => {
      const id = await sendApprovalToast(request)
      const signal = request?.signal
      const retire = () => {
        if (id === null) return
        const entry = approvalToasts.get(id)
        if (entry !== undefined && entry.timer !== null) clearTimeout(entry.timer)
        approvalToasts.delete(id)
        // The waterfall is settled (answered or aborted): take the toast down.
        helper.send({ op: 'status', id, state: 'resolved' })
      }
      if (signal?.aborted) {
        retire()
        return 'cancelled'
      }
      const onAbort = () => retire()
      signal?.addEventListener?.('abort', onAbort, { once: true })
      try {
        return await next()
      } finally {
        signal?.removeEventListener?.('abort', onAbort)
        retire()
      }
    }

    ctx.on('approval/request', (request, next) => {
      if (request?.agent === undefined || !isRootAgent(request.agent)) return next()
      return answerApproval(request, next)
    })

    // The model asked the user a direct question (waterfall; must call next).
    ctx.on('tools/execute', async (exec, next) => {
      if (exec?.name !== 'ask_user_question') return next()
      const session = exec?.agent?.session
      const sid = sessionIdOf(session)
      const callId = exec?.callId === undefined ? null : String(exec.callId)
      const questions = exec?.arguments?.questions
      const first = Array.isArray(questions) && questions.length > 0 ? questions[0] : null
      const title = first?.header || cfg.askTitle
      const body = first?.question || cfg.askBody
      // One id per interactive toast. The host keeps it so a question settled
      // in the DSH card (no toast answer, hence no proof) can tell the helper
      // to retire the toast and stop the attention flash.
      const helperId = sid !== null && Array.isArray(questions) && questions.length > 0
        ? `q-${Date.now().toString(36)}-${++questionSeq}`
        : ''
      if (sid !== null && callId !== null) {
        activeAsks.set(callId, {
          sessionId: sid,
          qids: new Set(
            (Array.isArray(questions) ? questions : []).map((question) => String(question?.id ?? '')),
          ),
          helperId,
        })
      }
      const toastId = await notify('question', title, body, session, questions, { event: 'question' }, helperId)
      // Only a question whose toast actually reached the helper may be held:
      // without a toast the card is the user's only surface.
      if (typeof toastId === 'string' && toastId.length > 0 && sid !== null) {
        lastQuestionToast = { sessionId: sid, id: toastId, at: Date.now() }
      }
      let settled = false
      try {
        // Resolving here is the concrete proof that the answer reached the
        // agent: this is the official tool call returning its result.
        const result = await next()
        settled = settleProof(sid, questions, result)
        return result
      } finally {
        // No proof means the toast was not the answer path: the question was
        // settled in the DSH card (or the call failed), so the helper must stop
        // the flash and remove the toast it still owns. When a proof did settle
        // the answer, the receipt pipeline keeps the flow and must not be
        // retired here.
        if (!settled && helperId.length > 0) {
          helper.send({ op: 'status', id: helperId, state: 'resolved' })
        }
        if (callId !== null) activeAsks.delete(callId)
        if (lastQuestionToast?.id === toastId) lastQuestionToast = null
        // The question has been answered (via toast or the DSH UI); clear the
        // pending marker so done-toasts are no longer suppressed and future
        // questions with the same id are allowed.
        if (sid !== null && pendingQuestion?.sessionId === sid) pendingQuestion = null
      }
    })

    // ------------------------------------------------------------------
    // Answer the question from the host whenever the page cannot show its card.
    //
    // Prepended, so it runs BEFORE the harness forwarder: without that, the
    // forwarder owns the request and the host could only wait for a page that
    // is minimized. Every toasting root-agent question is tracked (a visible
    // page gets the request forwarded immediately), so a toast click after the
    // window was minimized still settles it. Everything else falls straight
    // through to the official chain, and the in-window flow is unchanged.
    // ------------------------------------------------------------------
    ctx.on('user-questions/request', (request, next) => {
      if (request?.agent === undefined || !isRootAgent(request.agent)) return next()
      if (lastQuestionToast === null) return next()
      const sessionId = sessionIdOf(request.agent.session)
      if (sessionId === null || lastQuestionToast.sessionId !== sessionId) return next()
      if (Date.now() - lastQuestionToast.at > 120000) return next()
      return holdQuestion(request, next)
    }, { prepend: true })

    // A plugin reload must not strand a held question: hand it to the official
    // chain as the plugin goes away, so the card (or the next host instance)
    // still owns the answer. Disposal ignores the page state on purpose.
    ctx.effect(() => () => {
      for (const held of [...heldQuestions.values()]) handOverQuestion(held)
    }, 'dsh-notify-win: held questions')

    // "File changed" trigger: a successful call of one of the file-mutating
    // tools is the only reliable signal DSH exposes for a write. Root sessions
    // only; the per-session dedup window keeps a burst of edits from turning
    // into a notification storm.
    ctx.on('tools/execute', async (exec, next) => {
      if (!FILE_WRITE_TOOLS.has(exec?.name)) return next()
      const result = await next()
      try {
        if (result?.isError !== true && isRootAgent(exec?.agent)) {
          const args = exec?.arguments ?? {}
          const raw = typeof args.file_path === 'string'
            ? args.file_path
            : typeof args.path === 'string' ? args.path : ''
          const path = raw.length > 0 ? truncate(basename(raw), 80) : '文件'
          notify(
            'file',
            cfg.fileChangeTitle,
            fillTemplate(cfg.fileChangeBody, { path, tool: exec.name }),
            exec?.agent?.session,
            null,
            { event: 'file', reason: 'file' },
          )
        }
      } catch {
        // Notification failures must never change the tool result.
      }
      return result
    })
  },
}

export { Config }
export default plugin
