param(
  [Parameter(Mandatory = $true)][string]$Kind,
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [Parameter(Mandatory = $false)][string]$Launch = '',
  [Parameter(Mandatory = $false)][string]$SessionId = '',
  [Parameter(Mandatory = $false)][string]$Duration = 'short',
  [Parameter(Mandatory = $false)][string]$Reason = '',
  [Parameter(Mandatory = $false)][string]$Code = '',
  [Parameter(Mandatory = $false)][string]$Retry = '',
  [Parameter(Mandatory = $false)][string]$RetryMax = ''
)

# dsh-notify-win entry point.
#
# Responsibilities stay deliberately thin: validate the stop-reason kind,
# resolve the shared helpers, then run the fixed pipeline
#   identity/protocol -> toast -> balloon fallback -> taskbar flash.
# Per-kind presentation lives in notify/_kinds.ps1; OS plumbing lives in
# notify/_common.ps1. See README "Stop conditions" for the kind vocabulary.
#
# -Reason / -Code / -Retry / -RetryMax are diagnostics supplied by the host
# plugin (turn-end reason, provider-neutral failure code, retry count). They do
# not change the pipeline; they are echoed so a manual run reproduces the toast.

$ErrorActionPreference = 'Continue'

# lib/ holds the assets; dot-sourced files must not resolve assets from their
# own directory (lib/notify/).
$script:DshAssetRoot = $PSScriptRoot

$commonPath = Join-Path $PSScriptRoot 'notify\_common.ps1'
$kindsPath = Join-Path $PSScriptRoot 'notify\_kinds.ps1'
if (-not ((Test-Path $commonPath) -and (Test-Path $kindsPath))) {
  Write-Output ("notify:kind={0};error=helper-files-missing" -f $Kind)
  exit 3
}
. $commonPath
. $kindsPath

# If the DSH window is already focused the user is already looking at DSH - skip
# the toast entirely. The UI surfaces pending questions/approvals directly, so a
# toast would only be noise.
if (Test-DshWindowFocused) {
  Write-Output ("notify:kind={0};reason={1};code={2};skipped;why=dsh-focused" -f $Kind, $Reason, $Code)
  exit 0
}

# One-time (idempotent) environment setup. Each stage is best-effort: a failure
# must never stop the toast, the balloon fallback, or the taskbar flash.
try { Initialize-DshToastIdentity } catch {}
try { Register-DshNotifyProtocol } catch {}

$heroUri = ''
try { $heroUri = Get-DshHeroUri } catch { $heroUri = '' }

$xml = New-DshToastXml -Kind $Kind -Title $Title -Body $Body -Launch $Launch -Duration $Duration -HeroUri $heroUri
$toast = Show-DshToast -Xml $xml -Tag ('dsh-notify-' + (Get-DshToastSequence))

# Classic NotifyIcon balloon only when the WinRT toast could not be shown.
$balloonShown = $false
if (-not $toast.Shown) {
  try { $balloonShown = Show-DshBalloon -Title $Title -Body $Body } catch { $balloonShown = $false }
}

$flash = [pscustomobject]@{ Ok = $false; Title = ''; Hwnd = [IntPtr]::Zero }
try { $flash = Show-DshTaskbarFlash } catch {}

$debugLine = ("notify:kind={0};reason={1};code={2};retry={3}/{4};toast={5};balloon={6};flash={7};aumid={8};flashTitle={9};flashHwnd={10}" -f $Kind, $Reason, $Code, $Retry, $RetryMax, $toast.Shown, $balloonShown, $flash.Ok, $toast.Aumid, $flash.Title, $flash.Hwnd)
Write-Output $debugLine
