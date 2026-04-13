$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TemplatePath = Join-Path $Root 'daemon/com.interceptor.host.json'
$GeneratedDir = Join-Path $Root 'daemon/.generated'
$GeneratedManifest = Join-Path $GeneratedDir 'com.interceptor.host.json'
$DaemonPath = Join-Path $Root 'daemon/interceptor-daemon.exe'

New-Item -ItemType Directory -Force -Path $GeneratedDir | Out-Null
$template = Get-Content $TemplatePath -Raw | ConvertFrom-Json
$template.path = $DaemonPath
$template | ConvertTo-Json -Depth 10 | Set-Content -Path $GeneratedManifest -NoNewline

$chromeKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.interceptor.host'
$braveKey = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.interceptor.host'

New-Item -Path $chromeKey -Force | Out-Null
Set-ItemProperty -Path $chromeKey -Name '(default)' -Value $GeneratedManifest
New-Item -Path $braveKey -Force | Out-Null
Set-ItemProperty -Path $braveKey -Name '(default)' -Value $GeneratedManifest

Write-Host "Installed manifest registry keys:"
Write-Host "  Chrome: $chromeKey"
Write-Host "  Brave:  $braveKey"
Write-Host "Manifest: $GeneratedManifest"
