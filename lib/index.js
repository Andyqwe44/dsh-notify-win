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
 * The notification is a native Win11 toast (VSCode-Copilot style) with a
 * taskbar flash (FlashWindowEx, system warm pulse) on the DeepSeek Harness
 * window. See ./notify.ps1 for the OS-level implementation.
 *
 * This is a host-plane plugin: it only consumes harness lifecycle events and
 * the subprocess service. It registers no service, no tool, and no settings,
 * so it cannot collide with any other row and needs no isolate realm.
 */

import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, join } from 'node:path'
import os from 'node:os'

const SCRIPT_PATH = fileURLToPath(new URL('./notify.ps1', import.meta.url))
const QUESTION_EXE_PATH = fileURLToPath(new URL('./dsh-toast-question.exe', import.meta.url))
const WEB_BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'

const DEFAULTS = {
  doneTitle: 'DeepSeek Harness · 任务完成',
  doneBody: '任务已完成，可以查看结果。',
  compactTitle: 'DeepSeek Harness · 上下文已压缩',
  compactBody: '上下文压缩完成，可以继续。',
  questionTitle: 'DeepSeek Harness · 需要你确认',
  questionBody: '有操作需要你批准或拒绝。',
  askTitle: 'DeepSeek Harness · 有问题等你回答',
  askBody: '助手向你提了一个问题，请切换到 DeepSeek Harness 查看。',
  dedupMs: 1500,
  // Toast display duration: 'short' (~5 s, Windows default) or 'long' (~25 s).
  // questionToastDuration applies to interactive ask_user_question toasts
  // (single-select dropdown via dsh-toast-question.exe); doneToastDuration
  // applies to done / compact / approval toasts (via notify.ps1).
  questionToastDuration: 'short',
  doneToastDuration: 'short',
  // Appended to the question toast body when the .NET Desktop Runtime is
  // missing and the interactive helper cannot run. Guides the user to
  // install .NET so future questions get the in-toast dropdown.
  noDotNetHint: '（如需从 toast 直接回答，请安装 .NET 10 Desktop Runtime）',
  // Prefix notifications with the project label: the git remote origin
  // repository name when the session's cwd is a git work tree, else the cwd
  // folder name. Set false to disable.
  showProject: true,

  // ------------------------------------------------------------------
  // Stop-reason notifications. A root agent going idle is not always a
  // successful finish: it may have hit the output-token ceiling, been
  // blocked by a pre-step hook, failed after exhausting LLM retries, or
  // been cancelled. Each reason has its own text (templates support
  // {message} {code} {hint} {reason} {retry} {retryMax}).
  // ------------------------------------------------------------------
  // Show a lightweight notice when the user cancels a running turn.
  notifyOnCancel: true,
  // Show an alert for max-tokens / blocked / LLM failure / failed compaction.
  notifyOnError: true,
  // Append the machine-readable failure code to an error body.
  includeErrorCode: true,
  cancelledTitle: 'DeepSeek Harness · 已取消',
  cancelledBody: '任务已取消。',
  hookCancelledBody: '任务被 hook 拦截：{message}',
  maxTokensTitle: 'DeepSeek Harness · 输出达到上限',
  maxTokensBody: '模型输出达到上限，本轮已截断。发送「继续」即可接着写。',
  blockedTitle: 'DeepSeek Harness · 回合被拦截',
  blockedBody: '本轮在开始前被前置检查拒绝。',
  errorTitle: 'DeepSeek Harness · 任务中断',
  errorBody: '任务异常停止：{hint}',
  retrySuffix: '（已重试 {retry}/{retryMax} 次）',
  retrySuffixUnbounded: '（已重试 {retry} 次）',
  compactionFailedTitle: 'DeepSeek Harness · 上下文压缩失败',
  compactionFailedBody: '上下文压缩失败：{message}',
  unknownStopTitle: 'DeepSeek Harness · 任务已停止',
  unknownStopBody: '任务已停止，结束方式：{reason}',
}

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

