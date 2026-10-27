// Flash-policy guard for the sole (C#) implementation.
//
// The taskbar flash must stay OS-owned: FLASHW_TRAY | FLASHW_TIMERNOFG
// (2 | 12), uCount 0. Windows stops it when the DSH window comes to the
// foreground; an explicit FLASHW_STOP ends it when a question is resolved
// elsewhere. A periodic re-pulse (the old 3-second loop) must not come back.
//
// The notification path is now .NET-only. This test also pins that the
// PowerShell/VBS scripts are really gone, so a future change cannot quietly
// reintroduce a second implementation.
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

check(/FlashTray\s*=\s*0x2\b/.test(source), 'helper defines FLASHW_TRAY (2)')
check(/FlashTimerNoForeground\s*=\s*0xC\b/.test(source), 'helper defines FLASHW_TIMERNOFG (12)')
check(
  /dwFlags\s*=\s*FlashTray\s*\|\s*FlashTimerNoForeground/.test(source),
  'helper combines the two flags for FlashWindowEx',
)
check(!/Task\.Delay\(3000\)/.test(source), 'helper has no 3-second re-pulse timer')
check(!/_flashEnabled|_flashGeneration/.test(source), 'helper has no periodic flash state machine')
check(/static void StopTaskbarFlash/.test(source), 'helper exposes an explicit FLASHW_STOP')
check(
  (source.match(/StopTaskbarFlash\(\);/g) ?? []).length >= 3,
  'helper stops the flash on the answer/resolve paths',
)
check(/GetForegroundWindow/.test(source), 'helper does not arm a flash while DSH is foreground')

check(/case "notify":/.test(source), 'helper handles the non-interactive notify op')
check(/static bool ShowToast/.test(source), 'helper owns toast delivery')
check(/static void EnsureToastIdentity/.test(source), 'helper owns the toast identity')
check(/static void FocusDsh/.test(source), 'helper owns click-to-focus')

console.log(failed ? 'FLASH POLICY TEST FAILED' : 'FLASH POLICY TEST PASSED')
if (failed) process.exit(1)
