/**
 * dsh-notify-win client bundle (browser half).
 *
 * When a toast is clicked:
 * - In a normal browser tab, the launch URL may carry `?dsh-session=<id>`.
 * - In the installed Edge PWA, the toast focuses the app through the
 *   `dsh-notify://` protocol, and the session id / toast answer are read from
 *   the host HTTP endpoint `/dsh-notify/session`.
 *
 * The PWA is usually already open, so besides checking on load we also check
 * every time the window receives focus (the toast click focuses the window).
 */
window.__ModuleLoader__.load({
  id: 'dsh-notify-win',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    exports.name = 'dsh-notify-win-client'
    exports.inject = ['sessions']

    // The plugin may be hot-reloaded; old timers from a previous apply must
    // keep using the latest active context instead of a disposed one.
    let activeCtx = null

    const openSession = (sessionId) => {
      const ctx = activeCtx
      if (!sessionId) return false
      if (ctx && typeof ctx.sessions?.open === 'function') {
        ctx.sessions.open(sessionId)
        return true
      }
      return false
    }

    const submitAnswer = async (answer) => {
      const ctx = activeCtx
      if (!answer || !answer.sessionId) return
      if (answer.cancel) {
        try {
          const binding = ctx.sessions.binding(answer.sessionId)
          const pendingRaw = binding?.session?.pending
          const pending = pendingRaw instanceof Map
            ? Array.from(pendingRaw.values())
            : (Array.isArray(pendingRaw) ? pendingRaw : [])
          const wait = pending.find((item) => item.kind === 'question')
          if (!wait || typeof wait.respond !== 'function') return
          await wait.respond({
            ok: false,
            error: {
              code: 'cancelled',
              message: '用户在 toast 中取消了问题',
              details: {},
            },
          })
        } catch (error) {
          console.error('[dsh-notify-win] cancel toast question failed:', error)
        }
        return
      }
      let answers = Array.isArray(answer.answers) ? answer.answers : null
      // Legacy single-answer fallback: convert { questionId, option, custom }.
      if (!answers && answer.questionId) {
        const selected = answer.option ? [answer.option] : []
        const custom = answer.custom || undefined
        if (selected.length === 0 && (!custom || custom === '{custom}')) return
        answers = [{ id: answer.questionId, selected, custom }]
      }
      if (!answers || answers.length === 0) return
      // Normalize to the exact DSH answer-item shape: `custom` must be a string
      // or absent, never null; `selected` must always be an array.
      answers = answers.map((item) => ({
        id: item.id,
        selected: Array.isArray(item.selected) ? item.selected : [],
        ...(item.custom ? { custom: item.custom } : {}),
      }))
      try {
        const binding = ctx.sessions.binding(answer.sessionId)
        // The live Session stores pending waits in a Map keyed by wait.key; the
        // snapshot form exposes them as an array. Normalize both to an array.
        const pendingRaw = binding?.session?.pending
        const pending = pendingRaw instanceof Map
          ? Array.from(pendingRaw.values())
          : (Array.isArray(pendingRaw) ? pendingRaw : [])
        const wait = pending.find((item) => item.kind === 'question')
        if (!wait || typeof wait.respond !== 'function') return
        // The runtime's PendingWait.respond expects a full client-response
        // result shell (`ok`/`value`), not the bare answer object. Mirror the
        // official user-questions provider shape so the host accepts it.
        await wait.respond({
          ok: true,
          value: {
            sessionId: answer.sessionId,
            answer: { answers },
          },
        })
      } catch (error) {
        console.error('[dsh-notify-win] submit toast answer failed:', error)
      }
    }

    const checkPendingSession = () => {
      const ctx = activeCtx
      fetch('/dsh-notify/session', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then(async (data) => {
          if (!data) return
          if (data.answer) await submitAnswer(data.answer)
          if (data.sessionId) openSession(data.sessionId)
        })
        .catch((error) => {
          console.error('[dsh-notify-win] read pending session failed:', error)
        })
    }

    // Poll for a toast answer independently of window focus. The DSH window is
    // often already foreground when a toast action is clicked, so the browser
    // focus event may never fire; this interval guarantees the answer is still
    // delivered a moment later.
    const checkPendingAnswer = () => {
      const ctx = activeCtx
      fetch('/dsh-notify/pending-answer?v=2', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then(async (data) => {
          if (!data || !data.answer) return
          await submitAnswer(data.answer)
        })
        .catch((error) => {
          console.error('[dsh-notify-win] read pending answer failed:', error)
        })
    }

    exports.apply = (ctx) => {
      try {
        activeCtx = ctx
        const params = new URLSearchParams(window.location.search)
        const querySession = params.get('dsh-session')

        if (querySession) {
          openSession(querySession)
          const url = new URL(window.location.href)
          url.searchParams.delete('dsh-session')
          window.history.replaceState({}, '', url.pathname + url.search + url.hash)
        } else {
          // Installed PWA path: no query parameter, ask the host which
          // session / answer is waiting. Also re-check when the window is
          // focused by a toast click (the page itself is not reloaded), and
          // poll for answers in case the window was already focused so no
          // focus event fires.
          checkPendingSession()
          const onFocus = () => checkPendingSession()
          window.addEventListener('focus', onFocus)
          const pollTimer = setInterval(() => checkPendingAnswer(), 1500)
          ctx.effect(() => () => {
            window.removeEventListener('focus', onFocus)
            clearInterval(pollTimer)
          }, 'dsh-notify-win: toast focus/poll cleanup')
        }
      } catch (error) {
        console.error('[dsh-notify-win] open session from toast failed:', error)
      }
    }

    return module.exports
  },
})
