# flash-probe.ps1 — ASCII only. Flashes candidate windows and reports the
# foreground window at flash time, so we can tell "suppressed because
# foreground" apart from "wrong hwnd" / "OS not rendering".
$ErrorActionPreference = 'Continue'
Start-Sleep -Seconds 6

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DshFlashProbe {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO info);
  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO {
    public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout;
  }
}
'@

$script:cands = New-Object System.Collections.ArrayList
$callback = [DshFlashProbe+EnumProc]{
  param($h, $l)
  if ([DshFlashProbe]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][DshFlashProbe]::GetWindowText($h, $sb, $sb.Capacity)
    if ($sb.ToString() -like 'DeepSeek Harness*') { [void]$script:cands.Add($h) }
  }
  return $true
}
[void][DshFlashProbe]::EnumWindows($callback, [IntPtr]::Zero)

$fg = [DshFlashProbe]::GetForegroundWindow()
$sbFg = New-Object System.Text.StringBuilder 512
[void][DshFlashProbe]::GetWindowText($fg, $sbFg, $sbFg.Capacity)
Write-Output ("probe:foreground hwnd={0} title='{1}'" -f $fg, $sbFg.ToString())
Write-Output ("probe:candidates count={0}" -f $script:cands.Count)

foreach ($h in $script:cands) {
  $sbT = New-Object System.Text.StringBuilder 512
  [void][DshFlashProbe]::GetWindowText($h, $sbT, $sbT.Capacity)
  $info = New-Object DshFlashProbe+FLASHWINFO
  $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][DshFlashProbe+FLASHWINFO])
  $info.hwnd = $h
  $info.dwFlags = 3    # FLASHW_ALL
  $info.uCount = 5     # 5 pulses
  $info.dwTimeout = 0
  $ok = [DshFlashProbe]::FlashWindowEx([ref]$info)
  Write-Output ("probe:flash hwnd={0} title='{1}' ok={2}" -f $h, $sbT.ToString(), $ok)
  Start-Sleep -Seconds 2
}
