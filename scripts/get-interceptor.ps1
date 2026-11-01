# Install Interceptor from the latest GitHub release (Browser-only x64: Win10 22H2+).
#
#   irm https://raw.githubusercontent.com/Hacker-Valley-Media/Interceptor/main/scripts/get-interceptor.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Hacker-Valley-Media/Interceptor/main/scripts/get-interceptor.ps1))) -Full -Mcp all
#
# Downloads the signed installer for this computer, checks its SHA-256 and Authenticode
# signature, runs it silently (per user, no admin), then adopts the agent skills and
# registers the MCP server with every tool on (asks first). macOS and Linux: scripts/get-interceptor.sh.
# It never installs the browser extension itself; on a first install it opens the Chrome Web Store page.
param(
  [switch]$Full,      # Full edition (the default): your browser plus native desktop apps
  [switch]$Browser,   # Browser edition only: web pages in your signed-in browser
  [string]$Mcp = "",  # "all", or a list like "claude,codex": register the MCP server without asking
  [switch]$NoMcp,     # do not register the MCP server
  [switch]$NoSkills,  # do not add Interceptor's skills to your AI agents
  [switch]$Help
)

function Install-Interceptor {
  param([switch]$Browser, [switch]$Full, [string]$Mcp, [switch]$NoMcp, [switch]$NoSkills, [switch]$Help)
  # Preferences set here stay in this function; iex would otherwise change the caller's session.
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"  # the progress bar slows Invoke-WebRequest badly on 5.1
  $repo = "Hacker-Valley-Media/Interceptor"
  $signer = "CN=Hacker Valley Media LLC,*"
  $storeUrl = "https://chromewebstore.google.com/detail/interceptor/gomcpnagjjlhehnkoobkjgnkbleiooed"
  $installDir = Join-Path $env:LOCALAPPDATA "Programs\Interceptor"
  $cli = Join-Path $installDir "interceptor.exe"
  # MCP access the installer grants: `all` lifts every tier gate, `raw` turns on the passthrough tool.
  $mcpAllow = "all,raw"

  if ($Help) {
    Write-Host "Install Interceptor from the latest release."
    Write-Host "  -Full        Full edition (the default): your browser plus native desktop apps"
    Write-Host "  -Browser     Browser edition only: web pages in your signed-in browser"
    Write-Host "  -Mcp all     Register the MCP server, with every tool on, in every AI app found (or -Mcp claude,codex)"
    Write-Host "  -NoMcp       Do not register the MCP server"
    Write-Host "  -NoSkills    Do not add Interceptor's skills to your AI agents"
    Write-Host "With no edition it keeps the installed one, asks interactively, and installs Full otherwise."
    Write-Host "Windows 10 22H2 x64 supports Full and Browser-only. Windows ARM64 still needs Windows 11 24H2+."
    Write-Host "With no MCP option it asks (default yes) for each AI app without the server, and registers it when it cannot ask."
    return
  }
  if ($Browser -and $Full) { throw "Pass -Browser or -Full, not both." }
  if ($Mcp -and $NoMcp) { throw "Pass -Mcp or -NoMcp, not both." }

  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  switch ($arch) { "Arm64" { $arch = "arm64" } "X64" { $arch = "x64" } default { throw "No Windows package for $arch." } }
  $osBuild = [Environment]::OSVersion.Version.Build
  # Full on Windows 10 22H2 x64 has a separate, lower OS minimum.
  # Preserve Browser-only mode for the older Windows 11 builds as before.
  $win10Full = $arch -eq "x64" -and $osBuild -ge 19045 -and $osBuild -lt 22000
  $olderWin11BrowserOnly = $arch -eq "x64" -and $osBuild -ge 22000 -and $osBuild -lt 26100
  if ($osBuild -lt 26100 -and -not ($win10Full -or $olderWin11BrowserOnly)) {
    throw "This package requires Windows 11 24H2+ (except Windows 10 22H2 x64 Full/Browser-only)."
  }
  if ($olderWin11BrowserOnly -and $Full) {
    throw "Full on this Windows 11 build is not qualified; use Browser-only or Windows 11 24H2+."
  }

  $prior = ""
  if (Test-Path (Join-Path $installDir "interceptor-desktop.exe")) { $prior = "full" }
  elseif (Test-Path $cli) { $prior = "browser" }
  $interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected

  $mode = if ($olderWin11BrowserOnly) { "browser" } elseif ($Full) { "full" } elseif ($Browser) { "browser" } else { "" }
  if ($win10Full) { Write-Host "==> Windows 10 22H2 x64: Full and Browser-only are supported" }
  if (-not $mode -and $prior) {
    $mode = $prior
    Write-Host "==> Keeping your $mode install (pass -Browser or -Full to change it)"
  } elseif (-not $mode -and $interactive) {
    $answer = Read-Host "Install Full (your browser plus desktop apps) or Browser only? [F/b]"
    $mode = if ($answer -match "^(b|browser)$") { "browser" } else { "full" }
  } elseif (-not $mode) {
    $mode = "full"
    Write-Host "==> Installing the Full edition (pass -Browser for browser only)"
  }

  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $tag = (Invoke-RestMethod -UseBasicParsing -Headers @{ "User-Agent" = "get-interceptor" } "https://api.github.com/repos/$repo/releases/latest").tag_name
  if ($tag -notmatch '^v(\d+\.\d+\.\d+)$') { throw "Could not read the latest version (got '$tag')." }
  $version = $Matches[1]
  $base = "https://github.com/$repo/releases/download/$tag"
  $edition = if ($mode -eq "full") { "Full" } else { "Browser" }
  $asset = "Interceptor-$edition-$version-windows-$arch.exe"

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("get-interceptor-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $exe = Join-Path $tmp $asset
    Write-Host "==> Downloading Interceptor $version ($asset)"
    Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile $exe
    Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS-ALL" -OutFile (Join-Path $tmp "SHA256SUMS-ALL")

    $line = Get-Content (Join-Path $tmp "SHA256SUMS-ALL") | Where-Object { ($_ -split '\s+')[1] -in @($asset, "*$asset") } | Select-Object -First 1
    if (-not $line) { throw "$asset is not listed in SHA256SUMS-ALL; nothing was installed." }
    $want = ($line -split '\s+')[0].ToLower()
    if ((Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower() -ne $want) { throw "Checksum mismatch for $asset; nothing was installed." }
    $sig = Get-AuthenticodeSignature $exe
    if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Subject -notlike $signer) {
      throw "$asset is not validly signed by Hacker Valley Media (status $($sig.Status)); nothing was installed."
    }
    Write-Host "==> Checked: SHA-256 matches, signed by Hacker Valley Media"

    Write-Host "==> Installing $asset"
    $log = Join-Path $tmp "setup.log"
    # Not -Wait: on Windows PowerShell 5.1 it also waits for everything Setup starts, and Setup ends
    # by starting interceptor-desktop.exe, which keeps running.
    $p = Start-Process -FilePath $exe -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=`"$log`"" -PassThru
    $null = $p.Handle  # keeps ExitCode readable after the process exits
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) {
      Copy-Item $log (Join-Path $env:TEMP "interceptor-setup.log") -ErrorAction SilentlyContinue
      throw "Setup failed with exit code $($p.ExitCode); log: $env:TEMP\interceptor-setup.log"
    }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  # Setup added Interceptor to the user PATH; pick it up in this window too.
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  $installed = ""
  if (Test-Path $cli) { $installed = (& $cli --version | Select-Object -First 1) }
  if ("$installed" -notlike "* $version *") { throw "Interceptor $version did not install (found: '$installed')." }
  Write-Host "==> Installed $installed"

  $failed = $false
  if (-not $NoSkills) {
    Write-Host "==> Adding Interceptor's skills to your AI agents"
    & $cli skills adopt
    if ($LASTEXITCODE -ne 0) { $failed = $true; Write-Warning "Skills were not added; run: interceptor skills adopt" }
  }
  if (-not $Mcp -and -not $NoMcp) {
    # Only AI apps that do not have the server yet ("<mark> <label>  detected (run: ...)" in the status table;
    # `mcp status --json` is lost in released CLIs up to 2.1.5). Ids follow CLIENTS in cli/mcp/install.ts.
    $ids = @{ "Claude Code" = "claude"; "Codex" = "codex"; "Gemini CLI" = "gemini"; "Cursor" = "cursor"; "Claude Desktop" = "claude-desktop" }
    $found = @(& $cli mcp status | ForEach-Object { if ($_ -match '^\S+ (.+?)\s{2,}detected \(run:') { $Matches[1] } } | Where-Object { $ids.ContainsKey($_) })
    if ($found.Count -gt 0) {
      $answer = ""
      if ($interactive) { $answer = Read-Host "Register the Interceptor MCP server in $($found -join ', '), with every tool on? [Y/n]" }
      if ($answer -notmatch "^(n|no)$") { $Mcp = ($found | ForEach-Object { $ids[$_] }) -join "," }
    }
  }
  if ($Mcp) {
    Write-Host "==> Registering the Interceptor MCP server with every tool on"
    if ($Mcp -eq "all") { & $cli mcp install --allow $mcpAllow } else { & $cli mcp install --into $Mcp --allow $mcpAllow }
    if ($LASTEXITCODE -eq 0) { Write-Host "    Every tool is on (INTERCEPTOR_MCP_ALLOW=$mcpAllow). For reading and clicking only, run: interceptor mcp install" }
    else { $failed = $true; Write-Warning "The MCP server was not registered; run: interceptor mcp install --allow $mcpAllow" }
  }

  Write-Host ""
  if (-not $prior) {
    Write-Host "==> Next: add the browser extension: $storeUrl"
    Write-Host "    (Edge: allow extensions from other stores first.)"
    # Silent Setup opens nothing, so open the store listing here, like the Mac postinstall's fallback.
    if ($interactive) { Start-Process $storeUrl }
  }
  Write-Host "    Try it in a new terminal: interceptor open https://example.com"
  if ($failed) { throw "Interceptor installed, but a follow-up step failed (see the warnings above)." }
}

Install-Interceptor -Browser:$Browser -Full:$Full -Mcp $Mcp -NoMcp:$NoMcp -NoSkills:$NoSkills -Help:$Help
