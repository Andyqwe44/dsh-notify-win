// Policy guard for the configurable notification behavior.
//
// The host resolves one event -> effects row per notification. These checks
// pin the schema/DEFAULTS alignment (a missing key would make DSH reject a
// user's existing YAML), the default matrix (toast + taskbar badge instead of
// the taskbar flash), the interactive rows that can never lose their toast, and
// that the browser settings page lists exactly the host's event keys.
import { readFile } from 'node:fs/promises'
import plugin from '../lib/index.js'
import {
  DEFAULT_EVENT_POLICY,
  DEFAULTS,
  EVENT_KEYS,
  FILE_WRITE_TOOLS,
  Config,
  attentionSettings,
  resolveEffects,
} from '../lib/config.js'

let failed = false
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failed = true
}

/** Volatile config fields are references; read their current value. */
const plain = (value) =>
  value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value

// --- Schema/DEFAULTS alignment. ---
const fields = Config.dict ?? {}
check(Object.keys(DEFAULTS).every((key) => key in fields), 'Config declares every DEFAULTS key')
check(EVENT_KEYS.every((key) => key in (fields.eventPolicy?.dict ?? {})), 'Config declares every event row')
check('eventPolicy' in fields && fields.eventPolicy.meta.volatile === true, 'eventPolicy is volatile')
check('attention' in fields && fields.attention.meta.volatile === true, 'attention is volatile')

// --- Resolved defaults. ---
const resolved = Config({})
check(typeof resolved.eventPolicy?.get === 'function', 'eventPolicy resolves to a live reference')
check(typeof resolved.attention?.get === 'function', 'attention resolves to a live reference')
const policy = plain(resolved.eventPolicy)
const attention = plain(resolved.attention)
check(JSON.stringify(policy) === JSON.stringify(DEFAULT_EVENT_POLICY), 'resolved event policy equals the defaults')
check(attention.timing === 'after-timeout', 'effects start after the toast times out by default')
check(attention.blinkMaxMinutes === 30 && attention.blinkIntervalMs === 600, 'blink defaults are 30 min / 600 ms')
check(!('trayIcon' in attention), 'the helper tray icon is no longer configured')

// --- Default matrix: the warm flash is replaced by the taskbar badge. ---
check(DEFAULT_EVENT_POLICY.done.toast && DEFAULT_EVENT_POLICY.done.blink, 'done: toast + taskbar badge by default')
check(DEFAULT_EVENT_POLICY.done.flash === false, 'done: no taskbar flash by default')
check(DEFAULT_EVENT_POLICY.file.toast === false && DEFAULT_EVENT_POLICY.file.blink === false, 'file events stay silent by default')

// --- Per-event overrides keep unstated fields at THAT event's default. ---
const cfg = { eventPolicy: { ...DEFAULT_EVENT_POLICY, done: { toast: false, blink: true } }, attention }
const done = resolveEffects(cfg, 'done')
check(done.toast === false && done.blink === true && done.flash === false, 'a partial override keeps the other defaults')
check(done.timing === 'after-timeout', 'timing defaults to after-timeout')
const immediate = resolveEffects({ ...cfg, attention: { ...attention, timing: 'immediate' } }, 'done')
check(immediate.timing === 'immediate', 'immediate timing is resolved')

// --- Interactive rows can never lose their toast (it IS the UI). ---
const noToast = {
  eventPolicy: {
    ...DEFAULT_EVENT_POLICY,
    question: { toast: false, blink: false, flash: false },
    approval: { toast: false, blink: false, flash: false },
  },
  attention,
}
check(resolveEffects(noToast, 'question').toast === true, 'question toast cannot be suppressed')
check(resolveEffects(noToast, 'approval').toast === true, 'approval toast cannot be suppressed')

// --- Attention settings are clamped for the helper. ---
const clamped = attentionSettings({ attention: { blinkIntervalMs: 1, blinkMaxMinutes: -5 } })
check(clamped.blinkIntervalMs === 200, 'blink interval is clamped to 200 ms')
check(clamped.blinkMaxMinutes === 0, 'blink limit is clamped to 0 minutes')
const untrusted = attentionSettings({ attention: { blinkIntervalMs: 'x', blinkMaxMinutes: undefined } })
check(untrusted.blinkIntervalMs === 600 && untrusted.blinkMaxMinutes === 30,
  'missing attention config keeps the defaults')

// --- Cordis reads Config from the default export object. ---
check(plugin.Config === Config, 'Config is exported on the default plugin object')

// --- The settings page lists the same event keys as the host. ---
const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const rowsSource = /const EVENT_ROWS = \[([^\]]+)\]/.exec(client)
const clientKeys = rowsSource === null ? [] : [...rowsSource[1].matchAll(/'([a-z]+)'/g)].map((match) => match[1])
check(clientKeys.join(',') === EVENT_KEYS.join(','), 'client settings rows match the host event keys')

// --- The file trigger covers the write tools. ---
check(FILE_WRITE_TOOLS.has('write') && FILE_WRITE_TOOLS.has('edit') &&
  FILE_WRITE_TOOLS.has('apply_patch') && FILE_WRITE_TOOLS.has('str_replace_editor'),
'file trigger covers write/edit/apply_patch/str_replace_editor')

console.log(failed ? 'POLICY TEST FAILED' : 'POLICY TEST PASSED')
if (failed) process.exit(1)
