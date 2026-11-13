/**
 * dsh-notify-win configuration.
 *
 * Three things live here, shared by the host plugin and the tests:
 *
 * 1. DEFAULTS — every supported config key and its default. These are the
 *    values the plugin has always read; the settings schema below must cover
 *    each one, otherwise DSH's config validation would drop a user's existing
 *    text/duration overrides.
 * 2. Config — the schemastery schema DSH reads through
 *    `fiber.runtime.Config`. `eventPolicy` and `attention` are `.volatile()`,
 *    so the settings page can rewrite them live: the loader commits the new
 *    values into the references the running plugin already holds, without a
 *    reload.
 * 3. resolveEffects — the pure policy that turns one event kind into
 *    { toast, blink, flash, timing }. Kept side-effect free so the matrix can
 *    be tested without a helper or a desktop.
 */
import z from '@deepseek-ai/schemastery'

/**
 * One row per user-visible notification event. `file` is the only one that is
 * off by default: editing a file happens many times per turn.
 */
export const EVENT_KEYS = ['done', 'compact', 'receipt', 'question', 'approval', 'error', 'cancelled', 'file']

/** Tool names that change files, so a successful call is a "file changed" event. */
export const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor'])

/** Default per-event effects. `blink` is the QQ-style unread badge on the taskbar button. */
export const DEFAULT_EVENT_POLICY = {
  done: { toast: true, blink: true, flash: false },
  compact: { toast: true, blink: false, flash: false },
  receipt: { toast: true, blink: false, flash: false },
  question: { toast: true, blink: true, flash: false },
  approval: { toast: true, blink: true, flash: false },
  error: { toast: true, blink: true, flash: false },
  cancelled: { toast: true, blink: false, flash: false },
  file: { toast: false, blink: false, flash: false },
}

export const DEFAULTS = {
  doneTitle: 'DeepSeek Harness · 任务完成',
  doneBody: '任务已完成，可以查看结果。',
  compactTitle: 'DeepSeek Harness · 上下文已压缩',
  compactBody: '上下文压缩完成，可以继续。',
  questionTitle: 'DeepSeek Harness · 需要你确认',
  questionBody: '有操作需要你批准或拒绝。',
  askTitle: 'DeepSeek Harness · 有问题等你回答',
  askBody: '助手向你提了一个问题，请切换到 DeepSeek Harness 查看。',
  dedupMs: 1500,
  // Toast display duration: 'short' (~5 s, Windows default) or 'long' (~25 s).
  questionToastDuration: 'short',
  doneToastDuration: 'short',
  approvalToastDuration: 'long',
  helperLog: '',
  answerPendingTimeoutMs: 30000,
  answerSpeechTimeoutMs: 90000,
  showProject: true,

  // Stop-reason notifications.
  notifyOnCancel: true,
  notifyOnError: true,
  includeErrorCode: true,
  cancelledTitle: 'DeepSeek Harness · 已取消',
  cancelledBody: '任务已取消。',
  hookCancelledBody: '任务被 hook 拦截：{message}',
  maxTokensTitle: 'DeepSeek Harness · 输出达到上限',
  maxTokensBody: '模型输出达到上限，本轮已截断。发送「继续」即可接着写。',
  blockedTitle: 'DeepSeek Harness · 回合被拦截',
  blockedBody: '本轮在开始前被前置检查拒绝。',
  errorTitle: 'DeepSeek Harness · 任务中断',
  errorBody: '任务异常停止：{hint}',
  retrySuffix: '（已重试 {retry}/{retryMax} 次）',
  retrySuffixUnbounded: '（已重试 {retry} 次）',
  compactionFailedTitle: 'DeepSeek Harness · 上下文压缩失败',
  compactionFailedBody: '上下文压缩失败：{message}',
  unknownStopTitle: 'DeepSeek Harness · 任务已停止',
  unknownStopBody: '任务已停止，结束方式：{reason}',

  // File-change trigger (off by default).
  fileChangeTitle: 'DeepSeek Harness · 文件已修改',
  fileChangeBody: '已更新 {path}',

  // Event -> effects matrix. Editable from Settings → 通知 (live, no restart).
  eventPolicy: DEFAULT_EVENT_POLICY,
  attention: {
    // 'after-timeout': start the effect once the toast times out unanswered.
    // 'immediate': start it when the event fires (the toast still shows).
    timing: 'after-timeout',
    blinkMaxMinutes: 30,
    blinkIntervalMs: 600,
  },
}

/** A per-event schema whose absent fields fall back to THAT event's default. */
const policySchema = (defaults) => z.object({
  toast: z.boolean().default(defaults.toast),
  blink: z.boolean().default(defaults.blink),
  flash: z.boolean().default(defaults.flash),
})

