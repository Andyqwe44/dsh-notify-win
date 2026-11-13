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

    // React is only needed by the settings page; the toast-answer half must
    // keep working on a deployment that does not expose it.
    let React = null
    try {
      React = require('react')
    } catch {
      React = null
    }

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

    /**
     * Click allow/reject in DSH's own approval panel. The toast answer is only
     * a remote control: the panel stays the authority, exactly like the
     * question card below.
     */
    const approvalLabels = {
      'allowed-once': ['允许一次', 'Allow once'],
      rejected: ['拒绝', 'Reject'],
    }

    const driveApprovalPanel = async (decision) => {
      const panel = document.querySelector('[data-approval-key]')
      if (panel === null) return { ok: false, reason: 'no-panel' }
      const labels = approvalLabels[decision]
      if (labels === undefined) return { ok: false, reason: 'decision' }
      const button = Array.from(panel.querySelectorAll('button')).find((candidate) =>
        !candidate.disabled && labels.includes((candidate.textContent || '').trim()))
      if (button === undefined) return { ok: false, reason: 'button' }
      button.click()
      // The panel closing is the official UI's acknowledgement; the host still
      // waits for the waterfall outcome before retiring the toast.
      const closed = await waitFor(() => document.querySelector('[data-approval-key]') === null, 5000)
      return { ok: closed !== null, reason: closed === null ? 'close' : '' }
    }

    /** Peek at the parked answer without consuming it. */
    const peekPendingAnswer = async () => {
      const res = await fetch('/dsh-notify/pending-answer?peek=1', { cache: 'no-store' })
      if (!res.ok) return null
      const data = await res.json()
      return data && data.available === true ? data : null
    }

    /**
     * Poll for a parked toast answer. The answer is applied by the DSH UI
     * itself, so first switch to the session that owns the question/approval:
     * its card or panel only renders while that session is active. Nothing is
     * consumed until the target card is on screen, so a slow session switch
     * retries instead of dropping the answer.
     */
    const watchToastAnswers = async (isActive) => {
      while (isActive()) {
        await sleep(500)
        let pending
        try {
          pending = await peekPendingAnswer()
        } catch {
          continue
        }
        if (pending === null || pending.id === null || pending.sessionId === undefined) continue
        openSession(pending.sessionId)
        const selector = pending.kind === 'approval' ? '[data-approval-key]' : '[data-question-key]'
        if (await waitFor(() => document.querySelector(selector), 3000) === null) continue
        let data
        try {
          const res = await fetch(
            `/dsh-notify/pending-answer?latest=1&id=${encodeURIComponent(pending.id)}`,
            { cache: 'no-store' },
          )
          if (!res.ok) continue
          data = await res.json()
        } catch {
          continue
        }
        if (!data || data.available !== true) continue
        const outcome = data.kind === 'approval'
          ? await driveApprovalPanel(data.decision)
          : await driveQuestionCard(data.answers)
        if (data.id) {
          fetch('/dsh-notify/answer-ack', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: data.id, ok: outcome.ok === true, reason: outcome.reason ?? '' }),
          }).catch(() => {})
        }
      }
    }

    // ---------------------------------------------------------------------
    // Settings page (Settings → 通知). The host exports a Config schema with
    // volatile eventPolicy/attention objects; this page derives from the
    // shared settings mirror and writes one field at a time through
    // `configForms`, which commits the value into the running plugin without
    // a reload.
    // ---------------------------------------------------------------------
    const SETTINGS_NS = 'dsh-notify-win.settings'
    const SETTINGS_ID = 'dsh-notify-win'
    const EVENT_ROWS = ['done', 'compact', 'receipt', 'question', 'approval', 'error', 'cancelled', 'file']
    const INTERACTIVE_ROWS = new Set(['question', 'approval'])

    // DSH's locale lookup indexes the dictionary by the literal key (there is
    // no dotted-path traversal), so every key stays flat.
    const zh = {
      nav: '通知',
      title: '通知行为',
      intro: '选择每个事件要触发哪些提醒，以及提醒何时出现。修改即时生效，无需重启。',
      event: '事件',
      toast: 'Toast',
      blink: '托盘闪烁',
      flash: '任务栏闪烁',
      rowDone: '任务执行完成',
      rowCompact: '上下文压缩完成',
      rowReceipt: '回答完成（回执）',
      rowQuestion: '需要你回答',
      rowApproval: '需要你批准',
      rowError: '异常停止',
      rowCancelled: '任务已取消',
      rowFile: '文件修改完成',
      timingLabel: '提醒时机',
      timingAfter: 'Toast 超时未处理后',
      timingImmediate: '事件发生时立即',
      timingHint: '选「立即」时 Toast 仍会弹出，闪烁/暖流同时开始；关掉 Toast 的事件总是立即生效。',
      trayLabel: '托盘图标',
      trayAlways: '常驻显示（推荐）',
      trayOnBlink: '只在闪烁时显示',
      trayHint: 'Windows 11 默认把新托盘图标收进 ^ 溢出区；插件会把这个图标固定到托盘（可在 Windows 的「任务栏设置」里改回）。',
      limitLabel: '最长闪烁',
      limitUnit: '分钟，0 = 直到你回来',
      statusLoading: '读取设置…',
      statusSaving: '保存中…',
      statusSaved: '已保存',
      statusFailed: '保存失败，请重试',
      statusUnavailable: '插件未加载，暂时无法配置。',
      statusReadOnly: '当前部署的设置为只读。',
    }
    const en = {
      nav: 'Notifications',
      title: 'Notification behavior',
      intro: 'Pick which reminders each event triggers, and when they appear. Changes apply immediately, no restart.',
      event: 'Event',
      toast: 'Toast',
      blink: 'Tray blink',
      flash: 'Taskbar flash',
      rowDone: 'Task finished',
      rowCompact: 'Context compacted',
      rowReceipt: 'Reply receipt',
      rowQuestion: 'Your answer needed',
      rowApproval: 'Your approval needed',
      rowError: 'Stopped with an error',
      rowCancelled: 'Task cancelled',
      rowFile: 'File changed',
      timingLabel: 'Reminder timing',
      timingAfter: 'After the toast times out',
      timingImmediate: 'Right when the event happens',
      timingHint: 'With “immediate” the toast still appears and the effects start together. Events without a toast always start immediately.',
      trayLabel: 'Tray icon',
      trayAlways: 'Always visible (recommended)',
      trayOnBlink: 'Only while blinking',
      trayHint: 'Windows 11 files new tray icons under ^ by default; the helper pins this icon into the visible tray (change it in Windows taskbar settings).',
      limitLabel: 'Blink for at most',
      limitUnit: 'minutes, 0 = until you come back',
      statusLoading: 'Reading settings…',
      statusSaving: 'Saving…',
      statusSaved: 'Saved',
      statusFailed: 'Save failed, please retry',
      statusUnavailable: 'This plugin is not loaded, so it cannot be configured.',
      statusReadOnly: 'This deployment stores settings read-only.',
    }

    const SETTINGS_CSS = [
      '.dnw{display:flex;flex-direction:column;gap:14px;max-width:760px;color:var(--dsw-alias-label-primary)}',
      '.dnw-title{margin:0;font-size:18px;font-weight:600}',
      '.dnw-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}',
      '.dnw-status{margin:0;min-height:18px;color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.dnw-table{border-collapse:collapse;width:100%;font-size:13px}',
      '.dnw-table thead th{font-weight:500;text-align:left;padding:6px 8px;color:var(--dsw-alias-label-secondary);border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dnw-table tbody th{font-weight:400;text-align:left;padding:6px 8px;color:var(--dsw-alias-label-primary);border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dnw-table td{padding:6px 8px;text-align:center;width:96px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dnw-check{width:16px;height:16px;cursor:pointer;accent-color:var(--dsw-alias-brand-primary)}',
      '.dnw-check:disabled{cursor:default}',
      '.dnw-field{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
      '.dnw-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);padding:0}',
      '.dnw-radio{display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer}',
      '.dnw-select,.dnw-number{height:28px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 8px;width:260px}',
      '.dnw-number{width:120px}',
      '.dnw-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
    ].join('\n')

    const SETTINGS_CSS_ID = 'dsh-notify-win/settings.css'
    if (typeof document !== 'undefined' &&
        document.querySelector(`style[data-plugin-css="${SETTINGS_CSS_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', SETTINGS_CSS_ID)
      tag.textContent = SETTINGS_CSS
      document.head.appendChild(tag)
    }

    const SettingsSection = (props) => {
      const { form, t } = props
      const snapshot = React.useSyncExternalStore(
        (listener) => form.subscribe(listener),
        () => form.getSnapshot(),
      )
      const [status, setStatus] = React.useState('idle')
      const [detail, setDetail] = React.useState('')
      const [minutes, setMinutes] = React.useState('')
      const value = snapshot.value ?? {}
      const policy = value.eventPolicy ?? {}
      const attention = value.attention ?? {}
      const ready = snapshot.status === 'ready'
      const writable = ready && snapshot.writable === true && typeof form.mutate === 'function'
      const currentMinutes = Number(attention.blinkMaxMinutes ?? 30)
      React.useEffect(() => {
        if (ready) setMinutes(String(currentMinutes))
      }, [ready, currentMinutes])
      const write = (path, next) => {
        if (!writable) return
        setStatus('saving')
        setDetail('')
        const ops = [{ op: 'set', path, value: next }]
        const retry = async () => {
          // A refused write is usually a revision race (another settings
          // change landed between render and click); the controller recovers
          // by reloading the mirror, so retry once with the fresh revision.
          await new Promise((resolve) => setTimeout(resolve, 250))
          return form.mutate(ops, form.getSnapshot().revision)
        }
        const report = async (ok) => {
          if (ok) {
            setStatus('saved')
            return
          }
          setStatus('failed')
          try {
            const remote = form.ctx?.remote?.settings
            if (remote === undefined) return
            const response = await remote.mutate(SETTINGS_ID, ops, form.getSnapshot().revision)
            if (response.ok !== true) {
              setDetail(String(response.error?.message ?? response.error?.code ?? ''))
            }
          } catch {}
        }
        Promise.resolve(form.mutate(ops, form.getSnapshot().revision))
          .then((ok) => (ok ? true : retry()))
          .then((ok) => report(ok))
          .catch(() => setStatus('failed'))
      }
      const statusText = !ready
        ? t(snapshot.status === 'unavailable' ? 'statusUnavailable' : 'statusLoading')
        : !writable
          ? t('statusReadOnly')
          : status === 'saving'
            ? t('statusSaving')
            : status === 'saved'
              ? t('statusSaved')
              : status === 'failed' ? t('statusFailed') : ' '

      const rowLabel = (rowKey) => t('row' + rowKey.charAt(0).toUpperCase() + rowKey.slice(1))
      const cell = (rowKey, effect) => React.createElement('input', {
        key: effect,
        type: 'checkbox',
        className: 'dnw-check',
        checked: INTERACTIVE_ROWS.has(rowKey) && effect === 'toast'
          ? true
          : policy[rowKey]?.[effect] === true,
        disabled: !writable || (INTERACTIVE_ROWS.has(rowKey) && effect === 'toast'),
        title: `${rowLabel(rowKey)} · ${t(effect)}`,
        'aria-label': `${rowLabel(rowKey)} · ${t(effect)}`,
        onChange: (event) => write(['eventPolicy', rowKey, effect], event.target.checked),
      })
      const body = EVENT_ROWS.map((rowKey) => React.createElement('tr', { key: rowKey }, [
        React.createElement('th', { key: 'name', scope: 'row' }, rowLabel(rowKey)),
        React.createElement('td', { key: 'toast' }, cell(rowKey, 'toast')),
        React.createElement('td', { key: 'blink' }, cell(rowKey, 'blink')),
        React.createElement('td', { key: 'flash' }, cell(rowKey, 'flash')),
      ]))
      const table = React.createElement('table', { className: 'dnw-table', key: 'table' }, [
        React.createElement('thead', { key: 'head' }, React.createElement('tr', null, [
          React.createElement('th', { key: 'event', scope: 'col' }, t('event')),
          React.createElement('th', { key: 'toast', scope: 'col' }, t('toast')),
          React.createElement('th', { key: 'blink', scope: 'col' }, t('blink')),
          React.createElement('th', { key: 'flash', scope: 'col' }, t('flash')),
        ])),
        React.createElement('tbody', { key: 'body' }, body),
      ])

      const timing = React.createElement('fieldset', { className: 'dnw-field', key: 'timing' }, [
        React.createElement('legend', { key: 'legend', className: 'dnw-label' }, t('timingLabel')),
        React.createElement('label', { key: 'after', className: 'dnw-radio' }, [
          React.createElement('input', {
            key: 'input',
            type: 'radio',
            name: 'dnw-timing',
            checked: (attention.timing ?? 'after-timeout') !== 'immediate',
            disabled: !writable,
            onChange: () => write(['attention', 'timing'], 'after-timeout'),
          }),
          React.createElement('span', { key: 'text' }, t('timingAfter')),
        ]),
        React.createElement('label', { key: 'immediate', className: 'dnw-radio' }, [
          React.createElement('input', {
            key: 'input',
            type: 'radio',
            name: 'dnw-timing',
            checked: attention.timing === 'immediate',
            disabled: !writable,
            onChange: () => write(['attention', 'timing'], 'immediate'),
          }),
          React.createElement('span', { key: 'text' }, t('timingImmediate')),
        ]),
        React.createElement('p', { key: 'hint', className: 'dnw-hint' }, t('timingHint')),
      ])

      const tray = React.createElement('div', { className: 'dnw-field', key: 'tray' }, [
        React.createElement('label', { key: 'label', className: 'dnw-label' }, t('trayLabel')),
        React.createElement('select', {
          key: 'select',
          className: 'dnw-select',
          value: attention.trayIcon ?? 'always',
          disabled: !writable,
          onChange: (event) => write(['attention', 'trayIcon'], event.target.value),
        }, [
          React.createElement('option', { key: 'always', value: 'always' }, t('trayAlways')),
          React.createElement('option', { key: 'on-blink', value: 'on-blink' }, t('trayOnBlink')),
        ]),
        React.createElement('p', { key: 'hint', className: 'dnw-hint' }, t('trayHint')),
      ])

      const limit = React.createElement('div', { className: 'dnw-field', key: 'limit' }, [
        React.createElement('label', { key: 'label', className: 'dnw-label' },
          `${t('limitLabel')}（${t('limitUnit')}）`),
        React.createElement('input', {
          key: 'input',
          type: 'number',
          className: 'dnw-number',
          min: 0,
          max: 1440,
          value: minutes,
          disabled: !writable,
          onChange: (event) => setMinutes(event.target.value),
          onBlur: () => {
            const next = Math.max(0, Math.min(1440, Math.round(Number(minutes) || 0)))
            if (next !== currentMinutes) write(['attention', 'blinkMaxMinutes'], next)
            else setMinutes(String(currentMinutes))
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          },
        }),
      ])

      return React.createElement('section', { className: 'dnw' }, [
        React.createElement('h2', { key: 'title', className: 'dnw-title' }, t('title')),
        React.createElement('p', { key: 'intro', className: 'dnw-intro' }, t('intro')),
        React.createElement('p', { key: 'status', className: 'dnw-status', 'aria-live': 'polite' }, statusText),
        detail.length === 0
          ? null
          : React.createElement('p', { key: 'detail', className: 'dnw-hint' }, detail),
        table,
        timing,
        tray,
        limit,
      ])
    }

    /**
     * Register the settings section. The services are injected lazily so a
     * deployment without the settings UI keeps the toast-answer half working.
     */
    const mountSettings = (ctx) => {
      if (React === null || typeof ctx.inject !== 'function') return
      ctx.inject(['slots', 'locale', 'configForms'], (scope) => {
        const t = scope.locale.bind(SETTINGS_NS)
        scope.effect(() => scope.locale.register(SETTINGS_NS, { zh, en }),
          'dsh-notify-win: settings dictionaries')
        const form = scope.configForms.get(SETTINGS_ID)
        const face = () => ({ form, t })
        scope.effect(() => scope.configForms.whileServed([SETTINGS_ID], () =>
          scope.slots.inject('settings.section', () => scope.slots.register({
            name: 'settings.section',
            id: SETTINGS_ID,
            order: 22,
            label: () => t('nav'),
            locale: SETTINGS_NS,
            inject: face,
          }, SettingsSection))), 'dsh-notify-win: settings page')
      })
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

        // Settings → 通知. Lazy: a deployment without the settings services
        // simply never mounts the page.
        mountSettings(ctx)
      } catch (error) {
        console.error('[dsh-notify-win] client apply failed:', error)
      }
    }

    return module.exports
  },
})
