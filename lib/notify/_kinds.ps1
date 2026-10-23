# dsh-notify-win per-kind toast building, dot-sourced by ../notify.ps1.
#
# One place decides what each notification class looks like, so adding a stop
# reason means adding one entry to $script:DshKindStyles plus a caller value -
# not editing a 400-line script. ASCII only (see _common.ps1).
#
# Kinds:
#   done     normal completion / context compacted
#   alert    max-tokens, blocked, LLM failure, failed compaction
#   notice   cancelled by the user, parent, or a hook
#   question approval prompt (interactive questions use the .NET helper)
#
# Every kind is badge-only: no hero banner anywhere, so the toast stays compact
# and only the app icon in the header identifies it. The Hero flag is kept as the
# single switch if a banner is ever wanted for one kind again.
#
# -Reason/-Code/-Retry/-RetryMax are diagnostics from the host plugin: they are
# echoed in the debug line so a manual run reproduces the exact notification.

$script:DshKindStyles = @{
  done     = @{ Hero = $false; Flash = $true }
  compact  = @{ Hero = $false; Flash = $true }
  alert    = @{ Hero = $false; Flash = $true }
  notice   = @{ Hero = $false; Flash = $true }
  question = @{ Hero = $false; Flash = $true }
}

function Get-DshKindStyle {
  param([string]$Kind)
  if ($script:DshKindStyles.ContainsKey($Kind)) { return $script:DshKindStyles[$Kind] }
  # Unknown kind (a future stop reason): render like an alert rather than fail.
  return $script:DshKindStyles['alert']
}

function New-DshToastXml {
  param(
    [Parameter(Mandatory = $true)][string]$Kind,
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Body,
    [Parameter(Mandatory = $false)][string]$Launch = '',
    [Parameter(Mandatory = $false)][string]$Duration = 'short',
    [Parameter(Mandatory = $false)][string]$HeroUri = ''
  )
  $style = Get-DshKindStyle $Kind
  $durationAttr = if ($Duration -eq 'long') { 'long' } else { 'short' }
  $launchAttr = ''
  if ($Launch -ne '') {
    # The session id is stored host-side and served over HTTP; the toast only
    # needs to focus/launch the installed app via the dsh-notify protocol.
    $launchAttr = ' launch="dsh-notify://focus" activationType="protocol"'
  }
  $heroXml = ''
  if ($style.Hero -and $HeroUri -ne '') {
    $heroXml = '<image placement="hero" src="' + (ConvertTo-DshXmlAttribute $HeroUri) + '"/>'
  }
  $xml = '<toast' + $launchAttr + ' duration="' + $durationAttr + '"><visual><binding template="ToastGeneric">' +
    $heroXml +
    '<text>' + (ConvertTo-DshXmlText $Title) + '</text>' +
    '<text>' + (ConvertTo-DshXmlText $Body) + '</text>' +
    '</binding></visual></toast>'
  return $xml
}
