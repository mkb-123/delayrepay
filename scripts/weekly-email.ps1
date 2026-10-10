$ErrorActionPreference = "Stop"

$repository = "/mnt/c/Users/mitzb/code/delayrepay"
$endDate = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd")
$logPath = Join-Path (Split-Path $PSScriptRoot -Parent) "data-store\weekly-email.log"
$arguments = "email-summary --date $endDate --lookback-days 10"
$command = "cd '$repository' && { if [ -x .venv/bin/python ]; then .venv/bin/python -m delayrepay $arguments; else PYTHONPATH=python python3 -m delayrepay $arguments; fi; } 2>&1"

& wsl.exe bash -lc $command | Tee-Object -FilePath $logPath -Append
if ($LASTEXITCODE -ne 0) {
    throw "Delay Repay email failed with exit code $LASTEXITCODE. See $logPath"
}
