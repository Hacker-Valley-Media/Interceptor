<#
.SYNOPSIS
  Install Interceptor on Windows (browser-only).

.DESCRIPTION
  Windows analogue of scripts/install.sh. The macOS Swift bridge is mac-only,
  so on Windows -Full is rejected and only -BrowserOnly is supported.

  Steps performed:
    1. Generate native-messaging manifest pointing at daemon/interceptor-daemon.exe
    2. Write registry keys under HKCU:\Software\{Google\Chrome,BraveSoftware\Brave-Browser,Microsoft\Edge}\NativeMessagingHosts
    3. Preflight extensions.ui.developer_mode in the target profile's Preferences JSON
    4. Launch the chosen browser with --load-extension=...\extension\dist
    5. Probe `interceptor.exe status --verbose` for `extension: reachable`

.PARAMETER Browser
  chrome | brave | edge | both. If omitted, prompts (or auto-picks the only installed one).
  (both = chrome + brave, matching scripts/install.sh.)

.PARAMETER Profile
  Browser profile directory name (e.g. "Default", "Profile 2"). Defaults to "Default".

.PARAMETER SkipExtension
  Only install native-messaging manifest + registry keys; skip extension load.

.PARAMETER BrowserOnly
  Explicit browser-only mode. (Implicit on Windows; flag exists for parity with install.sh.)

.PARAMETER Full
  Rejected on Windows — the Swift bridge is macOS only. Use macOS to install --full.

.PARAMETER DryRun
  Print steps without executing.

.PARAMETER Profiles
  List browser profiles and exit.

.EXAMPLE
  pwsh -File scripts\install.ps1 -Browser brave -Profile Default

.EXAMPLE
  pwsh -File scripts\install.ps1 -Browser edge -Profiles

.EXAMPLE
  pwsh -File scripts\install.ps1 -Browser both -DryRun
#>

