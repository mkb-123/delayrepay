# One command to (re)authorise read-only Gmail access and push the result to the Pi.
# Run it the first time and again whenever the dashboard says "Gmail authorization needed"
# (in Google's Testing mode the login lasts 7 days).
#
# Prerequisite: the OAuth client JSON from Google Cloud (Desktop app) saved at
#   %LOCALAPPDATA%\DelayRepay\secrets\gmail-oauth-client.json
param([string]$PiHost = "bhakta-pi@pi.local")
$ErrorActionPreference = "Stop"
$secrets = Join-Path $env:LOCALAPPDATA "DelayRepay\secrets"
$client = Join-Path $secrets "gmail-oauth-client.json"
$token = Join-Path $secrets "gmail-oauth-token.json"
if (-not (Test-Path $client)) { throw "Save the Google OAuth client JSON as $client first." }
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$wslRepo = (& wsl wslpath -a $repo).Trim()
$wslClient = (& wsl wslpath -a $client).Trim()
$wslToken = (& wsl wslpath -a $token).Trim()

Write-Host "A Google page opens: sign in as mitzbhakta@gmail.com and press Allow (read-only access)."
& wsl bash -lc "cd '$wslRepo' && GMAIL_OAUTH_CLIENT_FILE='$wslClient' GMAIL_OAUTH_TOKEN_FILE='$wslToken' .venv/bin/delayrepay gmail-authorize"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $token)) { throw "Authorisation did not complete." }

Write-Host "Copying the files to the Pi..."
& wsl ssh $PiHost "install -d -m 700 /var/lib/delayrepay/secrets"
Get-Content -Raw $client | & wsl ssh $PiHost "umask 077; cat > /var/lib/delayrepay/secrets/gmail-oauth-client.json"
Get-Content -Raw $token | & wsl ssh $PiHost "umask 077; cat > /var/lib/delayrepay/secrets/gmail-oauth-token.json"
# Point the Pi at them once (idempotent).
& wsl ssh $PiHost "cd ~/delayrepay && for kv in GMAIL_OAUTH_CLIENT_FILE=/var/lib/delayrepay/secrets/gmail-oauth-client.json GMAIL_OAUTH_TOKEN_FILE=/var/lib/delayrepay/secrets/gmail-oauth-token.json; do k=`${kv%%=*}; grep -q `"^`$k=`" .env || echo `"`$kv`" >> .env; done"

Write-Host "Testing a reconciliation on the Pi..."
& wsl ssh $PiHost "cd ~/delayrepay && .venv/bin/python -m delayrepay gmail-reconcile"
Write-Host "Done. The Pi now checks Gmail every day at 20:00."
