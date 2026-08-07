#requires -Version 7
<#
.SYNOPSIS
  Register the Interceptor native-messaging host on Windows from a source checkout.

.DESCRIPTION
  DEVELOPER HELPER — not the product installer. This script only registers the
  native-messaging host for a built source checkout and prints the manual
  "Load unpacked" steps. The shipping Windows product is the signed per-user
  installer built from scripts/installer/interceptor.iss; see
  docs/windows-install.md.

  Deliberately out of scope, because none of it is safe or truthful here:
    * editing browser Preferences / enabling Developer mode
    * launching browsers with --load-extension (current branded Chrome ignores
      the switch on Windows; Chrome 137 removed it)
    * quitting or restarting a running browser
    * asserting that a specific browser/profile can reach the extension

  Steps performed:
    1. Generate a native-messaging manifest pointing at the built daemon
    2. Snapshot, then write HKCU native-host keys for Chrome, Brave, and Edge
       (all three always — Brave resolves the Google Chrome key as well as its
       own), restoring the snapshot if any write fails
    3. Print manual Load-unpacked instructions for the chosen browser

.PARAMETER Browser
  chrome | brave | edge | both. Only selects which instructions are printed;
  registry registration always covers all three. Required in non-interactive
  sessions — there is no silent default.

.PARAMETER ProfileName
  Browser profile directory name used by -Profiles listing (e.g. "Default",
  "Profile 2"). Named ProfileName rather than Profile because $Profile is a
  PowerShell automatic variable (the path to the current profile script); a
  parameter named Profile shadows it for the whole script scope.

.PARAMETER SkipExtension
  Register the native-messaging host only; print no extension instructions.

.PARAMETER BrowserOnly
  Explicit browser-only mode. (Implicit on Windows; flag exists for parity with install.sh.)

.PARAMETER Full
  Rejected on Windows — the Swift bridge is macOS only. Use macOS to install --full.

.PARAMETER DryRun
  Print steps without executing.

.PARAMETER Profiles
  List browser profiles and exit.

.EXAMPLE
  pwsh -File scripts\install.ps1 -Browser brave

.EXAMPLE
  pwsh -File scripts\install.ps1 -Browser edge -Profiles

.EXAMPLE
  pwsh -File scripts\install.ps1 -Browser both -DryRun
#>

[CmdletBinding()]
param(
  [ValidateSet('chrome', 'brave', 'edge', 'both')]
  [string]$Browser,

  # NOT named $Profile — that is a PowerShell automatic variable.
  [Alias('Profile')]
  [string]$ProfileName = 'Default',

  [switch]$SkipExtension,

  [switch]$BrowserOnly,

  [switch]$Full,

  [switch]$DryRun,

  [switch]$Profiles
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Full) {
  Write-Error "ERROR: -Full is macOS only (the Swift bridge does not build on Windows). Windows installs are browser-only."
  exit 1
}

# ── Paths ────────────────────────────────────────────────────────────────────────
$Root              = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TemplatePath      = Join-Path $Root 'daemon\com.interceptor.host.json'
$GeneratedDir      = Join-Path $Root 'daemon\.generated'
$GeneratedManifest = Join-Path $GeneratedDir 'com.interceptor.host.json'
$DaemonPath        = Join-Path $Root 'daemon\interceptor-daemon.exe'
$CliPath           = Join-Path $Root 'dist\interceptor.exe'
$ExtensionDir      = Join-Path $Root 'extension\dist'

$ChromeUserData = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$BraveUserData  = Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data'
$EdgeUserData   = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'

$ChromeBinary = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

