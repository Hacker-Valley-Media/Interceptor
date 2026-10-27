#!/bin/bash
# Install Interceptor from the latest GitHub release, end to end (macOS and Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/Hacker-Valley-Media/Interceptor/main/scripts/get-interceptor.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Hacker-Valley-Media/Interceptor/main/scripts/get-interceptor.sh | bash -s -- --full --mcp
#
# Downloads the signed package for this computer, checks its SHA-256 and signature,
# installs it without the Installer wizard, then adopts the agent skills and
# optionally registers the MCP server. Windows: scripts/get-interceptor.ps1.
# It never installs the browser extension itself; the first-run welcome window offers it.
set -euo pipefail

REPO="Hacker-Valley-Media/Interceptor"
# Version-less links to the newest release (302 to the GitHub asset); see Interceptor-Updates-Sparkle/Caddyfile.
LATEST="${INTERCEPTOR_LATEST_URL:-https://updates.hackervalley.media/latest}"
MAC_SIGNER="Developer ID Installer: HACKER VALLEY MEDIA, LLC (TPWBZD35WW)"
# Leaf certificate that signs the Linux SHA256SUMS (same pin as scripts/verify-release-manifest.sh).
LINUX_SIGNER_SHA256="660fb2654b040d9f57f209a59c2717bf60ec0f7428c4ae1d5a7df40695ed6860"
STORE_URL="https://chromewebstore.google.com/detail/interceptor/gomcpnagjjlhehnkoobkjgnkbleiooed"
# MCP access the installer grants: `all` lifts every tier gate (destructive and exec, every
# surface) and `raw` turns on the passthrough tool; see cli/mcp/tiers.ts parseAllow.
MCP_ALLOW="all,raw"
LINUX_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/interceptor-release"

usage() {
  cat <<'EOF'
Install Interceptor from the latest release.

Usage: get-interceptor.sh [options]
  --full           Full edition (the default): your browser plus native desktop apps,
                   and the iPhone on a Mac
  --browser        Browser edition only: web pages in your signed-in browser
  --safari         macOS: also install the Safari extension package
  --mcp            Register the MCP server, with every tool on, in every AI app found
  --mcp=LIST       Register it only in these apps (claude,codex,gemini,cursor,claude-desktop)
  --no-mcp         Do not register the MCP server
  --no-skills      Do not add Interceptor's skills to your AI agents
  -h, --help       Show this help

With no edition flag it keeps the edition already installed, asks when it has a
terminal, and installs Full otherwise. With no MCP flag it asks (default yes) for
each AI app that does not have the server yet, and registers it when it cannot ask.
EOF
}

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
has_tty() { (exec </dev/tty) 2>/dev/null; }

asset_name() { # os arch mode version
  local edition=Browser
  [[ "$3" == full ]] && edition=Full
  case "$1" in
    Darwin) echo "Interceptor-$edition-$4.pkg" ;;
    Linux) echo "Interceptor-$edition-$4-linux-$2.tar.gz" ;;
    *) return 1 ;;
  esac
}

latest_name() { # os arch mode: the version-less name under $LATEST
  local edition=Browser
  [[ "$3" == full ]] && edition=Full
  case "$1" in
    Darwin) echo "Interceptor-$edition.pkg" ;;
    Linux) echo "Interceptor-$edition-linux-$2.tar.gz" ;;
    *) return 1 ;;
  esac
}

mcp_targets() { # cli: "id,id|Label, Label" for AI apps found that do not have the MCP server yet
  # Reads the text table ("<mark> <label>  detected (run: ...)"): `mcp status --json` is lost in released
  # CLIs up to 2.1.5. Labels and ids follow CLIENTS in cli/mcp/install.ts.
  "$1" mcp status 2>/dev/null | awk '
    /  detected \(run:/ { sub(/^[^ ]+ /, ""); sub(/  .*$/, "")
      id = ($0 == "Claude Code") ? "claude" : ($0 == "Codex") ? "codex" : ($0 == "Gemini CLI") ? "gemini" \
         : ($0 == "Cursor") ? "cursor" : ($0 == "Claude Desktop") ? "claude-desktop" : ""
      if (id != "") { ids = ids sep id; labels = labels sep2 $0; sep = ","; sep2 = ", " } }
    END { printf "%s|%s", ids, labels }'
}

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'
}