[CmdletBinding()]
param(
  [ValidateSet('chrome', 'brave', 'edge', 'both')]
  [string]$Browser,

  [string]$Profile = 'Default',

  [switch]$SkipExtension,

  [switch]$BrowserOnly,

  [switch]$Full,

  [switch]$DryRun,

  [switch]$Profiles
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

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

$ChromeBinaryCandidates = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$BraveBinaryCandidates = @(
  (Join-Path $env:ProgramFiles 'BraveSoftware\Brave-Browser\Application\brave.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'BraveSoftware\Brave-Browser\Application\brave.exe'),
  (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\Application\brave.exe')
)
$EdgeBinaryCandidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
)

function Find-Binary {
  param([string[]]$Candidates)
  foreach ($c in $Candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

$ChromeBinary = Find-Binary $ChromeBinaryCandidates
$BraveBinary  = Find-Binary $BraveBinaryCandidates
$EdgeBinary   = Find-Binary $EdgeBinaryCandidates

# ── Mode resolution (browser-only is the only valid mode on Windows) ─────────────
if ($Full) {
  Write-Error "ERROR: -Full is rejected on Windows. The Swift bridge is macOS-only.`n       Use -BrowserOnly (or omit; browser-only is implicit on Windows)."
  exit 1
}
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
  } elseif ($DryRun -or -not [Environment]::UserInteractive) {
    $Browser = 'chrome'
    Write-Host "==> Browser not specified; defaulting to '$Browser' (non-interactive)."
  } else {
    Write-Host ""
    Write-Host "Choose target browser:"
    if ($ChromeBinary) { Write-Host "  chrome   Google Chrome" }
    if ($BraveBinary)  { Write-Host "  brave    Brave Browser" }
    if ($EdgeBinary)   { Write-Host "  edge     Microsoft Edge" }
    if ($ChromeBinary -and $BraveBinary) { Write-Host "  both     Chrome and Brave" }
    $answer = Read-Host "Browser (default: chrome)"
    if (-not $answer) { $answer = 'chrome' }
    if ($answer -notin @('chrome', 'brave', 'edge', 'both')) {
      Write-Error "Unrecognized browser '$answer'. Use chrome, brave, edge, or both."
      exit 1
    }
    $Browser = $answer
  }
}

Write-Host "==> Mode: $Mode"
Write-Host "==> Browser: $Browser"
if ($DryRun) { Write-Host "==> DRY RUN — no files will be created or modified." }

# ── Preflight ────────────────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $DaemonPath)) {
  Write-Error "ERROR: daemon binary not found at $DaemonPath`n       Build it first: bash scripts/build.sh --target=windows"
  exit 1
}
if (-not $SkipExtension -and -not (Test-Path -LiteralPath $ExtensionDir) -and -not $DryRun) {
  Write-Error "ERROR: extension bundle not found at $ExtensionDir`n       Build it first: bash scripts/build.sh --target=windows"
  exit 1
}

# ── Step 1: Generate native-messaging manifest ───────────────────────────────────
Write-Host "==> [browser] Generating native messaging manifest..."
Invoke-Step -Description "mkdir $GeneratedDir; write $GeneratedManifest with path=$DaemonPath" -Action {
  New-Item -ItemType Directory -Force -Path $GeneratedDir | Out-Null
  $template = Get-Content -LiteralPath $TemplatePath -Raw | ConvertFrom-Json
  $template.path = $DaemonPath
  $template | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $GeneratedManifest -NoNewline
  Write-Host "    Manifest: $GeneratedManifest"
}

# ── Step 2: Write native-messaging registry keys ─────────────────────────────────
Write-Host "==> [browser] Writing native messaging registry keys..."
$registryTargets = @()
switch ($Browser) {
  'chrome' { $registryTargets += @{ Name = 'Chrome'; Key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.interceptor.host' } }
  'brave'  { $registryTargets += @{ Name = 'Brave';  Key = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.interceptor.host' } }
  'edge'   { $registryTargets += @{ Name = 'Edge';   Key = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.interceptor.host' } }
  'both'   {
    $registryTargets += @{ Name = 'Chrome'; Key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.interceptor.host' }
    $registryTargets += @{ Name = 'Brave';  Key = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.interceptor.host' }
  }
}
foreach ($t in $registryTargets) {
  Invoke-Step -Description "registry: $($t.Key) (default) = $GeneratedManifest" -Action {
    New-Item -Path $t.Key -Force | Out-Null
    Set-ItemProperty -Path $t.Key -Name '(default)' -Value $GeneratedManifest
    Write-Host "    $($t.Name): $($t.Key)"
  }
}

# ── Step 3: Load extension into chosen browser(s) ────────────────────────────────
function Get-DeveloperMode {
  param([string]$PrefsPath)
  if (-not (Test-Path -LiteralPath $PrefsPath)) { return 'unknown' }
  try {
    $json = Get-Content -LiteralPath $PrefsPath -Raw | ConvertFrom-Json
    if ($json.PSObject.Properties.Match('extensions').Count -gt 0 -and
        $json.extensions.PSObject.Properties.Match('ui').Count -gt 0 -and
        $json.extensions.ui.PSObject.Properties.Match('developer_mode').Count -gt 0) {
      if ($json.extensions.ui.developer_mode) { return 'true' }
      return 'false'
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

function Set-DeveloperModeTrue {
  param([string]$PrefsPath, [string]$BrowserBinary)
  if (-not (Test-Path -LiteralPath $PrefsPath)) { return $false }
  $procName = [System.IO.Path]::GetFileNameWithoutExtension($BrowserBinary)
  if (Get-Process -Name $procName -ErrorAction SilentlyContinue) { return $false }
  try {
    $json = Get-Content -LiteralPath $PrefsPath -Raw | ConvertFrom-Json
    if (-not $json.PSObject.Properties.Match('extensions').Count) {
      $json | Add-Member -NotePropertyName 'extensions' -NotePropertyValue ([pscustomobject]@{})
    }
    if (-not $json.extensions.PSObject.Properties.Match('ui').Count) {
      $json.extensions | Add-Member -NotePropertyName 'ui' -NotePropertyValue ([pscustomobject]@{})
    }
    if (-not $json.extensions.ui.PSObject.Properties.Match('developer_mode').Count) {
      $json.extensions.ui | Add-Member -NotePropertyName 'developer_mode' -NotePropertyValue $true
    } else {
      $json.extensions.ui.developer_mode = $true
    }
    # Atomic-ish write: write sibling, then move into place.
    $tmp = "$PrefsPath.tmp"
    $json | ConvertTo-Json -Depth 100 -Compress | Set-Content -LiteralPath $tmp -NoNewline
    Move-Item -LiteralPath $tmp -Destination $PrefsPath -Force
    return $true
  } catch {
    return $false
  }
}

function Test-ExtensionReachable {
  if (-not (Test-Path -LiteralPath $CliPath)) { return $true }  # nothing to probe with; skip silently
  $output = & $CliPath status --verbose 2>$null
  return ($output -match '(?m)^extension:\s+reachable')
}

function Invoke-LoadExtension {
  param(
    [string]$Target,
    [string]$BrowserBinary,
    [string]$ProfileRoot,
    [string]$DisplayName
  )

  if ($SkipExtension) {
    Write-Host "==> [browser] Skipping extension loading (-SkipExtension)"
    return
  }

  if ($DryRun) {
    Write-Host "==> [browser] DRY: would launch $DisplayName --load-extension=$ExtensionDir"
    return
  }

  if (-not $BrowserBinary) {
    Write-Host "==> [browser] $DisplayName binary not found — skipping extension load."
    Write-Host "    Native messaging registry key has been installed."
    Write-Host "    Load manually: open the browser, navigate to $(Get-ExtensionsUrl $Target),"
    Write-Host "    enable Developer mode, click 'Load unpacked', select: $ExtensionDir"
    return
  }

  $profilePath = Join-Path $ProfileRoot $Profile
  $prefsPath   = Join-Path $profilePath 'Preferences'
  $devMode     = Get-DeveloperMode $prefsPath
  $extUrl      = Get-ExtensionsUrl $Target

  if ($devMode -eq 'false' -or $devMode -eq 'unknown') {
    Write-Host ""
    Write-Host "==> [browser] $DisplayName profile '$Profile' has Developer mode OFF (or hasn't been opened yet)."
    Write-Host ""
    Write-Host "    Without Developer mode, --load-extension is silently dropped by Chromium:"
    Write-Host "    the install reports success, the extension never registers, and every"
    Write-Host "    'interceptor open / read / act / ...' will time out at 15s."
    Write-Host ""
    Write-Host "    Manual remediation:"
    Write-Host "      1. Quit $DisplayName entirely."
    Write-Host "      2. Re-launch $DisplayName, open $extUrl, toggle Developer mode ON."
    Write-Host "      3. Quit $DisplayName again."
    Write-Host "      4. Re-run: pwsh -File scripts/install.ps1 -Browser $Target -Profile `"$Profile`""

    $procName = [System.IO.Path]::GetFileNameWithoutExtension($BrowserBinary)
    $isRunning = $null -ne (Get-Process -Name $procName -ErrorAction SilentlyContinue)
    $canAuto = (Test-Path -LiteralPath $prefsPath) -and -not $isRunning

    if ($canAuto -and [Environment]::UserInteractive) {
      Write-Host ""
      $answer = Read-Host "    Or: enable Developer mode now (writes Preferences while $DisplayName is closed)? [y/N]"
      if ($answer -and ($answer -eq 'y' -or $answer -eq 'Y')) {
        if (Set-DeveloperModeTrue $prefsPath $BrowserBinary) {
          Write-Host "    Developer mode enabled in $prefsPath."
        } else {
          Write-Error "    Failed to write Preferences (browser may have launched, file missing, or JSON malformed). Use the manual path above."
          exit 1
        }
      } else {
        Write-Error "    Skipped auto-enable. Use the manual path above, then re-run."
        exit 1
      }
    } elseif ([Environment]::UserInteractive) {
      Write-Error "    Auto-enable unavailable (no Preferences file at '$prefsPath' or $DisplayName is still running). Use the manual path."
      exit 1
    } else {
      exit 1
    }
  }

  $procName = [System.IO.Path]::GetFileNameWithoutExtension($BrowserBinary)
  $running = Get-Process -Name $procName -ErrorAction SilentlyContinue
  if ($running) {
    Write-Host ""
    Write-Host "==> $DisplayName is already running."
    Write-Host "    To load the extension without browser intervention, $DisplayName must be restarted."
    Write-Host "    Option 1 — Quit $DisplayName, then re-run this script."
    Write-Host "    Option 2 — Load manually:"
    Write-Host "      1. Open $extUrl"
    Write-Host "      2. Enable Developer Mode"
    Write-Host "      3. Load unpacked -> $ExtensionDir"
    Write-Host "    Option 3 — Force quit and relaunch (will restore tabs)."
    if ([Environment]::UserInteractive) {
      $confirm = Read-Host "      Quit $DisplayName and relaunch with extension? [y/N]"
      if ($confirm -and ($confirm -eq 'y' -or $confirm -eq 'Y')) {
        Write-Host "    Quitting $DisplayName..."
        Stop-Process -Name $procName -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        for ($j = 0; $j -lt 10; $j++) {
          if (-not (Get-Process -Name $procName -ErrorAction SilentlyContinue)) { break }
          Start-Sleep -Seconds 1
        }
      } else {
        Write-Host "    Skipping extension loading."
        return
      }
    } else {
      Write-Host "    Skipping (non-interactive)."
      return
    }
  }

  if ($Target -eq 'chrome' -or $Target -eq 'edge') {
    Write-Host ""
    Write-Host "==> $DisplayName on Windows accepts --load-extension but treats it as a developer flag."
    Write-Host "    Each launch may show 'Disable developer mode extensions' banner."
    Write-Host "    For a quieter setup, load manually via $extUrl -> Load unpacked -> $ExtensionDir"
  }

  Write-Host ""
  Write-Host "==> [browser] Launching $DisplayName with --load-extension..."
  Write-Host "    Extension: $ExtensionDir"

  $launchArgs = @("--load-extension=$ExtensionDir")
  if ($Profile) {
    $launchArgs += "--profile-directory=$Profile"
    Write-Host "    Profile:   $Profile"
  }

  Start-Process -FilePath $BrowserBinary -ArgumentList $launchArgs | Out-Null

  # ── Reachability probe ─────────────────────────────────────────────────────────
  Write-Host ""
  Write-Host "==> Verifying extension reachability (waits up to 8s)..."
  $probed = $false
  for ($i = 0; $i -lt 8; $i++) {
    Start-Sleep -Seconds 1
    if (Test-ExtensionReachable) { $probed = $true; break }
  }

  if ($probed) {
    Write-Host "==> Extension loaded into $DisplayName and reachable."
    Write-Host "    Extension ID: hkjbaciefhhgekldhncknbjkofbpenng"
    if ($Profile) { Write-Host "    Profile: $Profile" }
  } else {
    Write-Warning "==> $DisplayName launched, but the extension is NOT reachable after 8s."
    Write-Host ""
    Write-Host "    Most common cause: Developer mode is off in the profile $DisplayName actually opened"
    Write-Host "    (which may differ from the profile this script targeted)."
    Write-Host ""
    Write-Host "    Verify in ${DisplayName}:"
    Write-Host "      1. Open $extUrl"
    Write-Host "      2. Confirm Developer mode is ON (top-right toggle)."
    Write-Host "      3. Confirm 'Interceptor' appears with ID hkjbaciefhhgekldhncknbjkofbpenng."
    Write-Host "      4. If missing, click 'Load unpacked' and select: $ExtensionDir"
    Write-Host ""
    Write-Host "    Diagnose with: $CliPath status --verbose"
  }
}

switch ($Browser) {
  'chrome' { Invoke-LoadExtension -Target 'chrome' -BrowserBinary $ChromeBinary -ProfileRoot $ChromeUserData -DisplayName 'Chrome' }
  'brave'  { Invoke-LoadExtension -Target 'brave'  -BrowserBinary $BraveBinary  -ProfileRoot $BraveUserData  -DisplayName 'Brave'  }
  'edge'   { Invoke-LoadExtension -Target 'edge'   -BrowserBinary $EdgeBinary   -ProfileRoot $EdgeUserData   -DisplayName 'Edge'   }
  'both'   {
    Invoke-LoadExtension -Target 'chrome' -BrowserBinary $ChromeBinary -ProfileRoot $ChromeUserData -DisplayName 'Chrome'
    Invoke-LoadExtension -Target 'brave'  -BrowserBinary $BraveBinary  -ProfileRoot $BraveUserData  -DisplayName 'Brave'
  }
}

Write-Host ""
Write-Host "==> Done. Installed in browser-only mode."
Write-Host "    Test:    $CliPath status   (expect 'mode: browser-only')"
Write-Host "    Open:    $CliPath open https://example.com"
