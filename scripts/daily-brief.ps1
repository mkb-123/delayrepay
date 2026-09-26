$ErrorActionPreference = "Stop"

$repository = "/mnt/c/Users/mitzb/code/delayrepay"
$targetDate = Get-Date
while ($targetDate.DayOfWeek -in @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday)) {
    $targetDate = $targetDate.AddDays(-1)
}
$serviceDate = $targetDate.ToString("yyyy-MM-dd")
$logPath = Join-Path (Split-Path $PSScriptRoot -Parent) "data-store\scheduled-task.log"
$command = "cd $repository && if [ -x .venv/bin/python ]; then PY=.venv/bin/python; else export PYTHONPATH=python; PY=python3; fi; `$PY -m delayrepay collect --date $serviceDate && `$PY -m delayrepay report --date $serviceDate --lookback-days 10 --action-only"

& wsl.exe bash -lc $command 2>&1 | Tee-Object -FilePath $logPath -Append
if ($LASTEXITCODE -ne 0) {
    throw "Delay Repay briefing failed with exit code $LASTEXITCODE. See $logPath"
}