check_sum() { # file sums-file
  local name want
  name="$(basename "$1")"
  want="$(tr -d '\r' <"$2" | awk -v n="$name" '$2 == n || $2 == "*" n {print $1; exit}')"
  [[ -n "$want" ]] || die "$name is not listed in $(basename "$2"); nothing was installed"
  [[ "$(sha256_of "$1")" == "$want" ]] || die "checksum mismatch for $name; nothing was installed"
}

check_pkg() { # pkg
  local out
  out="$(pkgutil --check-signature "$1" 2>&1)" || die "$(basename "$1") is not signed; nothing was installed"
  grep -qF "$MAC_SIGNER" <<<"$out" || die "$(basename "$1") is not signed by Hacker Valley Media; nothing was installed"
  spctl -a -t install "$1" >/dev/null 2>&1 || die "$(basename "$1") is not notarized by Apple; nothing was installed"
}

check_linux_manifest() { # dir holding SHA256SUMS, SHA256SUMS.cms, linux-release-apple-root.pem
  command -v openssl >/dev/null || die "openssl is needed to check the release signature"
  openssl cms -verify -binary -inform DER -in "$1/SHA256SUMS.cms" -content "$1/SHA256SUMS" -purpose any \
    -ignore_critical -CAfile "$1/linux-release-apple-root.pem" -signer "$1/signer.pem" -out "$1/manifest" >/dev/null 2>&1 \
    || die "the release signature did not verify; nothing was installed"
  [[ "$(grep -c 'BEGIN CERTIFICATE' "$1/signer.pem")" == 1 ]] || die "the release must have exactly one signer"
  local fp
  fp="$(openssl x509 -in "$1/signer.pem" -noout -fingerprint -sha256 | sed 's/.*=//' | tr -d ':' | tr 'A-F' 'a-f')"
  [[ "$fp" == "$LINUX_SIGNER_SHA256" ]] || die "the release was signed by an unexpected certificate; nothing was installed"
  cmp -s "$1/SHA256SUMS" "$1/manifest" || die "the signed checksum list changed; nothing was installed"
}

installed_mode() { # os
  case "$1" in
    Darwin)
      if pkgutil --pkg-info com.interceptor.bridge.pkg >/dev/null 2>&1; then echo full
      elif pkgutil --pkg-info com.interceptor.daemon.pkg >/dev/null 2>&1; then echo browser
      fi ;;
    Linux)
      if [[ -f "$HOME/.local/share/interceptor/desktop-install.sha256" ]]; then echo full
      elif [[ -x "$LINUX_HOME/current/dist/interceptor" ]]; then echo browser
      fi ;;
  esac
}

install_pkg() { # pkg
  say "Installing $(basename "$1")"
  if [[ $EUID -eq 0 ]]; then
    installer -pkg "$1" -target /
  elif has_tty || sudo -n true 2>/dev/null; then
    sudo installer -pkg "$1" -target /
  else
    # No terminal (an AI agent ran this), so sudo cannot ask for the password. macOS 27 words a
    # scripted administrator prompt as "Apple could not verify this script is free of malware",
    # so hand the verified package to Installer, which names
    # Hacker Valley Media as the signer. Waits until Installer closes.
    say "No terminal to ask for your password: finish in the Installer window that just opened"
    open -W "$1"
  fi
}

install_linux() { # tarball mode
  mkdir -p "$LINUX_HOME"
  local stage dir link="$HOME/.local/bin/interceptor" flag=--browser-only
  stage="$(mktemp -d "$LINUX_HOME/.stage.XXXXXX")"
  tar -xzf "$1" -C "$stage"
  dir="$(find "$stage" -mindepth 1 -maxdepth 1 -type d | head -1)"
  [[ -f "$dir/scripts/install.sh" ]] || die "the archive has no scripts/install.sh"
  # A fixed folder, so the native host and an unpacked extension keep their paths across upgrades.
  rm -rf "$LINUX_HOME/current"
  mv "$dir" "$LINUX_HOME/current"
  rm -rf "$stage"
  if [[ "$2" == full ]]; then
    flag=--full
    # Drop our own Browser-edition link first; the Full installer refuses a link it did not make.
    if [[ -L "$link" && "$(readlink "$link")" == "$LINUX_HOME/current/dist/interceptor" ]]; then rm -f "$link"; fi
  fi
  if has_tty; then
    bash "$LINUX_HOME/current/scripts/install.sh" "$flag" </dev/tty
  else
    bash "$LINUX_HOME/current/scripts/install.sh" "$flag" </dev/null
  fi
  if [[ "$2" == browser && ! -e "$link" ]]; then
    mkdir -p "$(dirname "$link")"
    ln -s "$LINUX_HOME/current/dist/interceptor" "$link"
  fi
}

