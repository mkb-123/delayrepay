$ErrorActionPreference = "Stop"
$runner = Join-Path $PSScriptRoot "run-claim-worker.ps1"
$taskName = "MKC EUS Delay Repay Claim Worker"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`""
# Once a day at 19:00. If the laptop was off or asleep then, Windows runs it at the next opportunity.
$daily = New-ScheduledTaskTrigger -Daily -At "19:00"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $daily -Settings $settings `
    -Description "Submits Delay Repay claims selected in the dashboard and keeps operator sessions alive." -Force | Out-Null
Write-Host "Installed '$taskName': daily at 19:00, or at the next opportunity if the laptop was off."
Write-Host "No claims are made unless you chose them in the dashboard."
