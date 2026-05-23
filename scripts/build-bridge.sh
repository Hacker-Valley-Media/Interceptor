#!/bin/bash
# Build interceptor-bridge as a real macOS .app bundle so TCC tracks it
# by CFBundleIdentifier (com.interceptor.bridge). Required for Apple Events
# (app_intent), Accessibility, ScreenCapture, and Microphone consent prompts to
# render with a stable identity. Falls back to the legacy bare-binary path via
# a symlink so older callers keep working.
#
# Env overrides:
#   INTERCEPTOR_SIGNING_IDENTITY  codesign identity (default: HVM Developer ID)
#   INTERCEPTOR_BRIDGE_VERSION    version string in Info.plist (default 1.0.0)
#   INTERCEPTOR_SKIP_SIGNING=1    skip codesign + lsregister (dev mode)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BRIDGE_DIR="$PROJECT_DIR/interceptor-bridge"
DIST_DIR="$PROJECT_DIR/dist"

INTERCEPTOR_SIGNING_IDENTITY="${INTERCEPTOR_SIGNING_IDENTITY:-Developer ID Application: HACKER VALLEY MEDIA, LLC (TPWBZD35WW)}"
INTERCEPTOR_BRIDGE_IDENTIFIER="com.interceptor.bridge"
INTERCEPTOR_BRIDGE_VERSION="${INTERCEPTOR_BRIDGE_VERSION:-1.0.0}"
INTERCEPTOR_SPARKLE_FEED_URL="${INTERCEPTOR_SPARKLE_FEED_URL:-https://updates.hackervalley.media/appcast.xml}"
INTERCEPTOR_SPARKLE_PUBLIC_KEY="${INTERCEPTOR_SPARKLE_PUBLIC_KEY:-dnUnuHGCO4obHb44Khlf2TZQFUMmFGGpm2c6j+EqmdU=}"
## Bridge carries Virtualization framework capabilities (VM lifecycle)
## that the CLI and daemon don't need; entitlements-bridge.plist is the
## superset, entitlements.plist is the slim CLI/daemon set.
ENTITLEMENTS="$SCRIPT_DIR/entitlements-bridge.plist"
APP_DIR="$DIST_DIR/interceptor-bridge.app"

echo "==> Building interceptor-bridge (release)..."
cd "$BRIDGE_DIR"
swift build -c release 2>&1

BINARY="$BRIDGE_DIR/.build/release/interceptor-bridge"
if [ ! -f "$BINARY" ]; then
  echo "ERROR: Build failed — binary not found at $BINARY"
  exit 1
fi

mkdir -p "$DIST_DIR"

# Keep the legacy bare-binary path for back-compat — tests, the daemon's
# socket connect path, and older install scripts still look for it here.
cp "$BINARY" "$DIST_DIR/interceptor-bridge"
echo "==> Copied bare binary to $DIST_DIR/interceptor-bridge"

echo "==> Building .app bundle at $APP_DIR ..."
# real .app bundle so macOS TCC can track it by bundle identifier.
# This makes `tccutil` work, makes the Automation Privacy pane show
# interceptor-bridge with a proper name, and lets the OS pop the correct
# consent dialog the first time we send an Apple Event.
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"
mkdir -p "$APP_DIR/Contents/Frameworks"

cp "$BINARY" "$APP_DIR/Contents/MacOS/interceptor-bridge"

# Copy Sparkle.framework into the .app bundle. The bridge binary already
# links @rpath/Sparkle.framework/Versions/B/Sparkle and Package.swift sets
# the rpath to @executable_path/../Frameworks, so this is the only step
# needed for runtime resolution. Sparkle's own XPCServices/Autoupdate/
# Updater.app helpers ship inside the framework.
SPARKLE_FRAMEWORK="$BRIDGE_DIR/.build/arm64-apple-macosx/release/Sparkle.framework"
if [ -d "$SPARKLE_FRAMEWORK" ]; then
  echo "==> Copying Sparkle.framework into the .app"
  ditto "$SPARKLE_FRAMEWORK" "$APP_DIR/Contents/Frameworks/Sparkle.framework"
else
  echo "WARN: Sparkle.framework not found at $SPARKLE_FRAMEWORK — auto-update will fail" >&2
fi

