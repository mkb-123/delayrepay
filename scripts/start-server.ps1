$ErrorActionPreference = "Stop"

$repositoryWindows = Split-Path $PSScriptRoot -Parent
$repositoryWsl = (& wsl.exe wslpath -a ($repositoryWindows -replace '\\', '/')).Trim()
if (-not $repositoryWsl) {
    throw "Could not resolve the repository path in WSL."
}

$command = @"
cd '$repositoryWsl'
if [ -x .venv/bin/python ]; then
  exec .venv/bin/python -m delayrepay serve
else
  export PYTHONPATH=python
  exec python3 -m delayrepay serve
fi
"@

& wsl.exe bash -lc $command
if ($LASTEXITCODE -ne 0) {
    throw "Delay Repay server stopped with exit code $LASTEXITCODE."
}
