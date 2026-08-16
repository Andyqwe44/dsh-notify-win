# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-16

### Added

- **Click-to-focus**: clicking a toast focuses/launches the installed Edge PWA
  (or a normal browser tab) and switches DSH to the session that produced the
  notification.
- Client bundle (`lib/client.js`) declared via `dsh.client` + `exports["./client"]`.
- Host HTTP endpoint `/dsh-notify/session` serves the pending session id to the
  browser-side client (consumed on first read).

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
