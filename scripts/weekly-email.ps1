$ErrorActionPreference = "Stop"

$repository = "/mnt/c/Users/mitzb/code/delayrepay"
$logPath = Join-Path (Split-Path $PSScriptRoot -Parent) "data-store\weekly-email.log"
$command = "cd '$repository' && { if [ -x .venv/bin/python ]; then .venv/bin/python -m delayrepay email-summary; else PYTHONPATH=python python3 -m delayrepay email-summary; fi; } 2>&1"

& wsl.exe bash -lc $command | Tee-Object -FilePath $logPath -Append
if ($LASTEXITCODE -ne 0) {
    throw "Delay Repay email failed with exit code $LASTEXITCODE. See $logPath"
}
