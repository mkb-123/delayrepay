# Stores an operator account login for the claim worker's automatic re-login.
# The password is typed here (hidden), kept in %LOCALAPPDATA%\DelayRepay\secrets, readable only
# by your Windows account, and never goes to Git, the Pi or any AI.
param([Parameter(Mandatory = $true)][ValidateSet("VT", "LM")][string]$Operator)
$ErrorActionPreference = "Stop"
$prefix = if ($Operator -eq "VT") { "AVANTI_DELAY_REPAY" } else { "LNR_DELAY_REPAY" }
$dir = Join-Path $env:LOCALAPPDATA "DelayRepay\secrets"
New-Item -ItemType Directory -Force $dir | Out-Null
$file = Join-Path $dir "operator-accounts.env"
$email = Read-Host "$Operator account email"
$secure = Read-Host "$Operator account password" -AsSecureString
$password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
$lines = if (Test-Path $file) { Get-Content $file | Where-Object { $_ -notmatch "^${prefix}_(EMAIL|PASSWORD)=" } } else { @() }
$lines + "${prefix}_EMAIL=$email" + "${prefix}_PASSWORD=$password" | Set-Content -Encoding UTF8 $file
icacls $file /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
Write-Host "Saved $Operator login to $file (current user only)."
