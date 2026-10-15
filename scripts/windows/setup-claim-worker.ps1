$ErrorActionPreference = "Stop"
$runner = Join-Path $PSScriptRoot "run-claim-worker.ps1"
$taskName = "MKC EUS Delay Repay Claim Worker"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`""
# At sign-in, then every 15 minutes. Idle runs only ask the Pi for queued jobs and cost nothing.
$logon = New-ScheduledTaskTrigger -AtLogOn
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $repeat) -Settings $settings `
    -Description "Submits Delay Repay claims selected in the dashboard and keeps operator sessions alive." -Force | Out-Null
Write-Host "Installed '$taskName': at sign-in and every 15 minutes while this laptop is on and online."
Write-Host "Missed runs happen as soon as the laptop is available. No claims are made unless you chose them in the dashboard."
