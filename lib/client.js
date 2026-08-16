/**
 * dsh-notify-win client bundle (browser half).
 *
 * When a toast is clicked:
 * - In a normal browser tab, the launch URL may carry `?dsh-session=<id>`.
 * - In the installed Edge PWA, the toast focuses the app through the
 *   `dsh-notify://` protocol, and the session id is read from the host HTTP
 *   endpoint `/dsh-notify/session`.
 *
 * Either path calls `ctx.sessions.open(id)` to switch to the session that
 * produced the notification.
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

    exports.apply = (ctx) => {
      try {
        const params = new URLSearchParams(window.location.search)
        const querySession = params.get('dsh-session')

        if (querySession) {
          openSession(ctx, querySession)
          const url = new URL(window.location.href)
          url.searchParams.delete('dsh-session')
          window.history.replaceState({}, '', url.pathname + url.search + url.hash)
          return
        }

        // Installed PWA path: no query parameter, so ask the host which
        // session is waiting (the first read consumes it).
        fetch('/dsh-notify/session', { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (data && data.sessionId) openSession(ctx, data.sessionId)
          })
          .catch((error) => {
            console.error('[dsh-notify-win] read pending session failed:', error)
          })
      } catch (error) {
        console.error('[dsh-notify-win] open session from toast failed:', error)
      }
    }

    return module.exports
  },
})
