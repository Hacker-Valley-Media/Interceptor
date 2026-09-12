# iOS device surface — InterceptorRunner (app route)

> Drives any installed app on an **owned, unlocked, Developer-Mode** iPhone via **our own on-device InterceptorRunner** (a minimal XCUITest runner — *not* WebDriverAgent), brokered by the daemon-resident `IosManager` and addressed by `--context ios:<udid>`.
>
> This is the *app route*: it accepts Developer Mode and an operator Apple signing identity in exchange for the one thing only it gives — **deterministic, per-element coordinate control of arbitrary App Store apps with reliable text entry**.

## Architecture

The on-device InterceptorRunner **dials INTO** the daemon WebSocket and registers `{type:"ios"}` — the same "device dials in" model the browser extension and the macOS `runtime:` agent use (not the old `cdp:` daemon-dials-out model). The manager drives it over that socket via `RunnerChannel`. No WebDriverAgent, no usbmux HTTP forward.

```
interceptor ios <verb> --context ios:<udid>
   → cli/commands/ios.ts            builds { type: "ios_<verb>", … }, threads --context
   → daemon/index.ts                ios: prefix branch → iosManager.executeVerb(contextId, action)
   → daemon/ios/manager.ts          resolves the context, sends a verb frame over the runner's WS
   → daemon/ios/channel.ts          RunnerChannel: { id, op, …args } ⇄ { id, result }
   → [WiFi / WS]                    daemon WS server  ⇄  InterceptorRunner on device
   → ios/InterceptorRunner/         XCUITest: XCUICoordinate / XCUIApplication / XCUIScreen / snapshot
```

- `shared/ios-device.ts` — dependency-free classifier, `ios:` prefix, version/tunnel logic, the `{type:"ios"}` register frame + runner op codes (twin of `shared/native-agent.ts`).
- `daemon/ios/channel.ts` — `IosDeviceChannel` (the transport contract) + `RunnerChannel` (the WS dial-in channel). A legacy `WdaClient` (`--wda-url`) also implements it as a deprecated escape hatch.
- `daemon/ios/tree.ts` — the runner's `source` snapshot JSON → ref-registered element tree (`[e1] button "Send"`), mirroring the macOS `AccessibilityDomain` output. **Refs store each node's frame**; actuation is a deterministic **coordinate tap** at the frame center.
- `daemon/ios/tools.ts` — runner artifact staging, `.xctestrun` env-injection for the Xcode path, physical/simulator discovery, and VLM-budget screenshot resize via **`sips -Z`** (zero dependency).
- `daemon/ios/installer.ts` — no-Xcode install path: AFC uploads the runner into `PublicStaging`, then `installation_proxy` performs `Install`/`Upgrade`.
- `daemon/ios/usertunnel.ts` + `daemon/ios/testmanagerd.ts` — no-Xcode launch path: CoreDeviceProxy userspace tunnel, RSD, appservice env injection, and the testmanagerd DTX handshake.
- `ios/InterceptorRunner/` — the Swift runner (source only; capability-blind, operator-signed). Replaces WebDriverAgent.
- The Swift macOS bridge is **not** involved — the device channel is entirely daemon-side, so `interceptor ios` works in browser-only mode too.

## Setup (one time)

> **The XCTest authorization sheet is entered on the phone, by a person.** The first XCUITest launch after a reboot (and any later re-authorization) shows *"Enter iPhone Passcode for XCTest — Enable UI Automation"*. It blocks the runner itself, so no Interceptor verb can type into it, and every Mac-side route (AccessibilityAudit, Accessibility Inspector, Switch Control, iPhone Mirroring, re-signed Apple tools) was tried live on 2026-09-11 and could not enter a digit: the sheet's accessibility actions report unsupported and the private entitlements Apple's tools use do not survive re-signing. Agents must stop and ask for the tap (or a paired hardware keyboard). After approval, restart the daemon and retry.

