# Records claims made in a browser (by hand or by an agent) in the Pi database, so the
# dashboard shows them Submitted and the worker can never claim them again.
# Usage: .\record-claims.ps1 VT:2026-10-12:06:59:AWC-3944-187-759 LM:2026-09-30:17:26:LNR/DR/20261016/BDHX
param([Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Claims,
      [string]$PiHost = "bhakta-pi@pi.local")
$ErrorActionPreference = "Stop"
foreach ($claim in $Claims) {
    if ($claim -notmatch '^(VT|LM):(\d{4}-\d\d-\d\d):(\d\d:\d\d):([A-Za-z0-9/-]+)$') { throw "Expected OPERATOR:YYYY-MM-DD:HH:MM:REFERENCE, got '$claim'." }
    $op, $date, $time, $ref = $Matches[1], $Matches[2], $Matches[3], $Matches[4]
    $remote = "cd ~/delayrepay && set -a && . <(tr -d '\r' < .env) && set +a && .venv/bin/python -m delayrepay record-claim --operator $op --date $date --time $time --reference '$ref'"
    & wsl ssh $PiHost $remote
    if ($LASTEXITCODE -ne 0) { throw "Could not record $claim." }
}
