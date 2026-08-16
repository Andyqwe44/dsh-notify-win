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

# ---------------------------------------------------------------------------
# 0. Branded identity self-registration (one-time, idempotent). For an
#    unpackaged app, the Start Menu shortcut carrying the AppUserModelID is
#    what makes the toast header show the app name and icon; the registry
#    DisplayName/IconUri complement it. Runs at most once per user (marker
#    value on the identity key); failures fall back to the PowerShell
#    identity for the toast itself.
# ---------------------------------------------------------------------------
$brandAumid = 'DeepSeekHarness'
$regPath = "HKCU:\Software\Classes\AppUserModelID\$brandAumid"
if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
try {
  $regProps = Get-ItemProperty -Path $regPath -ErrorAction Stop
  $regIcon = Join-Path $PSScriptRoot 'dsh-logo-light.png'
  if ($regProps.DisplayName -ne 'DeepSeek Harness') { Set-ItemProperty -Path $regPath -Name 'DisplayName' -Value 'DeepSeek Harness' -ErrorAction Stop }
  if ($regProps.IconUri -ne $regIcon) { Set-ItemProperty -Path $regPath -Name 'IconUri' -Value $regIcon -ErrorAction Stop }
} catch {
  # Registry write failed; the toast still falls back below.
}
if ($regProps.ShortcutRegistered -ne '1') {
  $shortcutOk = $false
  $lnkPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk'
  $icoPath = Join-Path $PSScriptRoot 'dsh-logo.ico'
  try {
    $hasAumid = $false
    if (Test-Path $lnkPath) {
      $bytes = [System.IO.File]::ReadAllBytes($lnkPath)
      $hasAumid = [System.Text.Encoding]::Unicode.GetString($bytes).Contains($brandAumid)
    }
    if (-not $hasAumid -and (Test-Path $icoPath)) {
      # Recreate the shortcut and set the AppUserModelID extended property
      # through the property system (the ShellLink COM property store does
      # not persist it). Retry: the Start Menu file can be transiently
      # locked by Explorer's indexer.
      $ws = New-Object -ComObject WScript.Shell
      $sc = $ws.CreateShortcut($lnkPath)
      $sc.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
      $sc.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -Command "exit"'
      $sc.IconLocation = "$icoPath,0"
      $sc.Description = 'DeepSeek Harness notifications'
      $sc.Save()
      Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class DshToastIdentity {
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint cProps);
    [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    [PreserveSig] int Commit();
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

  [StructLayout(LayoutKind.Explicit)]
  public struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pwszVal;
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHGetPropertyStoreFromParsingName(string pszPath, IntPtr pbc, uint flags, ref Guid riid, out IntPtr ppv);

  public static void Set(string lnkPath, string appId) {
    var iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IntPtr ppv;
    int hr = SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2, ref iid, out ppv);
    if (hr != 0) throw new COMException("property store open failed: 0x" + hr.ToString("X8"), hr);
    var props = (IPropertyStore)Marshal.GetObjectForIUnknown(ppv);
    try {
      var key = new PROPERTYKEY();
      key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
      key.pid = 5;
      var pv = new PROPVARIANT();
      pv.vt = 31;
      pv.pwszVal = Marshal.StringToCoTaskMemUni(appId);
      try {
        hr = props.SetValue(ref key, ref pv);
        if (hr != 0) throw new COMException("SetValue failed: 0x" + hr.ToString("X8"), hr);
        hr = props.Commit();
        if (hr != 0) throw new COMException("Commit failed: 0x" + hr.ToString("X8"), hr);
      } finally {
        Marshal.FreeCoTaskMem(pv.pwszVal);
      }
    } finally {
      Marshal.ReleaseComObject(props);
      Marshal.Release(ppv);
    }
  }
}
'@
      $attempt = 0
      while (-not $shortcutOk -and $attempt -lt 3) {
        $attempt++
        try {
          [DshToastIdentity]::Set($lnkPath, $brandAumid)
          $shortcutOk = $true
        } catch {
          Start-Sleep -Milliseconds 400
        }
      }
    } elseif ($hasAumid) {
      $shortcutOk = $true
    }
  } catch {
    $shortcutOk = $false
  }
  if ($shortcutOk) {
    try { Set-ItemProperty -Path $regPath -Name 'ShortcutRegistered' -Value '1' -ErrorAction Stop } catch {}
  }
}

try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $titleXml = $Title -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;'
  $bodyXml = $Body -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;'
  # DeepSeek Harness logo as the toast app logo (overrides the PowerShell
  # identity's icon). The favicon is monochrome - black on light, white on
  # dark - and toast rendering does not apply CSS media queries, so the
  # variant is chosen here from the OS theme preference.
  $lightTheme = $true
  try {
    $theme = Get-ItemPropertyValue -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction Stop
    $lightTheme = $theme -ne 0
  } catch {
    $lightTheme = $true
  }
  $heroFile = Join-Path $PSScriptRoot $(if ($lightTheme) { 'dsh-hero-light.png' } else { 'dsh-hero-dark.png' })
  $heroUri = ''
  if (Test-Path $heroFile) {
    $heroUri = 'file:///' + ($heroFile -replace '\\', '/')
  }
  $xml = '<toast><visual><binding template="ToastGeneric">' +
    $(if ($heroUri -ne '') { '<image placement="hero" src="' + $heroUri + '"/>' } else { '' }) +
    '<text>' + $titleXml + '</text>' +
    '<text>' + $bodyXml + '</text>' +
    '</binding></visual></toast>'
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  $toast.Tag = 'dsh-notify-' + $seq
  # Branded AppUserModelID (registered in section 0 above). Unregistered
  # AUMIDs are silently dropped, so fall back to the system-registered
  # PowerShell identity if the branded one cannot be used.
  $notifier = $null
  try {
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($brandAumid)
    $notifier.Show($toast)
  } catch {
    $notifier = $null
  }
  if ($null -eq $notifier) {
    # Use the system-registered PowerShell identity: toasts with an
    # unregistered AppUserModelID are silently dropped on Win10/11, while this
    # identity (a Start-Menu registered shortcut) reliably displays.
    $toastAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($toastAppId)
    $notifier.Show($toast)
  }
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
