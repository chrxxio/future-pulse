# Starts the Futures Pulse price relay automatically, hidden, whenever you sign in.
# Run once from the repo folder in PowerShell (as administrator):
#   powershell -ExecutionPolicy Bypass -File scripts\relay-windows.ps1
# Remove it later with:
#   Unregister-ScheduledTask -TaskName "Futures Pulse price relay" -Confirm:$false
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..").Path
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js was not found. Install Node 18 or newer from nodejs.org, then run this again.' }
if (-not (Test-Path "$env:USERPROFILE\.futures-pulse-relay.json") -and -not (Test-Path "$repo\relay.config.json")) {
  throw "Create $env:USERPROFILE\.futures-pulse-relay.json first (see the README, 'Price relay')."
}

$action   = New-ScheduledTaskAction -Execute $node -Argument "`"$repo\scripts\relay.mjs`" --watch" -WorkingDirectory $repo
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
            -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
# S4U = runs in the background without a console window and without storing your password
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

Register-ScheduledTask -TaskName 'Futures Pulse price relay' -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description 'Sends futures prices to the Futures Pulse app every 5 minutes' -Force | Out-Null
Start-ScheduledTask -TaskName 'Futures Pulse price relay'
Write-Host 'Price relay is running in the background and will start each time you sign in.'
Write-Host 'Check it any time with:  Get-ScheduledTaskInfo -TaskName "Futures Pulse price relay"'
