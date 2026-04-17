#!/bin/bash
set -euo pipefail

# ── Build Interceptor DMG ──────────────────────────────────────────────────────
# Packages: CLI binary, daemon, extension, inject.py, installer into a DMG
# with a double-clickable Install Interceptor.app

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(python3 -c "import json; print(json.load(open('$ROOT/extension/dist/manifest.json'))['version'])")
DMG_NAME="Interceptor-v${VERSION}-macOS"
STAGING="$ROOT/dist/dmg-staging"
APP_DIR="$STAGING/Install Interceptor.app"
DMG_OUT="$ROOT/dist/${DMG_NAME}.dmg"

echo "==> Building Interceptor v${VERSION} DMG"

# ── Clean ──────────────────────────────────────────────────────────────────────
rm -rf "$STAGING" "$DMG_OUT"
mkdir -p "$STAGING"

# ── Create .app bundle (shell script app) ─────────────────────────────────────
# This is a minimal macOS app that runs the installer shell script.
# Users double-click it, get native dialogs, done.

MACOS_DIR="$APP_DIR/Contents/MacOS"
RESOURCES="$APP_DIR/Contents/Resources"
mkdir -p "$MACOS_DIR" "$RESOURCES"

# Info.plist
cat > "$APP_DIR/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>launcher</string>
    <key>CFBundleIdentifier</key>
    <string>com.interceptor.installer</string>
    <key>CFBundleName</key>
    <string>Install Interceptor</string>
    <key>CFBundleDisplayName</key>
    <string>Install Interceptor</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>LSUIElement</key>
    <false/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

# Launcher script — the .app executable
cat > "$MACOS_DIR/launcher" << 'LAUNCHER'
#!/bin/bash
ROOT="$(cd "$(dirname "$0")/../Resources/interceptor" && pwd)"
exec bash "$ROOT/scripts/installer.sh"
LAUNCHER
chmod +x "$MACOS_DIR/launcher"

# ── App icon ──────────────────────────────────────────────────────────────────
ICNS="$ROOT/scripts/Interceptor.icns"
if [[ -f "$ICNS" ]]; then
  cp "$ICNS" "$RESOURCES/AppIcon.icns"
fi

# ── Copy Interceptor payload into Resources ───────────────────────────────────
PAYLOAD="$RESOURCES/interceptor"
mkdir -p "$PAYLOAD/extension/dist" "$PAYLOAD/daemon" "$PAYLOAD/scripts" "$PAYLOAD/dist"

# Extension files
cp -R "$ROOT/extension/dist/"* "$PAYLOAD/extension/dist/"

# Daemon binary
cp "$ROOT/daemon/interceptor-daemon" "$PAYLOAD/daemon/interceptor-daemon"
chmod +x "$PAYLOAD/daemon/interceptor-daemon"

# CLI binary
cp "$ROOT/dist/interceptor" "$PAYLOAD/dist/interceptor"
chmod +x "$PAYLOAD/dist/interceptor"

# Bridge binary (macOS native control) — PRD-35
if [[ -f "$ROOT/dist/interceptor-bridge" ]]; then
  cp "$ROOT/dist/interceptor-bridge" "$PAYLOAD/dist/interceptor-bridge"
  chmod +x "$PAYLOAD/dist/interceptor-bridge"
else
  echo "ERROR: dist/interceptor-bridge not found — run scripts/build-bridge.sh first" >&2
  echo "       (the DMG is for macOS; the bridge is required for 'interceptor macos *' commands)" >&2
  exit 1
fi

# LaunchAgent plist template (installer.sh rewrites the path at install time) — PRD-35
mkdir -p "$PAYLOAD/launch"
cp "$ROOT/interceptor-bridge/com.interceptor.bridge.plist" "$PAYLOAD/launch/com.interceptor.bridge.plist"

# Scripts
cp "$ROOT/scripts/inject.py" "$PAYLOAD/scripts/inject.py"
cp "$ROOT/scripts/installer.sh" "$PAYLOAD/scripts/installer.sh"
chmod +x "$PAYLOAD/scripts/installer.sh"
if [[ -f "$ROOT/scripts/uninstall.sh" ]]; then
  cp "$ROOT/scripts/uninstall.sh" "$PAYLOAD/scripts/uninstall.sh"
  chmod +x "$PAYLOAD/scripts/uninstall.sh"
fi

# Native messaging template
mkdir -p "$PAYLOAD/daemon"
if [[ -f "$ROOT/daemon/com.interceptor.host.json" ]]; then
  cp "$ROOT/daemon/com.interceptor.host.json" "$PAYLOAD/daemon/"
fi

echo "==> Payload staged: $(du -sh "$PAYLOAD" | cut -f1)"

# ── Create DMG ────────────────────────────────────────────────────────────────
echo "==> Creating DMG..."
# Create read-write DMG first
RW_DMG="${DMG_OUT}.rw.dmg"
hdiutil create \
  -volname "Interceptor" \
  -srcfolder "$STAGING" \
  -ov \
  -format UDRW \
  -fs HFS+ \
  "$RW_DMG"

# ── Set DMG volume icon ───────────────────────────────────────────────────────
if [[ -f "$ICNS" ]]; then
  MOUNT_OUT=$(hdiutil attach "$RW_DMG" -noverify -noautoopen 2>&1)
  MOUNT_POINT=$(echo "$MOUNT_OUT" | grep '/Volumes/' | sed 's/.*\/Volumes/\/Volumes/')
  if [[ -n "$MOUNT_POINT" ]]; then
    cp "$ICNS" "$MOUNT_POINT/.VolumeIcon.icns"
    SetFile -a C "$MOUNT_POINT" 2>/dev/null || true
    hdiutil detach "$MOUNT_POINT" 2>/dev/null
  fi
fi

# Convert to compressed final DMG
hdiutil convert "$RW_DMG" -format UDZO -o "$DMG_OUT" -ov 2>/dev/null
rm -f "$RW_DMG"

echo ""
echo "==> DMG created: $DMG_OUT"
echo "    Size: $(du -h "$DMG_OUT" | cut -f1)"
echo ""
echo "    To install: open the DMG, double-click 'Install Interceptor.app'"
