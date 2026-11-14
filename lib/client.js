/**
 * dsh-notify-win client bundle (browser half).
 *
 * Two jobs, both inside the DSH page:
 *
 * 1. Toast click -> focus the right session. The launch URL may carry
 *    `?dsh-session=<id>`; the installed PWA talks through `dsh-notify://` and
 *    reads `/dsh-notify/v2/session`.
 *
 * 2. Answer a question from the toast. DSH's own question card stays the only
 *    answerer, so the host parks the toast choice
 *    (`/dsh-notify/v2/pending-answer?latest=1`) and this half clicks the same
 *    controls a human would: the matching option, then the card's own submit
 *    button. When no page is visible the host wakes the window for that click
 *    (Chromium throttles a hidden window's timers), and this half reports
 *    whether it can act at all (`/dsh-notify/v2/visibility`) and applies the
 *    parked answer immediately on the resulting visibility event.
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

    /**
     * Yield to the task queue WITHOUT a timer. Chromium throttles setTimeout in
     * a hidden window (1/s, then 1/min), but a MessagePort message is a plain
     * task and still runs: the toast answer has to be applied while DSH is
     * minimized, and every wait below goes through this helper.
     */
    const nextTask = () => new Promise((resolve) => {
      try {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => {
          channel.port1.close()
          resolve()
        }
        channel.port2.postMessage(0)
      } catch {
        setTimeout(resolve, 0)
      }
    })

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
      fetch('/dsh-notify/v2/session', { cache: 'no-store' })
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
        await nextTask()
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
          await nextTask()
        }

        const custom = typeof item.custom === 'string' ? item.custom.trim() : ''
        if (custom.length > 0) {
          const field = frame.querySelector('textarea')
          if (field === null) return { ok: false, reason: 'custom' }
          field.focus?.()
          setNativeValue(field, custom)
          await nextTask()
          await nextTask()
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

    /**
     * Wait for the host to park an answer. This is a HANGING request, not a
     * timer: Chromium throttles timers in a hidden window (1/s, then 1/min),
     * while a response to an open request is delivered like any other event.
     * The host answers the moment an answer is parked, so the click happens
     * immediately and the window never has to be brought up.
     * @returns the parked answer, or null when the host timed the request out.
     */
    const waitAnswer = async (since) => {
      const res = await fetch(`/dsh-notify/v2/wait-answer?since=${encodeURIComponent(since ?? '')}`, {
        cache: 'no-store',
      })
      if (!res.ok) return null
      const data = await res.json()
      return data && data.answer ? data.answer : null
    }

    /**
     * Apply parked toast answers. The answer is applied by the DSH UI itself,
     * so first switch to the session that owns the question/approval: its card
     * or panel only renders while that session is active. Nothing is consumed
     * until the target card is on screen, so a slow session switch retries
     * instead of dropping the answer.
     */
    const watchToastAnswers = async (isActive) => {
      let since = ''
      while (isActive()) {
        let pending = null
        try {
          pending = await waitAnswer(since)
        } catch {
          await nextTask()
          continue
        }
        if (!isActive()) return
        if (pending === null) continue
        since = String(pending.id ?? '')
        openSession(pending.sessionId)
        const selector = pending.kind === 'approval' ? '[data-approval-key]' : '[data-question-key]'
        if (await waitFor(() => document.querySelector(selector), 3000) === null) continue
        let data
        try {
          const res = await fetch(
            `/dsh-notify/v2/pending-answer?latest=1&id=${encodeURIComponent(pending.id)}`,
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
          fetch('/dsh-notify/v2/answer-ack', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: data.id, ok: outcome.ok === true, reason: outcome.reason ?? '' }),
          }).catch(() => {})
        }
      }
    }

    // ---------------------------------------------------------------------
    // The plugin's own page (插件 → dsh-notify-win), not Settings. The host
    // exports a Config schema with volatile eventPolicy/attention objects;
    // this section derives from the shared settings mirror and writes one
    // field at a time through `configForms`, which commits the value into the
    // running plugin without a reload.
    // ---------------------------------------------------------------------
    const SETTINGS_NS = 'dsh-notify-win.settings'
    const SETTINGS_ID = 'dsh-notify-win'
    // The section's DOM id, so the page head can jump to it (the README above
    // it can be long).
    const SETTINGS_ANCHOR = 'dsh-notify-win-settings'
    const EVENT_ROWS = ['done', 'compact', 'receipt', 'question', 'approval', 'error', 'cancelled', 'file']
    const INTERACTIVE_ROWS = new Set(['question', 'approval'])

    // Host primitives are optional: a deployment that does not expose them
    // keeps the native controls further down, and the page still works.
    let Button = null
    let Switch = null
    let SegmentedControl = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      if (typeof primitives?.Button === 'function') Button = primitives.Button
      if (typeof primitives?.Switch === 'function') Switch = primitives.Switch
      if (typeof primitives?.SegmentedControl === 'function') SegmentedControl = primitives.SegmentedControl
    } catch {
      // An older host ships no primitives; the fallbacks below are native.
    }

    // DSH's locale lookup indexes the dictionary by the literal key (there is
    // no dotted-path traversal), so every key stays flat.
    const zh = {
      title: '通知行为',
      intro: '选择每个事件要触发哪些提醒，以及提醒何时出现。修改即时生效，无需重启。',
      jumpToSettings: '通知设置',
      groupEffects: '提醒效果',
      effectsHint: 'Toast 是系统通知；红点画在 DSH 通知区域图标上；闪烁是任务栏暖流。',
      event: '事件',
      toast: 'Toast',
      blink: '红点',
      flash: '闪烁',
      rowDone: '任务执行完成',
      rowCompact: '上下文压缩完成',
      rowReceipt: '回答完成（回执）',
      rowQuestion: '需要你回答',
      rowApproval: '需要你批准',
      rowError: '异常停止',
      rowCancelled: '任务已取消',
      rowFile: '文件修改完成',
      groupTiming: '提醒时机',
      timingAfter: 'Toast 超时后',
      timingImmediate: '立即',
      timingHint: '选「立即」时 Toast 仍会弹出，红点/闪烁与它同时开始；关掉 Toast 的事件总是立即生效。',
      groupBadge: '托盘红点',
      limitLabel: '最长闪烁',
      limitUnit: '分钟',
      blinkHint: '红点画在 DSH 自己的通知区域图标上（像即时通讯软件的未读角标）：不改动图标，也不新增托盘图标。图标被收进 ^ 溢出区、找不到位置时，自动改画在任务栏按钮上。0 表示一直闪到你回来。',
      statusLoading: '读取设置…',
      statusSaving: '保存中…',
      statusSaved: '已保存',
      statusFailed: '保存失败，请重试',
      statusUnavailable: '插件未加载，暂时无法配置。',
      statusReadOnly: '当前部署的设置为只读。',
    }
    const en = {
      title: 'Notification behavior',
      intro: 'Pick which reminders each event triggers and when they appear. Changes apply immediately, no restart.',
      jumpToSettings: 'Notification settings',
      groupEffects: 'Effects',
      effectsHint: 'Toast is the system notification; the badge is a dot on DSH’s own notification-area icon; flash is the taskbar warm pulse.',
      event: 'Event',
      toast: 'Toast',
      blink: 'Badge',
      flash: 'Flash',
      rowDone: 'Task finished',
      rowCompact: 'Context compacted',
      rowReceipt: 'Reply receipt',
      rowQuestion: 'Your answer needed',
      rowApproval: 'Your approval needed',
      rowError: 'Stopped with an error',
      rowCancelled: 'Task cancelled',
      rowFile: 'File changed',
      groupTiming: 'Timing',
      timingAfter: 'After the toast expires',
      timingImmediate: 'Immediately',
      timingHint: '“Immediately” still shows the toast and starts the effects with it; events without a toast always start immediately.',
      groupBadge: 'Tray badge',
      limitLabel: 'Blink for at most',
      limitUnit: 'min',
      blinkHint: 'The dot is painted over DSH’s own notification-area icon (like a chat app’s unread dot): the icon itself is untouched and no tray icon is added. When the icon is filed under ^ and cannot be located, the dot moves to the taskbar button instead. 0 keeps it blinking until you come back.',
      statusLoading: 'Reading settings…',
      statusSaving: 'Saving…',
      statusSaved: 'Saved',
      statusFailed: 'Save failed, please retry',
      statusUnavailable: 'This plugin is not loaded, so it cannot be configured.',
      statusReadOnly: 'This deployment stores settings read-only.',
    }

    // The plugin page's own look: a title row, then one group per decision with
    // a hairline above it. Everything is sized for the page's 13px body text and
    // takes its colours from the theme aliases, so light and dark mode follow
    // the app without a second stylesheet.
    const SETTINGS_CSS = [
      '.dnw{display:flex;flex-direction:column;gap:14px;max-width:720px;scroll-margin-top:24px;color:var(--dsw-alias-label-primary)}',
      '.dnw-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
      '.dnw-title{margin:0;font-size:15px;line-height:22px;font-weight:600}',
      '.dnw-status{margin:0;min-height:18px;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}',
      '.dnw-intro{margin:-6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dnw-group{display:flex;flex-direction:column;gap:8px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dnw-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:24px}',
      '.dnw-grouptitle{margin:0;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.dnw-table{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}',
      // Fixed layout takes its column widths from the head row: the effect
      // columns are pinned and the event column absorbs what is left, so the
      // three switches stay under their own headers instead of drifting.
      '.dnw-table thead th{width:112px;font-size:12px;font-weight:400;text-align:center;padding:0 0 6px;color:var(--dsw-alias-label-tertiary)}',
      '.dnw-table thead th:first-child{width:auto}',
      '.dnw-table thead th:first-child,.dnw-table tbody th{text-align:left}',
      '.dnw-table tbody th{font-weight:400;padding:5px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dnw-table tbody td{width:112px;text-align:center;padding:5px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dnw-check{width:16px;height:16px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary)}',
      '.dnw-check:disabled,.dnw-number:disabled{cursor:default}',
      '.dnw-numberwrap{display:inline-flex;align-items:center;gap:8px}',
      '.dnw-number{height:26px;box-sizing:border-box;width:72px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:center;padding:0 6px}',
      '.dnw-unit{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.dnw-radios{display:flex;gap:12px}',
      '.dnw-radio{display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer}',
      '.dnw-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dnw-jump{height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}',
      '.dnw-jump:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-1))}',
    ].join('\n')

    const SETTINGS_CSS_ID = 'dsh-notify-win/settings.css'
    if (typeof document !== 'undefined') {
      // Hot reload re-runs this module without a page load: refresh the sheet a
      // previous instance left behind instead of stacking a second copy.
      const previous = document.querySelector(`style[data-plugin-css="${SETTINGS_CSS_ID}"]`)
      const tag = previous ?? document.createElement('style')
      tag.setAttribute('data-plugin-css', SETTINGS_CSS_ID)
      tag.textContent = SETTINGS_CSS
      if (previous === null) document.head.appendChild(tag)
    }

    const SettingsSection = (props) => {
      const { form, t, view } = props
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

      /** Commit one field at once: this page has no save button, like the plugin's rows. */
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

      const rowLabel = (rowKey) => t('row' + rowKey.charAt(0).toUpperCase() + rowKey.slice(1))
      const toggle = (rowKey, effect) => {
        // The interactive rows ARE a UI: their toast can never be turned off.
        const forced = INTERACTIVE_ROWS.has(rowKey) && effect === 'toast'
        const checked = forced ? true : policy[rowKey]?.[effect] === true
        const label = `${rowLabel(rowKey)} · ${t(effect)}`
        const onChange = (next) => write(['eventPolicy', rowKey, effect], next)
        return Switch !== null
          ? React.createElement(Switch, {
            key: effect, checked, disabled: !writable || forced, label, title: label, onChange,
          })
          : React.createElement('input', {
            key: effect,
            type: 'checkbox',
            className: 'dnw-check',
            checked,
            disabled: !writable || forced,
            title: label,
            'aria-label': label,
            onChange: (event) => onChange(event.target.checked),
          })
      }
      const table = React.createElement('table', { className: 'dnw-table', key: 'table' }, [
        React.createElement('thead', { key: 'head' }, React.createElement('tr', null, [
          React.createElement('th', { key: 'event', scope: 'col' }, t('event')),
          React.createElement('th', { key: 'toast', scope: 'col' }, t('toast')),
          React.createElement('th', { key: 'blink', scope: 'col' }, t('blink')),
          React.createElement('th', { key: 'flash', scope: 'col' }, t('flash')),
        ])),
        React.createElement('tbody', { key: 'body' }, EVENT_ROWS.map((rowKey) =>
          React.createElement('tr', { key: rowKey }, [
            React.createElement('th', { key: 'name', scope: 'row' }, rowLabel(rowKey)),
            React.createElement('td', { key: 'toast' }, toggle(rowKey, 'toast')),
            React.createElement('td', { key: 'blink' }, toggle(rowKey, 'blink')),
            React.createElement('td', { key: 'flash' }, toggle(rowKey, 'flash')),
          ]))),
      ])

      const timing = (attention.timing ?? 'after-timeout') === 'immediate' ? 'immediate' : 'after-timeout'
      const timingOptions = [
        { value: 'after-timeout', label: t('timingAfter') },
        { value: 'immediate', label: t('timingImmediate') },
      ]
      const timingControl = SegmentedControl !== null
        ? React.createElement(SegmentedControl, {
          key: 'segmented',
          id: 'dnw-timing',
          value: timing,
          options: timingOptions,
          label: t('groupTiming'),
          disabled: !writable,
          onChange: (next) => write(['attention', 'timing'], next),
        })
        : React.createElement('div', { key: 'radios', className: 'dnw-radios' }, timingOptions.map((option) =>
          React.createElement('label', { key: option.value, className: 'dnw-radio' }, [
            React.createElement('input', {
              key: 'input',
              type: 'radio',
              name: 'dnw-timing',
              checked: timing === option.value,
              disabled: !writable,
              onChange: () => write(['attention', 'timing'], option.value),
            }),
            React.createElement('span', { key: 'text' }, option.label),
          ])))

      const limit = React.createElement('div', { className: 'dnw-numberwrap', key: 'limit' }, [
        React.createElement('span', { key: 'label', className: 'dnw-hint' }, t('limitLabel')),
        React.createElement('input', {
          key: 'input',
          type: 'number',
          className: 'dnw-number',
          min: 0,
          max: 1440,
          value: minutes,
          disabled: !writable,
          'aria-label': t('limitLabel'),
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
        React.createElement('span', { key: 'unit', className: 'dnw-unit' }, t('limitUnit')),
      ])

      const statusText = !ready
        ? t(snapshot.status === 'unavailable' ? 'statusUnavailable' : 'statusLoading')
        : !writable
          ? t('statusReadOnly')
          : status === 'saving'
            ? t('statusSaving')
            : status === 'saved'
              ? t('statusSaved')
              : status === 'failed' ? t('statusFailed') : ' '

      // The bundle page asks for `page` only; a `summary` would be the card's
      // one-liner, which this plugin contributes nothing to.
      if (view !== 'page') return null

      /** One decision: a heading row that may carry its control, then its copy. */
      const group = (key, title, trailing, children) => React.createElement('div', { key, className: 'dnw-group' }, [
        React.createElement('div', { key: 'head', className: 'dnw-row' }, [
          React.createElement('h4', { key: 'title', className: 'dnw-grouptitle' }, title),
          trailing,
        ]),
        ...children,
      ])

      return React.createElement('section', { className: 'dnw', id: SETTINGS_ANCHOR, 'aria-label': t('title') }, [
        React.createElement('div', { key: 'head', className: 'dnw-head' }, [
          React.createElement('h3', { key: 'title', className: 'dnw-title' }, t('title')),
          React.createElement('span', { key: 'status', className: 'dnw-status', 'aria-live': 'polite' }, statusText),
        ]),
        React.createElement('p', { key: 'intro', className: 'dnw-intro' }, t('intro')),
        detail.length === 0 ? null : React.createElement('p', { key: 'detail', className: 'dnw-hint' }, detail),
        group('effects', t('groupEffects'), null, [
          table,
          React.createElement('p', { key: 'hint', className: 'dnw-hint' }, t('effectsHint')),
        ]),
        group('timing', t('groupTiming'), timingControl, [
          React.createElement('p', { key: 'hint', className: 'dnw-hint' }, t('timingHint')),
        ]),
        group('badge', t('groupBadge'), limit, [
          React.createElement('p', { key: 'hint', className: 'dnw-hint' }, t('blinkHint')),
        ]),
      ])
    }

    /**
     * The head of the bundle's page: the rendered README above the settings can
     * be long, so one control jumps to the section instead of making the reader
     * scroll all the way down. It renders for this bundle only.
     */
    const JumpToSettings = (props) => {
      const { subject, t } = props
      if (subject?.kind !== 'bundle' || subject.pkg?.name !== SETTINGS_ID) return null
      const jump = () => {
        if (typeof document === 'undefined') return
        const node = document.getElementById(SETTINGS_ANCHOR)
        if (node === null || typeof node.scrollIntoView !== 'function') return
        node.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      const text = t('jumpToSettings')
      return Button !== null
        ? React.createElement(Button, { variant: 'outline', size: 'sm', onClick: jump }, text)
        : React.createElement('button', { type: 'button', className: 'dnw-jump', onClick: jump }, text)
    }

    /**
     * Register the section on the plugin's own page. `plugins.bundle.config` is
     * dispatched with the package name on the bundle's page in 插件, so the
     * notification matrix sits where the plugin is managed instead of adding
     * another entry to the global Settings list. The services are injected
     * lazily so a deployment without them keeps the toast-answer half working.
     */
    const mountSettings = (ctx) => {
      if (React === null || typeof ctx.inject !== 'function') return
      ctx.inject(['slots', 'locale', 'configForms'], (scope) => {
        const t = scope.locale.bind(SETTINGS_NS)
        scope.effect(() => scope.locale.register(SETTINGS_NS, { zh, en }),
          'dsh-notify-win: settings dictionaries')
        const form = scope.configForms.get(SETTINGS_ID)
        const face = () => ({ form, t })
        scope.effect(() => scope.configForms.whileServed([SETTINGS_ID], () => {
          const offSection = scope.slots.inject('plugins.bundle.config', () => scope.slots.register({
            name: 'plugins.bundle.config',
            key: SETTINGS_ID,
            inject: face,
          }, SettingsSection))
          const offJump = scope.slots.inject('plugins.detail.actions', () => scope.slots.register({
            name: 'plugins.detail.actions',
            id: 'dsh-notify-win-settings',
            order: 10,
            inject: () => ({ t }),
          }, JumpToSettings))
          return () => {
            offSection()
            offJump()
          }
        }), 'dsh-notify-win: plugin page')
      })
    }

    exports.apply = (ctx) => {
      try {
        activeCtx = ctx

        // Tell the host whether a page can click a question card. The answer
        // path stays DSH's own (the page clicks the official card); the host
        // only uses this to decide that a parked answer needs the window
        // restored first, because Chromium throttles a hidden window's timers.
        const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
        const reportVisibility = (visible) => {
          try {
            void fetch('/dsh-notify/v2/visibility', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ clientId, visible }),
              keepalive: true,
            }).catch(() => {})
          } catch {
            // A page without fetch keeps the host on the card path.
          }
        }
        const reportCurrentVisibility = () => {
          reportVisibility(typeof document !== 'undefined' && document.visibilityState === 'visible')
        }
        const onPageHide = () => reportVisibility(false)
        ctx.effect(() => {
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', reportCurrentVisibility)
          window.addEventListener('pageshow', reportCurrentVisibility)
          window.addEventListener('pagehide', onPageHide)
          window.addEventListener('focus', reportCurrentVisibility)
          reportCurrentVisibility()
          // Heartbeat: a page that crashed without pagehide must stop counting
          // as a card surface after the host's expiry.
          const heartbeat = setInterval(reportCurrentVisibility, 4000)
          return () => {
            clearInterval(heartbeat)
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', reportCurrentVisibility)
            window.removeEventListener('pageshow', reportCurrentVisibility)
            window.removeEventListener('pagehide', onPageHide)
            window.removeEventListener('focus', reportCurrentVisibility)
            reportVisibility(false)
          }
        }, 'dsh-notify-win: page visibility')

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

        // 插件 → dsh-notify-win. Lazy: a deployment without the settings
        // services simply never mounts the section.
        mountSettings(ctx)
      } catch (error) {
        console.error('[dsh-notify-win] client apply failed:', error)
      }
    }

    return module.exports
  },
})
