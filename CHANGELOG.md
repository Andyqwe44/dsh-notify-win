# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
