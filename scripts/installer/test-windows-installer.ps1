[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][ValidateSet('x64', 'arm64')][string]$Architecture,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [string]$SignTool = '',
  [switch]$DisposableMachine
)

$ErrorActionPreference = 'Stop'
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$productKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{B7F4D8A1-3E22-4B91-A6E4-9C2D5F8A1234}_is1'
$stateKey = 'Software\Hacker Valley Media\Interceptor\Installer\State'
$hostKeys = @(
  'Software\Google\Chrome\NativeMessagingHosts\com.interceptor.host',
  'Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.interceptor.host',
  'Software\Microsoft\Edge\NativeMessagingHosts\com.interceptor.host'
)
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\Interceptor'
$setupLog = Join-Path $env:TEMP 'interceptor-setup-test.log'
$repairLog = Join-Path $env:TEMP 'interceptor-repair-test.log'
$uninstallLog = Join-Path $env:TEMP 'interceptor-uninstall-test.log'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Get-Machine([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $pe = [BitConverter]::ToInt32($bytes, 0x3c)
  [BitConverter]::ToUInt16($bytes, $pe + 4)
}

function Read-RegistryValue([string]$SubKey, [string]$Name) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey, $false)
  if ($null -eq $key) { return @{ KeyExists = $false; Exists = $false; Value = $null; Kind = $null } }
  try {
    $exists = $key.GetValueNames() -contains $Name
    if (-not $exists) { return @{ KeyExists = $true; Exists = $false; Value = $null; Kind = $null } }
    return @{
      KeyExists = $true
      Exists = $true
      Value = $key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      Kind = $key.GetValueKind($Name)
    }
  } finally { $key.Dispose() }
}

function Write-RegistrySnapshot([string]$SubKey, [string]$Name, $Snapshot) {
  if (-not $Snapshot.KeyExists) {
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($SubKey, $false)
    return
  }
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($SubKey)
  try {
    if ($Snapshot.Exists) { $key.SetValue($Name, $Snapshot.Value, $Snapshot.Kind) }
    else { $key.DeleteValue($Name, $false) }
  } finally { $key.Dispose() }
}

function Run-Setup([string]$Path, [string]$Log) {
  $process = Start-Process -FilePath $Path -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',("/LOG=$Log") -Wait -PassThru
  Assert-True ($process.ExitCode -eq 0) "Setup failed with exit code $($process.ExitCode). See $Log"
}

$existingProduct = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($productKey)
if ($null -ne $existingProduct) {
  $existingProduct.Dispose()
  throw 'The acceptance harness refuses an existing Interceptor installation.'
}
if (-not $DisposableMachine) { throw 'Pass -DisposableMachine after confirming this user/VM is disposable.' }

$pathSnapshot = Read-RegistryValue 'Environment' 'Path'
$hostSnapshots = @{}
$hostSentinelSnapshots = @{}
foreach ($hostKey in $hostKeys) {
  $hostSnapshots[$hostKey] = Read-RegistryValue $hostKey ''
  $hostSentinelSnapshots[$hostKey] = Read-RegistryValue $hostKey 'AcceptanceSentinel'
}
$installed = $false