export default {
  name: 'dsh-notify-win',
  inject: ['subprocess', 'webServer'],
  apply(ctx, config) {
    const cfg = { ...DEFAULTS, ...(config ?? {}) }
    // Per-session dedup: each project (session) notifies independently, so two
    // projects finishing back-to-back never collapse into one toast, while a
    // single session's rapid idle transitions (spurious wake/idle) still stay
    // quiet. A 1.5s floor between ANY two toasts also bounds an approval
    // burst that cannot be attributed to one session.
    let powershellPath = undefined

    /**
     * Resolve the PowerShell executable for notify.ps1.
     *
     * Windows PowerShell 5.1 comes FIRST: it is the only host that still ships
     * the WinRT projection the toast path needs. PowerShell 7 cannot resolve
     * `Windows.UI.Notifications` types, so a pwsh 7 first-executor silently
     * degrades every toast to the legacy NotifyIcon balloon (verified on a real
     * machine). 5.1 is present on every supported Windows install, so it leads;
     * pwsh 7 stays as a last-resort fallback when 5.1 is unavailable.
     */
    const resolvePowershell = async (subprocess) => {
      const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
      const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const fixed = [
        join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
        join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'),
      ]
      for (const candidate of fixed) {
        if (existsSync(candidate)) return candidate
      }
      for (const name of ['powershell', 'pwsh']) {
        try {
          return await subprocess.resolveExecutable(name)
        } catch {
          // try the next name
        }
      }
      throw new Error('no PowerShell executable found (tried Windows PowerShell 5.1, pwsh 7 install, and PATH)')
    }

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
          return { kind: 'done', title: cfg.doneTitle, body: cfg.doneBody, reason: 'completed' }
        case 'max-tokens':
          if (cfg.notifyOnError === false) return null
          return { kind: 'alert', title: cfg.maxTokensTitle, body: cfg.maxTokensBody, reason: 'max-tokens' }
        case 'blocked':
          if (cfg.notifyOnError === false) return null
          return { kind: 'alert', title: cfg.blockedTitle, body: cfg.blockedBody, reason: 'blocked' }
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
              code: 'hook',
            }
          }
          return {
            kind: 'notice',
            title: cfg.cancelledTitle,
            body: cfg.cancelledBody,
            reason: 'aborted',
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

    const notify = async (kind, title, body, session, questions = null, meta = {}) => {
      const now = Date.now()
      const key = session?.id ?? session?.header?.id ?? '\u0000any'
      // Per-session dedup: different sessions notify independently (each
      // project's completion always surfaces), while a single session's rapid
      // idle transitions (spurious wake/idle) stay quiet.
      if (now - (lastBySession.get(key) ?? 0) < cfg.dedupMs) return
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
          pendingQuestion.sessionId === sessionId) return
      pendingSession = sessionId ? String(sessionId) : null
      pendingQuestion = sessionId && Array.isArray(questions) && questions.length > 0
        ? { sessionId: String(sessionId), questions }
        : null
      // A new notification must not inherit a stale toast answer from an
      // earlier interaction (e.g. an unread action from a previous toast).
      pendingAnswer = null
      const launch = sessionId ? 'dsh-notify://focus' : ''
      runNotify(kind, title, finalBody, launch, questions, sessionId ? String(sessionId) : '', meta).catch((error) => {
        console.error('[dsh-notify-win] notify failed:', error)
      })
    }

    const runNotify = async (kind, title, body, launch = '', questions = null, sessionId = '', meta = {}) => {
      const subprocess = ctx.get('subprocess')
      if (subprocess === undefined) return
      // Interactive question toasts go through the .NET helper: it can read
      // the toast dropdown/text input and forward it back to the host
      // (PowerShell 5.1 cannot). If the Desktop Runtime is missing the spawn
      // fails silently, so probe first and fall back to a plain PowerShell
      // toast that still surfaces the question and nudges the user to install
      // .NET for in-toast answers.
      if (Array.isArray(questions) && questions.length > 0 && sessionId) {
        let dotnetOk = false
        try {
          const check = subprocess.spawn({
            argv: [QUESTION_EXE_PATH, '--check', '1'],
            cwd: os.tmpdir(),
            stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
            graceMs: 5000,
          })
          await check.done
          dotnetOk = true
        } catch {
          dotnetOk = false
        }

        if (dotnetOk) {
          const first = questions[0]
          const argv = [
            QUESTION_EXE_PATH,
            '--session', String(sessionId),
            '--qid', first?.id ? String(first.id) : '',
            '--title', title,
            '--body', body,
            '--questions', Buffer.from(JSON.stringify(questions), 'utf8').toString('base64'),
            '--duration', cfg.questionToastDuration,
          ]
          const qhandle = subprocess.spawn({
            argv,
            cwd: os.tmpdir(),
            stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
            graceMs: 300000,
          })
          qhandle.done.catch((err) => {
            console.error('[dsh-notify-win] interactive toast helper failed:', err)
          })
          return
        }

        // .NET missing: fall through to the PowerShell path with a hint so
        // the user still gets notified and knows what to install.
        body = body + '\n' + cfg.noDotNetHint
      }
      if (powershellPath === undefined) {
        powershellPath = await resolvePowershell(subprocess)
      }
      const handle = subprocess.spawn({
        argv: (() => {
          const argv = [
            powershellPath,
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle',
            'Hidden',
            '-File',
            SCRIPT_PATH,
            '-Kind', kind,
            '-Title', title,
            '-Body', body,
            '-Launch', launch,
          ]
          if (sessionId) argv.push('-SessionId', sessionId)
          argv.push('-Duration', cfg.doneToastDuration)
          // Stop-reason facts drive the per-kind rendering in notify.ps1 and
          // the debug line, so a manual run can reproduce the exact toast.
          if (meta.reason) argv.push('-Reason', String(meta.reason))
          if (meta.code) argv.push('-Code', String(meta.code))
          if (meta.retry !== undefined) argv.push('-Retry', String(meta.retry))
          if (meta.retryMax !== undefined) argv.push('-RetryMax', String(meta.retryMax))
          return argv
        })(),
        cwd: os.tmpdir(),
        // Notify.ps1 is fire-and-forget; its output is only for manual CLI
        // testing. Keeping stdout/stderr ignored avoids subprocess-local log
        // spills and terminal noise during normal DSH operation.
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        graceMs: 2000,
      })
      handle.done.catch(() => {})
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
            if (answer?.sessionId) pendingAnswer = answer
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          },
        })
        return () => { disposeSession(); disposeAnswerPoll(); disposeAnswer() }
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
          notify('compact', cfg.compactTitle, cfg.compactBody, session)
          return
        }
        default:
          return
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

    // A decision is waiting for the user (approval/request is a waterfall:
    // the listener must hand the request on via next()).
    ctx.on('approval/request', (req, next) => {
      if (req?.agent === undefined || isRootAgent(req.agent)) {
        const reason =
          typeof req?.reason === 'string' && req.reason.length > 0
            ? req.reason
            : cfg.questionBody
        notify('question', cfg.questionTitle, reason, req?.agent?.session)
      }
      return next()
    })

    // The model asked the user a direct question (waterfall; must call next).
    ctx.on('tools/execute', async (exec, next) => {
      if (exec?.name !== 'ask_user_question') return next()
      const questions = exec?.arguments?.questions
      const first = Array.isArray(questions) && questions.length > 0 ? questions[0] : null
      const title = first?.header || cfg.askTitle
      const body = first?.question || cfg.askBody
      notify('question', title, body, exec?.agent?.session, questions)
      try {
        return await next()
      } finally {
        // The question has been answered (via toast or the DSH UI); clear the
        // pending marker so done-toasts are no longer suppressed and future
        // questions with the same id are allowed.
        const sid = exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id
        if (sid && pendingQuestion?.sessionId === String(sid)) pendingQuestion = null
      }
    })
  },
}