1. **Developer Mode** on the device: Settings → Privacy & Security → Developer Mode → on, restart, confirm with passcode. (Required for any dev-signed/test app; a paid Apple license does **not** waive it.)
2. **Pair + trust** the device (`Trust This Computer`).
3. **Trust the Developer App certificate** after the runner is installed, if iOS asks for it: Settings → General → VPN & Device Management → Developer App → Trust. This is device-side Apple platform behavior; the host cannot bypass it.
4. **Choose a signing/install path**:
   - **Xcode-backed self-service path:** `interceptor ios setup [<device>] [--team <TEAM_ID>]` builds the packaged `InterceptorRunner.xcodeproj` with the user's locally configured Xcode account/team (`xcodebuild build-for-testing -allowProvisioningUpdates`), stages the signed Products, installs them with `devicectl`, and launches with `xcodebuild test-without-building`. Xcode owns Apple-ID auth, 2FA, device registration, certificate creation, profile creation, and the runner test session.
   - **Userspace launch diagnostic:** set `INTERCEPTOR_NO_XCODE=1` only when testing Interceptor's experimental CoreDeviceProxy/testmanagerd launcher.
5. **InterceptorRunner** (`ios/InterceptorRunner/`): this surface drives our own runner and ships source plus an unsigned build input, with no signing material in the core (capability-blind; enforced by `scripts/audit-capability-blind.sh`). You sign it with your team. Provide it one of three ways:
   - **Managed (recommended):** run `interceptor ios setup --team <TEAM>`; the manager builds/signs with Xcode, installs via Interceptor, injects the WS URL/token at launch, and the runner dials home.
   - **Prebuilt:** build once (`xcodebuild build-for-testing`), then `export INTERCEPTOR_RUNNER_XCTESTRUN=<…/.xctestrun>` for fast re-enables.
   - **Manual:** launch it yourself with `INTERCEPTOR_WS_URL` / `INTERCEPTOR_WS_TOKEN` (or a shared `INTERCEPTOR_IOS_TOKEN`).
   - **Legacy escape hatch (deprecated):** drive an existing WebDriverAgent over HTTP with `--wda-url http://127.0.0.1:8100`.

## Commands (seamless surface)

The package carries an unsigned build input at
`/Library/Application Support/Interceptor/ios-runner.tar` and the runner source
project. `ios setup` rebuilds and signs the source on the user's Mac, validates
the resulting identity, installs it with `devicectl`, and launches it with Xcode's
`test-without-building` path. `ios install` only reinstalls that already-signed
staged result; it refuses the unsigned package input. Verbs **auto-connect** (no
`enable`); address a phone with `--on <name>` (or it uses your only phone).

```bash
interceptor ios setup [<device>]            # build, sign, install, and launch with Xcode
interceptor ios install [<device>]          # reinstall the runner previously signed by setup
interceptor ios devices                      # phones that have the agent (+ names)
interceptor ios name <device> <alias>        # rename a phone, e.g. "work"

interceptor ios tree    [--on work] [--filter interactive|all|full]
interceptor ios find    [--on work] --label "Send" [--role button]
interceptor ios inspect [--on work] <ref>
interceptor ios click   [--on work] <ref> | --x N --y N
interceptor ios type    [--on work] <ref> "text"
interceptor ios keys    [--on work] "text"
interceptor ios scroll  [--on work] [<ref>] --dir up|down|left|right
interceptor ios drag    [--on work] <from> <to>
interceptor ios press   [--on work] home|lock|volume-up|volume-down
interceptor ios screenshot [--on work]
interceptor ios apps    [--on work]
interceptor ios app     [--on work] launch|activate|terminate <bundleId>
```

Release builds the agent: `release.sh` runs an unsigned `build-for-testing` of
`ios/InterceptorRunner` and tars the Products as an input for user-owned signing.
Override with `INTERCEPTOR_RUNNER_PREBUILT=<Products dir>` to provide a prepared
build, or `INTERCEPTOR_SKIP_RUNNER=1` to omit it. Legacy/internal:
`enable`/`disable`/`status`/`discover` still exist; `--wda-url` is the deprecated WDA hatch.

