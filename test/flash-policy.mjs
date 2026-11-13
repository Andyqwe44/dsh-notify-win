// Attention guard for the .NET helper.
//
// The taskbar flash is no longer the default: each event's policy decides
// whether the helper shows a toast, blinks the notification tray icon, pulses
// the taskbar button, or does several of them. The flash must stay OS-owned
// (FLASHW_TRAY | FLASHW_TIMERNOFG) and stop when DSH comes to the foreground;
// there is still no periodic re-pulse timer. The QQ-style tray blink lives in
// TrayBlink.cs, and every path routes through StartAttention/StopAttention.
//
// This test also pins that the PowerShell/VBS scripts are really gone, so a
// future change cannot quietly reintroduce a second implementation.
import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = fileURLToPath(new URL('../src/DshToastQuestion/', import.meta.url))

async function readCsTree(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const parts = []
  for (const entry of entries) {
    if (entry.name === 'bin' || entry.name === 'obj') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      parts.push(await readCsTree(path))
    } else if (entry.isFile() && entry.name.endsWith('.cs')) {
      parts.push(await readFile(path, 'utf8'))
    }
  }
  return parts.join('\n')
}

const source = await readCsTree(sourceRoot)

let failed = false
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failed = true
}

const gone = async (relative) => {
  try {
    await access(new URL(relative, import.meta.url))
    return false
  } catch {
    return true
  }
}

check(await gone('../lib/notify.ps1'), 'notify.ps1 is gone')
check(await gone('../lib/notify/_common.ps1'), 'notify/_common.ps1 is gone')
check(await gone('../lib/notify/_kinds.ps1'), 'notify/_kinds.ps1 is gone')
check(await gone('../lib/focus-dsh.ps1'), 'focus-dsh.ps1 is gone')
check(await gone('../lib/focus-dsh.vbs'), 'focus-dsh.vbs is gone')
check(await gone('../test/toast-probe.ps1'), 'toast-probe.ps1 is gone')
check(await gone('../test/flash-probe.ps1'), 'flash-probe.ps1 is gone')

// --- Taskbar flash stays OS-owned and stoppable. ---
check(/FlashTray\s*=\s*0x2\b/.test(source), 'helper defines FLASHW_TRAY (2)')
check(/FlashTimerNoForeground\s*=\s*0xC\b/.test(source), 'helper defines FLASHW_TIMERNOFG (12)')
check(
  /dwFlags\s*=\s*FlashTray\s*\|\s*FlashTimerNoForeground/.test(source),
  'helper combines the two flags for FlashWindowEx',
)
check(!/Task\.Delay\(3000\)/.test(source), 'helper has no 3-second re-pulse timer')
check(!/_flashEnabled|_flashGeneration/.test(source), 'helper has no periodic flash state machine')
check(/static void StopTaskbarFlash/.test(source), 'helper exposes an explicit FLASHW_STOP')
check(/GetForegroundWindow/.test(source), 'helper does not arm a flash while DSH is foreground')
check(/_flashHwnd/.test(source), 'helper remembers the armed window for an explicit stop')
check(
  /SetWinEventHook\(\s*EventSystemForeground/.test(source) &&
    /static void OnForegroundChanged/.test(source),
  'helper stops the flash as soon as a DSH window is foreground',
)

// --- One attention entry point, driven by the host policy. ---
check(/static void StartAttention\(EffectPolicy\? effects, string reason\)/.test(source),
  'helper has one StartAttention entry point')
check(/if \(effects\.Blink\) StartTrayBlink/.test(source), 'StartAttention arms the tray blink when enabled')
check(/if \(effects\.Flash\) FlashTaskbar/.test(source), 'StartAttention arms the taskbar flash when enabled')
check(
  /static void StopAttention\(\)[\s\S]{0,160}StopTaskbarFlash\(\)[\s\S]{0,160}StopTrayBlink\(\)/.test(source),
  'StopAttention stops both effects',
)
check(/case "attention":/.test(source), 'helper accepts an effect-only attention op')
check(/case "config":/.test(source), 'helper accepts the tray/blink config op')

// --- Toast dismissal honours the per-event policy, not a hard-coded flash. ---
check(/StartAttention\(message\.Effects/.test(source), 'notify toasts start their configured effects')
check(/StartAttention\(flow\.Effects/.test(source), 'question toasts start their configured effects')
check(/effects\?\.Timing == "immediate"/.test(source) && /Timing == "immediate"/.test(source),
  'helper honours the immediate timing')
check(/!effects\.Toast/.test(source), 'the receipt toast can be turned off')

// --- QQ-style tray blink. ---
check(/static void StartTrayBlink\(/.test(source), 'helper owns the tray blink start')
check(/static void StopTrayBlink\(/.test(source), 'helper owns the tray blink stop')
check(/NotifyIcon/.test(source), 'the blink uses a NotifyIcon')
check(/Application\.Run\(context\)/.test(source), 'the tray icon runs on its own message loop')
check(/SetApartmentState\(ApartmentState\.STA\)/.test(source), 'the tray thread is STA')
check(/TestDshWindowFocused\(\)/.test(source), 'the tray blink stops when DSH is foreground')
check(/DestroyIcon\(handle\)/.test(source), 'drawn tray icons release their HICON')
check(/static void TickBlink\(\)/.test(source) && /_blinkMaxMinutes/.test(source),
  'the tray blink has an expiry guard')
check(/Tray icon build failed|BuildBlinkIcon/.test(source), 'the tray frames are built at runtime')

// --- Existing helper seams stay intact. ---
check(/static bool ShowToast/.test(source), 'helper owns toast delivery')
check(/static void EnsureToastIdentity/.test(source), 'helper owns the toast identity')
check(/static void FocusDsh/.test(source), 'helper owns click-to-focus')
check(
  /FindDshWindow\(includeHidden: true\)/.test(source) && /keybd_event\(/.test(source),
  'click-to-focus shows a hidden window and forces the foreground',
)

console.log(failed ? 'ATTENTION POLICY TEST FAILED' : 'ATTENTION POLICY TEST PASSED')
if (failed) process.exit(1)
