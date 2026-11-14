# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.3] - 2026-11-14

### Fixed

- **Answering from the toast while DSH is minimized, without moving the
  window.** Chromium throttles timers in a hidden renderer (1/s, then 1/min),
  which is why the 500 ms poll could sit for a minute. The page now waits on a
  hanging request instead (`/dsh-notify/v2/wait-answer`): a response is
  delivered to a hidden renderer like any other event, so the parked answer
  arrives immediately, DSH's own card submits it in the background and the
  window never appears or takes focus. The waits inside the card-driving code
  use `MessageChannel` tasks instead of `setTimeout` for the same reason.
- The helper wake is now only the fallback, armed with a 6 s grace
  (`answerWakeGraceMs`) and retired as soon as the page consumes the answer or
  acknowledges it. When it does fire it restores and briefly activates the
  window (Chromium only un-hides on activation), then minimizes and hands the
  foreground back.

### Changed

- The plugin's HTTP routes moved to `/dsh-notify/v2/…` so a half-registered
  hot reload cannot shadow them; registration now logs a duplicate instead of
  failing the whole plugin.

## [0.8.2] - 2026-11-14

### Fixed

- **Answering from the toast while DSH is minimized.** A question is still
  answered by DSH's own card — the host never settles the question behind its
  back — but Chromium throttles a hidden window's timers, so the card click
  waited until the window was restored. The host now parks the toast answer,
  asks the resident helper to restore and raise the window for the click
  (`wake`: no activation, no focus change), and sends `restore` when the page
  reports back, putting the window back to its previous minimized state. The
  page applies the parked answer on the `visibilitychange` event instead of
  waiting for the next poll tick, so the window is only up for a moment. A 15 s
  safety timer in the helper restores it even when the page never reports back.

### Added

- `GET /dsh-notify/state`: which pages reported themselves visible, whether the
  host currently believes answering needs a wake, and the parked answer it is
  waiting on. Enough for a bug report to say what happened without reading DSH's
  console.
- `wake` / `restore` helper ops, covered by the protocol test and by a new
  `background-answer` suite that pins the "never settle it ourselves" contract.

## [0.8.1] - 2026-11-13

### Removed

- **The NotifyIcon balloon fallback.** When Windows refused every toast
  identity, the helper created a visible `NotifyIcon` for eight seconds to show
  a balloon tip — the one path left that added an icon to the notification area.
  A refused toast now logs and leaves the reminder to the configured attention
  effects (tray badge / taskbar flash), so the helper owns no tray icon at all.
  The stale `HKCU\Control Panel\NotifyIconSettings` row left behind by the
  pre-0.7 tray icon was a leftover, not a running icon; it can be deleted, which
  removes the app from Settings → Taskbar → *Other system tray icons*.

## [0.8.0] - 2026-11-13

### Changed

- **Settings moved onto the plugin's own page.** The notification matrix is no
  longer a **Settings → Notifications** section: the client half now registers
  `plugins.bundle.config` (keyed by the package name) instead of a
  `settings.section`, so it renders on **插件 → dsh-notify-win** and the global
  Settings list stops growing by one entry per installed plugin. Nothing else
  changed about the writes: each control still commits through `configForms`,
  which applies to the running plugin without a restart.
- **Tighter, quieter layout.** Switches come from the host's own `Switch`
  primitive (native checkboxes when a deployment does not expose it), the timing
  choice is a `SegmentedControl` (radio fallback), and the blink limit is a small
  right-aligned number field with its unit beside it. The section is capped at
  720 px and split into three hairline-separated groups — effects, timing, badge
  — instead of one long form.
- **A jump control in the page header.** The bundle page renders its README
  above the configuration, and that README is long, so a `plugins.detail.actions`
  entry adds a 通知设置 / *Notification settings* button that scrolls straight to
  the section (`scroll-margin-top` keeps the heading below the page's sticky
  header).

## [0.7.0] - 2026-11-13

### Changed

- **unread-dot reminder moved onto DSH's own tray icon.** `blink` now paints a red
  unread dot over DSH's notification-area icon: the helper places a click-through
  layered window (`WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE`) on the
  icon's cell, located with the documented `Shell_NotifyIconGetRect`. The icon
  bitmap is never replaced and no tray icon is registered, so nothing is added to
  the notification area and nothing has to be pinned in the ^ overflow. The dot
  toggles until DSH comes to the foreground, the toast is answered/resolved, or
  `attention.blinkMaxMinutes` expires.
