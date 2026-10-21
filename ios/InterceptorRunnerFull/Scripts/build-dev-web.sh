#!/bin/bash
# Build the one-app InterceptorRunner: the XCUITest runner plus the on-device
# Developer Disk Image mount, the loopback Reflector Network Extension, and the
# Safari Connect UI. Assembles an Xcode project from the in-repo sources, builds
# it with the current Xcode, embeds XCTest and the Reflector appex, fixes the
# rpath order, re-signs, and installs it when a device UDID is given.
#
#   INTERCEPTOR_IOS_TEAM=<team> ios/InterceptorRunnerFull/Scripts/build-dev-web.sh [udid]
#
# Needs a PAID Apple Developer team (Network Extension entitlement), Xcode,
# xcodegen, and bun. Without a UDID it stops after signing and prints the app path.
# Scratch dir: $INTERCEPTOR_RUNNER_FULL_BUILD (default $TMPDIR/interceptor-runner-full).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
FULL="$REPO/ios/InterceptorRunnerFull"
RUN="$REPO/ios/InterceptorRunner"
COMP="$REPO/ios/InterceptorCompanion"
WEBUI="$COMP/WebUI"
FISHHOOK="$REPO/interceptor-agent/Sources/AgentLoader"
TEAM="${INTERCEPTOR_IOS_TEAM:?set INTERCEPTOR_IOS_TEAM to your paid Apple Developer team ID}"
# Bundle ids carry the lowercased team, the same rule daemon/ios/tools.ts applies.
TEAM_LC="$(printf '%s' "$TEAM" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-')"
DEV="${1:-}"
WORK="${INTERCEPTOR_RUNNER_FULL_BUILD:-${TMPDIR:-/tmp}/interceptor-runner-full}"
B="$WORK/MergedRunner"
SEED="$WORK/seed-$TEAM_LC"
SEEDPROD="$SEED/dd/Build/Products/Debug-iphoneos"
PLAT="$(xcode-select -p)/Platforms/iPhoneOS.platform/Developer"
VERSION="$(PKG="$REPO/package.json" bun -p 'require(process.env.PKG).version')"
[ -n "$VERSION" ] || { echo "could not read the version from $REPO/package.json"; exit 2; }

# Fill the __TEAM_LC__ / __VERSION__ placeholders in a generated file; fail if any is left.
fill() {
  /usr/bin/sed -i '' -e "s/__TEAM_LC__/$TEAM_LC/g" -e "s/__VERSION__/$VERSION/g" "$1"
  if grep -qE '__(TEAM_LC|VERSION)__' "$1"; then echo "unfilled placeholder in $1"; exit 5; fi
}

echo "==> 1/8 assemble sources into $B"
[ -d "$COMP/Frameworks/IDevice.xcframework" ] || bash "$COMP/Scripts/fetch-idevice.sh"
rm -rf "$B"; mkdir -p "$B/Sources" "$B/Tunnel" "$B/Generated" "$B/Frameworks"
# base runner
cp "$RUN/Sources/InterceptorRunnerUITests.swift" "$RUN/Sources/ObjCSupport.h" \
   "$RUN/Sources/InterceptorRunner-Bridging-Header.h" "$RUN/Sources/ObjCSupport.m" "$B/Sources/"
# companion mount/VPN sources
for f in DDIMounter RPPairing RunnerLauncher ReflectorTunnel DeveloperDiskImageStore PairingFileStore CompanionLog; do
  cp "$COMP/Sources/$f.swift" "$B/Sources/$f.swift"
done
# the full-runner additions
cp "$FULL/Sources/ICWebServer.swift" "$FULL/Sources/ICBootstrap.swift" "$FULL/Sources/ICRunnerUI.m" "$B/Sources/"
# fishhook (compiled via #include in ICRunnerUI.m; header on the search path)
cp "$FISHHOOK/fishhook.c" "$FISHHOOK/include/fishhook.h" "$B/Sources/"
# reflector NE + idevice + the built WebUI
cp "$COMP/Tunnel/PacketTunnelProvider.swift" "$B/Tunnel/"
cp -R "$COMP/Frameworks/IDevice.xcframework" "$B/Frameworks/"
( cd "$WEBUI" && bun build-ui.ts "$B/WebUIDist" >/dev/null )

