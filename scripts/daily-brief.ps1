$ErrorActionPreference = "Stop"

$repository = "/mnt/c/Users/mitzb/code/delayrepay"
$targetDate = Get-Date
while ($targetDate.DayOfWeek -in @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday)) {
    $targetDate = $targetDate.AddDays(-1)
}
$serviceDate = $targetDate.ToString("yyyy-MM-dd")
$logPath = Join-Path (Split-Path $PSScriptRoot -Parent) "data-store\scheduled-task.log"
$command = "cd $repository && export PYTHONPATH=python && python3 -m delayrepay collect --date $serviceDate && python3 -m delayrepay report --date $serviceDate --action-only"

& wsl.exe bash -lc $command 2>&1 | Tee-Object -FilePath $logPath -Append
if ($LASTEXITCODE -ne 0) {
    throw "Delay Repay briefing failed with exit code $LASTEXITCODE. See $logPath"
}
