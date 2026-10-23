/**
 * dsh-notify-win client bundle (browser half).
 *
 * Two jobs, both inside the DSH page:
 *
 * 1. Toast click -> focus the right session. The launch URL may carry
 *    `?dsh-session=<id>`; the installed PWA talks through `dsh-notify://` and
 *    reads `/dsh-notify/session`.
 *
 * 2. Answer a question from the toast. Only the official question card can
 *    settle the `user-questions/request` waterfall, and a third-party plugin is
 *    registered after it, so joining that waterfall would never win. Instead the
 *    host parks the toast choice (`/dsh-notify/pending-answer?latest=1`) and this
 *    half clicks the same controls a human would: the matching option, then the
 *    card's own submit button.
 */
window.__ModuleLoader__.load({
  id: 'dsh-notify-win',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    exports.name = 'dsh-notify-win-client'
    exports.inject = ['sessions']

    // A hot reload replaces apply(); async loops from an older fiber must stop
    // instead of driving the card twice.
    let activeCtx = null

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    const openSession = (sessionId) => {
      const ctx = activeCtx
      if (!sessionId) return false
      if (ctx && typeof ctx.sessions?.open === 'function') {
        ctx.sessions.open(sessionId)
        return true
      }
      return false
    }

    const checkPendingSession = () => {
      fetch('/dsh-notify/session', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data && data.sessionId) openSession(data.sessionId)
        })
        .catch(() => {})
    }

    /**
     * Apply a toast answer to the official question card: select the chosen
     * option, then press the card's submit button. Falls back silently (the
     * user can always answer in the card itself).
     */
    const driveQuestionCard = async (answers) => {
      const frame = document.querySelector('[data-question-key]')
      if (!frame) return false
      const buttons = () => Array.from(frame.querySelectorAll('button'))
      for (const item of answers) {
        const labels = Array.isArray(item.selected) ? item.selected : []
        for (const label of labels) {
          const option = buttons().find((b) => (b.getAttribute('aria-label') || '') === label)
          if (option === undefined) return false
          if (option.getAttribute('aria-pressed') !== 'true') option.click()
          await sleep(80)
        }
      }
      // The primary button is the card's submit (the last question's "提交").
      for (let attempt = 0; attempt < 20; attempt++) {
        const submit = buttons().find((b) => /primary/i.test(String(b.className)))
        if (submit !== undefined && !submit.disabled) {
          submit.click()
          return true
        }
        await sleep(100)
      }
      return false
    }

    /** Poll for a parked toast answer while a question card is on screen. */
    const watchToastAnswers = async (isActive) => {
      while (isActive()) {
        await sleep(500)
        if (!document.querySelector('[data-question-key]')) continue
        try {
          const res = await fetch('/dsh-notify/pending-answer?latest=1', { cache: 'no-store' })
          if (!res.ok) continue
          const data = await res.json()
          if (!data || !Array.isArray(data.answers) || data.answers.length === 0) continue
          await driveQuestionCard(data.answers)
        } catch {}
      }
    }

    exports.apply = (ctx) => {
      try {
        activeCtx = ctx

        ctx.effect(() => {
          let running = true
          void watchToastAnswers(() => running)
          return () => { running = false }
        }, 'dsh-notify-win: toast answer -> question card')

        const params = new URLSearchParams(window.location.search)
        const querySession = params.get('dsh-session')
        if (querySession) {
          openSession(querySession)
          const url = new URL(window.location.href)
          url.searchParams.delete('dsh-session')
          window.history.replaceState({}, '', url.pathname + url.search + url.hash)
        } else {
          // Installed PWA path: no query parameter, ask the host which session
          // a toast click should open, on load and again whenever the window
          // regains focus (a toast click focuses it without a reload).
          checkPendingSession()
          const onFocus = () => checkPendingSession()
          window.addEventListener('focus', onFocus)
          ctx.effect(() => () => {
            window.removeEventListener('focus', onFocus)
          }, 'dsh-notify-win: toast focus cleanup')
        }
      } catch (error) {
        console.error('[dsh-notify-win] client apply failed:', error)
      }
    }

    return module.exports
  },
})