echo "==> 2/8 patch ObjCSupport.m (+load routing for the one-app runner)"
bun - "$B/Sources/ObjCSupport.m" <<'TS'
const p = Bun.argv[2]; let s = await Bun.file(p).text();
if (s.includes("ICDDIMountedThisBoot")) { console.log("  ObjCSupport already patched"); process.exit(0); }
function swap(anchor: string, next: string) {
  if (!s.includes(anchor)) { console.error(`  !! anchor not found in ObjCSupport.m: ${anchor.split("\n")[0]}`); process.exit(3); }
  s = s.replace(anchor, next);
}
const helper = `
// DDI mounted this boot? (warm/cold discriminant; set by ICBootstrap.markMounted)
static BOOL ICDDIMountedThisBoot(void) {
    NSString *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
    if (!docs) return NO;
    NSString *saved = [NSString stringWithContentsOfFile:[docs stringByAppendingPathComponent:@"ic-boot-marker"] encoding:NSUTF8StringEncoding error:nil];
    if (!saved) return NO;
    struct timeval tv; size_t sz = sizeof(tv); int mib[2] = { CTL_KERN, KERN_BOOTTIME };
    if (sysctl(mib, 2, &tv, &sz, NULL, 0) != 0) return NO;
    NSString *now = [NSString stringWithFormat:@"%ld.%d", (long)tv.tv_sec, (int)tv.tv_usec];
    return [[saved stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] isEqualToString:now];
}
`;
const oldLoad = `+ (void)load {
    if ([NSProcessInfo.processInfo.environment[@"INTERCEPTOR_WS_URL"] length] > 0) return;
    [self suspendWhenActiveWithRetries:120]; // every 0.5 s for up to a minute
}`;
const newLoad = `+ (void)load {
    BOOL full = [[NSBundle bundleForClass:[ICEarlyBackground class]].infoDictionary[@"ICFullApp"] boolValue];
    BOOL hasSession = [NSProcessInfo.processInfo.environment[@"INTERCEPTOR_WS_URL"] length] > 0;
    BOOL coldTap = full && !hasSession && !ICDDIMountedThisBoot();
    // Always serve the Connect UI; ICRunnerUI opens Safari to it on a cold tap.
    if (full) {
        Class ws = NSClassFromString(@"ICWebServer");
        if (ws) ((void(*)(id, SEL))objc_msgSend)((id)ws, @selector(start));
    }
    if (coldTap) return; // ICRunnerUI keeps us alive + opens Safari; Connect POSTs /action
    if (hasSession) return; // Mac launch: the daemon backgrounds the runner
    // warm full tap OR base runner tap: free any leftover reflector, then self-background
    if (full) {
        Class b = NSClassFromString(@"ICBootstrap");
        if (b) ((void(*)(id, SEL))objc_msgSend)((id)b, @selector(stopReflectorBestEffort));
    }
    [self suspendWhenActiveWithRetries:120]; // every 0.5 s for up to a minute
}`;
swap("#import <stdatomic.h>", "#import <stdatomic.h>\n#import <sys/sysctl.h>");
swap("NSError * _Nullable ICRunCatching", helper + "\nNSError * _Nullable ICRunCatching");
swap(oldLoad, newLoad);
await Bun.write(p, s);
console.log("  + ICDDIMountedThisBoot + one-app +load");
TS

echo "==> 3/8 write project.yml + entitlements + Info.plists"
cat > "$B/Runner.entitlements" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.developer.networking.networkextension</key><array><string>packet-tunnel-provider</string></array>
</dict></plist>
EOF
cp "$B/Runner.entitlements" "$B/Tunnel/Reflector.entitlements"
cat > "$B/Generated/Reflector-Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>__VERSION__</string><key>CFBundleVersion</key><string>__VERSION__</string>
  <key>NSExtension</key><dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.networkextension.packet-tunnel</string>
    <key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).PacketTunnelProvider</string>
  </dict>
</dict></plist>
EOF
fill "$B/Generated/Reflector-Info.plist"
# DEVELOPMENT_TEAM is passed to xcodebuild below, not written here.
cat > "$B/project.yml" <<'EOF'
name: InterceptorRunner
options: { bundleIdPrefix: com.interceptor, deploymentTarget: { iOS: "16.0" }, createIntermediateGroups: true }
settings:
  base: { SWIFT_VERSION: "5.0", CODE_SIGN_STYLE: Automatic, TARGETED_DEVICE_FAMILY: "1,2" }
