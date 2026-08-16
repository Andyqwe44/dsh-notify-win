/**
 * dsh-notify-win — DeepSeek Harness host plugin.
 *
 * Notifies the user on Windows 11 when:
 *   - a task finishes  (root agent goes idle: API stream ended, no more tool
 *     rounds are continuing)          -> "done" notification
 *   - an answer is needed (approval request, or the model asked a direct
 *     question via ask_user_question) -> "question" notification
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
const WEB_BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'

const DEFAULTS = {
  doneTitle: 'DeepSeek Harness · 任务完成',
  doneBody: '任务已完成，可以查看结果。',
  questionTitle: 'DeepSeek Harness · 需要你确认',
  questionBody: '有操作需要你批准或拒绝。',
  askTitle: 'DeepSeek Harness · 有问题等你回答',
  askBody: '助手向你提了一个问题，请切换到 DeepSeek Harness 查看。',
  dedupMs: 1500,
  // Prefix notifications with the project label: the git remote origin
  // repository name when the session's cwd is a git work tree, else the cwd
  // folder name. Set false to disable.
  showProject: true,
}

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
    const lastBySession = new Map()
    let pendingSession = null
    let pendingQuestion = null
    let pendingAnswer = null
    let powershellPath = undefined

    /**
     * Resolve the PowerShell executable, mirroring the official
     * dsh-pwsh-local strategy (pwsh 7 install -> PATH pwsh -> Windows
     * PowerShell 5.1). 5.1 supports the WinRT toast projection, so it is a
     * valid final executor for notify.ps1.
     */
    const resolvePowershell = async (subprocess) => {
      const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
      const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const fixed = [
        join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
        join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'),
        join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ]
      for (const candidate of fixed) {
        if (existsSync(candidate)) return candidate
      }
      for (const name of ['pwsh', 'powershell']) {
        try {
          return await subprocess.resolveExecutable(name)
        } catch {
          // try the next name
        }
      }
      throw new Error('no PowerShell executable found (tried pwsh 7 install, PATH, and Windows PowerShell 5.1)')
    }

    /** Root sessions only: skip subagents so delegation noise stays silent. */
    const isRootAgent = (agent) => {
      try {
        const depth = agent?.session?.header?.delegationDepth
        return depth === undefined || depth === 0
      } catch {
        return true
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

    const notify = async (kind, title, body, session, questions = null) => {
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
      // question (the agent loop can re-emit the same ask while waiting).
      if (kind === 'question' && pendingQuestion &&
          pendingQuestion.sessionId === sessionId &&
          pendingQuestion.questions?.[0]?.id === questions?.[0]?.id) return
      pendingSession = sessionId ? String(sessionId) : null
      pendingQuestion = sessionId && Array.isArray(questions) && questions.length > 0
        ? { sessionId: String(sessionId), questions }
        : null
      // A new notification must not inherit a stale toast answer from an
      // earlier interaction (e.g. an unread action from a previous toast).
      pendingAnswer = null
      const launch = sessionId ? 'dsh-notify://focus' : ''
      runNotify(kind, title, finalBody, launch, questions, sessionId ? String(sessionId) : '').catch((error) => {
        console.error('[dsh-notify-win] notify failed:', error)
      })
    }

    const runNotify = async (kind, title, body, launch = '', questions = null, sessionId = '') => {
      const subprocess = ctx.get('subprocess')
      if (subprocess === undefined) return
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
          if (Array.isArray(questions) && questions.length > 0) {
            const first = questions[0]
            if (first?.id) argv.push('-QuestionId', String(first.id))
            argv.push('-QuestionsJson', Buffer.from(JSON.stringify(questions), 'utf8').toString('base64'))
          }
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
          handler: (req, res) => {
            const url = new URL(req.url ?? '/', 'http://dsh-notify.local')
            pendingAnswer = {
              sessionId: url.searchParams.get('session'),
              questionId: url.searchParams.get('qid'),
              option: url.searchParams.get('option'),
              custom: url.searchParams.get('custom'),
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          },
        })
        return () => { disposeSession(); disposeAnswerPoll(); disposeAnswer() }
      }, 'dsh-notify-win: pending session/answer routes')
    }

    // Task finished: the agent loop reports idle only when no driver remains
    // scheduled or active — i.e. the API response ended and no tool call is
    // continuing the dialogue round.
    ctx.on('agent/status', (payload) => {
      if (payload?.status !== 'idle') return
      if (!isRootAgent(payload?.agent)) return
      notify('done', cfg.doneTitle, cfg.doneBody, payload?.agent?.session)
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
    ctx.on('tools/execute', (exec, next) => {
      if (exec?.name === 'ask_user_question') {
        const questions = exec?.arguments?.questions
        const first = Array.isArray(questions) && questions.length > 0 ? questions[0] : null
        const title = first?.header || cfg.askTitle
        const body = first?.question || cfg.askBody
        notify('question', title, body, exec?.agent?.session, questions)
      }
      return next()
    })
  },
}
