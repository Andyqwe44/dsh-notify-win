# dsh-notify-win shared helpers, dot-sourced by ../notify.ps1.
#
# ASCII only: Windows PowerShell 5.1 reads a -File script with the ANSI code
# page, so non-ASCII comments would not survive. All user-visible text arrives
# as parameters (already UTF-8 decoded by the caller's argv).
#
# Every function here is best-effort: a failure in one stage must never stop
# the later stages (toast -> balloon -> taskbar flash).

$ErrorActionPreference = 'Continue'

# $script:DshAssetRoot is set by the entry script (lib/). Resolving assets from
# $PSScriptRoot inside this file would point at lib/notify/ instead.
function Get-DshAssetPath {
  param([Parameter(Mandatory = $true)][string]$Leaf)
  return Join-Path $script:DshAssetRoot $Leaf
}

# ---------------------------------------------------------------------------
# Toast identity (one-time, idempotent)
#
# For an unpackaged app, the Start Menu shortcut carrying the AppUserModelID is
# what makes the toast header show the app name and icon; the registry
# DisplayName/IconUri complement it. Runs at most once per user (marker value
# on the identity key); failures fall back to the PowerShell identity.
# ---------------------------------------------------------------------------
function Initialize-DshToastIdentity {
  $brandAumid = 'DeepSeekHarness'
  $regPath = "HKCU:\Software\Classes\AppUserModelID\$brandAumid"
  if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
  try {
    $regProps = Get-ItemProperty -Path $regPath -ErrorAction Stop
    $regIcon = Get-DshAssetPath 'dsh-logo-light.png'
    if ($regProps.DisplayName -ne 'DeepSeek Harness') { Set-ItemProperty -Path $regPath -Name 'DisplayName' -Value 'DeepSeek Harness' -ErrorAction Stop }
    if ($regProps.IconUri -ne $regIcon) { Set-ItemProperty -Path $regPath -Name 'IconUri' -Value $regIcon -ErrorAction Stop }
  } catch {
    # Registry write failed; the toast still falls back to another identity.
    $regProps = $null
  }
  $lnkPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk'
  $icoPath = Get-DshAssetPath 'dsh-logo.ico'
  $helperPath = Get-DshAssetPath 'dsh-toast-question.exe'
  $shortcutTargetOk = $false
  if (Test-Path $lnkPath) {
    try {
      $wsProbe = New-Object -ComObject WScript.Shell
      $scProbe = $wsProbe.CreateShortcut($lnkPath)
      $shortcutTargetOk = ($scProbe.TargetPath -eq $helperPath)
    } catch {}
  }
  if ($null -ne $regProps -and $regProps.ShortcutRegistered -eq '1' -and $shortcutTargetOk) { return }
  $shortcutOk = $false
  try {
    $hasAumid = $false
    if (Test-Path $lnkPath) {
      $bytes = [System.IO.File]::ReadAllBytes($lnkPath)
      $hasAumid = [System.Text.Encoding]::Unicode.GetString($bytes).Contains($brandAumid)
    }
    if ((Test-Path $icoPath) -and (Test-Path $helperPath)) {
      # Recreate the shortcut and set the AppUserModelID extended property
      # through the property system (the ShellLink COM property store does not
      # persist it). Retry: the Start Menu file can be transiently locked by
      # Explorer's indexer. The target must be the toast question helper so
      # foreground toast activation reaches the running .NET helper.
      $ws = New-Object -ComObject WScript.Shell
      $sc = $ws.CreateShortcut($lnkPath)
      $sc.TargetPath = $helperPath
      $sc.Arguments = ''
      $sc.IconLocation = "$icoPath,0"
      $sc.Description = 'DeepSeek Harness notifications'
      $sc.WindowStyle = 7
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
    } elseif ($hasAumid -and $shortcutTargetOk) {
      $shortcutOk = $true
    }
  } catch {
    $shortcutOk = $false
  }
  if ($shortcutOk) {
    try { Set-ItemProperty -Path $regPath -Name 'ShortcutRegistered' -Value '1' -ErrorAction Stop } catch {}
  }
}

