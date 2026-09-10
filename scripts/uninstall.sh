#!/bin/bash
# Uninstall Interceptor.
#
# Handles both install paths:
#   • Pkg install (public release):   /Applications, /usr/local/bin,
#     /Library/Application Support/Interceptor (system locations — needs sudo)
#   • Developer install (install.sh): repo-relative, no sudo
#
# --bridge-only flag downgrades a full install back to browser-only by
# removing ONLY the Swift-bridge artifacts (LaunchAgent + .app + symlink),
# leaving the daemon / CLI / extension / native-messaging manifest in place.
#
# Run with:
#   sudo bash /Library/Application Support/Interceptor/uninstall.sh   (pkg install)
#   bash scripts/uninstall.sh                                          (dev install — full)
#   bash scripts/uninstall.sh --bridge-only                            (downgrade to browser-only)

set -euo pipefail

# ── Parse flags ────────────────────────────────────────────────────────────────
BRIDGE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --bridge-only) BRIDGE_ONLY=1 ;;
    -h|--help)
      echo "Usage: bash scripts/uninstall.sh [--bridge-only]"
      echo ""
      echo "  (no flags)        Remove everything — both browser and bridge surfaces."
      echo "  --bridge-only     Remove only the macOS bridge (LaunchAgent + .app + symlink),"
      echo "                    leaving the browser-only install (daemon, CLI, extension,"
      echo "                    native messaging manifests) intact. Effectively downgrades"
      echo "                    a full install to browser-only."
      exit 0 ;;
    *)
      echo "Unknown flag: $arg" >&2
      echo "Use 'bash scripts/uninstall.sh --help' for usage." >&2
      exit 1 ;;
  esac
done

USER_HOME="${USER_HOME_OVERRIDE:-$HOME}"
# Honor sudo: prefer the GUI user's home so we clean per-user files even when
# uninstall is run as root.
if [[ -n "${SUDO_USER:-}" && -d "/Users/$SUDO_USER" ]]; then
  USER_HOME="/Users/$SUDO_USER"
fi

PATH_MARKER_START="# >>> interceptor path >>>"
PATH_MARKER_END="# <<< interceptor path <<<"

# ── Bridge-only path (downgrade) ──────────────────────────────────────────────
if [[ "$BRIDGE_ONLY" == "1" ]]; then
  echo "==> Downgrading to browser-only mode (--bridge-only)..."

  echo "==> Stopping bridge process..."
  pkill -f "interceptor-bridge" 2>/dev/null || true
  rm -f /tmp/interceptor-bridge.sock /tmp/interceptor-bridge.pid

  echo "==> Removing bridge LaunchAgent..."
  TARGET_UID="$(id -u "${SUDO_USER:-$USER}" 2>/dev/null || echo "")"
  if [[ -n "$TARGET_UID" ]]; then
    launchctl bootout "gui/$TARGET_UID/com.interceptor.bridge" 2>/dev/null || true
  fi
  rm -f "$USER_HOME/Library/LaunchAgents/com.interceptor.bridge.plist"
  if [[ -e "/Library/LaunchAgents/com.interceptor.bridge.plist" ]]; then
    rm -f "/Library/LaunchAgents/com.interceptor.bridge.plist" 2>/dev/null && \
      echo "    removed /Library/LaunchAgents/com.interceptor.bridge.plist" || \
      echo "    /Library/LaunchAgents/com.interceptor.bridge.plist — re-run with sudo"
  fi

  echo "==> Removing bridge .app bundle and symlinks..."
  if [[ -e "$USER_HOME/.local/share/interceptor/interceptor-bridge.app" ]]; then
    rm -rf "$USER_HOME/.local/share/interceptor/interceptor-bridge.app"
  fi
  # If the .local/share/interceptor dir is now empty, drop it.
  rmdir "$USER_HOME/.local/share/interceptor" 2>/dev/null || true
  rm -f "$USER_HOME/.local/bin/interceptor-bridge"
  if [[ -e "/Applications/interceptor-bridge.app" ]]; then
    rm -rf "/Applications/interceptor-bridge.app" 2>/dev/null && \
      echo "    removed /Applications/interceptor-bridge.app" || \
      echo "    /Applications/interceptor-bridge.app — re-run with sudo"
  fi
  if [[ -e "/usr/local/bin/interceptor-bridge" ]]; then
    rm -f "/usr/local/bin/interceptor-bridge" 2>/dev/null || true
  fi

  echo ""
  echo "Bridge removed. Browser-only install remains intact."
  echo "Verify with: interceptor status   (expect 'mode: browser-only')"
  exit 0
fi

# ── Full uninstall (default) ──────────────────────────────────────────────────
echo "==> Stopping interceptor processes..."
pkill -f "interceptor-daemon" 2>/dev/null || true
pkill -f "interceptor-bridge" 2>/dev/null || true

