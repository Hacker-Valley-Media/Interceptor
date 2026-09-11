#!/bin/bash
# Install the interceptor-bridge .app bundle. Registers it with
# LaunchServices via lsregister so macOS TCC + System Settings → Privacy &
# Security can address it by CFBundleIdentifier (com.interceptor.bridge), and
# wires up the LaunchAgent to keep the bridge running.
#
# Legacy-compat: also keeps a bare-binary symlink at ~/.local/bin/interceptor-bridge
# pointing into the bundle, so older callers that hard-code that path still work.
#
# Env overrides:
#   INTERCEPTOR_BRIDGE_BIN   Absolute path to use as the bridge binary in the
#                            generated LaunchAgent plist. When set, the binary
#                            is NOT copied — the path is referenced as-is.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"
BINARY_SRC="$DIST_DIR/interceptor-bridge"
APP_SRC="$DIST_DIR/interceptor-bridge.app"

PLIST_NAME="com.interceptor.bridge"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

# Bundle install path: ~/.local/share/interceptor/interceptor-bridge.app
BUNDLE_INSTALL_PARENT="$HOME/.local/share/interceptor"
BUNDLE_INSTALL_DIR="$BUNDLE_INSTALL_PARENT/interceptor-bridge.app"
BUNDLE_INNER_BINARY="$BUNDLE_INSTALL_DIR/Contents/MacOS/interceptor-bridge"

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

# The bridge keeps its pid/socket in the user's temp dir (Platform.runtimeDir);
# a pre-0.26 bridge used /tmp. Stop whichever generation is running.
RUNTIME_DIR="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || echo /tmp)"
RUNTIME_DIR="${RUNTIME_DIR%/}"
for PIDFILE in /tmp/interceptor-bridge.pid "$RUNTIME_DIR/interceptor-bridge.pid"; do
  if [[ -f "$PIDFILE" ]]; then
    PID="$(head -1 "$PIDFILE")"
    kill "$PID" 2>/dev/null || true
    sleep 1
  fi
done

# install the .app bundle for TCC tracking, then a back-compat symlink
# at the legacy bare-binary path. INTERCEPTOR_BRIDGE_BIN override skips this
# whole block — power users keep their own layout.
if [[ "$USE_OVERRIDE" == "1" ]]; then
  echo "==> Using bridge binary at $BINARY_DST (INTERCEPTOR_BRIDGE_BIN override; skipping bundle install)..."
elif [[ -d "$APP_SRC" ]]; then
  echo "==> Installing bundle to $BUNDLE_INSTALL_DIR ..."
  mkdir -p "$BUNDLE_INSTALL_PARENT"
  rm -rf "$BUNDLE_INSTALL_DIR"
  cp -R "$APP_SRC" "$BUNDLE_INSTALL_DIR"

  # register with LaunchServices so TCC + Privacy &
  # Security pane address by CFBundleIdentifier instead of by absolute path.
  LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  if [[ -x "$LSREGISTER" ]]; then
    echo "==> Registering bundle with LaunchServices ..."
    "$LSREGISTER" -f "$BUNDLE_INSTALL_DIR" || true
  fi

  # Legacy path symlink — the inner binary inside the bundle, so spawning
  # the symlink still gives the process a Bundle.main resolution to the
  # com.interceptor.bridge identifier.
  BINARY_PARENT="$(dirname "$BINARY_DST")"
  mkdir -p "$BINARY_PARENT"
  ln -sf "$BUNDLE_INNER_BINARY" "$BINARY_DST"
  echo "==> Symlinked $BINARY_DST -> $BUNDLE_INNER_BINARY"

  # The LaunchAgent plist will reference the inner binary so Bundle.main
  # resolves correctly. The first-run consent path (when the daemon spawns
  # the bridge before the LaunchAgent has booted it) uses `open -gj` against
  # the bundle root, which is what gives the process aqua-session ancestry
  # so TCC can render its consent dialogs. See cli/transport.ts spawn helper.
  BINARY_FOR_LAUNCHAGENT="$BUNDLE_INNER_BINARY"
else
  # Fallback: no bundle was built. Install the bare binary at the legacy
  # path. App-intent (Apple Events) consent will not render correctly in
  # this mode; user gets a warning.
  echo "==> WARN: $APP_SRC not found, falling back to bare-binary install."
  echo "          Apple Events / app_intent consent will not render."
  echo "          Run: bash scripts/build-bridge.sh    to produce the bundle."
  BINARY_PARENT="$(dirname "$BINARY_DST")"
  mkdir -p "$BINARY_PARENT"
  cp "$BINARY_SRC" "$BINARY_DST"
  chmod +x "$BINARY_DST"
  BINARY_FOR_LAUNCHAGENT="$BINARY_DST"
fi

case ":$PATH:" in
  *":$(dirname "$BINARY_DST"):"*) ;;
  *)
    echo "WARN: $(dirname "$BINARY_DST") is not on your PATH. Add it so 'interceptor-bridge' is reachable directly:" >&2
    echo "        echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc" >&2
    echo "      The LaunchAgent itself uses the absolute path and will run regardless." >&2
    ;;
esac

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
        <string>${BINARY_FOR_LAUNCHAGENT:-$BINARY_DST}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
PLIST

echo "==> Loading LaunchAgent..."
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"

echo ""
echo "==> interceptor-bridge installed."
echo "    Bundle: ${BUNDLE_INSTALL_DIR:-(none — bare-binary fallback)}"
echo "    Symlink: $BINARY_DST"
echo "    Test:    interceptor macos tree"
echo ""
echo "    On first app_intent dispatch, macOS will prompt for Apple Events"
echo "    consent for each target app. Grant once per (interceptor-bridge,"
echo "    target-app) pair. Use 'interceptor macos intent warmup <bundleId>...'"
echo "    to batch-prompt several apps in one consent session."
