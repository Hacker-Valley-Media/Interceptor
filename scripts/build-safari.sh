#!/usr/bin/env bash
# Safari Web Extension containing-app build + sign + notarize + pkg.
#
# The Safari Web Extension is delivered as a native macOS containing app
# (InterceptorSafari.app) with an embedded app-extension (the appex). The user
# installs the app, opens it once (it registers the extension with Safari), then
# enables "Interceptor" in Safari > Settings > Extensions. The CLI + daemon come
# from the main Interceptor pkg; this pkg carries only the Safari surface.
#
# Prereqs: Xcode + the Developer ID Application/Installer identities, and the
# notary keychain profile (default: interceptor-notary). macOS only. The script
# rebuilds source bundles by default so stale extension bytes cannot be signed
# as a new Safari release.
#
# Env overrides:
#   INTERCEPTOR_SIGNING_IDENTITY    Developer ID Application name
#   INTERCEPTOR_INSTALLER_IDENTITY  Developer ID Installer name
#   INTERCEPTOR_NOTARY_PROFILE      notarytool keychain profile
#   INTERCEPTOR_VERSION             version (else read from package.json)
#   INTERCEPTOR_SKIP_NOTARIZE=1     build + sign only (offline / CI without notary;
#                                  output is deliberately marked UNNOTARIZED)
#   INTERCEPTOR_SKIP_BASE_BUILD=1    reuse prebuilt bundles (advanced/CI only)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

SIGN_APP="${INTERCEPTOR_SIGNING_IDENTITY:-Developer ID Application: HACKER VALLEY MEDIA, LLC (TPWBZD35WW)}"
SIGN_INSTALLER="${INTERCEPTOR_INSTALLER_IDENTITY:-Developer ID Installer: HACKER VALLEY MEDIA, LLC (TPWBZD35WW)}"
NOTARY_PROFILE="${INTERCEPTOR_NOTARY_PROFILE:-interceptor-notary}"
VER="${INTERCEPTOR_VERSION:-$(grep '"version"' package.json | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')}"
SKIP_NOTARIZE="${INTERCEPTOR_SKIP_NOTARIZE:-0}"
SKIP_BASE_BUILD="${INTERCEPTOR_SKIP_BASE_BUILD:-0}"

PROJ="safari/InterceptorSafari/InterceptorSafari.xcodeproj"
ENT="$REPO_ROOT/safari/InterceptorSafari.entitlements"
APPEX_RES="safari/InterceptorSafari/InterceptorSafari Extension/Resources"
POSTINSTALL_SAFARI="$REPO_ROOT/scripts/release/postinstall-safari"
DERIVED="safari/build"
APP="$DERIVED/Build/Products/Release/InterceptorSafari.app"
OUT_DIR="dist"
ASSESS_DIR=""
PKG_SCRIPTS_DIR="$DERIVED/pkg-scripts"
cleanup_assess_dir() {
  if [[ -n "$ASSESS_DIR" && "$ASSESS_DIR" == /private/tmp/interceptor-safari-assess.* ]]; then
    rm -rf -- "$ASSESS_DIR"
  fi
}
trap cleanup_assess_dir EXIT
if [[ "$SKIP_NOTARIZE" == "1" ]]; then
  PKG="$OUT_DIR/Interceptor-Safari-$VER-UNNOTARIZED.pkg"
else
  PKG="$OUT_DIR/Interceptor-Safari-$VER.pkg"
fi

if [[ "$SKIP_BASE_BUILD" != "1" ]]; then
  echo "==> Rebuilding Interceptor bundles from source..."
  bash "$SCRIPT_DIR/build.sh"
fi
[[ -d extension/dist-safari ]] || { echo "ERROR: extension/dist-safari missing after base build." >&2; exit 1; }
[[ -x "$POSTINSTALL_SAFARI" ]] || { echo "ERROR: Safari postinstall missing or not executable: $POSTINSTALL_SAFARI" >&2; exit 1; }
echo "==> Safari build $VER  (app id com.interceptor.safari, appex com.interceptor.safari.Extension)"

# Keep the WebExtension, containing app, and installer on one release version.
# (A previous package shipped a newer manifest than its source tree, which made
# it impossible to tell which JavaScript Safari had actually registered.)
INTERCEPTOR_SAFARI_BUILD_VERSION="$VER" bun -e '
const fs = require("fs");
const path = "extension/dist-safari/manifest.json";
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
manifest.version = process.env.INTERCEPTOR_SAFARI_BUILD_VERSION;
fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
'

# Gate packaging on WebKit loading the real background bundle. The API used by
# this verifier starts at macOS 15.4; older supported build hosts skip the gate.
OS_VERSION="$(sw_vers -productVersion)"
OS_MAJOR="${OS_VERSION%%.*}"
OS_REST="${OS_VERSION#*.}"
OS_MINOR="${OS_REST%%.*}"
if (( OS_MAJOR > 15 || (OS_MAJOR == 15 && OS_MINOR >= 4) )); then
  echo "==> Verifying Safari background bootstrap in WebKit..."
  xcrun swift scripts/verify-safari-extension.swift "$REPO_ROOT/extension/dist-safari"
else
  echo "==> Skipping WebKit bootstrap verifier (requires macOS 15.4+)"
fi

# 1. Sync the freshly built web-extension resources into the appex.
ditto extension/dist-safari "$APPEX_RES"

