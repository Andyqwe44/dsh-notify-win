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
     * options / type custom text for each question, advance through the card's
     * pages, then press the card's own submit button. Falls back silently (the
     * user can always answer in the card itself) but reports the failure to the
     * host so the toast can stop pretending it delivered anything.
     */
    const readProgress = (frame) => {
      const footer = frame.querySelector('footer')
      if (footer === null) return null
      const progress = footer.querySelector('[class*="progress"]')
      if (progress === null) return null
      const match = /(\d+)\s*\/\s*(\d+)/.exec(progress.textContent || '')
      if (match === null) return null
      return { index: Number(match[1]) - 1, total: Number(match[2]) }
    }

    /** React tracks the DOM value itself, so set it through the native setter. */
    const setNativeValue = (element, value) => {
      const proto = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      if (setter === undefined) element.value = value
      else setter.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }

    /**
     * Option buttons are the only buttons carrying an aria-checked state. The
     * card strips a trailing recommendation marker from the displayed label, so
     * match both the raw label and its stripped form.
     */
    const stripRecommended = (label) =>
      label.replace(/\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i, '')

    const optionButton = (frame, label) => {
      const wanted = [label, stripRecommended(label)]
      return Array.from(frame.querySelectorAll('button[aria-checked]'))
        .find((button) => wanted.includes(button.getAttribute('aria-label') || ''))
    }

    const primaryButton = (frame) =>
      Array.from(frame.querySelectorAll('button'))
        .find((button) => /primary/i.test(String(button.className)) && !button.disabled)

    const nextButton = (frame) => {
      const footer = frame.querySelector('footer')
      const pager = footer?.querySelector('[class*="pager"]')
      if (pager === null || pager === undefined) return undefined
      return Array.from(pager.querySelectorAll('button'))[1]
    }

    const waitFor = async (check, timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const value = check()
        if (value) return value
        await sleep(80)
      }
      return null
    }

    const driveQuestionCard = async (answers) => {
      const frame = document.querySelector('[data-question-key]')
      if (frame === null) return { ok: false, reason: 'no-card' }

      for (let index = 0; index < answers.length; index++) {
        const item = answers[index]
        const onQuestion = await waitFor(() => {
          const progress = readProgress(frame)
          return progress === null || progress.index === index
        }, 4000)
        if (onQuestion === null) return { ok: false, reason: 'index' }

        for (const label of Array.isArray(item.selected) ? item.selected : []) {
          const option = optionButton(frame, label)
          if (option === undefined) return { ok: false, reason: 'option' }
          if (option.getAttribute('aria-checked') !== 'true') option.click()
          await sleep(90)
        }

        const custom = typeof item.custom === 'string' ? item.custom.trim() : ''
        if (custom.length > 0) {
          const field = frame.querySelector('textarea')
          if (field === null) return { ok: false, reason: 'custom' }
          field.focus?.()
          setNativeValue(field, custom)
          await sleep(120)
        }

        if (index < answers.length - 1) {
          const advanced = await waitFor(() => {
            const progress = readProgress(frame)
            return progress !== null && progress.index === index + 1
          }, 1500)
          if (advanced === null) {
            const next = nextButton(frame)
            if (next === undefined) return { ok: false, reason: 'advance' }
            next.click()
            const clicked = await waitFor(() => {
              const progress = readProgress(frame)
              return progress !== null && progress.index === index + 1
            }, 3000)
            if (clicked === null) return { ok: false, reason: 'advance' }
          }
        }
      }

      const submit = await waitFor(() => primaryButton(frame), 5000)
      if (submit === null) return { ok: false, reason: 'submit' }
      submit.click()
      // The card closing is the official UI's acknowledgement. The host still
      // waits for the tool result before telling the user it was delivered.
      const closed = await waitFor(() => document.querySelector('[data-question-key]') === null, 5000)
      return { ok: true, closed: closed !== null }
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
          const outcome = await driveQuestionCard(data.answers)
          if (data.id) {
            fetch('/dsh-notify/answer-ack', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: data.id, ok: outcome.ok === true, reason: outcome.reason ?? '' }),
            }).catch(() => {})
          }
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