# ---------------------------------------------------------------------------
# dsh-notify:// protocol: clicking a toast focuses/launches the installed
# DeepSeek Harness app (the browser-side client then reads the pending session
# from the host HTTP route). Idempotent, best-effort.
# ---------------------------------------------------------------------------
function Register-DshNotifyProtocol {
  $protoName = 'dsh-notify'
  $protoRoot = "HKCU:\Software\Classes\$protoName"
  try {
    if (-not (Test-Path $protoRoot)) { New-Item -Path $protoRoot -Force | Out-Null }
    Set-ItemProperty -Path $protoRoot -Name '(default)' -Value 'URL:dsh-notify Protocol' -ErrorAction Stop
    Set-ItemProperty -Path $protoRoot -Name 'URL Protocol' -Value '' -ErrorAction Stop
    $protoCmd = "$protoRoot\shell\open\command"
    New-Item -Path $protoCmd -Force | Out-Null
    # Find the installed DSH app (skip the toast identity AUMID registered above).
    $pwaAumid = $null
    try {
      $pwa = Get-StartApps | Where-Object {
        $_.Name -eq 'DeepSeek Harness' -and $_.AppID -like '*!App' -and $_.AppID -ne 'DeepSeekHarness'
      } | Select-Object -First 1
      if ($pwa) { $pwaAumid = $pwa.AppID }
    } catch {}
    $focusScript = Get-DshAssetPath 'focus-dsh.ps1'
    $focusVbs = Get-DshAssetPath 'focus-dsh.vbs'
    if (Test-Path $focusVbs) {
      # wscript runs the VBS hidden, which launches PowerShell hidden too - no
      # console flash when the toast is clicked. %1 is the invoked dsh-notify URI.
      $handler = "wscript.exe `"$focusVbs`" `"%1`""
      Set-ItemProperty -Path $protoCmd -Name '(default)' -Value $handler -ErrorAction Stop
    } elseif (Test-Path $focusScript) {
      $handler = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File `"$focusScript`""
      Set-ItemProperty -Path $protoCmd -Name '(default)' -Value $handler -ErrorAction Stop
    } elseif ($pwaAumid) {
      $handler = "cmd.exe /c start `"`" shell:AppsFolder\$pwaAumid"
      Set-ItemProperty -Path $protoCmd -Name '(default)' -Value $handler -ErrorAction Stop
    }
  } catch {
    # Protocol registration failed; clicking the toast simply dismisses it.
  }
}

# ---------------------------------------------------------------------------
# Focus check: when DSH is already the foreground window the user is looking at
# the UI, which surfaces pending questions/approvals itself, so a toast is noise.
# ---------------------------------------------------------------------------
function Test-DshWindowFocused {
  try {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DshFocusCheck {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr IntPtr, StringBuilder sb, int max);
}
'@
    $fg = [DshFocusCheck]::GetForegroundWindow()
    if ($fg -eq [IntPtr]::Zero) { return $false }
    $sb = New-Object System.Text.StringBuilder 512
    [void][DshFocusCheck]::GetWindowText($fg, $sb, $sb.Capacity)
    return $sb.ToString() -like '*DeepSeek Harness*'
  } catch {
    return $false
  }
}

# ---------------------------------------------------------------------------
# Theme-aware hero image. The favicon is monochrome (black on light, white on
# dark) and toast rendering ignores CSS media queries, so pick the variant here.
# ---------------------------------------------------------------------------
function Get-DshHeroUri {
  $lightTheme = $true
  try {
    $theme = Get-ItemPropertyValue -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction Stop
    $lightTheme = $theme -ne 0
  } catch {
    $lightTheme = $true
  }
  $heroFile = Get-DshAssetPath $(if ($lightTheme) { 'dsh-hero-light.png' } else { 'dsh-hero-dark.png' })
  if (-not (Test-Path $heroFile)) { return '' }
  return 'file:///' + ($heroFile -replace '\\', '/')
}

function ConvertTo-DshXmlText {
  param([string]$Text)
  return ([string]$Text -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;')
}

function ConvertTo-DshXmlAttribute {
  param([string]$Text)
  return ([string]$Text -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;')
}

# A monotonic per-process sequence id keeps every toast in the Win11
# notification queue instead of being dropped when several arrive together.
function Get-DshToastSequence {
  $seqPath = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-notify-tag'
  $seq = 0
  try { $seq = [int](Get-Content $seqPath -ErrorAction SilentlyContinue) } catch { $seq = 0 }
  $seq += 1
  try { Set-Content -Path $seqPath -Value $seq -ErrorAction SilentlyContinue } catch {}
  return $seq
}

# ---------------------------------------------------------------------------
# Show one toast. The branded DeepSeekHarness identity is registered by
# Initialize-DshToastIdentity (AppUserModelID key + Start Menu shortcut), so the
# header reads "DeepSeek Harness" with our own icon instead of "Windows
# PowerShell". The system identities remain as fallbacks: an identity whose
# notifier cannot be created throws, and then the next one is tried.
# ---------------------------------------------------------------------------
function Show-DshToast {
  param(
    [Parameter(Mandatory = $true)][string]$Xml,
    [Parameter(Mandatory = $true)][string]$Tag
  )
  $result = [pscustomobject]@{ Shown = $false; Aumid = '' }
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($Xml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
    $toast.Tag = $Tag
    $pwaAumid = $null
    try {
      $pwaAumid = (Get-StartApps | Where-Object {
        $_.Name -eq 'DeepSeek Harness' -and $_.AppID -like '*!App' -and $_.AppID -ne 'DeepSeekHarness'
      } | Select-Object -First 1).AppID
    } catch {}
    $candidates = @()
    # Branded identity first: registered by Initialize-DshToastIdentity, so the
    # toast header reads "DeepSeek Harness" with our own icon.
    $candidates += ,@('DeepSeekHarness', 'branded')
    if ($pwaAumid) { $candidates += ,@($pwaAumid, 'pwa') }
    $candidates += ,@('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe', 'powershell')
    foreach ($candidate in $candidates) {
      $appId = $candidate[0]
      try {
        $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
        $notifier.Show($toast)
        $result.Shown = $true
        $result.Aumid = $appId
        break
      } catch {
        # try the next identity
      }
    }
  } catch {
    $result.Shown = $false
  }
  return $result
}

# ---------------------------------------------------------------------------
# Fallback: classic NotifyIcon balloon (only when the toast failed). The sleep
# keeps the script alive long enough for the balloon to appear.
# ---------------------------------------------------------------------------
function Show-DshBalloon {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Body
  )
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
    Start-Sleep -Milliseconds 8500
    $ni.Dispose()
    return $true
  } catch {
    return $false
  }
}

# ---------------------------------------------------------------------------
# Taskbar flash: FlashWindowEx on the DeepSeek Harness top-level window,
# FLASHW_TRAY | FLASHW_TIMERNOFG (14) - the taskbar button only, kept flashing
# until the window comes to the foreground. Also used by the .NET question
# helper (see Program.cs FlashTaskbar).
# ---------------------------------------------------------------------------
function Show-DshTaskbarFlash {
  $result = [pscustomobject]@{ Ok = $false; Title = ''; Hwnd = [IntPtr]::Zero }
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
    $script:foundTitle = ''
    $callback = [DshFlash+EnumProc]{
      param($h, $l)
      if ([DshFlash]::IsWindowVisible($h)) {
        $sb = New-Object System.Text.StringBuilder 512
        [void][DshFlash]::GetWindowText($h, $sb, $sb.Capacity)
        $title = $sb.ToString()
        # Prefer the actual DSH window: its title ends with the em dash
        # (U+2014) plus "DeepSeek Harness". This file stays ASCII, so the em
        # dash is expressed as a .NET regex \u2014 escape. Other Edge windows
        # can contain the repo description and must not steal the flash.
        if ($title -match '\u2014\s*DeepSeek Harness\s*$' -or $title -match '\u2014\s*DeepSeek Harness') {
          $script:found = $h
          $script:foundTitle = $title
          return $false
        }
        if ($script:found -eq [IntPtr]::Zero -and
            ($title -like 'DeepSeek*' -or $title -like '*3080* - DeepSeek*' -or $title -like '*:3080*' -or $title -like '*DeepSeek Harness*')) {
          $script:found = $h
          $script:foundTitle = $title
        }
      }
      return $true
    }
    [void][DshFlash]::EnumWindows($callback, [IntPtr]::Zero)
    if ($script:found -ne [IntPtr]::Zero) {
      $result.Hwnd = $script:found
      $result.Title = $script:foundTitle
      $info = New-Object DshFlash+FLASHWINFO
      $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][DshFlash+FLASHWINFO])
      $info.hwnd = $script:found
      $info.dwFlags = 14   # FLASHW_TRAY(2) | FLASHW_TIMERNOFG(12) - taskbar button only
      $info.uCount = 0     # flash until the window comes to the foreground
      $info.dwTimeout = 0
      [void][DshFlash]::FlashWindowEx([ref]$info)
      $result.Ok = $true
    }
  } catch {
    $result.Ok = $false
  }
  return $result
}
