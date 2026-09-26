#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"

$taskName = "MKC EUS Delay Repay Server"
$scriptPath = Join-Path $PSScriptRoot "start-server.ps1"
$listenPort = 8787
$serverPort = 8765
$firewallName = "MKC EUS Delay Repay (home network)"

netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$listenPort | Out-Null
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$listenPort connectaddress=127.0.0.1 connectport=$serverPort | Out-Null

Remove-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $firewallName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $listenPort -RemoteAddress LocalSubnet -Profile Any | Out-Null

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

$address = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.InterfaceAlias -notmatch 'vEthernet|Loopback' } |
    Select-Object -First 1 -ExpandProperty IPAddress

Write-Host "Delay Repay server task installed and started."
Write-Host "On this computer: http://localhost:$listenPort"
if ($address) {
    Write-Host "On your phone while using the same Wi-Fi: http://${address}:$listenPort"
}
