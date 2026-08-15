param(
  [Parameter(Mandatory = $true)][string]$Kind,
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body
)

$ErrorActionPreference = 'Continue'
$flashOk = $false
$toastShown = $false
$balloonShown = $false

# ---------------------------------------------------------------------------
# 1. Native Windows 11 toast (WinRT). A monotonic per-process sequence id keeps
#    every toast in the Win11 notification queue instead of being dropped when
#    finished tasks arrive close together (multi-project bursts).
# ---------------------------------------------------------------------------
$seqPath = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-notify-tag'
$seq = 0
try { $seq = [int](Get-Content $seqPath -ErrorAction SilentlyContinue) } catch { $seq = 0 }
$seq += 1
try { Set-Content -Path $seqPath -Value $seq -ErrorAction SilentlyContinue } catch {}
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $titleXml = $Title -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;'
  $bodyXml = $Body -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;'
  $xml = '<toast><visual><binding template="ToastGeneric">' +
    '<text>' + $titleXml + '</text>' +
    '<text>' + $bodyXml + '</text>' +
    '</binding></visual></toast>'
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  # Use the system-registered PowerShell identity: toasts with an unregistered
  # AppUserModelID are silently dropped on Win10/11, while this identity (a
  # Start-Menu registered shortcut) reliably displays.
  $toastAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($toastAppId)
  $toast.Tag = 'dsh-notify-' + $seq
  $notifier.Show($toast)
  $toastShown = $true
} catch {
  $toastShown = $false
}

# ---------------------------------------------------------------------------
# 2. Fallback: classic NotifyIcon balloon (only when the toast failed).
# ---------------------------------------------------------------------------
if (-not $toastShown) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $ni = New-Object System.Windows.Forms.NotifyIcon
    $ni.Icon = [System.Drawing.SystemIcons]::Information
    $ni.Visible = $true
    $ni.BalloonTipTitle = $Title
    $ni.BalloonTipText = $Body
    $ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
    $ni.ShowBalloonTip(8000)
    $balloonShown = $true
    Start-Sleep -Milliseconds 8500
    $ni.Dispose()
  } catch {
    $balloonShown = $false
  }
}

# ---------------------------------------------------------------------------
# 3. Taskbar flash: FlashWindowEx on the DeepSeek Harness top-level window,
#    FLASHW_ALL | FLASHW_TIMERNOFG = 15 (keeps flashing until focused).
# ---------------------------------------------------------------------------
try {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DshFlash {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO info);
  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO {
    public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout;
  }
}
'@
  $script:found = [IntPtr]::Zero
  $callback = [DshFlash+EnumProc]{
    param($h, $l)
    if ([DshFlash]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][DshFlash]::GetWindowText($h, $sb, $sb.Capacity)
      $title = $sb.ToString()
      # An Edge/msedge window's title is the ACTIVE tab, which may be another
      # project while the dsh tab sits in the same window. Match the dsh tab
      # by title OR the harness port/name so multi-tab setups still flash.
      if ($title -like 'DeepSeek*' -or $title -like '*3080* - DeepSeek*' -or $title -like '*:3080*' -or $title -like '*DeepSeek Harness*') {
        $script:found = $h
        return $false
      }
    }
    return $true
  }
  [void][DshFlash]::EnumWindows($callback, [IntPtr]::Zero)
  if ($script:found -ne [IntPtr]::Zero) {
    $info = New-Object DshFlash+FLASHWINFO
    $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][DshFlash+FLASHWINFO])
    $info.hwnd = $script:found
    $info.dwFlags = 15   # FLASHW_ALL(3) | FLASHW_TIMERNOFG(12)
    $info.uCount = 0     # flash until the window comes to the foreground
    $info.dwTimeout = 0
    [void][DshFlash]::FlashWindowEx([ref]$info)
    $flashOk = $true
  }
} catch {
  $flashOk = $false
}

Write-Output ("notify:kind={0};toast={1};balloon={2};flash={3}" -f $Kind, $toastShown, $balloonShown, $flashOk)