try {
  if ($SignTool) {
    & $SignTool verify /pa /all /v /tw $Installer
    Assert-True ($LASTEXITCODE -eq 0) 'Outer installer Authenticode verification failed.'
  }

  for ($index = 0; $index -lt $hostKeys.Count; $index++) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($hostKeys[$index])
    try {
      $key.SetValue('', "C:\foreign\host-$index.json", [Microsoft.Win32.RegistryValueKind]::String)
      $key.SetValue('AcceptanceSentinel', 'preserve-me', [Microsoft.Win32.RegistryValueKind]::String)
    } finally { $key.Dispose() }
  }

  Run-Setup $Installer $setupLog
  $installed = $true

  $expectedMachine = if ($Architecture -eq 'x64') { 0x8664 } else { 0xaa64 }
  $cli = Join-Path $installRoot 'interceptor.exe'
  $daemon = Join-Path $installRoot 'daemon\interceptor-daemon.exe'
  $manifest = Join-Path $installRoot 'daemon\com.interceptor.host.json'
  $icon = Join-Path $installRoot 'interceptor.ico'
  $uninstaller = Join-Path $installRoot 'unins000.exe'
  foreach ($path in @($cli, $daemon, $manifest, $icon, $uninstaller)) { Assert-True (Test-Path -LiteralPath $path) "Missing installed payload: $path" }
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $installRoot 'extension'))) 'Production installer included an unpacked extension.'
  Assert-True ((Get-Machine $cli) -eq $expectedMachine) 'Installed CLI architecture mismatch.'
  Assert-True ((Get-Machine $daemon) -eq $expectedMachine) 'Installed daemon architecture mismatch.'
  Assert-True ((& $cli --version) -match [regex]::Escape($Version)) 'Installed CLI version mismatch.'
  if ($SignTool) {
    foreach ($path in @($cli, $daemon, $uninstaller)) {
      & $SignTool verify /pa /all /v /tw $path
      Assert-True ($LASTEXITCODE -eq 0) "Installed signature verification failed: $path"
    }
  }

  $manifestJson = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  Assert-True ($manifestJson.path -eq 'interceptor-daemon.exe') 'Native-host path is not relative.'
  Assert-True ($manifestJson.allowed_origins.Count -ge 1) 'Native-host manifest has no approved origins.'
  foreach ($hostKey in $hostKeys) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($hostKey)
    try {
      Assert-True ($key.GetValue('') -eq $manifest) "Native-host registration mismatch: $hostKey"
      Assert-True ($key.GetValue('AcceptanceSentinel') -eq 'preserve-me') "Named registry value was not preserved: $hostKey"
    } finally { $key.Dispose() }
  }
  $pathAfterInstall = [string](Read-RegistryValue 'Environment' 'Path').Value
  $tokens = @($pathAfterInstall -split ';' | Where-Object { $_.Trim(' ', '"', '\') -ieq $installRoot.TrimEnd('\') })
  Assert-True ($tokens.Count -eq 1) 'Install root was not added to PATH exactly once.'
  Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'skills\interceptor\SKILL.md')) 'Router skill was not installed.'
  Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'skills\interceptor-browser\SKILL.md')) 'Browser skill was not installed.'
  Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'skills\interceptor-research\SKILL.md')) 'Research skill was not installed.'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $env:TEMP 'interceptor.installing'))) 'Maintenance guard remained after install.'

  Run-Setup $Installer $repairLog

  $edge = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($hostKeys[2])
  try { $edge.SetValue('', 'C:\foreign\changed-after-install.json', [Microsoft.Win32.RegistryValueKind]::String) }
  finally { $edge.Dispose() }

  $process = Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',("/LOG=$uninstallLog") -Wait -PassThru
  Assert-True ($process.ExitCode -eq 0) "Uninstall failed with exit code $($process.ExitCode). See $uninstallLog"
  $installed = $false

  Assert-True (-not (Test-Path -LiteralPath $cli)) 'CLI remained after uninstall.'
  $pathAfterUninstall = Read-RegistryValue 'Environment' 'Path'
  Assert-True ($pathAfterUninstall.Exists -eq $pathSnapshot.Exists) 'PATH value presence was not restored.'
  if ($pathSnapshot.Exists) {
    Assert-True ($pathAfterUninstall.Kind -eq $pathSnapshot.Kind) 'PATH registry type was not restored.'
    Assert-True ([string]$pathAfterUninstall.Value -ceq [string]$pathSnapshot.Value) 'PATH raw value was not restored.'
  }
  for ($index = 0; $index -lt 2; $index++) {
    $value = (Read-RegistryValue $hostKeys[$index] '').Value
    Assert-True ($value -eq "C:\foreign\host-$index.json") "Prior native-host value was not restored: $($hostKeys[$index])"
  }
  Assert-True ((Read-RegistryValue $hostKeys[2] '').Value -eq 'C:\foreign\changed-after-install.json') 'Post-install foreign native-host change was not preserved.'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $env:TEMP 'interceptor.installing'))) 'Maintenance guard remained after uninstall.'
  Assert-True ($null -eq [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($stateKey)) 'Persistent installer state remained after uninstall.'
} finally {
  if ($installed -and (Test-Path -LiteralPath (Join-Path $installRoot 'unins000.exe'))) {
    Start-Process -FilePath (Join-Path $installRoot 'unins000.exe') -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait | Out-Null
  }
  Write-RegistrySnapshot 'Environment' 'Path' $pathSnapshot
  foreach ($hostKey in $hostKeys) {
    Write-RegistrySnapshot $hostKey '' $hostSnapshots[$hostKey]
    Write-RegistrySnapshot $hostKey 'AcceptanceSentinel' $hostSentinelSnapshots[$hostKey]
  }
  Remove-Item -LiteralPath (Join-Path $env:TEMP 'interceptor.installing') -Force -ErrorAction SilentlyContinue
}

Write-Host "Windows installer acceptance passed: $Architecture $Version"
