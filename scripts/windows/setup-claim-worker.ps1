$ErrorActionPreference = "Stop"
$runner = Join-Path $PSScriptRoot "run-claim-worker.ps1"
$taskName = "MKC EUS Delay Repay Claim Worker"
$command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runner`""
schtasks.exe /Create /F /TN $taskName /SC MINUTE /MO 10 /TR $command | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Could not create $taskName." }
Write-Host "Installed $taskName. It checks the Pi queue every ten minutes while this laptop is available."