- **Event-driven badge.** Nothing polls: the dot runs on one `WM_TIMER` per
  blink frame, taskbar/DPI changes arrive as `WM_DISPLAYCHANGE` /
  `WM_SETTINGCHANGE` on the overlay window, and the taskbar fallback blocks on
  an `AutoResetEvent` while idle. The only repeated call is a single
  `Shell_NotifyIconGetRect` per visible frame (window/id cached), because
  Windows emits no event when a tray icon moves into the `^` overflow.
- When Windows 11 files the icon under the `^` overflow the shell reports no
  rectangle; the helper then falls back to an `ITaskbarList3::SetOverlayIcon`
  badge on the taskbar button. Two missed frames retarget the reminder, so an
  icon moved mid-blink is not silently lost.
- **Removed** the helper-owned notification tray icon, its Windows 11 overflow
  promotion (`HKCU\Control Panel\NotifyIconSettings` → `IsPromoted`) and the
  `attention.trayIcon` setting. A profile that still carries `trayIcon:` is
  accepted; the schema drops the unknown key.

## [0.6.0] - 2026-11-13

### Added

- **Per-event notification policy.** Every event (task done, context
  compaction, reply receipt, question, approval, error, cancellation, file
  change) now resolves its own row: native toast, unread tray blink and the
  taskbar flash can be enabled independently, and the attention effects start
  either when the event fires or after its toast times out unanswered. The
  runtime exports a `Config` schema, so DSH renders the matrix in **Settings →
  Notifications**; the fields are `.volatile()`, which applies a checkbox to the
  running plugin without a restart.
- **unread tray blink.** The helper runs its own notification tray icon on a
  dedicated STA thread and blinks a red unread dot between two frames. It stops
  when a DSH window is foreground, when the icon is clicked, when the
  question/approval is answered or resolved, when the helper shuts down, or
  after `attention.blinkMaxMinutes`. Windows 11 files new tray icons under the
  overflow chevron, so the helper pins its own icon into the visible tray once
  (`HKCU\Control Panel\NotifyIconSettings` → `IsPromoted`) before re-registering
  it; set `attention.trayIcon: on-blink` to skip the permanent icon.
- **File-change trigger** for successful `write` / `edit` / `apply_patch` /
  `str_replace_editor` calls, off by default, with configurable title/body.
- `test/policy.mjs` guards the schema/default alignment, the effect matrix and
  the settings-page event keys.

### Changed

- The taskbar warm pulse is now opt-in: the default reminder after an ignored
  toast is the tray blink (`eventPolicy.*.flash` defaults to `false`).
- The helper protocol grew `effects` on `notify` / `question` / `status`, an
  effect-only `attention` op and a `config` op carrying the tray-icon mode and
  blink timing.

### Changed

- **One .NET notification implementation.** Every toast — done / compact /
  alert / notice / approval and interactive questions — is now shown by the
  resident `dsh-toast-question.exe` helper over one stdin JSON protocol. The
  plugin no longer spawns `powershell.exe` per notification and no longer
  ships or executes any `.ps1`/`.vbs` file. The .NET 10 Desktop Runtime is a
  hard requirement.
- The helper now owns toast identity registration (AUMID + Start Menu
  shortcut), the `dsh-notify://` protocol, click-to-focus (`--focus`), the
  balloon fallback and the taskbar flash. A toast click is handled in-process;
  the old focus scripts are gone.
- The helper source is split by responsibility (`Protocol/`, `Notifications/`,
  `Questions/`, `Platform/`, `Interop/`, `Logging/`) instead of one large
  `Program.cs`. All generated files live under `artifacts/` (gitignored);
  `npm run build` publishes there and stages only the final exe into `lib/`.
- All toasts now flash only after Windows dismisses them by timeout; the flash
  stops when DSH comes to the foreground. The helper also remembers the armed
  window and sends `FLASHW_STOP` on `EVENT_SYSTEM_FOREGROUND` as soon as a DSH
  window is activated, so the shell's flash-tick / fade tail is no longer
  visible. The question flow is unchanged (submit/cancel/`resolved` still call
  `FLASHW_STOP`).
