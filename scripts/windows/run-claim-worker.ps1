param([string]$PiHost = "bhakta-pi@pi.local")
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" }
if (-not (Test-Path $node)) { throw "Node.js was not found." }

# Keep a log of every run (scheduled runs are hidden, so a hang or error would otherwise leave no trace).
$logDir = Join-Path $env:LOCALAPPDATA "DelayRepay\logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir "worker.log"
if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Move-Item $log "$log.old" -Force }
Start-Transcript -Path $log -Append | Out-Null

$tunnel = Start-Process wsl.exe -ArgumentList @("ssh", "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=10", "-o", "ConnectTimeout=15", "-L", "8877:127.0.0.1:8765", $PiHost) -PassThru -WindowStyle Hidden
try {
    $ready = $false
    1..30 | ForEach-Object {
        if (-not $ready) {
            Start-Sleep -Milliseconds 500
            if ($tunnel.HasExited) { throw "The SSH tunnel exited before becoming ready." }
            try {
                # Short timeouts: without them a half-open tunnel can hang this script forever.
                $health = (Invoke-RestMethod -TimeoutSec 5 "http://127.0.0.1:8877/health").status -eq "ok"
                $route = Invoke-WebRequest -TimeoutSec 5 -UseBasicParsing -Method Options "http://127.0.0.1:8877/api/private-worker/next"
                $ready = $health -and $route.StatusCode -eq 200
            } catch {}
        }
    }
    if (-not $ready) { throw "Could not open the SSH tunnel to the Pi." }
    & $node (Join-Path $PSScriptRoot "claim-worker.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Claim worker failed with exit code $LASTEXITCODE." }
} finally {
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
    Stop-Transcript | Out-Null
}