main() {
  local mode="" safari=0 skills=1 mcp=ask
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --browser) mode=browser ;;
      --full) mode=full ;;
      --safari) safari=1 ;;
      --mcp) mcp=all ;;
      --mcp=*) mcp="${1#--mcp=}"; [[ -n "$mcp" ]] || die "--mcp= needs a list, for example --mcp=claude,codex" ;;
      --no-mcp) mcp=no ;;
      --no-skills) skills=0 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option '$1' (see --help)" ;;
    esac
    shift
  done

  local os arch
  os="$(uname -s)"
  case "$os" in
    Darwin)
      [[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" == 1 ]] \
        || die "the macOS packages need Apple silicon; on an Intel Mac build from source: https://github.com/$REPO#development-and-contributions"
      arch=arm64 ;;
    Linux)
      case "$(uname -m)" in
        aarch64|arm64) arch=arm64 ;;
        x86_64|amd64) arch=x64 ;;
        *) die "no Linux package for $(uname -m)" ;;
      esac ;;
    *) die "this script is for macOS and Linux; on Windows run: irm https://raw.githubusercontent.com/$REPO/main/scripts/get-interceptor.ps1 | iex" ;;
  esac
  [[ $safari == 0 || $os == Darwin ]] || die "--safari is for macOS"

  local prior
  prior="$(installed_mode "$os")"
  if [[ -z "$mode" && -n "$prior" ]]; then
    mode="$prior"
    say "Keeping your $mode install (pass --browser or --full to change it)"
  elif [[ -z "$mode" ]] && has_tty; then
    printf 'Install Full (your browser plus desktop apps%s) or Browser only? [F/b] ' "$([[ $os == Darwin ]] && echo ' and iPhone')" >/dev/tty
    local answer=""
    read -r answer </dev/tty || true
    case "$answer" in b|B|browser|Browser) mode=browser ;; *) mode=full ;; esac
  elif [[ -z "$mode" ]]; then
    mode=full
    say "Installing the Full edition (pass --browser for browser only)"
  fi

  # The update host's version file for this OS names the release its /latest/ links point at.
  local version src="$LATEST" vfile=desktop.txt
  [[ $os == Darwin ]] && vfile=macos.txt
  version="$(curl -fsSL --max-time 20 "$LATEST/$vfile" 2>/dev/null | tr -d '[:space:]')" || version=""
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    # Update host unreachable: take the same signed files straight from GitHub.
    local url
    url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" \
      || die "could not reach updates.hackervalley.media or GitHub"
    version="${url##*/v}"; src=""
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "could not read the latest version from $url"
  fi
  # Checksum lists always come from the immutable GitHub release for that version.
  local base="https://github.com/$REPO/releases/download/v$version"

  local asset
  # Global, so the EXIT trap still sees it after main returns.
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/get-interceptor.XXXXXX")"
  trap 'rm -rf "$TMP_DIR"' EXIT
  local tmp="$TMP_DIR"
  asset="$(asset_name "$os" "$arch" "$mode" "$version")"
  # Saved under the versioned name the checksum lists use; if /latest/ moved mid-run the
  # checksum no longer matches and nothing is installed.
  local from="$base/$asset"
  [[ -n "$src" ]] && from="$src/$(latest_name "$os" "$arch" "$mode")"
  say "Downloading Interceptor $version from ${from%/*}/"
  curl -fSL --retry 3 --progress-bar -o "$tmp/$asset" "$from"

  local cli
  if [[ $os == Darwin ]]; then
    curl -fsSL --retry 3 -o "$tmp/SHA256SUMS-ALL" "$base/SHA256SUMS-ALL"
    local pkgs=("$tmp/$asset")
    if [[ $safari == 1 ]]; then
      local safari_from="$base/Interceptor-Safari-$version.pkg"
      [[ -n "$src" ]] && safari_from="$src/Interceptor-Safari.pkg"
      curl -fSL --retry 3 --progress-bar -o "$tmp/Interceptor-Safari-$version.pkg" "$safari_from"
      pkgs+=("$tmp/Interceptor-Safari-$version.pkg")
    fi
    local pkg
    for pkg in "${pkgs[@]}"; do check_sum "$pkg" "$tmp/SHA256SUMS-ALL"; check_pkg "$pkg"; done
    say "Checked: SHA-256 matches, signed by Hacker Valley Media, notarized by Apple"
    for pkg in "${pkgs[@]}"; do install_pkg "$pkg"; done
    cli=/usr/local/bin/interceptor
  else
    local f
    for f in SHA256SUMS SHA256SUMS.cms linux-release-apple-root.pem; do
      curl -fsSL --retry 3 -o "$tmp/$f" "$base/$f"
    done
    check_linux_manifest "$tmp"
    check_sum "$tmp/$asset" "$tmp/SHA256SUMS"
    say "Checked: SHA-256 matches the checksum list signed by Hacker Valley Media"
    install_linux "$tmp/$asset" "$mode"
    if [[ $mode == full ]]; then cli="$HOME/.local/share/interceptor/interceptor"; else cli="$LINUX_HOME/current/dist/interceptor"; fi
  fi
  local installed
  installed="$("$cli" --version 2>/dev/null | head -1 || true)"
  [[ "$installed" == *" $version "* ]] || die "Interceptor $version did not install (found: ${installed:-nothing at $cli})"
  say "Installed $installed"

  local failed=0
  if [[ $skills == 1 ]]; then
    say "Adding Interceptor's skills to your AI agents"
    "$cli" skills adopt || { failed=1; echo "warning: skills were not added; run: interceptor skills adopt" >&2; }
  fi
  if [[ $mcp == ask ]]; then
    # Only AI apps that do not have the server yet: a re-run leaves an existing registration as it is.
    local targets ids labels
    # A failing `mcp status` means no AI apps to offer, not a failed install.
    targets="$(mcp_targets "$cli")" || targets="|"
    ids="${targets%%|*}"; labels="${targets#*|}"
    if [[ -z "$ids" ]]; then
      mcp=no
    elif has_tty; then
      printf 'Register the Interceptor MCP server in %s, with every tool on? [Y/n] ' "$labels" >/dev/tty
      local answer=""
      read -r answer </dev/tty || true
      case "$answer" in n|N|no|No) mcp=no ;; *) mcp="$ids" ;; esac
    else
      mcp="$ids"
    fi
  fi
  if [[ $mcp != no ]]; then
    say "Registering the Interceptor MCP server with every tool on"
    local mcp_ok=1
    if [[ $mcp == all ]]; then "$cli" mcp install --allow "$MCP_ALLOW" || mcp_ok=0
    else "$cli" mcp install --into "$mcp" --allow "$MCP_ALLOW" || mcp_ok=0; fi
    if [[ $mcp_ok == 1 ]]; then
      echo "    Every tool is on (INTERCEPTOR_MCP_ALLOW=$MCP_ALLOW). For reading and clicking only, run: interceptor mcp install"
    else
      failed=1; echo "warning: the MCP server was not registered; run: interceptor mcp install --allow $MCP_ALLOW" >&2
    fi
  fi

  echo
  if [[ $os == Darwin && -z "$prior" ]]; then
    say "Next: add the browser extension in the Interceptor window that just opened."
    echo "    No window? Add it from $STORE_URL"
  fi
  [[ $os == Darwin && $mode == full ]] && echo "    For desktop apps, grant permissions when asked, or run: interceptor macos trust --walkthrough"
  [[ $safari == 1 ]] && echo "    Safari: open /Applications/InterceptorSafari.app once, then turn on Interceptor in Safari > Settings > Extensions."
  case ":$PATH:" in *":$(dirname "$cli"):"*|*":$HOME/.local/bin:"*) ;; *) [[ $os == Linux ]] && echo "    Add ~/.local/bin to your PATH to run 'interceptor' by name." ;; esac
  echo "    Try it: interceptor open https://example.com"
  return $failed
}

# Everything above only defines functions, so a cut-off download runs nothing.
# Tests source the file with GET_INTERCEPTOR_LIB=1 to call the functions directly.
[[ "${GET_INTERCEPTOR_LIB:-}" == 1 ]] || main "$@"
