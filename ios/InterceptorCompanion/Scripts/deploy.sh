#!/bin/bash
# deploy.sh — one-command home setup for InterceptorCompanion.
#
# Run this ONCE with the iPhone on the Mac's Wi-Fi or USB (CoreDevice-reachable).
# It builds + signs + installs the companion app (with its own loopback Network
# Extension), exports the device's pairing file and the matching Developer Disk
# Image from this Mac, and pushes both straight into the app's container. After
# this, the app works after any reboot, away from home, on cellular: open it and
# tap Connect.
#
#   bash ios/InterceptorCompanion/Scripts/deploy.sh <UDID> <TEAM>
#   (or set INTERCEPTOR_IOS_TEAM instead of passing TEAM)
#
# Requires: Xcode, xcodegen, bun, and a paid Apple Developer team (the Network
# Extension entitlement).
set -euo pipefail

USAGE="usage: deploy.sh <UDID> <TEAM>  (TEAM = your paid Apple Developer team ID, or set INTERCEPTOR_IOS_TEAM)"
UDID="${1:?$USAGE}"
TEAM="${2:-${INTERCEPTOR_IOS_TEAM:-}}"
[ -n "$TEAM" ] || { echo "$USAGE" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
APP_DIR="$REPO/ios/InterceptorCompanion"
APP_BUNDLE="com.interceptor.companion"
DD="${TMPDIR:-/tmp}/interceptor-companion-dd"
# The pairing record and the RemotePairing private key are staged here: private
# to this user, removed on exit.
STAGE="$(mktemp -d)"
chmod 700 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

echo "==> 1/7 Fetch the idevice xcframework (if missing)"
bash "$APP_DIR/Scripts/fetch-idevice.sh"

echo "==> 2/7 Generate + build + sign the app (and its Reflector NE)"
( cd "$APP_DIR" && xcodegen generate >/dev/null )
rm -rf "$DD"
xcrun xcodebuild build -project "$APP_DIR/InterceptorCompanion.xcodeproj" \
  -scheme InterceptorCompanion -destination "id=$UDID" \
  -derivedDataPath "$DD" -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" >/dev/null
APP="$DD/Build/Products/Debug-iphoneos/InterceptorCompanion.app"

echo "==> 3/7 Install on the device"
xcrun devicectl device install app --device "$UDID" "$APP" >/dev/null

echo "==> 4/7 Export the lockdown pairing file from usbmux (for primeCryptoProvider)"
bun -e '
import { exportPairRecordXml } from "'"$REPO"'/daemon/ios/lockdown"
const xml = await exportPairRecordXml("'"$UDID"'")
if (!xml) { console.error("no pair record — is the phone on usbmux (USB/Wi-Fi)?"); process.exit(2) }
require("fs").writeFileSync("'"$STAGE"'/pairingFile.plist", xml)
console.log("  pairing file:", xml.length, "bytes")
'

echo "==> 4b/7 Generate the device-trusted RemotePairing file over USB"
# The RSD tunnel (tunnel_create_rppairing, port 49152) needs a 3-field RP
# identity the device trusts. It can ONLY be minted with the phone on USB
# (usbmux provides the escrow attach CoreDeviceProxy needs); on-device or over
# Tailscale it broken-pipes. One-time, like "Trust This Computer".
RP_DID=$(bun -e 'import { usbmuxListDevices } from "'"$REPO"'/daemon/ios/usbmux-forward"; const d=await usbmuxListDevices(); const u=d.find(x=>x.udid.toUpperCase()==="'"$UDID"'".toUpperCase()&&x.connectionType==="USB"); console.log(u?u.deviceId:"")' 2>/dev/null)
if [ -z "$RP_DID" ]; then echo "  ERROR: phone not on USB. Plug in the iPhone by USB once to mint the RemotePairing file."; exit 2; fi
RP_HARNESS="$APP_DIR/Scripts/rpgen-usb"
MACXC="$APP_DIR/Frameworks/IDevice.xcframework/macos-arm64_x86_64"
if [ ! -x "$RP_HARNESS" ]; then
  [ -d "$MACXC" ] || { echo "  (macOS idevice slice missing; keep it in fetch-idevice.sh to enable RP generation)"; exit 2; }
  xcrun swiftc -o "$RP_HARNESS" "$APP_DIR/Scripts/rpgen-usb.swift" -I "$MACXC/Headers" "$MACXC/idevice-macos.a" -import-objc-header "$MACXC/Headers/idevice.h"
fi
"$RP_HARNESS" "$UDID" "$RP_DID" "$STAGE/rpPairingFile.plist"

echo "==> 5/7 Export the personalized Developer Disk Image (the one Xcode mounts)"
# Xcode mounts the personalized image on iOS 27.2 too (devicectl: PersonalizedImage
# mountImage). Its manifest's cryptex identity is labeled "Cryptex Developer Disk
# Image", which idevice's cryptex loader rejects (BadBuildManifest).
DDI_SRC="/Library/Developer/DeveloperDiskImages/iOS_DDI/Restore"
DDI_DST="$STAGE/DDI/Xcode_iOS_DDI_Personalized"
M="$DDI_SRC/BuildManifest.plist"
mkdir -p "$DDI_DST"
for i in $(seq 0 $(( $(plutil -extract BuildIdentities raw "$M") - 1 ))); do
  IMG=$(plutil -extract "BuildIdentities.$i.Manifest.PersonalizedDMG.Info.Path" raw "$M" 2>/dev/null) || continue
  TC=$(plutil -extract "BuildIdentities.$i.Manifest.LoadableTrustCache.Info.Path" raw "$M"); break
done
[ -n "${IMG:-}" ] || { echo "  ERROR: no PersonalizedDMG in $M"; exit 2; }
cp "$DDI_SRC/$IMG" "$DDI_DST/Image.dmg"
cp "$DDI_SRC/$TC" "$DDI_DST/Image.dmg.trustcache"
cp "$M" "$DDI_DST/BuildManifest.plist"
echo "  DDI: personalized $IMG ($(du -sh "$DDI_DST" | cut -f1))"

echo "==> 6/7 Push pairing files + DDI into the app container"
PUSH="$STAGE/push/Library/Application Support"
mkdir -p "$PUSH/Pairing" "$PUSH/DDI"
cp "$STAGE/pairingFile.plist" "$PUSH/Pairing/pairingFile.plist"
cp "$STAGE/rpPairingFile.plist" "$PUSH/Pairing/rpPairingFile.plist"
cp -R "$STAGE/DDI/." "$PUSH/DDI/"
xcrun devicectl device copy to --device "$UDID" \
  --domain-type appDataContainer --domain-identifier "$APP_BUNDLE" \
  --source "$STAGE/push/Library" --destination "Library" >/dev/null

echo "==> Done. On the phone: open InterceptorCompanion and tap Connect."
echo "    It brings up the reflector, mounts the DDI, and launches the runner."
