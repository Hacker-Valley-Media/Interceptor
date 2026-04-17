#!/bin/bash
set -euo pipefail

# ── Interceptor signed + notarized DMG release pipeline ─────────────────────
#
# Usage:
#   bash scripts/release-dmg.sh
#
# Version is read from extension/manifest.json. Bump that file before running.
#
# Prerequisites:
#   - signing.env with SIGN_IDENTITY="Developer ID Application: ..."
#   - notarization.env with NOTARY_PROFILE="interceptor-notary"
#   - Keychain profile stored via:
#       xcrun notarytool store-credentials "interceptor-notary" \
#         --apple-id <apple-id> --team-id TPWBZD35WW --password <app-specific-pwd>
#
# This script closes the gap that bit v0.6.0: build-dmg.sh alone produces an
# unsigned .app with unsigned embedded binaries, which macOS Gatekeeper rejects
# for remote-downloaded installs. This pipeline signs every executable with
# Developer ID + hardened runtime + timestamp, then notarizes + staples the DMG.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

# ── Load credentials ─────────────────────────────────────────────────────────
[[ -f signing.env ]] || { echo "ERROR: signing.env missing"; exit 1; }
[[ -f notarization.env ]] || { echo "ERROR: notarization.env missing"; exit 1; }
# shellcheck disable=SC1091
source signing.env
# shellcheck disable=SC1091
source notarization.env
: "${SIGN_IDENTITY:?SIGN_IDENTITY not set in signing.env}"
: "${NOTARY_PROFILE:?NOTARY_PROFILE not set in notarization.env}"

VERSION=$(python3 -c "import json; print(json.load(open('extension/manifest.json'))['version'])")
DMG_BASENAME="Interceptor-v${VERSION}-macOS"
DMG_OUT="$ROOT/dist/${DMG_BASENAME}.dmg"

echo "============================================================"
echo "  Interceptor v${VERSION} signed + notarized DMG release"
echo "============================================================"
echo "  Sign as:      $SIGN_IDENTITY"
echo "  Notary:       $NOTARY_PROFILE"
echo "  Output DMG:   $DMG_OUT"
echo

# ── Entitlements for hardened runtime ────────────────────────────────────────
ENT_PLIST="$(mktemp -t interceptor-entitlements).plist"
cat > "$ENT_PLIST" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
EOF

# ── Phase 1: Build extension, CLI, daemon, bridge ───────────────────────────
echo "==> Phase 1/6: Build all components"
bash scripts/build.sh
bash scripts/build-bridge.sh

# ── Phase 2: Sign embedded binaries ─────────────────────────────────────────
echo
echo "==> Phase 2/6: Sign embedded binaries"

sign_one() {
  local bin="$1"
  local bundle_id="$2"
  [[ -f "$bin" ]] || { echo "    SKIP $bin (missing)"; return; }
  echo "    Signing $bin"
  codesign --force --options runtime --timestamp \
    --sign "$SIGN_IDENTITY" \
    --entitlements "$ENT_PLIST" \
    -i "$bundle_id" \
    "$bin"
  codesign --verify --verbose=1 "$bin" 2>&1 | sed 's/^/      /' | head -3
}

sign_one "$ROOT/dist/interceptor"           "com.hackervalley.interceptor-cli"
sign_one "$ROOT/daemon/interceptor-daemon"  "com.hackervalley.interceptor-daemon"
sign_one "$ROOT/dist/interceptor-bridge"    "com.hackervalley.interceptor-bridge"

# ── Phase 3: Build DMG with signed payload ──────────────────────────────────
echo
echo "==> Phase 3/6: Build DMG"
bash scripts/build-dmg.sh

# ── Phase 4: Sign the .app inside the DMG staging (which was just rebuilt),
#             then re-sign every nested binary, then sign the .app itself ────
echo
echo "==> Phase 4/6: Re-sign .app and its nested binaries"

STAGING="$ROOT/dist/dmg-staging"
APP_DIR="$STAGING/Install Interceptor.app"
PAYLOAD="$APP_DIR/Contents/Resources/interceptor"