const TEXT_KEYS = [
  'doneTitle', 'doneBody', 'compactTitle', 'compactBody',
  'questionTitle', 'questionBody', 'askTitle', 'askBody',
  'cancelledTitle', 'cancelledBody', 'hookCancelledBody',
  'maxTokensTitle', 'maxTokensBody', 'blockedTitle', 'blockedBody',
  'errorTitle', 'errorBody', 'retrySuffix', 'retrySuffixUnbounded',
  'compactionFailedTitle', 'compactionFailedBody',
  'unknownStopTitle', 'unknownStopBody', 'helperLog',
  'fileChangeTitle', 'fileChangeBody',
]
const NUMBER_KEYS = ['dedupMs', 'answerPendingTimeoutMs', 'answerSpeechTimeoutMs']
const BOOLEAN_KEYS = ['showProject', 'notifyOnCancel', 'notifyOnError', 'includeErrorCode']
const DURATION_KEYS = ['questionToastDuration', 'doneToastDuration', 'approvalToastDuration']

const fields = {}
for (const key of TEXT_KEYS) fields[key] = z.string().default(DEFAULTS[key])
for (const key of NUMBER_KEYS) fields[key] = z.number().default(DEFAULTS[key])
for (const key of BOOLEAN_KEYS) fields[key] = z.boolean().default(DEFAULTS[key])
for (const key of DURATION_KEYS) {
  fields[key] = z.union([z.const('short'), z.const('long')]).default(DEFAULTS[key])
}

// `.default()` keeps the object present even when the user has never opened the
// settings page; `.volatile()` is what makes it live-editable (a volatile ref
// only exists in the running config when the field resolved to a value).
fields.eventPolicy = z.object({
  done: policySchema(DEFAULT_EVENT_POLICY.done),
  compact: policySchema(DEFAULT_EVENT_POLICY.compact),
  receipt: policySchema(DEFAULT_EVENT_POLICY.receipt),
  question: policySchema(DEFAULT_EVENT_POLICY.question),
  approval: policySchema(DEFAULT_EVENT_POLICY.approval),
  error: policySchema(DEFAULT_EVENT_POLICY.error),
  cancelled: policySchema(DEFAULT_EVENT_POLICY.cancelled),
  file: policySchema(DEFAULT_EVENT_POLICY.file),
}).default(DEFAULTS.eventPolicy).volatile()

fields.attention = z.object({
  timing: z.union([z.const('after-timeout'), z.const('immediate')]).default(DEFAULTS.attention.timing),
  blinkMaxMinutes: z.number().min(0).max(1440).default(DEFAULTS.attention.blinkMaxMinutes),
  blinkIntervalMs: z.number().min(200).max(5000).default(DEFAULTS.attention.blinkIntervalMs),
}).default(DEFAULTS.attention).volatile()

/** The plugin's Config schema (exported on the default plugin object). */
export const Config = z.object(fields)

/**
 * Resolve the effects of one event. Absent fields fall back to the event's
 * default, so a YAML override that only sets one checkbox keeps the others.
 *
 * @param cfg - live plugin config (plain values).
 * @param eventKey - one of EVENT_KEYS.
 * @returns `{ toast, blink, flash, timing }`.
 */
export const resolveEffects = (cfg, eventKey) => {
  const base = DEFAULT_EVENT_POLICY[eventKey] ?? { toast: true, blink: false, flash: false }
  const chosen = cfg?.eventPolicy?.[eventKey]
  const effects = {
    toast: typeof chosen?.toast === 'boolean' ? chosen.toast : base.toast,
    blink: typeof chosen?.blink === 'boolean' ? chosen.blink : base.blink,
    flash: typeof chosen?.flash === 'boolean' ? chosen.flash : base.flash,
  }
  // The interactive question/approval card IS the notification; it can never
  // be suppressed, only its attention effects can be turned off.
  if (eventKey === 'question' || eventKey === 'approval') effects.toast = true
  const timing = cfg?.attention?.timing === 'immediate' ? 'immediate' : 'after-timeout'
  return { ...effects, timing }
}

/** Badge-blink settings, clamped for the helper (which trusts the host). */
export const attentionSettings = (cfg) => {
  const raw = cfg?.attention ?? {}
  const minutes = Number(raw.blinkMaxMinutes)
  const interval = Number(raw.blinkIntervalMs)
  return {
    blinkMaxMinutes: Number.isFinite(minutes) ? Math.max(0, Math.min(1440, minutes)) : DEFAULTS.attention.blinkMaxMinutes,
    blinkIntervalMs: Number.isFinite(interval) ? Math.max(200, Math.min(5000, interval)) : DEFAULTS.attention.blinkIntervalMs,
  }
}
