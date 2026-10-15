param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("VT", "LM")]
    [string]$Operator,
    [string]$PiHost = "bhakta-pi@pi.local"
)

$ErrorActionPreference = "Stop"
$repoDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
    $chrome = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
}
if (-not (Test-Path $chrome)) { throw "Chrome or Edge was not found." }
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else {
    Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
}
if (-not (Test-Path $node)) {
    throw "Node.js was not found. Install Node.js or run this command from a Codex terminal."
}

$settings = if ($Operator -eq "VT") {
    @{ Url = "https://delayrepay.avantiwestcoast.co.uk/"; Domain = "delayrepay.avantiwestcoast.co.uk" }
} else {
    @{ Url = "https://londonnorthwesternrailway.delayrepaycompensation.com/index.cfm?action=login.login"; Domain = "londonnorthwesternrailway.delayrepaycompensation.com" }
}
$port = if ($Operator -eq "VT") { 9223 } else { 9224 }
$profile = Join-Path $env:TEMP "delayrepay-login-$($Operator.ToLower())"
$cookieFile = Join-Path $env:TEMP "$($Operator.ToLower())-cookies.json"

$browser = Start-Process -FilePath $chrome -ArgumentList @(
    "--remote-debugging-port=$port", "--user-data-dir=$profile", "--no-first-run", $settings.Url
) -PassThru
try {
    Read-Host "Log in fully in the browser, complete CAPTCHA, then press Enter here"
    & $node (Join-Path $PSScriptRoot "export-browser-cookies.mjs") $port $settings.Domain $cookieFile
    ssh $PiHost "mkdir -p /var/lib/delayrepay/secrets && chmod 700 /var/lib/delayrepay/secrets"
    scp $cookieFile "${PiHost}:/var/lib/delayrepay/secrets/$($Operator.ToLower())-cookies.json"
    ssh $PiHost "chmod 600 /var/lib/delayrepay/secrets/$($Operator.ToLower())-cookies.json"
    Write-Host "Saved $Operator session on the Pi."
} finally {
    Remove-Item -LiteralPath $cookieFile -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $browser.Id -Force -ErrorAction SilentlyContinue
}