`interceptor contexts` lists `ios:<udid>` beside browser / `cdp:` / `runtime:` contexts.

## Capability boundary

| Can | Cannot |
|---|---|
| Drive any installed app's UI (tap/type/swipe), trusted, **per-element by coordinate** | Pass Face ID / passcode / Apple Pay (Secure Enclave) |
| Read the **foreground** app's element tree + screenshot | Read other apps' on-disk/sandbox data or object graph |
| Launch / activate / terminate apps, press hardware buttons | Get past the lock screen / unlock the device |
| Type into secure fields | Read back secure-field values (AX-redacted) |
| Keep the screen awake during a session | Run with the device locked or asleep |

## Failure modes (clear errors, never hangs)

- `INTERCEPTOR_NO_XCODE=1` uses the daemon's unprivileged CoreDeviceProxy userspace tunnel. The obsolete root `com.interceptor.ios-tunnel` LaunchDaemon is not on either launch path.
- Developer App certificate not trusted → iOS denies launch before the runner starts; trust it on-device in Settings → General → VPN & Device Management.
- iOS 17+ launches use `xcodebuild test-without-building` by default.
- Runner never connects → "InterceptorRunner did not register within Ns" + guidance (check WiFi pairing / Developer Mode, or set `INTERCEPTOR_RUNNER_PROJECT`).
- Runner socket drops mid-session → context auto-disabled; the next drive verb launches it again.
- Developer Mode off / not paired → `enable` reports exactly what to fix.
- Stale ref → "ref `eN` is stale — re-read with `interceptor ios tree`."
- Secure-Enclave gate / locked device → a specific error, not a hang.

## Actuation primitives (InterceptorRunner)

The runner drives the foreground app via **public XCUITest APIs** (`ios/InterceptorRunner/Sources/InterceptorRunnerUITests.swift`): taps/drags are screen-absolute `XCUICoordinate.tap()` / `press(forDuration:thenDragTo:)`, text is `XCUIApplication.typeText`, screenshots are `XCUIScreen.main.screenshot()`, hardware buttons are `XCUIDevice.press(_:)`, and the `tree` comes from `XCUIElementSnapshot`. `tree`/`find`/`inspect` **auto-target whatever app is on screen** — the runner resolves the foreground app via the private XCTest AX client (`ObjCSupport.m` `ICActiveApplicationBundleID`: `XCUIDevice.accessibilityInterface.activeApplications` → pid → `applicationMonitor.applicationProcessWithPID:` → `bundleID`). `app activate <bundleId>` still pins a specific app if you want.

## Getting InterceptorRunner onto a device (iOS 26)

1. Install Xcode, open Xcode → Settings → Accounts, and sign in with the Apple ID/team that should own the runner signing.
2. Run setup. Pass `--team` when Xcode has more than one team:
   ```
   interceptor ios setup <UDID-or-alias> --team <TEAM>
   ```
   The installed PKG includes `/Library/Application Support/Interceptor/ios/InterceptorRunner/InterceptorRunner.xcodeproj`; use `--project <xcodeproj>` only for development overrides.
3. Manual diagnostic build (same signing path setup uses internally):
   ```
   xcrun xcodebuild build-for-testing -project InterceptorRunner.xcodeproj -scheme InterceptorRunner \
     -destination "id=<UDID>" -allowProvisioningUpdates DEVELOPMENT_TEAM=<TEAM> -derivedDataPath /tmp/runner-dd
   ```
   By default, Xcode/CoreDevice owns the RemoteXPC tunnel, DDI, and `test-without-building` launch. Set `INTERCEPTOR_NO_XCODE=1` only for userspace-launch diagnostics.

### No cable
Pair the device over WiFi (Xcode → *Connect via network*, or `xcrun devicectl`), then unplug. `interceptor ios discover` shows each device's `transport` (USB/Network). The runner reaches the daemon over the LAN; **the Mac just stays on the same network** (it owns the `testmanagerd` session for the test's lifetime). A fully no-Mac, untethered app driving *other* apps is impossible on stock iOS (no third-party automation API)
