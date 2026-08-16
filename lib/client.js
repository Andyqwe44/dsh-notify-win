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

    const openSession = (ctx, sessionId) => {
      if (!sessionId) return false
      if (ctx && typeof ctx.sessions?.open === 'function') {
        ctx.sessions.open(sessionId)
        return true
      }
      return false
    }

    const submitAnswer = async (ctx, answer) => {
      if (!answer || !answer.sessionId || !answer.questionId) return
      try {
        const binding = ctx.sessions.binding(answer.sessionId)
        const pending = binding?.session?.pending ?? []
        const wait = pending.find((item) => item.kind === 'question')
        if (!wait || typeof wait.respond !== 'function') return
        const selected = answer.option ? [answer.option] : []
        const custom = answer.custom || undefined
        await wait.respond({
          answers: [{ id: answer.questionId, selected, custom }],
        })
      } catch (error) {
        console.error('[dsh-notify-win] submit toast answer failed:', error)
      }
    }

    const checkPendingSession = (ctx) => {
      fetch('/dsh-notify/session', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then(async (data) => {
          if (!data) return
          if (data.answer) await submitAnswer(ctx, data.answer)
          if (data.sessionId) openSession(ctx, data.sessionId)
        })
        .catch((error) => {
          console.error('[dsh-notify-win] read pending session failed:', error)
        })
    }

    exports.apply = (ctx) => {
      try {
        const params = new URLSearchParams(window.location.search)
        const querySession = params.get('dsh-session')

        if (querySession) {
          openSession(ctx, querySession)
          const url = new URL(window.location.href)
          url.searchParams.delete('dsh-session')
          window.history.replaceState({}, '', url.pathname + url.search + url.hash)
        } else {
          // Installed PWA path: no query parameter, ask the host which
          // session / answer is waiting. Also re-check when the window is
          // focused by a toast click (the page itself is not reloaded).
          checkPendingSession(ctx)
          window.addEventListener('focus', () => checkPendingSession(ctx))
        }
      } catch (error) {
        console.error('[dsh-notify-win] open session from toast failed:', error)
      }
    }

    return module.exports
  },
})
