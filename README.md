# dsh-notify-win

English | [中文](README.zh.md)

DeepSeek Harness (DSH) host plugin for Windows: shows a **native toast**
(VSCode-Copilot style, bottom-right) and **flashes the DeepSeek Harness
taskbar button** (system warm pulse, `FlashWindowEx`) when:

- **a task finishes** — the harness detects that the model API response ended
  and no tool call is continuing the dialogue round (root agent went `idle`);
- **an answer is needed** — an approval/decision request is waiting, or the
  assistant asked you a direct question (`ask_user_question`).

The trigger is the harness's own lifecycle, **not a model tool call**, so no
DSH model-approval is involved. The only permission involved is the OS-level
one (Windows showing a notification for the harness process).

## Requirements

- Windows 10/11, DeepSeek Harness with any profile (`web` recommended).
- PowerShell 7 or Windows PowerShell 5.1 (either works; 5.1 is probed
  automatically as a fallback).

## Install

The package is a standard DSH **bundle** plugin: it ships its own
`cordis.patch.yml` and registers itself once it is a profile dependency.

### From npm (recommended after publishing)

```powershell
dsh plugin --profile web add dsh-notify-win
```

(`dsh plugin` runs `pnpm add` in the profile and automatically adds any
`dsh.bundle`-declaring dependency to the profile's bundle layer stack.)

### From a git clone (no npm)

```powershell
git clone https://github.com/Andyqwe44/dsh-notify-win.git

# Make the package resolvable from the profile (a junction into the profile
# node_modules farm; adjust the -Target to your clone path):
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-notify-win" -Target "D:\path\to\dsh-notify-win"

# Register the bundle in the profile manifest:
#   "$env:USERPROFILE\.dsh\profiles\web\package.json"
#     "dependencies": { "dsh-notify-win": "^0.1.0" },
#     "dsh": { "profile": { "bundles": [ ..., "dsh-notify-win" ] } }

# Verify the composed tree contains the row:
dsh --profile web --dump-config   # look for: # == dsh-notify-win / - id: dsh-notify-win
```

**Restart the harness** (`dsh web`) afterwards. The plugin is enabled by
default and stays enabled across restarts because it lives in the profile
composition.

## Enable / disable (the switch)

The load/disable switch is the standard `disabled` flag on the plugin row —
edit `$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml`:

```yaml
# disable:
- id: dsh-notify-win
  disabled: true

# re-enable (remove the override or set false):
- id: dsh-notify-win
  disabled: false
```

A restart applies the change (web profile HMR is disabled in the shipped
template).

## Customize texts

```yaml
- id: dsh-notify-win
  config:
    doneTitle: 'DeepSeek Harness · 任务完成'
    doneBody: '任务已完成，可以查看结果。'
    questionTitle: 'DeepSeek Harness · 需要你确认'
    questionBody: '有操作需要你批准或拒绝。'
    askTitle: 'DeepSeek Harness · 有问题等你回答'
    askBody: '助手向你提了一个问题，请切换到 DeepSeek Harness 查看。'
    dedupMs: 1500   # suppression window between two notifications
```

## How it works

| Concern | Implementation |
| --- | --- |
| Trigger "done" | `agent/status` event with `status: 'idle'` (root agents only; subagents are skipped via `delegationDepth`) |
| Trigger "question" | `approval/request` waterfall (fires + calls `next()`), plus `tools/execute` for `ask_user_question` (fires + calls `next()`) |
| Toast | `lib/notify.ps1` → WinRT `Windows.UI.Notifications` (native toast), falls back to a `NotifyIcon` balloon |
| Taskbar flash | `lib/notify.ps1` → `EnumWindows` finds the top-level window whose title starts with `DeepSeek Harness`, then `FlashWindowEx` (`FLASHW_ALL \| FLASHW_TIMERNOFG` = 15, flashes until the window is focused) |
| Execution | `ctx.subprocess.spawn(powershell -NoProfile -NonInteractive -WindowStyle Hidden -File notify.ps1 ...)`, fire-and-forget; PowerShell resolved like the official `dsh-pwsh-local` (pwsh 7 install → PATH → Windows PowerShell 5.1) |

The plugin registers no service, no tool, and no settings namespace — it is a
plain consumer row, safe in any profile, no isolate realm needed.

## Known limitations

- **Flash color**: `FlashWindowEx` uses the system's own warm-pulse highlight;
  a custom pure-orange flash is not possible through the public Windows API.
- **Cancel = done**: stopping a running turn also lands the agent in `idle`,
  so a cancelled task still triggers the "done" notification (the status
  event does not carry the stop cause).
- **Restart required** after install/disable changes on the web profile
  (web HMR is disabled in the shipped template).
- One notification per root agent turn; a 1.5 s dedup window (configurable)
  prevents double pops from back-to-back events.

## Development

```powershell
npm run check     # syntax check
npm test          # logic smoke test (mocked ctx)

# Standalone notification script test (shows a real toast + taskbar flash):
powershell -NoProfile -File lib/notify.ps1 -Kind done -Title "test" -Body "test"

# End-to-end load test (boots a headless profile with the plugin via overlay):
dsh --profile headless --patch test/headless-overlay.yml "reply ok"
```

## Project layout

```
dsh-notify-win/
├── .github/workflows/ci.yml   # CI: node check + smoke test, ps1 parse
├── lib/
│   ├── index.js               # Host half: event listeners -> subprocess spawn
│   └── notify.ps1             # Toast + taskbar flash implementation
├── test/
│   ├── smoke.mjs              # Plugin logic smoke test (mocked ctx)
│   └── headless-overlay.yml   # Test overlay for end-to-end boot
├── cordis.patch.yml           # DSH bundle patch: inserts the plugin row
├── package.json               # dsh.bundle declaration + npm metadata
├── README.md / README.zh.md   # English / 中文 documentation
├── CHANGELOG.md
└── LICENSE
```

## License

[MIT](LICENSE)
