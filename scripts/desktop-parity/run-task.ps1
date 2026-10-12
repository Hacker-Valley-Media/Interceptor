# Run a PowerShell script in the console (session 1) through an Interactive scheduled task.
# ssh lands in Session 0, where the native provider refuses; this hop reaches the logged-in session.
param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Script)
$ErrorActionPreference = 'Stop'
$user = (Get-CimInstance Win32_ComputerSystem).UserName
# conhost --headless hosts the console itself: Windows 11 would otherwise open each task's PowerShell in a visible
# (elevated) Windows Terminal window that stays open and holds the foreground.
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Script`""
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $Name -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $Name
# Wait for it to finish (state returns to Ready), up to 20 minutes.
for ($i = 0; $i -lt 240; $i++) {
  Start-Sleep -Seconds 5
  if ((Get-ScheduledTask -TaskName $Name).State -eq 'Ready' -and $i -gt 0) { break }
}
Unregister-ScheduledTask -TaskName $Name -Confirm:$false
"ran $Name"
