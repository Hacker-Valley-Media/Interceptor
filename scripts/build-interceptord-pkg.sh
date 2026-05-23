#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_DIR="$ROOT/interceptor-bridge"
OUT_DIR="${OUT_DIR:-$ROOT/dist}"
IDENTIFIER="${IDENTIFIER:-com.interceptor.guest}"
VERSION="${VERSION:-0.1.0}"
PKG="$OUT_DIR/InterceptorD-${VERSION}.pkg"
UNSIGNED_PKG="$OUT_DIR/InterceptorD-${VERSION}-unsigned.pkg"
INTERCEPTOR_SIGNING_IDENTITY="${INTERCEPTOR_SIGNING_IDENTITY:-Developer ID Application: HACKER VALLEY MEDIA, LLC (TPWBZD35WW)}"
INTERCEPTOR_INSTALLER_IDENTITY="${INTERCEPTOR_INSTALLER_IDENTITY:-Developer ID Installer: HACKER VALLEY MEDIA, LLC (TPWBZD35WW)}"

mkdir -p "$OUT_DIR"

cd "$BRIDGE_DIR"
swift build -c release --product InterceptorD

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

install -d "$STAGE/Library/PrivilegedHelperTools"
install -m 0755 ".build/release/InterceptorD" "$STAGE/Library/PrivilegedHelperTools/InterceptorD"

if [[ "${INTERCEPTOR_SKIP_SIGNING:-0}" == "1" ]]; then
  echo "==> INTERCEPTOR_SKIP_SIGNING=1 — skipping InterceptorD codesign and pkg signing"
elif security find-identity -p codesigning -v 2>/dev/null | grep -q "$INTERCEPTOR_SIGNING_IDENTITY"; then
  echo "==> Codesigning InterceptorD with: $INTERCEPTOR_SIGNING_IDENTITY"
  codesign --force --options runtime --timestamp \
    --sign "$INTERCEPTOR_SIGNING_IDENTITY" \
    "$STAGE/Library/PrivilegedHelperTools/InterceptorD"
  codesign --verify --strict --verbose=2 "$STAGE/Library/PrivilegedHelperTools/InterceptorD"
else
  echo "WARN: signing identity not found: $INTERCEPTOR_SIGNING_IDENTITY" >&2
  echo "      Set INTERCEPTOR_SIGNING_IDENTITY or INTERCEPTOR_SKIP_SIGNING=1." >&2
fi

install -d "$STAGE/Library/LaunchAgents"
cat > "$STAGE/Library/LaunchAgents/$IDENTIFIER.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$IDENTIFIER</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Library/PrivilegedHelperTools/InterceptorD</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/InterceptorD.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/InterceptorD.err.log</string>
</dict>
</plist>
PLIST

PKGBUILD_OUTPUT="$PKG"
if [[ "${INTERCEPTOR_SKIP_SIGNING:-0}" != "1" ]] && security find-identity -v 2>/dev/null | grep -q "$INTERCEPTOR_INSTALLER_IDENTITY"; then
  PKGBUILD_OUTPUT="$UNSIGNED_PKG"
fi

rm -f "$PKG" "$UNSIGNED_PKG"

pkgbuild \
  --root "$STAGE" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --install-location / \
  "$PKGBUILD_OUTPUT"

if [[ "$PKGBUILD_OUTPUT" == "$UNSIGNED_PKG" ]]; then
  echo "==> Signing pkg with: $INTERCEPTOR_INSTALLER_IDENTITY"
  productsign \
    --sign "$INTERCEPTOR_INSTALLER_IDENTITY" \
    "$UNSIGNED_PKG" \
    "$PKG"
  rm -f "$UNSIGNED_PKG"
  pkgutil --check-signature "$PKG"
elif [[ "${INTERCEPTOR_SKIP_SIGNING:-0}" != "1" ]]; then
  echo "WARN: installer identity not found: $INTERCEPTOR_INSTALLER_IDENTITY" >&2
  echo "      Set INTERCEPTOR_INSTALLER_IDENTITY or INTERCEPTOR_SKIP_SIGNING=1." >&2
fi

echo "$PKG"