targets:
  InterceptorRunner:
    type: bundle.ui-testing
    platform: iOS
    sources:
      - path: Sources
        excludes: [ "fishhook.c" ]   # compiled via #include in ICRunnerUI.m, not standalone (dup symbols)
      - { path: WebUIDist, type: folder }
    dependencies:
      - { target: Reflector, embed: true }
      - { framework: Frameworks/IDevice.xcframework, embed: false }
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.interceptor.runner.__TEAM_LC__
        PRODUCT_NAME: InterceptorRunner
        GENERATE_INFOPLIST_FILE: NO
        TEST_TARGET_NAME: ""
        USES_XCTRUNNER: YES
        CODE_SIGN_ENTITLEMENTS: Runner.entitlements
        SWIFT_OBJC_BRIDGING_HEADER: Sources/InterceptorRunner-Bridging-Header.h
        CLANG_ENABLE_MODULES: YES
        ENABLE_USER_SCRIPT_SANDBOXING: NO
    info:
      path: Generated/InterceptorRunner-Info.plist
      properties:
        CFBundleDevelopmentRegion: "$(DEVELOPMENT_LANGUAGE)"
        CFBundleExecutable: "$(EXECUTABLE_NAME)"
        CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)"
        CFBundleInfoDictionaryVersion: "6.0"
        CFBundleName: "$(PRODUCT_NAME)"
        CFBundlePackageType: BNDL
        CFBundleShortVersionString: "__VERSION__"
        CFBundleVersion: "__VERSION__"
        ICFullApp: true
        NSLocalNetworkUsageDescription: "InterceptorRunner connects to the Interceptor daemon to receive local automation commands."
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true }
  Reflector:
    type: app-extension
    platform: iOS
    sources: [Tunnel]
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.interceptor.runner.__TEAM_LC__.xctrunner.reflector
        PRODUCT_NAME: Reflector
        GENERATE_INFOPLIST_FILE: NO
        INFOPLIST_FILE: Generated/Reflector-Info.plist
        CODE_SIGN_ENTITLEMENTS: Tunnel/Reflector.entitlements
schemes:
  InterceptorRunner:
    build: { targets: { InterceptorRunner: [test], Reflector: all } }
    test: { targets: [InterceptorRunner] }
EOF
fill "$B/project.yml"

echo "==> 4/8 ensure the Network Extension App IDs exist (seed two throwaway app targets)"
# Automatic signing only provisions the NE capability for app targets, so build two
# tiny apps with the runner's and the reflector's bundle ids once per team.
if [ ! -d "$SEEDPROD/SeedReflector.app" ]; then
  rm -rf "$SEED"; mkdir -p "$SEED/Sources"
  cat > "$SEED/Sources/App.swift" <<'EOF'
import SwiftUI
@main struct SeedApp: App { var body: some Scene { WindowGroup { Text("seed") } } }
EOF
  cp "$B/Runner.entitlements" "$SEED/ne.entitlements"
  cat > "$SEED/project.yml" <<'EOF'
name: Seed
options: { bundleIdPrefix: com.interceptor, deploymentTarget: { iOS: "16.0" } }
settings: { base: { CODE_SIGN_STYLE: Automatic, SWIFT_VERSION: "5.0", GENERATE_INFOPLIST_FILE: YES, MARKETING_VERSION: "1.0", CURRENT_PROJECT_VERSION: "1", INFOPLIST_KEY_UIApplicationSceneManifest_Generation: YES } }
targets:
  SeedRunner: { type: application, platform: iOS, sources: [Sources], settings: { base: { PRODUCT_BUNDLE_IDENTIFIER: com.interceptor.runner.__TEAM_LC__.xctrunner, CODE_SIGN_ENTITLEMENTS: ne.entitlements } } }
  SeedReflector: { type: application, platform: iOS, sources: [Sources], settings: { base: { PRODUCT_BUNDLE_IDENTIFIER: com.interceptor.runner.__TEAM_LC__.xctrunner.reflector, CODE_SIGN_ENTITLEMENTS: ne.entitlements } } }
EOF
  fill "$SEED/project.yml"
  ( cd "$SEED" && xcodegen generate >/dev/null )
  for t in SeedRunner SeedReflector; do
    xcrun xcodebuild build -project "$SEED/Seed.xcodeproj" -scheme "$t" -destination 'generic/platform=iOS' \
      -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" -derivedDataPath "$SEED/dd" > "$WORK/seed-$t.log" 2>&1 \
      && echo "  seeded $t" \
      || { echo "  seed $t FAILED (log: $WORK/seed-$t.log)"; grep -n -E 'error:' "$WORK/seed-$t.log" | head -15; exit 4; }
  done
