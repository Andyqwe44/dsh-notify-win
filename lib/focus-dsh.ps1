# focus-dsh.ps1 - bring an existing DeepSeek Harness PWA/browser window to the
# foreground; if none is open, launch the installed Edge PWA.
param([string]$Uri = '')

# If the toast was an answer action, forward the selected option / custom text
# to the host before focusing the window.
if ($Uri -like 'dsh-notify://answer*') {
  $qIndex = $Uri.IndexOf('?')
  if ($qIndex -ge 0) {
    $query = $Uri.Substring($qIndex)
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:3080/dsh-notify/answer$query" -TimeoutSec 3 | Out-Null
    } catch {
      # Host may be briefly unavailable; the toast still focuses DSH.
    }
  }
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DshFocus {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

$script:found = [IntPtr]::Zero
$callback = [DshFocus+EnumProc]{
  param($h, $l)
  if ([DshFocus]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][DshFocus]::GetWindowText($h, $sb, $sb.Capacity)
    $title = $sb.ToString()
    if ($title -like '*DeepSeek Harness*') {
      $script:found = $h
      return $false
    }
  }
  return $true
}
[void][DshFocus]::EnumWindows($callback, [IntPtr]::Zero)

if ($script:found -ne [IntPtr]::Zero) {
  [void][DshFocus]::ShowWindow($script:found, 9)  # SW_RESTORE
  [void][DshFocus]::SetForegroundWindow($script:found)
  exit 0
}

$pwa = Get-StartApps | Where-Object {
  $_.Name -eq 'DeepSeek Harness' -and $_.AppID -like '*!App' -and $_.AppID -ne 'DeepSeekHarness'
} | Select-Object -First 1
if ($pwa) {
  Start-Process 'explorer.exe' -ArgumentList "shell:AppsFolder\$($pwa.AppID)"
}