- Approval requests are now interactive: DSH's own approval panel stays on
  screen and the toast is a remote control for it, using the same fixed-choice
  single-select card as the question flow (`允许一次` / `拒绝`, no free-text
  input). The toast answer is parked for the browser half, which switches to the
  owning session and clicks allow/reject in the panel; the panel remains the
  authority. The toast uses the new `approvalToastDuration` (default `long`);
  cancelling it leaves the decision to the panel, and an aborted turn retires the
  toast. The browser half now also switches to the answer's session before
  driving a card, so an answer given while another session is open is applied
  instead of being lost.
- The answer receipt now shows the model's **first line** instead of its first
  sentence: the line is filled to the toast width and cut with `…` (one
  full-width cell) when it is longer. The receipt fires when that line ends or
  once it is already wider than the toast, so a line without a break still
  appears; a turn that ends on a short line still reports the line.
- The answer flow is now two toasts only: the question, then the model's first
  line. Submitting dismisses the question toast; the “⏳ 已提交，等待 DSH
  确认…” and “✓ agent 已收到并回应” stages are gone, and the receipt carries
  no title line. A turn with no visible text shows nothing instead of a
  delivery claim.

### Removed

- `lib/notify.ps1`, `lib/notify/_common.ps1`, `lib/notify/_kinds.ps1`,
  `lib/focus-dsh.ps1`, `lib/focus-dsh.vbs`, and the PowerShell test probes.
- The `helperEnabled`, `helperUnavailableHint` and `noDotNetHint` config keys:
  the helper is required, so there is no PowerShell fallback to tune.

### Fixed

- Clicking a toast now behaves like the DSH tray icon: a window hidden to the
  tray is shown again, a minimized one is restored, a maximized one stays
  maximized, and the foreground switch is forced (a single Alt keystroke is
  used when Windows refuses a background process) so DSH really comes to the
  front. Previously `SW_RESTORE` un-maximized the window, and a background
  process's `SetForegroundWindow` could be refused.
- Clicking a toast now opens DSH through the app's own `dsh://open` path when
  the window is hidden to the tray (the same `focusPrimaryWindow` as the tray
  icon), so Chromium's renderer resumes and the window accepts the mouse. A
  window shown natively used to appear but ignore clicks and hover. When a
  full-screen foreground app refuses the follow-up foreground switch, the
  helper raises the window topmost for the switch and restores the normal
  Z-order afterwards.
- A toast body click that cold-starts the helper (the shortcut path, with no
  `--focus` argument) now focuses DSH instead of exiting with code 2, so the
  click works even when the in-process activation is not delivered. The Start
  Menu shortcut also carries `--focus` and is recreated when that argument is
  missing.
- The helper now clears `ELECTRON_RUN_AS_NODE` before it shell-launches the DSH
  app. The desktop host starts the helper from a Node-mode Electron process, so
  the variable was inherited; a `dsh://open` launch then started
  `DeepSeek Harness.exe` as plain Node, which exited immediately with
  `Cannot find module 'dsh:\open'` and never showed the window. That is why a
  toast click still did nothing even with the focus path fixed: the window now
  appears through the app in ~300 ms instead of falling back to a native
  `ShowWindow` that rendered a frame but ignored the mouse.
- A tray-hidden DSH window that still holds the foreground slot no longer
  suppresses the next toast. The "already focused" check now requires a visible,
  non-minimized window, so closing the GUI to the tray and letting a task finish
  still pops the completion toast.
- The timeout taskbar flash now uses `FLASHW_TRAY | FLASHW_TIMERNOFG`
  (`2 | 12`), so Windows stops it as soon as DSH comes to the foreground. The
  helper no longer runs a 3-second re-pulse loop: that loop was also the only
  stop detector, so it kept flashing after DSH was already in front or after
  the question had been answered.
- A question settled in the DSH card (not in the toast) now retires its toast
  and stops the flash: the host sends `resolved`, and the helper calls
  `FlashWindowEx(FLASHW_STOP)`.

## [0.5.0] - 2026-10-23

### Added

- **Paged multi-question toast.** A batch of two or more questions is now one
  toast with `上一题 / 下一题 / 提交 / 取消` navigation and a `问题 i/n` header,
  instead of a new toast per question. The header also shows the question's
  own heading when it has one.
