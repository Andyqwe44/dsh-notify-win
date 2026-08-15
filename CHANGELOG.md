# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