fi

echo "==> 5/8 build-for-testing"
( cd "$B" && xcodegen generate >/dev/null )
xcrun xcodebuild build-for-testing -project "$B/InterceptorRunner.xcodeproj" -scheme InterceptorRunner \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" \
  -derivedDataPath "$B/dd" > "$WORK/build.log" 2>&1 \
  || { echo "BUILD FAILED (log: $WORK/build.log)"; grep -n -E 'error:|duplicate symbol' "$WORK/build.log" | head -15; exit 1; }
APP="$B/dd/Build/Products/Debug-iphoneos/InterceptorRunner-Runner.app"
# Re-sign everything below with the identity Xcode just chose (the leaf Authority).
SIGINFO="$(codesign -dvv "$APP" 2>&1)"
IDENT="$(printf '%s\n' "$SIGINFO" | sed -n 's/^Authority=//p' | sed -n 1p)"
[ -n "$IDENT" ] || { echo "could not read the signing identity of $APP"; printf '%s\n' "$SIGINFO"; exit 6; }
echo "  signing identity: $IDENT"

echo "==> 6/8 embed XCTest (Xcode 27 no longer does) + fix rpath order"
mkdir -p "$APP/Frameworks"
for fw in Library/Frameworks/XCTest.framework Library/Frameworks/XCUIAutomation.framework Library/Frameworks/Testing.framework \
          Library/PrivateFrameworks/XCTestCore.framework Library/PrivateFrameworks/XCTestSupport.framework \
          Library/PrivateFrameworks/XCTAutomationSupport.framework Library/PrivateFrameworks/XCUnit.framework usr/lib/libXCTestSwiftSupport.dylib; do
  rm -rf "$APP/Frameworks/$(basename "$fw")"; cp -R "$PLAT/$fw" "$APP/Frameworks/"
done
for f in "$APP"/Frameworks/*; do codesign --force --sign "$IDENT" --timestamp=none "$f"; done
# mounted DDI's XCTest must win over the bundled copy on a warm launch
EXE="$APP/InterceptorRunner-Runner"; XT="$APP/PlugIns/InterceptorRunner.xctest/InterceptorRunner"
install_name_tool -delete_rpath @executable_path/Frameworks "$EXE"; install_name_tool -add_rpath @executable_path/Frameworks "$EXE"
install_name_tool -delete_rpath @executable_path/Frameworks "$XT"
install_name_tool -add_rpath /System/Developer/Library/Frameworks "$XT"
install_name_tool -add_rpath /System/Developer/usr/lib "$XT"
install_name_tool -add_rpath @executable_path/Frameworks "$XT"
codesign --force --sign "$IDENT" --preserve-metadata=entitlements --generate-entitlement-der --timestamp=none "$APP/PlugIns/InterceptorRunner.xctest"

echo "==> 7/8 embed Reflector appex + re-sign"
codesign -d --entitlements :- "$SEEDPROD/SeedReflector.app" 2>/dev/null | plutil -convert xml1 -o "$WORK/appex.entitlements" -
codesign -d --entitlements :- "$APP" 2>/dev/null | plutil -convert xml1 -o "$WORK/runner.entitlements" -
PROD="$B/dd/Build/Products/Debug-iphoneos"
rm -rf "$APP/PlugIns/Reflector.appex"; cp -R "$PROD/Reflector.appex" "$APP/PlugIns/Reflector.appex"
cp "$SEEDPROD/SeedReflector.app/embedded.mobileprovision" "$APP/PlugIns/Reflector.appex/embedded.mobileprovision"
codesign --force --sign "$IDENT" --entitlements "$WORK/appex.entitlements" --generate-entitlement-der --timestamp=none "$APP/PlugIns/Reflector.appex"
codesign --force --sign "$IDENT" --entitlements "$WORK/runner.entitlements" --generate-entitlement-der --timestamp=none "$APP"
codesign --verify --strict "$APP"
echo "  signed OK (XCTest: $(ls "$APP/Frameworks" | wc -l | tr -d ' ') items, WebUIDist: $(ls "$APP/PlugIns/InterceptorRunner.xctest/WebUIDist" 2>/dev/null | tr '\n' ' '))"

if [ -z "$DEV" ]; then
  echo "==> 8/8 no device UDID given; skipping install"
  echo "DONE: $APP"
  exit 0
fi
echo "==> 8/8 install on $DEV"
xcrun devicectl device install app --device "$DEV" "$APP"
echo "DONE: $APP"