- **Drafts survive paging.** Every page keeps its dropdown choice and custom
  text. Returning to a page restores the dropdown through the toast XML
  `defaultInput` attribute (and the text field through its own `defaultInput`),
  and a `已答：…` line summarises the other answers. Submitting with an
  unanswered page jumps back to it with a hint instead of failing silently.
- **Custom answer field on every page.** Single-select pages carry both the
  dropdown and a free-text override; multi-select and optionless pages use the
  text field alone. A filled custom answer wins over the dropdown, matching the
  previous single-question behaviour.

### Changed

- Multi-page question toasts always use the `long` duration so there is time to
  page through; single-question toasts still honour `questionToastDuration`.
- Each page is shown with a fresh toast tag, so the native show animation runs
  (the same behaviour the standalone demo was judged on).

## [0.4.0] - 2026-10-23

### Added

- **Resident question helper, tied to the plugin lifetime.** `dsh-toast-question.exe`
  now runs in `--serve` mode as one long-lived child of the DSH host, spoken to
  over the child's stdin/stdout with newline-delimited JSON. The plugin starts it
  in `apply`, reuses it for every question (no per-question process spawn), sends
  `shutdown` when the plugin is disposed, and the helper also exits on stdin EOF
  when DSH quits — so a disabled plugin or a closed DSH never leaves an orphan.
- **Honest two-stage answer receipt.** The toast no longer claims “已发送” right
  after the HTTP call. It says “⏳ 已提交，等待 DSH 确认…” and only switches to
  “✓ 回答已送达 agent” after the actual `ask_user_question` tool result returns.
  It then switches to “✓ agent 已收到并回应” with the **model's first sentence**,
  captured from `agent/assistant-stream` `text-delta` frames — text that can only
  exist if the answer really reached the model.
- The receipt reports the truth in every branch: a mismatched agent answer
  (“agent 收到的是其它答案”), a card that could not be filled (“请在 DSH 窗口中手动回答”),
  a window that never confirmed (“未收到 DSH 确认”), a stale toast (“该问题已在
  DSH 中处理”), and a turn with no visible text (“本轮没有文本回复”).
- Multi-question batches and custom text are now driven on the official card
  (select options / type custom text per page, advance, submit) and the browser
  half reports a failed drive to the host.
- New config: `helperEnabled`, `helperLog`, `answerPendingTimeoutMs`,
  `answerSpeechTimeoutMs`, `helperUnavailableHint`.

### Changed

- The interactive helper no longer posts over HTTP, so the Web GUI port no longer
  matters for toast answers. `/dsh-notify/answer` stays as a manual-test route.
- The helper seeds toast tag numbers from its pid, so two overlapping helper
  instances cannot replace each other's question toast.

### Removed

- The one-shot `--session/--qid/--questions/--url` helper invocation and its
  “✓ 已发送” confirmation, which could not distinguish “HTTP accepted” from
  “agent received”.

## [0.3.3] - 2026-10-23

### Added

- **Answering from the toast now reaches the agent.** Choosing an option in the
  interactive question toast and pressing Send fills and submits the official
  question card inside DSH, so the pending `ask_user_question` call returns at
  once instead of waiting for a click in the window.

### Fixed

- The interactive helper posts its answer to the advertised Web GUI origin
  passed as `--url`; it was hardcoded to port 3080, so every Send failed
  whenever the GUI listened on another port.
- Clicking the toast body no longer strands the question: the toast re-opens.
  Submitting with nothing selected re-opens it too, instead of leaving only a
  hint behind.

### Changed

- The question toast honours `--duration` (`short` / `long`).

### Known limitation

- The toast drives the official card through the DOM (its option button, then
  its submit button). A third-party client plugin is registered after the
  official answerer, so it can never win the `user-questions/request` waterfall
  and must reuse the card instead. A host-side API for answering a question
  would replace this.

## [0.3.2] - 2026-10-23

### Changed

- **Toast identity is ours.** Every notification is attributed to
  **DeepSeek Harness** with its own icon (self-registered AppUserModelID plus a
  Start Menu shortcut). Windows previously fell through to the PowerShell
  identity, so the toast header read "Windows PowerShell" with the PowerShell
  icon. The system identities stay as fallbacks when the branded notifier
  cannot be created.
- **No hero banner anywhere.** Every kind — including the interactive question
  toast — renders badge-only, so the header icon is the only image and the toast
  stays compact. `_kinds.ps1` keeps the `Hero` flag as the single switch if a
  banner is ever wanted again.

