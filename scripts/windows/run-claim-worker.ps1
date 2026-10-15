param([string]$PiHost = "bhakta-pi@pi.local")
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" }
if (-not (Test-Path $node)) { throw "Node.js was not found." }
$tunnel = Start-Process wsl.exe -ArgumentList @("ssh", "-N", "-o", "ExitOnForwardFailure=yes", "-L", "8877:127.0.0.1:8765", $PiHost) -PassThru -WindowStyle Hidden
try {
    $ready = $false
    1..20 | ForEach-Object {
        if (-not $ready) {
            Start-Sleep -Milliseconds 500
            if ($tunnel.HasExited) { throw "The SSH tunnel exited before becoming ready." }
            try {
                $health = (Invoke-RestMethod "http://127.0.0.1:8877/health").status -eq "ok"
                $route = Invoke-WebRequest -Method Options "http://127.0.0.1:8877/api/private-worker/next"
                $ready = $health -and $route.StatusCode -eq 200
            } catch {}
        }
    }
    if (-not $ready) { throw "Could not open the SSH tunnel to the Pi." }
    & $node (Join-Path $PSScriptRoot "claim-worker.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Claim worker failed with exit code $LASTEXITCODE." }
} finally { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
