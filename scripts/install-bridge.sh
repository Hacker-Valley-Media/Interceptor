#!/bin/bash
set -euo pipefail

# install-bridge.sh — Install the locally built interceptor-bridge.
#
# Usage:
#   bash scripts/build-bridge.sh
#   bash scripts/install-bridge.sh
#
# Env overrides:
#   INTERCEPTOR_BRIDGE_BIN   Absolute path to use as the bridge binary in the
#                            generated LaunchAgent plist. When set, the binary
#                            is NOT copied — the path is referenced as-is.
#                            Useful for power users who symlink to the repo
#                            build output instead of installing a copy.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"
BINARY_SRC="$DIST_DIR/interceptor-bridge"

PLIST_NAME="com.interceptor.bridge"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

if [[ -n "${INTERCEPTOR_BRIDGE_BIN:-}" ]]; then
  BINARY_DST="$INTERCEPTOR_BRIDGE_BIN"
  USE_OVERRIDE=1
else
  BINARY_DST="$HOME/.local/bin/interceptor-bridge"
  USE_OVERRIDE=0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: interceptor-bridge is macOS only."
  exit 1
fi

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  echo "ERROR: do not run install-bridge.sh with sudo." >&2
  echo "       LaunchAgents are user-scoped — running as root installs them" >&2
  echo "       under /var/root and tries to bootstrap into gui/0, which is not" >&2
  echo "       a real domain (root has no GUI session). Re-run as your user:" >&2
  echo "         bash scripts/install-bridge.sh" >&2
  exit 1
fi

if [[ "$USE_OVERRIDE" == "1" ]]; then
  if [[ ! -e "$BINARY_DST" ]]; then
    echo "ERROR: INTERCEPTOR_BRIDGE_BIN points to a path that does not exist:" >&2
    echo "       $BINARY_DST" >&2
    exit 1
  fi
else
  if [[ ! -f "$BINARY_SRC" ]]; then
    echo "ERROR: bridge binary not found at $BINARY_SRC"
    echo "Run: bash scripts/build-bridge.sh"
    exit 1
  fi
fi

if launchctl list | grep -q "$PLIST_NAME" 2>/dev/null; then
  echo "==> Unloading existing LaunchAgent..."
  launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true
fi

if [[ -f /tmp/interceptor-bridge.pid ]]; then
  PID="$(head -1 /tmp/interceptor-bridge.pid)"
  kill "$PID" 2>/dev/null || true
  sleep 1
fi

if [[ "$USE_OVERRIDE" == "1" ]]; then
  echo "==> Using bridge binary at $BINARY_DST (INTERCEPTOR_BRIDGE_BIN override; skipping copy)..."
else
  BINARY_PARENT="$(dirname "$BINARY_DST")"
  mkdir -p "$BINARY_PARENT"
  echo "==> Installing bridge binary to $BINARY_DST..."
  cp "$BINARY_SRC" "$BINARY_DST"
  chmod +x "$BINARY_DST"

  case ":$PATH:" in
    *":$BINARY_PARENT:"*) ;;
    *)
      echo "WARN: $BINARY_PARENT is not on your PATH. Add it so 'interceptor-bridge' is reachable directly:" >&2
      echo "        echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc" >&2
      echo "      The LaunchAgent itself uses the absolute path and will run regardless." >&2
      ;;
  esac
fi

echo "==> Installing LaunchAgent plist..."
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_DST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BINARY_DST</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/interceptor-bridge.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/interceptor-bridge.stderr.log</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
PLIST

echo "==> Loading LaunchAgent..."
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"

echo ""
echo "==> interceptor-bridge installed."
echo "    Binary: $BINARY_DST"
echo "    Test:   interceptor macos tree"