### Fixed

- `--duration` on the interactive question toast now actually applies
  (`short`/`long`).

## [0.3.1] - 2026-10-23

### Added

- **Post-action confirmation toasts**, merged in from the published `0.2.1`
  line: clicking "Send" or "取消" on a question toast now shows a follow-up
  toast — "✓ 已发送" once the DSH host has accepted the answer, "已取消" for a
  cancellation, and "✗ 发送失败，请重试" when the round trip fails. Submitting
  without a selection now says "请选择答案" instead of closing silently.

### Fixed

- The `0.2.1` confirmation toasts and the `0.3.0` taskbar-flash control now
  coexist: the flash stops first, then the confirmation toast appears.
- A latent build break in the `0.3.0` source: WinRT has no
  `ToastNotification.Duration` property, so the value is now emitted as the
  toast XML `duration` attribute.

## [0.3.0] - 2026-10-23

### Added

- **Stop-reason notifications.** `agent/status` only reports `idle`; the plugin
  now caches the `turn/end` reason (appended immediately before idle) and says
  WHY the turn stopped:
  - `max-tokens` → "output ceiling reached, truncated"
  - `blocked` → "turn blocked by a pre-step check"
  - `error` → alert with the provider-neutral failure code hint and the retry
    count from durable `llm/retry` events
  - `aborted` (`user`/`parent`/`legacy`) → lightweight "cancelled" notice
  - `aborted` (`hook`) → notice naming the hook reason
  - `aborted` (`disposed`) → silent (no bogus "done" toast on shutdown)
  - `interrupted`/`forked` → silent (durable history markers, never live)
  - unknown future reasons → generic "stopped" alert
- Failed context compaction (`compaction/end` with `error`) now alerts instead
  of staying silent.
- New config keys: `notifyOnCancel`, `notifyOnError`, `includeErrorCode`,
  `cancelledTitle/Body`, `hookCancelledBody`, `maxTokensTitle/Body`,
  `blockedTitle/Body`, `errorTitle/Body`, `retrySuffix`, `retrySuffixUnbounded`,
  `compactionFailedTitle/Body`, `unknownStopTitle/Body`. Templates support
  `{message}`, `{code}`, `{hint}`, `{reason}`, `{retry}`, `{retryMax}`.
- Smoke cases H–O cover every live stop reason, the disposal silence, duplicate
  idle suppression, and compaction success/failure.

### Changed

- **`notify.ps1` split by concern and notification class**, for maintainability:
  - `lib/notify.ps1` — entry: parameter validation, helper resolution, pipeline
  - `lib/notify/_common.ps1` — identity/protocol/theme/focus, toast delivery,
    balloon fallback, taskbar flash
  - `lib/notify/_kinds.ps1` — per-kind presentation (`done`, `compact`, `alert`,
    `notice`, `question`); adding a kind is one map entry
- `notify.ps1` gained `-Reason`, `-Code`, `-Retry`, `-RetryMax` diagnostics and
  echoes them in the debug line; the dead `-QuestionId`/`-QuestionsJson`
  code path was removed (interactive questions use the .NET helper).
- **Windows PowerShell 5.1 is now preferred over pwsh 7** for `notify.ps1`:
  pwsh 7 cannot resolve `Windows.UI.Notifications` types and silently degraded
  every toast to a NotifyIcon balloon.

### Fixed

- Cancelling a running turn no longer reports "task complete"; it reports
  "cancelled" (silenceable via `notifyOnCancel: false`).
- Plugin/agent disposal no longer fires a spurious "task complete" toast.

## [0.2.1] - 2026-08-20

### Added

- **Post-action confirmation toasts**: after the user clicks "Send" (or "取消"),
  the question toast is dismissed by Windows, then a small follow-up toast
  confirms the outcome — "✓ 已发送" when DSH receives the answer, "已取消" for
  cancellation, "✗ 发送失败，请重试" on network/error failure. The confirmation
  only appears after `SubmitAsync` waits for the DSH host HTTP response, so the
  user gets a real round-trip signal, not a fake one.

## [0.2.0] - 2026-08-16

### Added

- **Click-to-focus**: clicking a toast focuses/launches the installed Edge PWA
  (or a normal browser tab) and switches DSH to the session that produced the
  notification.