# Copy bundled Core ML models into the .app's Resources directory.
# We put them under Contents/Resources/ (rather than letting SwiftPM
# generate a nested resource bundle) because nested SwiftPM bundles lack
# an Info.plist and codesign rejects them.
SOURCE_RESOURCES_DIR="$BRIDGE_DIR/Sources/Resources"
if [[ -d "$SOURCE_RESOURCES_DIR" ]]; then
  for entry in "$SOURCE_RESOURCES_DIR"/*; do
    [[ -e "$entry" ]] || continue
    cp -R "$entry" "$APP_DIR/Contents/Resources/"
    echo "==> Bundled resource: $(basename "$entry")"
  done
fi

# Synthesize Info.plist. LSUIElement=true makes it a faceless agent (no dock
# icon, no menu bar) — same effect main.swift requests at runtime via
# NSApplication.setActivationPolicy(.accessory).
cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>interceptor-bridge</string>
    <key>CFBundleIdentifier</key>
    <string>$INTERCEPTOR_BRIDGE_IDENTIFIER</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>interceptor-bridge</string>
    <key>CFBundleDisplayName</key>
    <string>interceptor-bridge</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$INTERCEPTOR_BRIDGE_VERSION</string>
    <key>CFBundleVersion</key>
    <string>$INTERCEPTOR_BRIDGE_VERSION</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>15.0</string>
    <key>NSAppleEventsUsageDescription</key>
    <string>interceptor-bridge dispatches Apple Events to apps you ask Interceptor to control via app_intent. macOS will prompt you to allow each target app the first time.</string>
    <key>NSAccessibilityUsageDescription</key>
    <string>interceptor-bridge uses the macOS accessibility tree to let Interceptor inspect and drive UI elements (mac_tree, mac_click, mac_type).</string>
    <key>NSScreenCaptureUsageDescription</key>
    <string>interceptor-bridge captures screen frames when you ask Interceptor to take screenshots or run screen capture / stream commands.</string>
    <key>NSMicrophoneUsageDescription</key>
    <string>interceptor-bridge captures microphone input when you ask Interceptor to use listen / audio commands.</string>

    <!-- personal data and distribution surfaces.
         Each TCC-gated framework gets a usage description string that surfaces
         in the system consent dialog. Strings follow Apple's recommended shape
         (verb + reason). Both modern (macOS 14+) and legacy keys are present
         so the bridge stays safe across deployment targets. -->

    <key>NSCalendarsFullAccessUsageDescription</key>
    <string>interceptor-bridge reads, creates, and modifies your calendar events under your direction (mac_calendar verbs).</string>
    <key>NSCalendarsWriteOnlyAccessUsageDescription</key>
    <string>interceptor-bridge creates calendar events under your direction (mac_calendar create).</string>
    <key>NSCalendarsUsageDescription</key>
    <string>interceptor-bridge reads and modifies your calendar events under your direction (legacy fallback for macOS &lt; 14).</string>
    <key>NSRemindersFullAccessUsageDescription</key>
    <string>interceptor-bridge reads, creates, and modifies your reminders under your direction (mac_reminders verbs).</string>
    <key>NSRemindersUsageDescription</key>
    <string>interceptor-bridge reads and modifies your reminders under your direction (legacy fallback for macOS &lt; 14).</string>
    <key>NSContactsUsageDescription</key>
    <string>interceptor-bridge reads and modifies your contacts under your direction (mac_contacts verbs).</string>
    <key>NSPhotoLibraryUsageDescription</key>
    <string>interceptor-bridge reads, exports, and modifies your Photos library under your direction (mac_photos verbs).</string>
    <key>NSPhotoLibraryAddUsageDescription</key>
    <string>interceptor-bridge adds photos and videos to your library under your direction (mac_photos import).</string>
    <key>NSLocationUsageDescription</key>
    <string>interceptor-bridge uses location data for geocoding and current-position queries under your direction (mac_location verbs).</string>
    <key>NSLocationWhenInUseUsageDescription</key>
    <string>interceptor-bridge uses your location for geocoding and current-position queries under your direction (mac_location verbs).</string>
    <key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
    <string>interceptor-bridge uses your location for geocoding and current-position queries under your direction (mac_location verbs).</string>
    <!-- Per Apple's NSLocationTemporaryUsageDescriptionDictionary doc:
         CLLocationManager.requestTemporaryFullAccuracyAuthorization(withPurposeKey:)
         resolves the supplied key against this dictionary. Without a matching
         entry, the call returns kCLErrorPromptDeclined (CLError 18) silently.
         The keys here are the purpose tokens callers pass via --purpose. -->
    <key>NSLocationTemporaryUsageDescriptionDictionary</key>
    <dict>
        <key>PreciseGeocode</key>
        <string>interceptor-bridge briefly requests precise location to resolve a precise geocode or current-position query you triggered.</string>
        <key>PreciseDirections</key>
        <string>interceptor-bridge briefly requests precise location to compute accurate routing or distance for a query you triggered.</string>
    </dict>
    <key>NSAppleMusicUsageDescription</key>
    <string>interceptor-bridge accesses your Apple Music library and plays back catalog items under your direction (mac_music verbs).</string>
    <key>NSFaceIDUsageDescription</key>
    <string>interceptor-bridge uses Face ID / Touch ID to confirm sensitive actions before performing them (mac_auth confirm).</string>

    <!-- Sparkle auto-update. The bridge polls the appcast feed, prompts the
         user when a new pkg is available, and hands the .pkg off to the
         macOS installer. Public EdDSA key is matched against per-release
         sign_update signatures embedded in each appcast item. -->
    <key>SUFeedURL</key>
    <string>$INTERCEPTOR_SPARKLE_FEED_URL</string>
    <key>SUPublicEDKey</key>
    <string>$INTERCEPTOR_SPARKLE_PUBLIC_KEY</string>
    <key>SUEnableInstallerLauncherService</key>
    <true/>
    <key>SUEnableAutomaticChecks</key>
    <true/>
    <key>SUScheduledCheckInterval</key>
    <integer>86400</integer>
    <key>SUAllowsAutomaticUpdates</key>
    <false/>
</dict>
</plist>
PLIST

if [[ "${INTERCEPTOR_SKIP_SIGNING:-0}" == "1" ]]; then
  echo "==> INTERCEPTOR_SKIP_SIGNING=1 — skipping codesign (development build)"
else
  if security find-identity -p codesigning -v 2>/dev/null | grep -q "$INTERCEPTOR_SIGNING_IDENTITY"; then
    echo "==> Codesigning bundle with: $INTERCEPTOR_SIGNING_IDENTITY"

    # Sign Sparkle.framework + nested helpers FIRST (inside-out is the rule).
    # Sparkle's helpers don't need our entitlements — they get hardened
    # runtime + timestamp only. The framework itself wraps everything.
    SPARKLE_BUNDLE="$APP_DIR/Contents/Frameworks/Sparkle.framework"
    if [ -d "$SPARKLE_BUNDLE" ]; then
      echo "==> Codesigning Sparkle helpers"
      for comp in \
        "$SPARKLE_BUNDLE/Versions/B/XPCServices/Downloader.xpc" \
        "$SPARKLE_BUNDLE/Versions/B/XPCServices/Installer.xpc" \
        "$SPARKLE_BUNDLE/Versions/B/Updater.app" \
        "$SPARKLE_BUNDLE/Versions/B/Autoupdate" \
        "$SPARKLE_BUNDLE/Versions/B/Sparkle"
      do
        if [ -e "$comp" ]; then
          codesign --force --options runtime --timestamp \
            --sign "$INTERCEPTOR_SIGNING_IDENTITY" \
            "$comp"
        fi
      done
      # Versioned framework bundle wrap.
      codesign --force --options runtime --timestamp \
        --sign "$INTERCEPTOR_SIGNING_IDENTITY" \
        "$SPARKLE_BUNDLE"
    fi

    # Sign the inner binary first, then the bundle, with the same entitlements.
    codesign --force --options runtime --timestamp \
      --sign "$INTERCEPTOR_SIGNING_IDENTITY" \
      --identifier "$INTERCEPTOR_BRIDGE_IDENTIFIER" \
      --entitlements "$ENTITLEMENTS" \
      "$APP_DIR/Contents/MacOS/interceptor-bridge"

    codesign --force --options runtime --timestamp \
      --sign "$INTERCEPTOR_SIGNING_IDENTITY" \
      --identifier "$INTERCEPTOR_BRIDGE_IDENTIFIER" \
      --entitlements "$ENTITLEMENTS" \
      "$APP_DIR"

    codesign --verify --strict --verbose=2 "$APP_DIR" || true
  else
    echo "==> Signing identity not present in keychain — performing ad-hoc sign for development."
    echo "    Set INTERCEPTOR_SIGNING_IDENTITY to a real Developer ID for distribution."
    if [ -d "$APP_DIR/Contents/Frameworks/Sparkle.framework" ]; then
      codesign --force --deep --sign - "$APP_DIR/Contents/Frameworks/Sparkle.framework" 2>/dev/null || true
    fi
    codesign --force --sign - --entitlements "$ENTITLEMENTS" "$APP_DIR/Contents/MacOS/interceptor-bridge" 2>/dev/null || true
    codesign --force --sign - --entitlements "$ENTITLEMENTS" "$APP_DIR" 2>/dev/null || true
  fi
fi

echo "==> Bundle ready at $APP_DIR"
ls -la "$APP_DIR/Contents/MacOS/interceptor-bridge"
echo "==> Build complete."
