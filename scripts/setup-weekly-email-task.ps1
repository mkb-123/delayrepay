$ErrorActionPreference = "Stop"

$taskName = "MKC EUS Delay Repay Email"
$scriptPath = Join-Path $PSScriptRoot "weekly-email.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Saturday -At "09:00"
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "Email the outstanding Delay Repay summary every Saturday morning." -Force | Out-Null

Write-Host "Updated '$taskName'. It runs Saturdays at 09:00 and catches up after missed starts."
