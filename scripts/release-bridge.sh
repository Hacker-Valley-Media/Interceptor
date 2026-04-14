#!/bin/bash
set -euo pipefail

# release-bridge.sh — Build, sign, notarize, and upload interceptor-bridge
#
# Usage:
#   bash scripts/release-bridge.sh <tag>
#   bash scripts/release-bridge.sh v0.5.0
#
# Prerequisites:
#   - Xcode installed (swift, codesign, xcrun, lipo)
#   - signing.env with SIGN_IDENTITY
#   - notarization.env with NOTARY_PROFILE
#   - Keychain profile stored via:
#       xcrun notarytool store-credentials "interceptor-notary" \
#         --apple-id "<AppleID>" --team-id "TPWBZD35WW" --password <app-specific-password>
#   - gh CLI authenticated (for upload)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BRIDGE_DIR="$PROJECT_DIR/interceptor-bridge"
DIST_DIR="$PROJECT_DIR/dist"
SIGNING_ENV="$PROJECT_DIR/signing.env"
NOTARIZATION_ENV="$PROJECT_DIR/notarization.env"
BUNDLE_ID="com.hackervalley.interceptor-bridge"

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "ERROR: Usage: bash scripts/release-bridge.sh <tag>"
  echo "  e.g. bash scripts/release-bridge.sh v0.5.0"
  exit 1
fi

# ── Load credentials ─────────────────────────────────────────────────────────

if [ ! -f "$SIGNING_ENV" ]; then
  echo "ERROR: signing.env not found at $SIGNING_ENV"
  echo "Create it with: SIGN_IDENTITY=\"Developer ID Application: ...\""
  exit 1
fi
source "$SIGNING_ENV"

if [ -z "${SIGN_IDENTITY:-}" ]; then
  echo "ERROR: SIGN_IDENTITY not set in signing.env"
  exit 1
fi

if [ ! -f "$NOTARIZATION_ENV" ]; then
  echo "ERROR: notarization.env not found at $NOTARIZATION_ENV"
  echo "Create it with: NOTARY_PROFILE=\"interceptor-notary\""
  exit 1
fi
source "$NOTARIZATION_ENV"

if [ -z "${NOTARY_PROFILE:-}" ]; then
  echo "ERROR: NOTARY_PROFILE not set in notarization.env"
  exit 1
fi

echo "==> Release: interceptor-bridge $TAG"
echo "    Signing:      $SIGN_IDENTITY"
echo "    Notary:       $NOTARY_PROFILE"
echo ""

# ── Phase 1: Build for both architectures ────────────────────────────────────

cd "$BRIDGE_DIR"

echo "==> Building arm64..."
swift build -c release --arch arm64 2>&1

echo "==> Building x86_64..."
swift build -c release --arch x86_64 2>&1

ARM64_BIN="$BRIDGE_DIR/.build/arm64-apple-macosx/release/interceptor-bridge"
X86_BIN="$BRIDGE_DIR/.build/x86_64-apple-macosx/release/interceptor-bridge"

if [ ! -f "$ARM64_BIN" ]; then
  echo "ERROR: arm64 build failed — binary not found at $ARM64_BIN"
  exit 1
fi

if [ ! -f "$X86_BIN" ]; then
  echo "ERROR: x86_64 build failed — binary not found at $X86_BIN"
  exit 1
fi

echo "==> arm64:  $(ls -lh "$ARM64_BIN" | awk '{print $5}')"
echo "==> x86_64: $(ls -lh "$X86_BIN" | awk '{print $5}')"

# ── Phase 2: Create universal binary ─────────────────────────────────────────

mkdir -p "$DIST_DIR"
UNIVERSAL_BIN="$DIST_DIR/interceptor-bridge"

echo "==> Creating universal binary..."
lipo -create "$ARM64_BIN" "$X86_BIN" -output "$UNIVERSAL_BIN"

echo "==> Universal: $(ls -lh "$UNIVERSAL_BIN" | awk '{print $5}')"
echo "==> Architectures: $(lipo -info "$UNIVERSAL_BIN")"

# ── Phase 3: Code sign ──────────────────────────────────────────────────────

echo "==> Signing with Developer ID..."
codesign --force \
  --sign "$SIGN_IDENTITY" \
  --timestamp \
  --options runtime \
  -i "$BUNDLE_ID" \
  "$UNIVERSAL_BIN"

echo "==> Verifying signature..."
codesign --verify --verbose=2 "$UNIVERSAL_BIN"

# ── Phase 4: Notarize ───────────────────────────────────────────────────────

RELEASE_NAME="interceptor-bridge-macos"
ZIP_PATH="$DIST_DIR/${RELEASE_NAME}.zip"

echo "==> Packaging for notarization..."
cd "$DIST_DIR"
ditto -c -k --keepParent "interceptor-bridge" "$ZIP_PATH"

echo "==> Submitting to Apple notary service..."
xcrun notarytool submit "$ZIP_PATH" \
  --keychain-profile "$NOTARY_PROFILE" \
  --wait

echo "==> Notarization complete."

# Check the log for any warnings
SUBMISSION_ID=$(xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" 2>&1 | head -5 | grep -oE '[0-9a-f-]{36}' | head -1 || true)
if [ -n "$SUBMISSION_ID" ]; then
  echo "==> Downloading notarization log..."
  xcrun notarytool log "$SUBMISSION_ID" \
    --keychain-profile "$NOTARY_PROFILE" \
    "$DIST_DIR/notarization-log.json" 2>/dev/null || true
  if [ -f "$DIST_DIR/notarization-log.json" ]; then
    echo "    Log saved to $DIST_DIR/notarization-log.json"
  fi
fi

# ── Phase 5: Upload to GitHub Releases ───────────────────────────────────────

echo "==> Uploading to GitHub release $TAG..."

# Rename binary for release asset
RELEASE_ASSET="$DIST_DIR/${RELEASE_NAME}"
cp "$UNIVERSAL_BIN" "$RELEASE_ASSET"

# Check if release exists, create if not
if ! gh release view "$TAG" &>/dev/null; then
  echo "    Creating release $TAG..."
  gh release create "$TAG" --title "$TAG" --notes "interceptor-bridge $TAG" --draft
fi

gh release upload "$TAG" "$RELEASE_ASSET" --clobber
gh release upload "$TAG" "$ZIP_PATH" --clobber

echo ""
echo "==> Release complete!"
echo "    Tag:     $TAG"
echo "    Binary:  $RELEASE_ASSET ($(ls -lh "$RELEASE_ASSET" | awk '{print $5}'))"
echo "    ZIP:     $ZIP_PATH ($(ls -lh "$ZIP_PATH" | awk '{print $5}'))"
echo ""
echo "    To publish: gh release edit $TAG --draft=false"
