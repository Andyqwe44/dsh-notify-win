# dsh-notify-win

> DeepSeek Harness (DSH) Windows notification plugin — native toast + taskbar flash when a task finishes or your input is needed.

English | [中文](README.zh.md)

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4)
![license](https://img.shields.io/badge/license-MIT-green)
![version](https://img.shields.io/badge/version-0.2.0-blue)

## ✨ Features

- 🔔 **Native Windows toast** (bottom-right, Win10/11 system style)
- 💡 **Taskbar flash** (`FlashWindowEx`) when DSH is in the background
- 🖱️ **Click-to-focus** — clicking a toast opens DSH and switches to the corresponding session
- ✅ Triggers when a **task finishes** (root agent goes `idle`)
- ❓ Triggers when **your input is needed** (approval / `ask_user_question`)
- 🖼️ Hero banner with the DeepSeek Harness logo (light/dark theme aware)
- 🚀 Fire-and-forget: no service, no model approval, no settings namespace

## 🚀 One-line install

```powershell
dsh plugin --profile web add dsh-notify-win
```

> Requires `pnpm` on PATH (`corepack enable` if missing). See [Install](#install) for details.

## Install

1. **Prerequisite: pnpm**

   ```powershell
   corepack enable
   ```

   Or without admin, put a user-level shim in a PATH directory:

   ```powershell
   Set-Content -Path "$env:LOCALAPPDATA\Microsoft\WindowsApps\pnpm.cmd" -Value "@echo off`r`ncorepack pnpm %*`r`n"
   corepack pnpm --version
   ```

2. **Install the plugin**

   ```powershell
   # From npm (recommended)
   dsh plugin --profile web add dsh-notify-win

   # Or directly from GitHub:
   dsh plugin --profile web add github:Andyqwe44/dsh-notify-win

   # If github: is blocked, use SSH:
   dsh plugin --profile web add git+ssh://git@github.com/Andyqwe44/dsh-notify-win.git
   ```

3. **Verify**

   ```powershell
   dsh --profile web --dump-config   # look for: # == dsh-notify-win / - id: dsh-notify-win
   ```

4. **Restart and test**

   ```powershell
   dsh web
   ```

   Complete any task. The first notification self-registers the branded toast identity (Start Menu shortcut + AppUserModelID, one-time). If the toast header still shows `DeepSeekHarness` without an icon, restart Explorer once:

   ```powershell
   Stop-Process -Name explorer -Force; Start-Process explorer
   ```

## Requirements

- Windows 10/11
- DeepSeek Harness, any profile (`web` recommended)
- PowerShell 7 or Windows PowerShell 5.1 (5.1 is used automatically as fallback)

## Configuration

Edit `$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml`:

```yaml
- id: dsh-notify-win
  config:
    doneTitle: 'DeepSeek Harness · Task complete'
    doneBody: 'Your task has finished.'
    questionTitle: 'DeepSeek Harness · Action needed'
    questionBody: 'An approval or decision is waiting.'
    askTitle: 'DeepSeek Harness · Question for you'
    askBody: 'The assistant asked you something.'
    dedupMs: 1500              # suppress duplicate notifications within this window
    showProject: true          # prefix body with project label
```

To disable:

```yaml
- id: dsh-notify-win
  disabled: true
```

Restart after install/disable changes (web profile HMR is disabled by default).

## How it works

| Concern | Implementation |
| --- | --- |
| Trigger "done" | `agent/status` event with `status: 'idle'` (root agents only) |
| Trigger "question" | `approval/request` waterfall + `tools/execute` for `ask_user_question` |
| Toast | WinRT `Windows.UI.Notifications` with hero banner, falls back to `NotifyIcon` balloon |
| Taskbar flash | `EnumWindows` + `FlashWindowEx` (`FLASHW_ALL \| FLASHW_TIMERNOFG`) |
| Execution | Fire-and-forget `powershell -File notify.ps1` subprocess |

The plugin registers no service, tool, or settings namespace — a plain consumer row, safe in any profile.

## Known limitations

- `FlashWindowEx` uses the system's warm-pulse highlight; custom colors are not possible.
- Windows never flashes the foreground window — the taskbar button only flashes when DSH is in the background.
- Cancelling a running turn also goes `idle`, so a cancelled task still triggers the "done" toast.
- Notifications are deduplicated per session within `dedupMs` (default 1500 ms).

## Development

```powershell
npm run check     # syntax check
npm test          # logic smoke test (mocked ctx)

# Show a real toast + taskbar flash:
powershell -NoProfile -File lib/notify.ps1 -Kind done -Title "test" -Body "test"
```

## Project layout

```
dsh-notify-win/
├── lib/
│   ├── index.js       # Host half: event listeners -> subprocess spawn
│   └── notify.ps1     # Toast + taskbar flash implementation
├── test/
│   ├── smoke.mjs      # Plugin logic smoke test
│   └── headless-overlay.yml
├── cordis.patch.yml   # DSH bundle patch
├── package.json       # dsh.bundle declaration
├── README.md
└── README.zh.md
```

## Links

- 🌐 Landing page: https://Andyqwe44.github.io/dsh-notify-win/

## License

[MIT](LICENSE)