# 2. Build the containing app + appex (Developer ID, hardened runtime, sandbox).
PUBLIC_SOURCE_ROOT="/src/interceptor"
xcodebuild -project "$PROJ" -scheme InterceptorSafari -configuration Release \
  -derivedDataPath "$DERIVED" \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=TPWBZD35WW \
  "CODE_SIGN_IDENTITY=$SIGN_APP" "CODE_SIGN_ENTITLEMENTS=$ENT" \
  "OTHER_CFLAGS=\"-ffile-prefix-map=$REPO_ROOT=$PUBLIC_SOURCE_ROOT\" \"-fdebug-prefix-map=$REPO_ROOT=$PUBLIC_SOURCE_ROOT\" \"-ffile-compilation-dir=$PUBLIC_SOURCE_ROOT/safari/InterceptorSafari\"" \
  "OTHER_SWIFT_FLAGS=-file-prefix-map \"$REPO_ROOT=$PUBLIC_SOURCE_ROOT\" -debug-prefix-map \"$REPO_ROOT=$PUBLIC_SOURCE_ROOT\" -file-compilation-dir \"$PUBLIC_SOURCE_ROOT/safari/InterceptorSafari\"" \
  "MARKETING_VERSION=$VER" \
  MACOSX_DEPLOYMENT_TARGET=14.0 "OTHER_CODE_SIGN_FLAGS=--timestamp" \
  PROVISIONING_PROFILE_SPECIFIER="" -allowProvisioningUpdates \
  clean build

# 3. Re-sign inside-out with explicit entitlements. A plain `build` injects the
#    debug com.apple.security.get-task-allow entitlement, which notarization
#    rejects; re-signing from our entitlements file (sandbox + network.client)
#    strips it and keeps the hardened runtime + secure timestamp.
codesign --force --options runtime --timestamp --sign "$SIGN_APP" --entitlements "$ENT" "$APP/Contents/PlugIns/InterceptorSafari Extension.appex"
codesign --force --options runtime --timestamp --sign "$SIGN_APP" --entitlements "$ENT" "$APP"
codesign --verify --strict --deep --verbose=2 "$APP"

# Xcode registers built apps with LaunchServices as a normal development
# convenience. This script is a packager: leaving the build-tree appex
# registered creates two extensions with the same identifier once the signed
# app is installed, and Safari can block the identifier during discovery.
pluginkit -r "$APP/Contents/PlugIns/InterceptorSafari Extension.appex" || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$APP" || true

mkdir -p "$OUT_DIR"
rm -rf -- "$PKG_SCRIPTS_DIR"
mkdir -p "$PKG_SCRIPTS_DIR"
cp "$POSTINSTALL_SAFARI" "$PKG_SCRIPTS_DIR/postinstall"
chmod 755 "$PKG_SCRIPTS_DIR/postinstall"

if [[ "$SKIP_NOTARIZE" == "1" ]]; then
  echo "WARNING: skipping notarization; Safari can reject this app outside its unsigned-extension developer mode." >&2
  echo "==> Building explicitly marked UNNOTARIZED development pkg"
  pkgbuild --component "$APP" --install-location /Applications \
    --scripts "$PKG_SCRIPTS_DIR" \
    --identifier com.interceptor.safari.pkg --version "$VER" \
    --sign "$SIGN_INSTALLER" --timestamp "$PKG"
  echo "==> Built (not notarized): $PKG"
  exit 0
fi

# 4. Round 1: notarize + staple the .app (offline Gatekeeper for the app itself).
APP_ZIP="$DERIVED/InterceptorSafari-$VER.zip"
ditto -c -k --keepParent "$APP" "$APP_ZIP"
echo "==> Notarizing app (round 1)…"
xcrun notarytool submit "$APP_ZIP" --keychain-profile "$NOTARY_PROFILE" --wait | tee "$DERIVED/notary-app.log"
grep -q "status: Accepted" "$DERIVED/notary-app.log"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

# Gatekeeper can report spurious bundle-format/open-file failures when assessing
# a valid notarized Xcode product directly on an external build volume. Assess
# and package a byte-for-byte ditto copy on the system volume; this also ensures
# pkgbuild consumes the exact artifact that passed the release gate.
ASSESS_DIR="$(mktemp -d /private/tmp/interceptor-safari-assess.XXXXXX)"
ASSESS_APP="$ASSESS_DIR/InterceptorSafari.app"
ditto "$APP" "$ASSESS_APP"
codesign --verify --strict --deep --verbose=2 "$ASSESS_APP"
xcrun stapler validate "$ASSESS_APP"
spctl --assess --type execute --verbose=4 "$ASSESS_APP"

# 5. Build + sign the installer pkg from the stapled app.
pkgbuild --component "$ASSESS_APP" --install-location /Applications \
  --scripts "$PKG_SCRIPTS_DIR" \
  --identifier com.interceptor.safari.pkg --version "$VER" \
  --sign "$SIGN_INSTALLER" --timestamp "$PKG"

# 6. Round 2: notarize + staple the pkg.
echo "==> Notarizing pkg (round 2)…"
xcrun notarytool submit "$PKG" --keychain-profile "$NOTARY_PROFILE" --wait | tee "$DERIVED/notary-pkg.log"
grep -q "status: Accepted" "$DERIVED/notary-pkg.log"
xcrun stapler staple "$PKG"
xcrun stapler validate "$PKG"

# 7. Verify (non-fatal — the artifact is already built + notarized + stapled).
echo "==> Verifying…"
pkgutil --check-signature "$PKG" 2>&1 | sed -n '1,4p' || true
spctl --assess -vv --type install "$PKG" 2>&1 | sed -n '1,4p' || true
echo "==> Done: $PKG"
