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
  inject: ['subprocess'],
  apply(ctx, config) {
    const cfg = { ...DEFAULTS, ...(config ?? {}) }
    // Per-session dedup: each project (session) notifies independently, so two
    // projects finishing back-to-back never collapse into one toast, while a
    // single session's rapid idle transitions (spurious wake/idle) still stay
    // quiet. A 1.5s floor between ANY two toasts also bounds an approval
    // burst that cannot be attributed to one session.
    const lastBySession = new Map()
    let pendingSession = null
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

    const notify = async (kind, title, body, session) => {
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
      pendingSession = sessionId ? String(sessionId) : null
      const launch = sessionId ? 'dsh-notify://focus' : ''
      runNotify(kind, title, finalBody, launch).catch((error) => {
        console.error('[dsh-notify-win] notify failed:', error)
      })
    }

    const runNotify = async (kind, title, body, launch = '') => {
      const subprocess = ctx.get('subprocess')
      if (subprocess === undefined) return
      if (powershellPath === undefined) {
        powershellPath = await resolvePowershell(subprocess)
      }
      const handle = subprocess.spawn({
        argv: [
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
        ],
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
    // installed Edge PWA. The first read consumes the pending session so a
    // normal refresh does not keep jumping.
    const webServer = ctx.get('webServer')
    if (webServer !== undefined) {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-notify/session',
        handler: (_req, res) => {
          const sessionId = pendingSession
          pendingSession = null
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ sessionId }))
        },
      }), 'dsh-notify-win: pending session route')
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
        notify('question', cfg.askTitle, cfg.askBody, exec?.agent?.session)
      }
      return next()
    })
  },
}
