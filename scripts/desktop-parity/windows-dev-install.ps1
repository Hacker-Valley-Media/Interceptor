# Windows dev loop: swap freshly built binaries into the installed Interceptor
# folder and restart the provider in this (console) session. Run through an Interactive
# scheduled task; the originals are kept once in <install>\.interceptor-dev-original.
# -Version is the package.json version the staged provider was built as (it names the Contacts identity).
param([string]$Stage = "$env:USERPROFILE\interceptor-dev\stage", [string]$Sdk = "$env:USERPROFILE\interceptor-dev\sdk", [string]$Version)
$ErrorActionPreference = 'Stop'
if (-not $Version) { throw 'Pass -Version <x.y.z>: the package.json version the staged provider was built as.' }
$install = Join-Path $env:LOCALAPPDATA 'Programs\Interceptor'
$backup = Join-Path $install '.interceptor-dev-original'
$files = @(@('interceptor.exe', 'interceptor.exe'), @('interceptor-daemon.exe', 'daemon\interceptor-daemon.exe'), @('interceptor-desktop.exe', 'interceptor-desktop.exe'))
# Windows PowerShell 5.1 turns any native stderr line into a terminating error under 'Stop'.
$ErrorActionPreference = 'Continue'; & (Join-Path $install 'interceptor.exe') daemon stop *> $null; $ErrorActionPreference = 'Stop'
Get-Process interceptor-desktop, interceptor-daemon -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800
New-Item -ItemType Directory -Force $backup | Out-Null
foreach ($f in $files) {
  $dest = Join-Path $install $f[1]
  if (-not (Test-Path (Join-Path $backup $f[0]))) { Copy-Item $dest (Join-Path $backup $f[0]) }
  Copy-Item (Join-Path $Stage $f[0]) $dest -Force
}
# Pinned engines (PDFium) live in <install>\engines beside the provider.
$engines = Join-Path $Stage 'engines'
if (Test-Path $engines) { Remove-Item (Join-Path $install 'engines') -Recurse -Force -ErrorAction SilentlyContinue; Copy-Item $engines (Join-Path $install 'engines') -Recurse -Force }
# Contacts/Calendar run from interceptor-contacts-native.exe (the provider copy with the sparse-package
# identity embedded as a manifest resource). Refresh it from the new provider and re-embed the Contacts
# identity with the SDK's mt.exe, so token/tail/changes run the new code under the same package identity.
$contacts = Join-Path $install 'interceptor-contacts-native.exe'
$mt = Join-Path $Sdk 'mt.exe'
if ((Test-Path $contacts) -and (Test-Path $mt)) {
  if (-not (Test-Path (Join-Path $backup 'interceptor-contacts-native.exe'))) { Copy-Item $contacts (Join-Path $backup 'interceptor-contacts-native.exe') }
  Copy-Item (Join-Path $install 'interceptor-desktop.exe') $contacts -Force
  $name = 'HackerValleyMedia.Interceptor.Desktop'
  $publisher = 'CN=Hacker Valley Media LLC, O=Hacker Valley Media LLC, L=Austin, S=Texas, C=US'
  $assembly = "<?xml version=`"1.0`" encoding=`"utf-8`"?><assembly manifestVersion=`"1.0`" xmlns=`"urn:schemas-microsoft-com:asm.v1`"><assemblyIdentity version=`"$Version.0`" name=`"$name`"/><msix xmlns=`"urn:schemas-microsoft-com:msix.v1`" publisher=`"$publisher`" packageName=`"$name`" applicationId=`"Contacts`"/></assembly>"
  $manifestPath = Join-Path $Stage 'Contacts.application.manifest'
  [IO.File]::WriteAllText($manifestPath, $assembly, (New-Object Text.UTF8Encoding($false)))
  & $mt -nologo -manifest $manifestPath "-outputresource:$contacts;#1"
  if ($LASTEXITCODE -ne 0) { throw "mt.exe failed to embed Contacts identity: $LASTEXITCODE" }
}
Start-Process (Join-Path $install 'interceptor-desktop.exe') -WorkingDirectory $install -WindowStyle Hidden
Start-Sleep -Seconds 2
$p = Get-CimInstance Win32_Process -Filter "Name='interceptor-desktop.exe'" | Select-Object -First 1
$hashes = foreach ($f in $files) { '{0} {1}' -f (Get-FileHash (Join-Path $install $f[1])).Hash, $f[1] }
@("provider pid=$($p.ProcessId) session=$($p.SessionId) path=$($p.ExecutablePath)") + $hashes | Set-Content (Join-Path $Stage 'dev-install.txt')
