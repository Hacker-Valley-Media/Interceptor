---
author: agent
generated_by: "claude-opus-5-5 (Maestro)"
created: 2026-10-19
updated: 2026-10-21
status: active
reviewed: false
source: "ios/InterceptorRunnerFull sources and Scripts/build-dev-web.sh"
---

# InterceptorRunnerFull: the one-app runner (developer build)

The standard [InterceptorRunner](../InterceptorRunner) is an XCUITest runner that
the Mac starts. After the iPhone restarts, the Developer Disk Image (DDI) is no
longer mounted, so nothing can start the runner until a Mac mounts it again.

This variant puts the on-device DDI mount from
[InterceptorCompanion](../InterceptorCompanion) into the runner itself, so there is
one Home Screen app. Tap it after a restart, tap Connect on the page it opens, and
the runner mounts the image on the phone and dials home, including over cellular
with no Mac nearby.

It is a developer build. It is not part of the shipped Interceptor installer.

## Requirements

- A **paid** Apple Developer Program team. The loopback reflector is a packet-tunnel
  Network Extension, and that entitlement is not available to free teams. With a
  free team, use the standard InterceptorRunner (`interceptor ios setup`).
- Xcode with the iOS platform, [xcodegen](https://github.com/yonaskolb/XcodeGen),
  and [bun](https://bun.sh).
- `IDevice.xcframework` in `../InterceptorCompanion/Frameworks/`. The build script
  runs `../InterceptorCompanion/Scripts/fetch-idevice.sh` when it is missing.
- An iPhone in Developer Mode, paired with the Mac.
- For the mount: the lockdown pairing file, the RemotePairing file, and the
  personalized DDI files in the runner's app container
  (`Library/Application Support/{Pairing,DDI}`).
  `../InterceptorCompanion/Scripts/deploy.sh` shows how to export them and push
  them with `devicectl device copy to`. It targets the Companion's container, so
  change `--domain-identifier` to `com.interceptor.runner.<team>.xctrunner` for this
  build.

## Build

```bash
INTERCEPTOR_IOS_TEAM=<team> ios/InterceptorRunnerFull/Scripts/build-dev-web.sh [udid]
```

- `INTERCEPTOR_IOS_TEAM` is required. Bundle ids use it lowercased:
  `com.interceptor.runner.<team>` (the `.xctrunner` app) and
  `com.interceptor.runner.<team>.xctrunner.reflector` (the Reflector appex).
- With a UDID the script installs the app with `devicectl`. Without one it stops
  after signing and prints the app path.
- Scratch files, logs, and entitlements go to `$INTERCEPTOR_RUNNER_FULL_BUILD`
  (default `$TMPDIR/interceptor-runner-full`).
- The version comes from the repo's `package.json`.

The script assembles one project from the base runner, the Companion's mount and
reflector sources, this directory's `Sources/`, fishhook, and the built WebUI. It
patches `ObjCSupport.m` `+load` (failing if an anchor is missing), builds two
throwaway apps once per team so automatic signing provisions the Network Extension
capability, runs `xcodebuild build-for-testing`, embeds XCTest with the rpath
order a warm launch needs, embeds the Reflector appex, and re-signs everything
with the identity Xcode chose for the app.

## What the Connect flow does

A tap on the runner icon opens Safari to `http://127.0.0.1:8723/?t=<token>`. The
runner serves that page from `Sources/ICWebServer.swift`; the page source is
`../InterceptorCompanion/WebUI`. `POST /action` requires the per-process token
from that URL, so other apps on the phone can't start the flow.

Connect (`ICBootstrap.webConnect`) then:

1. Starts the Reflector, a loopback packet tunnel that makes the phone's own
   `remoted` reachable at `10.7.0.1`.
2. On cellular, asks the person to turn Cellular Data off, because iOS refuses the
   device service through the reflector while it is on.
3. Opens a RemotePairing tunnel and mounts the personalized DDI. Before the step
   that needs Apple's signing server, it asks for Cellular Data back on.
4. Writes a boot marker and relaunches the runner over the same tunnel. The new
   process sees the image mounted this boot, runs the real XCUITest, and dials home.
5. Asks the person to turn their VPN back on.

On any failure it stops the Reflector and shows what to turn back on. Connect is
refused when the image is already mounted this boot, so it can't replace a live
runner.

Each stage publishes a `step` (`ready`, `startingVpn`, `cellularOff`, `preparing`,
`cellularOn`, `installing`, `connecting`, `vpnOn`, `failed`, `setupNeeded`,
`allClear`). `WebUI/src/screens.ts` turns each one into a plain-language screen.

## Known limitations

- iOS runs one VPN at a time. Starting the Reflector switches off the person's own
  VPN, and they have to turn it back on before the runner can dial home over it.
- On cellular, Cellular Data has to be off while the tunnel opens and back on for
  the install. The page walks the person through both.
- Only a cold tap opens the page. A warm tap, or a tap on a runner that is already
  running, does not.
- Nothing publishes `allClear` yet, so "You're connected" never shows.
- Each tap opens a new Safari tab.
- A bookmark or web clip of the page has no valid token, so Connect from it is
  refused. Tap the runner icon instead.

## Credits

The Reflector is based on [StosVPN](https://github.com/SideStore/StosVPN) by
SideStore. The DDI mount code is based on [iCTRL](https://github.com/OpenMinis/iCTRL)
by OpenMinis (Apache License 2.0). The on-device mount approach comes from
StikDebug. License texts: `../InterceptorCompanion/THIRD_PARTY_NOTICES.md`.
