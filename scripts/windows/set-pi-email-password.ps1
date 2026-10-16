# Stores the Gmail app password on the Pi so it can send alert emails and the Saturday summary.
# Create the password first: Google Account -> Security -> 2-Step Verification -> App passwords
# (https://myaccount.google.com/apppasswords), name it "Delay Repay", copy the 16 characters.
# The password is typed hidden here, sent over ssh on stdin, and written to the Pi's .env only.
param([string]$PiHost = "bhakta-pi@pi.local")
$ErrorActionPreference = "Stop"
$secure = Read-Host "Gmail app password (16 characters; spaces are fine)" -AsSecureString
$password = ([Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))) -replace '\s', ''
if ($password.Length -ne 16) { throw "Expected 16 characters, got $($password.Length)." }
$password | & wsl ssh $PiHost 'read -r pw; cd ~/delayrepay && sed -i "s|^GMAIL_APP_PASSWORD=.*|GMAIL_APP_PASSWORD=$pw|" .env && grep -c "^GMAIL_APP_PASSWORD=.\+" .env'
if ($LASTEXITCODE -ne 0) { throw "Could not update the Pi .env." }
Write-Host "Saved. Sending a test alert..."
& wsl ssh $PiHost 'cd ~/delayrepay && .venv/bin/python -m delayrepay alerts --test'