$BraveBinary = @(
  (Join-Path $env:ProgramFiles 'BraveSoftware\Brave-Browser\Application\brave.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'BraveSoftware\Brave-Browser\Application\brave.exe'),
  (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\Application\brave.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

$EdgeBinary = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

$Mode = 'browser-only'

# ── Helper: run-or-print ─────────────────────────────────────────────────────────
function Invoke-Step {
  param([string]$Description, [scriptblock]$Action)
  if ($DryRun) {
    Write-Host "    DRY: $Description"
  } else {
    & $Action
  }
}

# ── Per-browser metadata ───────────────────────────────────────────────────────
function Get-ProfileRoot {
  param([string]$Target)
  switch ($Target) {
    'chrome' { return $ChromeUserData }
    'brave'  { return $BraveUserData }
    'edge'   { return $EdgeUserData }
  }
  return $null
}

function Get-ExtensionsUrl {
  param([string]$Target)
  switch ($Target) {
    'brave' { return 'brave://extensions/' }
    'edge'  { return 'edge://extensions/' }
    default { return 'chrome://extensions/' }
  }
}

if ($Profiles) {
  if (-not $Browser) {
    if ($BraveBinary)      { $Browser = 'brave' }
    elseif ($ChromeBinary) { $Browser = 'chrome' }
    elseif ($EdgeBinary)   { $Browser = 'edge' }
    else { Write-Error "No supported browser found. Install Chrome, Brave, or Edge first."; exit 1 }
  }
  if ($Browser -eq 'both') {
    Write-Error "-Profiles requires a single browser (chrome, brave, or edge), not 'both'."
    exit 1
  }
  $root = Get-ProfileRoot $Browser
  if (-not $root -or -not (Test-Path -LiteralPath $root)) {
    Write-Error "Profile root not found: $root"
    exit 1
  }
  Write-Host "Available profiles in $root`n"
  '{0,-20} {1}' -f 'DIRECTORY', 'DISPLAY NAME' | Write-Host
  '{0,-20} {1}' -f '---------', '------------' | Write-Host
  Get-ChildItem -LiteralPath $root -Directory | ForEach-Object {
    $prefs = Join-Path $_.FullName 'Preferences'
    if (Test-Path -LiteralPath $prefs) {
      $display = '(unknown)'
      try {
        $json = Get-Content -LiteralPath $prefs -Raw | ConvertFrom-Json
        if ($json.profile -and $json.profile.name) { $display = $json.profile.name }
      } catch {}
      '{0,-20} {1}' -f $_.Name, $display | Write-Host
    }
  }
  exit 0
}

# ── Browser resolution ───────────────────────────────────────────────────────────
# Instruction targeting only. Registration always covers all three browsers, so a
# wrong guess here cannot mis-register anything — but a silent default in a
# non-interactive session still prints instructions for a browser that may not be
# installed, so require an explicit choice there.
if (-not $Browser) {
  $installed = @()
  if ($ChromeBinary) { $installed += 'chrome' }
  if ($BraveBinary)  { $installed += 'brave' }
  if ($EdgeBinary)   { $installed += 'edge' }

  if ($installed.Count -eq 0) {
    Write-Error "ERROR: No supported browser found.`n       Install Google Chrome (winget install Google.Chrome), Brave (winget install Brave.Brave), or Edge (preinstalled on Windows)."
    exit 1
  }

  if ($installed.Count -eq 1) {
    $Browser = $installed[0]
    Write-Host "==> Browser: $Browser (only supported browser found)"
  } elseif (-not [Environment]::UserInteractive) {
    Write-Error "ERROR: multiple browsers found ($($installed -join ', ')). Pass -Browser explicitly in a non-interactive session."
    exit 1
  } else {
    Write-Host ""
    Write-Host "Choose target browser:"
    if ($ChromeBinary) { Write-Host "  chrome   Google Chrome" }
    if ($BraveBinary)  { Write-Host "  brave    Brave Browser" }
    if ($EdgeBinary)   { Write-Host "  edge     Microsoft Edge" }
    if ($ChromeBinary -and $BraveBinary) { Write-Host "  both     Chrome and Brave" }
    $answer = Read-Host "Browser"
    if ($answer -notin @('chrome', 'brave', 'edge', 'both')) {
      Write-Error "Unrecognized browser '$answer'. Use chrome, brave, edge, or both."
      exit 1
    }
    $Browser = $answer
  }
}

Write-Host "==> Mode: $Mode (source-checkout developer registration)"
Write-Host "==> Browser: $Browser"
if ($DryRun) { Write-Host "==> DRY RUN — no files will be created or modified." }

# ── Preflight ────────────────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $DaemonPath)) {
  Write-Error "ERROR: daemon binary not found at $DaemonPath`n       Build it first: bash scripts/build.sh --target=windows-x64 (or --target=windows-arm64)"
  exit 1
}
if (-not $SkipExtension -and -not (Test-Path -LiteralPath $ExtensionDir) -and -not $DryRun) {
  Write-Error "ERROR: extension bundle not found at $ExtensionDir`n       Build it first: bash scripts/build.sh"
  exit 1
}

# ── Step 1: Generate native-messaging manifest ───────────────────────────────────
Write-Host "==> [browser] Generating native messaging manifest..."
Invoke-Step -Description "mkdir $GeneratedDir; write $GeneratedManifest with path=$DaemonPath" -Action {
  New-Item -ItemType Directory -Force -Path $GeneratedDir | Out-Null
  $template = Get-Content -LiteralPath $TemplatePath -Raw | ConvertFrom-Json
  $template.path = $DaemonPath
  $template | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $GeneratedManifest -NoNewline
  if (-not (Test-Path -LiteralPath $GeneratedManifest)) { throw "manifest was not written to $GeneratedManifest" }
  Write-Host "    Manifest: $GeneratedManifest"
}

# ── Step 2: Write native-messaging registry keys ─────────────────────────────────
# All three always: Brave resolves the Google Chrome native-host key in addition to
# its own, so a Brave-only registration leaves the host unreachable.
Write-Host "==> [browser] Writing native messaging registry keys (Chrome, Brave, Edge)..."
$registryTargets = @(
  @{ Name = 'Chrome'; Key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.interceptor.host' }
  @{ Name = 'Brave';  Key = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.interceptor.host' }
  @{ Name = 'Edge';   Key = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.interceptor.host' }
)

if ($DryRun) {
  foreach ($t in $registryTargets) { Write-Host "    DRY: registry: $($t.Key) (default) = $GeneratedManifest" }
} else {
  # Snapshot every key before touching it so a partial failure can be undone.
  $snapshots = @{}
  foreach ($t in $registryTargets) {
    $existed = Test-Path -LiteralPath $t.Key
    $prior = $null
    if ($existed) { $prior = (Get-ItemProperty -LiteralPath $t.Key -ErrorAction SilentlyContinue).'(default)' }
    $snapshots[$t.Key] = @{ Existed = $existed; Value = $prior }
  }
  try {
    foreach ($t in $registryTargets) {
      New-Item -Path $t.Key -Force | Out-Null
      Set-ItemProperty -Path $t.Key -Name '(default)' -Value $GeneratedManifest
      Write-Host "    $($t.Name): $($t.Key)"
    }
  } catch {
    Write-Warning "Registry write failed — restoring prior native-host values."
    foreach ($key in $snapshots.Keys) {
      $snap = $snapshots[$key]
      try {
        if (-not $snap.Existed) { Remove-Item -LiteralPath $key -Force -Recurse -ErrorAction SilentlyContinue }
        elseif ($null -ne $snap.Value) { Set-ItemProperty -Path $key -Name '(default)' -Value $snap.Value }
      } catch {}
    }
    Write-Error "ERROR: could not register the native messaging host: $($_.Exception.Message)"
    exit 1
  }
}

# ── Step 3: Manual extension instructions ────────────────────────────────────────
# No browser launch, no profile edits, no process control. Current branded Chrome
# ignores --load-extension on Windows, so automating it would report success while
# loading nothing.
if ($SkipExtension) {
  Write-Host "==> [browser] Skipping extension instructions (-SkipExtension)"
} else {
  $targets = if ($Browser -eq 'both') { @('chrome', 'brave') } else { @($Browser) }
  Write-Host ""
  Write-Host "==> [browser] Load the unpacked extension manually:"
  foreach ($target in $targets) {
    Write-Host ""
    Write-Host "    $(Get-ExtensionsUrl $target)"
    Write-Host "      1. Enable Developer mode (top-right toggle)."
    Write-Host "      2. Click 'Load unpacked'."
    Write-Host "      3. Select: $ExtensionDir"
  }
  Write-Host ""
  Write-Host "    Restart the browser afterward so it picks up the native-host registration."
}

Write-Host ""
Write-Host "==> Native messaging host registered (browser-only, source checkout)."
Write-Host "    Verify:  $CliPath status --verbose"
Write-Host "             (reports global extension reachability, not a specific browser/profile)"
Write-Host "    Product installer: docs/windows-install.md"
