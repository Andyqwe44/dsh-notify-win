# toast-probe.ps1 — ASCII only, tests which toast identity is VISIBLE on this PC.
$ErrorActionPreference = 'Continue'

# Give the user time to switch away from the browser (taskbar flash test).
Start-Sleep -Seconds 8

function Try-Toast($appId, $text) {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $xml = '<toast><visual><binding template="ToastGeneric"><text>dsh-notify-win probe</text><text>' + $text + '</text></binding></visual></toast>'
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
    $notifier.Show($toast)
    return $true
  } catch { return $false }
}

$r1 = Try-Toast 'DeepSeekHarness' 'test1: unregistered AUMID'
Start-Sleep -Seconds 3
$r2 = Try-Toast '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe' 'test2: PowerShell identity'
Start-Sleep -Seconds 3
$r3 = $false
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $ni = New-Object System.Windows.Forms.NotifyIcon
  $ni.Icon = [System.Drawing.SystemIcons]::Information
  $ni.Visible = $true
  $ni.BalloonTipTitle = 'dsh-notify-win probe'
  $ni.BalloonTipText = 'test3: balloon fallback'
  $ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
  $ni.ShowBalloonTip(6000)
  $r3 = $true
  Start-Sleep -Seconds 7
  $ni.Dispose()
} catch { $r3 = $false }

Write-Output ("probe:t1={0};t2={1};balloon={2}" -f $r1, $r2, $r3)
