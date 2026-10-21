#!/bin/bash
# Fetch the idevice xcframework (MIT, github.com/jkcoxson/idevice) into
# Frameworks/. The release ships ~215MB static archives and is only a release
# asset (SPM can't resolve it by URL), so it is pulled here and not committed.
set -euo pipefail
VERSION="${IDEVICE_VERSION:-v0.1.68}"
# SHA-256 of idevice-xcframework-${VERSION}.zip (GitHub's published asset digest); update with VERSION.
SHA256="${IDEVICE_SHA256:-c9eccdd1942de756d746a2569d93302774ab0eff1cff314ec8118f768b3d8dc7}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/Frameworks/IDevice.xcframework"
URL="https://github.com/jkcoxson/idevice/releases/download/${VERSION}/idevice-xcframework-${VERSION}.zip"
if [ -f "$DEST/ios-arm64/libidevice_ffi.a" ]; then echo "✅ IDevice.xcframework present ($DEST)"; exit 0; fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if [ -n "${IDEVICE_ZIP:-}" ]; then cp "$IDEVICE_ZIP" "$TMP/idevice.zip"; else
  echo "⬇️  Fetching idevice ${VERSION} (~215MB)…"; curl -fL --progress-bar -o "$TMP/idevice.zip" "$URL"; fi
GOT="$(shasum -a 256 "$TMP/idevice.zip" | cut -d' ' -f1)"
[ "$GOT" = "$SHA256" ] || { echo "❌ idevice archive SHA-256 $GOT does not match $SHA256"; exit 1; }
unzip -q "$TMP/idevice.zip" -d "$TMP/x"
rm -rf "$DEST"; mkdir -p "$(dirname "$DEST")"
cp -R "$TMP/x/swift/IDevice.xcframework" "$DEST"
# Keep iOS device + simulator + macOS slices; drop catalyst (macOS is needed by
# Scripts/rpgen-usb.swift to mint the RemotePairing file over USB).
rm -rf "$DEST/ios-arm64_x86_64-maccatalyst"
/usr/bin/python3 - "$DEST/Info.plist" <<'PY'
import plistlib,sys
d=plistlib.load(open(sys.argv[1],'rb'))
d['AvailableLibraries']=[l for l in d['AvailableLibraries'] if l['LibraryIdentifier'] in ('ios-arm64','ios-arm64_x86_64-simulator','macos-arm64_x86_64')]
plistlib.dump(d,open(sys.argv[1],'wb'))
PY
echo "✅ IDevice.xcframework ${VERSION} installed at $DEST"
