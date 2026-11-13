// Attention guard for the .NET helper.
//
// The taskbar flash is no longer the default: each event's policy decides
// whether the helper shows a toast, blinks the unread badge on DSH's own
// taskbar button, pulses the taskbar button, or does several of them. The
// flash must stay OS-owned (FLASHW_TRAY | FLASHW_TIMERNOFG) and stop when DSH
// comes to the foreground; there is still no periodic re-pulse timer. The
// QQ-style badge lives in TaskbarBadge.cs (ITaskbarList3 overlay, no extra tray
// icon), and every path routes through StartAttention/StopAttention.
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
check(/if \(!StartTrayBadge/.test(source) && /else[\s\S]{0,80}StartTaskbarBadge|StartTaskbarBadge\(reason/.test(source),
  'StartAttention prefers the tray dot and falls back to the taskbar badge')
check(/if \(effects\.Flash\) FlashTaskbar/.test(source), 'StartAttention arms the taskbar flash when enabled')
check(
  /static void StopAttention\(\)[\s\S]{0,160}StopTaskbarFlash\(\)[\s\S]{0,160}StopTaskbarBadge\(\)/.test(source),
  'StopAttention stops both effects',
)
check(/case "attention":/.test(source), 'helper accepts an effect-only attention op')
check(/case "config":/.test(source), 'helper accepts the badge timing config op')

// --- Toast dismissal honours the per-event policy, not a hard-coded flash. ---
check(/StartAttention\(message\.Effects/.test(source), 'notify toasts start their configured effects')
check(/StartAttention\(flow\.Effects/.test(source), 'question toasts start their configured effects')
check(/effects\?\.Timing == "immediate"/.test(source) && /Timing == "immediate"/.test(source),
  'helper honours the immediate timing')
check(/!effects\.Toast/.test(source), 'the receipt toast can be turned off')

// --- QQ-style unread badge on DSH's own taskbar button. ---
// --- QQ-style unread dot over DSH's own tray icon. ---
check(/static bool StartTrayBadge\(/.test(source), 'helper owns the tray dot start')
check(/Shell_NotifyIconGetRect/.test(source), 'the dot is placed with the documented tray rect API')
check(/Electron_NotifyIconHostWindow/.test(source), "the dot finds Electron's tray host window")
check(/WsExTransparent/.test(source) && /WsExLayered/.test(source) && /WsExNoActivate/.test(source),
  'the dot window is layered and click-through')
check(/SetProcessDpiAwarenessContext/.test(source) && /EnablePhysicalPixels\(\);/.test(source),
  'the helper works in physical pixels so the dot lands on the icon')
check(/static void StopTrayBadge\(/.test(source), 'helper owns the tray dot stop')
check(/_blinkMaxMinutes/.test(source) && /tray badge stopped: timed out/.test(source),
  'the tray dot has an expiry guard')
check(/RectRefreshMs/.test(source), 'the tray rect is re-read instead of cached forever')
check(/tray badge lost the icon; falling back to the taskbar badge/.test(source),
  'an icon moved into the overflow mid-blink retargets to the taskbar badge')

check(await gone('../src/DshToastQuestion/Platform/TrayBlink.cs'), 'the extra tray icon implementation is gone')
check(!/_trayIconMode|StartTrayBlink|StopTrayBlink|TrayBlinking/.test(source),
  'no tray-blink code remains in the helper')
check(/static void StartTaskbarBadge\(/.test(source), 'helper owns the badge start')
check(/static void StopTaskbarBadge\(/.test(source), 'helper owns the badge stop')
check(/ITaskbarList3/.test(source) && /SetOverlayIcon/.test(source),
  'the badge is an ITaskbarList3 overlay on the DSH window')
check(/CoInitializeEx\(/.test(source), 'the badge thread initializes COM')
check(/SetApartmentState\(ApartmentState\.STA\)/.test(source), 'the badge thread is STA')
check(/TestDshWindowFocused\(\)/.test(source), 'the badge stops when DSH is foreground')
check(/DestroyIcon\(icon\)/.test(source), 'the drawn badge releases its HICON')
check(/_blinkMaxMinutes/.test(source) && /taskbar badge stopped: timed out/.test(source),
  'the badge has an expiry guard')
check(/static void DisposeTaskbarBadge\(/.test(source) && /DisposeTaskbarBadge\(\)/.test(source),
  'the badge is cleared synchronously before the helper exits')
check(/static void ClearStaleTaskbarBadge\(/.test(source) && /ClearStaleTaskbarBadge\(\);/.test(source),
  'a stale badge from a killed helper is cleared on startup')

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