echo "==> Removing runtime files..."
rm -f /tmp/interceptor.sock /tmp/interceptor.pid
rm -f /tmp/interceptor-bridge.sock /tmp/interceptor-bridge.pid

echo "==> Removing native messaging manifests..."
rm -f "$USER_HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.interceptor.host.json"
rm -f "$USER_HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.interceptor.host.json"
rm -f "$USER_HOME/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts/com.interceptor.host.json"
rm -f "$USER_HOME/Library/Application Support/Chromium/NativeMessagingHosts/com.interceptor.host.json"

# Dev install — clean repo-relative generated dir if present
if [[ -d "$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/daemon/.generated" ]]; then
  rm -rf "$(cd "$(dirname "$0")/.." && pwd)/daemon/.generated"
fi

echo "==> Removing extension metadata from old installs if present..."
for ext_id in gomcpnagjjlhehnkoobkjgnkbleiooed hkjbaciefhhgekldhncknbjkofbpenng; do
  rm -f "$USER_HOME/Library/Application Support/Google/Chrome/External Extensions/$ext_id.json"
  rm -f "$USER_HOME/Library/Application Support/BraveSoftware/Brave-Browser/External Extensions/$ext_id.json"
done

echo "==> Removing bridge LaunchAgent (both system and per-user paths)..."
TARGET_UID="$(id -u "${SUDO_USER:-$USER}" 2>/dev/null || echo "")"
if [[ -n "$TARGET_UID" ]]; then
  launchctl bootout "gui/$TARGET_UID/com.interceptor.bridge" 2>/dev/null || true
fi
rm -f "$USER_HOME/Library/LaunchAgents/com.interceptor.bridge.plist"
# pkg install puts the LaunchAgent here (system-wide, root-owned)
if [[ -e "/Library/LaunchAgents/com.interceptor.bridge.plist" ]]; then
  rm -f "/Library/LaunchAgents/com.interceptor.bridge.plist" 2>/dev/null && \
    echo "    removed /Library/LaunchAgents/com.interceptor.bridge.plist" || \
    echo "    /Library/LaunchAgents/com.interceptor.bridge.plist — re-run with sudo"
fi

echo "==> Removing per-user bridge .app bundle and symlinks..."
if [[ -e "$USER_HOME/.local/share/interceptor/interceptor-bridge.app" ]]; then
  rm -rf "$USER_HOME/.local/share/interceptor/interceptor-bridge.app"
fi
rmdir "$USER_HOME/.local/share/interceptor" 2>/dev/null || true
rm -f "$USER_HOME/.local/bin/interceptor-bridge"

echo "==> Removing pkg-installed system files (requires sudo to fully clean)..."
if [[ -e "/Applications/interceptor-bridge.app" ]]; then
  rm -rf "/Applications/interceptor-bridge.app" 2>/dev/null && \
    echo "    removed /Applications/interceptor-bridge.app" || \
    echo "    /Applications/interceptor-bridge.app — re-run with sudo"
fi
if [[ -e "/usr/local/bin/interceptor" ]]; then
  rm -f "/usr/local/bin/interceptor" 2>/dev/null && \
    echo "    removed /usr/local/bin/interceptor" || \
    echo "    /usr/local/bin/interceptor — re-run with sudo"
fi
if [[ -e "/usr/local/bin/interceptor-bridge" ]]; then
  rm -f "/usr/local/bin/interceptor-bridge" 2>/dev/null || true
fi
if [[ -e "/Library/Application Support/Interceptor" ]]; then
  rm -rf "/Library/Application Support/Interceptor" 2>/dev/null && \
    echo "    removed /Library/Application Support/Interceptor" || \
    echo "    /Library/Application Support/Interceptor — re-run with sudo"
fi

# Forget the package receipts so a future reinstall starts clean.
pkgutil --pkgs 2>/dev/null | grep -E '^com\.interceptor\.' | while read -r p; do
  pkgutil --forget "$p" >/dev/null 2>&1 || true
done

echo "==> Removing legacy CLI install directory if present..."
rm -rf "$USER_HOME/.interceptor"

echo "==> Removing legacy shell PATH hooks if present..."
for target in "$USER_HOME/.zprofile" "$USER_HOME/.zshrc" "$USER_HOME/.bash_profile" "$USER_HOME/.bashrc"; do
  [[ -f "$target" ]] || continue
  perl -0pi -e "s/\\Q$PATH_MARKER_START\\E.*?\\Q$PATH_MARKER_END\\E\\n?//sg" "$target"
done

echo ""
echo "Interceptor uninstalled."
echo ""
echo "Remove the browser extension manually if it is still present:"
echo "  Brave:  brave://extensions/"
echo "  Chrome: chrome://extensions/"