- Client bundle (`lib/client.js`) declared via `dsh.client` + `exports["./client"]`.
- Host HTTP endpoint `/dsh-notify/session` serves the pending session id to the
  browser-side client (consumed on first read).
- **V1 question toasts**: `ask_user_question` notifications now include the
  question, option buttons, and a custom-answer input. Selecting an option or
  sending custom text forwards the answer to the host and submits it to the
  waiting question after focusing DSH.

### Changed

- `notify.ps1` accepts an optional `-Launch` argument and sets
  `activationType="protocol"` when present.
- `notify.ps1` registers the `dsh-notify://` protocol pointing at the installed
  DeepSeek Harness Edge PWA (detected via `Get-StartApps`).
- `lib/focus-dsh.ps1` reuses an existing DeepSeek Harness window when present,
  and only launches a new PWA window when none is open.
- `lib/focus-dsh.vbs` launches `focus-dsh.ps1` through `wscript` so no console
  window flashes on toast click.
- Client bundle re-checks `/dsh-notify/session` on window `focus`, so clicking a
  toast works even when the PWA is already open (no page reload).
- Notify subprocess output is ignored to avoid terminal noise / log spills.

## [0.1.0] - 2026-08-15

### Added

- `dsh-notify-win` host plugin: native Windows toast (WinRT, with NotifyIcon
  balloon fallback) and taskbar flash (`FlashWindowEx`) for DeepSeek Harness.
- "Task finished" notification on root-agent `idle` (`agent/status`), skipping
  subagents via `delegationDepth`.
- "Answer needed" notification on `approval/request` (waterfall, non-blocking)
  and on `ask_user_question` tool execution (waterfall, non-blocking).
- 1.5 s dedup window (configurable via `dedupMs`) between notifications.
- DSH bundle packaging (`dsh.bundle.patch` → `cordis.patch.yml`): installable
  via `dsh plugin --profile <name> add dsh-notify-win`, enable/disable via the
  standard `disabled` flag.
- Configurable notification texts via the row's `config`.
- Logic smoke test (`test/smoke.mjs`) and CI workflow.

### Fixed

- Toast identity: use the system-registered PowerShell AppUserModelID instead
  of an unregistered one, which Windows 10/11 silently drops (verified on a
  real machine with a three-variant visibility probe).

## [0.1.1] - 2026-08-15

### Changed

- **Per-session dedup** (was a single global window): different sessions
  (projects) now each notify independently — two projects finishing
  back-to-back no longer collapse into one toast. Anti-spam moves to the
  session level (same session's rapid idle/approval still collapse).
- Toast now carries a per-process **sequence tag**, so a burst of finished
  tasks is queued and displayed rather than dropped by Win11.
- Taskbar-flash window-matching widened: it flashes any Edge/msedge window
  whose active-tab title contains `DeepSeek` / `:3080` / `DeepSeek Harness`,
  which works even when another project's tab is the active one in the same
  Edge window (Edge in the foreground still deliberately skips flashing).
- Toast now shows the **DeepSeek Harness logo** as its app icon: the official
  favicon is rendered to theme-matched PNGs (black for light, white for dark
  Windows theme) and injected via `appLogoOverride` (the AUMID identity —
  and therefore the toast app name — remains Windows PowerShell).

### Assets

- `lib/dsh-logo-light.png` / `lib/dsh-logo-dark.png` / `lib/dsh-logo.svg` /
  `lib/dsh-logo.ico` — generated from the official DSH favicon served by the
  harness (`/favicon.svg`, part of the MIT-licensed DeepSeek Harness project).

### Added

- **Branded toast identity**: registers the `DeepSeekHarness` AppUserModelID
  (registry `DisplayName`/`IconUri` + a Start-Menu shortcut carrying the
  AUMID, created via ShellLink COM + the property system), so the toast
  header shows **DeepSeek Harness** with the DSH logo instead of
  "Windows PowerShell". Falls back to the system PowerShell identity when
  registration is unavailable.
- **Project label in the notification body**: `showProject` (default true)
  prefixes the body with the project name — the git remote origin repository
  name when the session's cwd is a git work tree, otherwise the cwd folder
  name — so multi-project setups know which task just finished.
- README install guide rewritten for the official flow (`dsh plugin --profile
  web add github:Andyqwe44/dsh-notify-win`, with pnpm prerequisite shims and
  the SSH fallback), verified on a real profile via pnpm 11 through corepack.
