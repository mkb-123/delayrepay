param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("VT", "LM")]
    [string]$Operator
)

$ErrorActionPreference = "Stop"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
    $chrome = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
}
if (-not (Test-Path $chrome)) { throw "Chrome or Edge was not found." }

$settings = if ($Operator -eq "VT") {
    @{ Url = "https://delayrepay.avantiwestcoast.co.uk/" }
} else {
    @{ Url = "https://londonnorthwesternrailway.delayrepaycompensation.com/index.cfm?action=login.login" }
}
$profile = Join-Path $env:LOCALAPPDATA "DelayRepay\browser-profiles\$($Operator.ToLower())"
New-Item -ItemType Directory -Force $profile | Out-Null

$browser = Start-Process -FilePath $chrome -ArgumentList @(
    "--user-data-dir=$profile", "--no-first-run", $settings.Url
) -PassThru
try {
    Read-Host "Log in fully in the browser, complete CAPTCHA, then press Enter here"
    Write-Host "Saved $Operator session in the private laptop browser profile."
} finally {
    Stop-Process -Id $browser.Id -Force -ErrorAction SilentlyContinue
}
