$ErrorActionPreference = "Stop"

$repository = "/mnt/c/Users/mitzb/code/delayrepay"
$targetDate = Get-Date
while ($targetDate.DayOfWeek -in @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday)) {
    $targetDate = $targetDate.AddDays(-1)
}
$serviceDate = $targetDate.ToString("yyyy-MM-dd")
$logPath = Join-Path (Split-Path $PSScriptRoot -Parent) "data-store\scheduled-task.log"
$collectArguments = "collect --date $serviceDate --lookback-days 10"
$reportArguments = "report --date $serviceDate --lookback-days 10 --action-only"
$command = "cd '$repository' && { if [ -x .venv/bin/python ]; then .venv/bin/python -m delayrepay $collectArguments && .venv/bin/python -m delayrepay $reportArguments; else PYTHONPATH=python python3 -m delayrepay $collectArguments && PYTHONPATH=python python3 -m delayrepay $reportArguments; fi; } 2>&1"

& wsl.exe bash -lc $command | Tee-Object -FilePath $logPath -Append
if ($LASTEXITCODE -ne 0) {
    throw "Delay Repay briefing failed with exit code $LASTEXITCODE. See $logPath"
}
