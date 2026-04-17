#!/bin/bash
set -euo pipefail

# ── Interceptor Uninstaller ───────────────────────────────────────────────────
# Removes the bridge LaunchAgent, installed binaries, and user install dir.
# Does NOT remove the browser extension — that must be done per-browser at
# brave://extensions or chrome://extensions (Secure Preferences HMAC install
# cannot be cleanly reversed from outside the browser).

INSTALL_DIR="$HOME/.interceptor"
PLIST_DST="$HOME/Library/LaunchAgents/com.interceptor.bridge.plist"

echo "==> Unloading bridge LaunchAgent..."
launchctl unload "$PLIST_DST" 2>/dev/null || true

echo "==> Removing LaunchAgent plist..."
rm -f "$PLIST_DST"

echo "==> Killing any running interceptor processes..."
pkill -f "interceptor-daemon" 2>/dev/null || true
pkill -f "interceptor-bridge" 2>/dev/null || true

echo "==> Removing install dir ($INSTALL_DIR)..."
rm -rf "$INSTALL_DIR"

echo "==> Removing stale runtime files..."
rm -f /tmp/interceptor.sock /tmp/interceptor.pid
rm -f /tmp/interceptor-bridge.sock /tmp/interceptor-bridge.pid

echo ""
echo "✓ Interceptor uninstalled."
echo ""
echo "The browser extension was NOT removed automatically — remove it manually:"
echo "  • Brave:   open brave://extensions/ and click Remove on Interceptor"
echo "  • Chrome:  open chrome://extensions/ and click Remove on Interceptor"
echo ""
echo "Also revoke Privacy permissions (Accessibility / Input Monitoring /"
echo "Screen Recording) for interceptor-bridge via System Settings → Privacy & Security"
echo "if you want a fully clean system."