# Re-sign every executable inside the payload (build-dmg.sh copies files which
# can lose the signature or touch mtime). Doing this here is belt-and-suspenders.
sign_one "$PAYLOAD/dist/interceptor"             "com.hackervalley.interceptor-cli"
sign_one "$PAYLOAD/daemon/interceptor-daemon"    "com.hackervalley.interceptor-daemon"
# Bridge is not embedded in the DMG (it installs separately) but if a future
# change adds it, sign here too.
[[ -f "$PAYLOAD/dist/interceptor-bridge" ]] && \
  sign_one "$PAYLOAD/dist/interceptor-bridge" "com.hackervalley.interceptor-bridge"

# Sign the .app bundle itself (deep, so any nested Mach-Os are covered)
echo "    Signing .app bundle (deep)"
codesign --force --options runtime --timestamp --deep \
  --sign "$SIGN_IDENTITY" \
  --entitlements "$ENT_PLIST" \
  -i "com.hackervalley.interceptor-installer" \
  "$APP_DIR"
codesign --verify --verbose=1 --deep --strict "$APP_DIR" 2>&1 | sed 's/^/      /' | head -5

# Rebuild DMG from the now-properly-signed staging directory
echo "    Rebuilding DMG from signed staging..."
RW_DMG="${DMG_OUT}.rw.dmg"
rm -f "$DMG_OUT" "$RW_DMG"
hdiutil create -volname "Interceptor" -srcfolder "$STAGING" -ov -format UDRW -fs HFS+ "$RW_DMG" > /dev/null
ICNS="$ROOT/scripts/Interceptor.icns"
if [[ -f "$ICNS" ]]; then
  MOUNT_OUT=$(hdiutil attach "$RW_DMG" -noverify -noautoopen 2>&1)
  MOUNT_POINT=$(echo "$MOUNT_OUT" | grep '/Volumes/' | sed 's/.*\/Volumes/\/Volumes/')
  if [[ -n "$MOUNT_POINT" ]]; then
    cp "$ICNS" "$MOUNT_POINT/.VolumeIcon.icns"
    SetFile -a C "$MOUNT_POINT" 2>/dev/null || true
    hdiutil detach "$MOUNT_POINT" 2>/dev/null > /dev/null
  fi
fi
hdiutil convert "$RW_DMG" -format UDZO -o "$DMG_OUT" -ov > /dev/null
rm -f "$RW_DMG"
echo "    DMG built: $DMG_OUT ($(du -h "$DMG_OUT" | cut -f1))"

# Sign the DMG itself
echo "    Signing DMG"
codesign --force --sign "$SIGN_IDENTITY" --timestamp "$DMG_OUT"
codesign --verify --verbose=1 "$DMG_OUT" 2>&1 | sed 's/^/      /' | head -3

# ── Phase 5: Notarize + staple ──────────────────────────────────────────────
echo
echo "==> Phase 5/6: Notarize DMG (this can take 1-5 minutes)"
xcrun notarytool submit "$DMG_OUT" \
  --keychain-profile "$NOTARY_PROFILE" \
  --wait

echo "    Stapling notarization to DMG..."
xcrun stapler staple "$DMG_OUT"

# ── Phase 6: Verify final artifact ──────────────────────────────────────────
echo
echo "==> Phase 6/6: Verification"
echo "    --- codesign ---"
codesign -dvv "$DMG_OUT" 2>&1 | sed 's/^/      /' | head -12
echo "    --- spctl (Gatekeeper assessment) ---"
spctl --assess --type open --context context:primary-signature -vv "$DMG_OUT" 2>&1 | sed 's/^/      /'
echo "    --- stapler validate ---"
xcrun stapler validate "$DMG_OUT" 2>&1 | sed 's/^/      /'

rm -f "$ENT_PLIST"

echo
echo "============================================================"
echo "  ✓ Interceptor v${VERSION} release build complete"
echo "  → $DMG_OUT"
echo "============================================================"
