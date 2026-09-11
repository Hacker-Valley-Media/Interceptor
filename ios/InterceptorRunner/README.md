# InterceptorRunner

Interceptor's own minimal **XCUITest runner** — the on-device agent that drives
any installed app on an owned, Developer-Mode iPhone. It **replaces WebDriverAgent**
: instead of WDA's 45k-LOC WebDriver HTTP server, this is a few hundred
lines of Swift we own, driving the foreground app via **public XCUITest APIs**
(`XCUICoordinate`, `XCUIApplication`, `XCUIScreen`, `XCUIElementSnapshot`).

It **dials OUT** to the Interceptor daemon over a WebSocket and answers verb frames —
the same "device dials in" model the browser extension and the macOS `runtime:`
agent use. No HTTP server, no CocoaHTTPServer, no usbmux port-forward.

## What it is

- A single never-ending UI test (`InterceptorRunnerUITests.testRunner`) keeps the
  XCUITest/`testmanagerd` session alive (the same trick WDA uses) while a
  `URLSessionWebSocketTask` connects to the daemon and dispatches verbs.
- The daemon retains the `xcodebuild` process and WebSocket channel after
  registration. The runner has no 30-second lease; later verbs reuse it until
  the socket closes or the device is disabled.
- **Capability-blind:** this directory contains **source only** — no signing
  identity, team, or provisioning. You sign it with your own Apple Developer team,
  exactly as you would WebDriverAgent.

## Connection env (injected by the daemon at launch)

| Var | Meaning |
|---|---|
| `INTERCEPTOR_WS_URL` | `ws://<mac-ip>:19222` — the daemon's WebSocket |
| `INTERCEPTOR_WS_TOKEN` | per-session (or shared) pairing token |
| `INTERCEPTOR_UDID` | this device's udid |
| `INTERCEPTOR_CONTEXT_ID` | `ios:<udid>` |

The daemon injects these into the `.xctestrun` at launch (the only point env
reaches an on-device test process).

## Generate the Xcode project

```bash
brew install xcodegen          # one-time
cd ios/InterceptorRunner
xcodegen generate              # writes InterceptorRunner.xcodeproj
```

## Build + run

**Supported product path**: configure an Apple Developer team in Xcode, then let
Interceptor build, validate, install, and launch the device-specific runner:

```bash
interceptor ios setup <UDID> --team <YOUR_TEAM_ID>
```

Xcode owns automatic signing, device registration, provisioning, the iOS 17+
tunnel, and the `test-without-building` session. The installed bundle ID is
derived from the selected team and recorded for later launches.

The first install signed by a given Apple Development certificate may require
one on-device trust action before iOS will launch it: unlock the phone and go to
Settings → General → VPN & Device Management → Developer App → Trust. Interceptor
cannot bypass that device-local security decision.

**Prebuilt development override**: build a signed runner and point the daemon at
the build products directory. The daemon still owns launch and injects the
WebSocket environment into the `.xctestrun`:

```bash
xcrun xcodebuild build-for-testing \
  -project InterceptorRunner.xcodeproj -scheme InterceptorRunner \
  -destination "id=<UDID>" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<YOUR_TEAM_ID> -derivedDataPath /tmp/runner-dd
export INTERCEPTOR_RUNNER_DIR="/tmp/runner-dd/Build/Products/Debug-iphoneos"
interceptor ios enable <UDID> --yes
```

**Manual diagnostic**: Xcode's `test-without-building` path is the default.
Set `INTERCEPTOR_NO_XCODE=1` only to exercise Interceptor's experimental
userspace CoreDeviceProxy/testmanagerd launcher.

## No cable

Pair the device over WiFi (Xcode → device → *Connect via network*, or
`xcrun devicectl`), then unplug. The runner reaches the daemon over the LAN and
the daemon launches the test over the paired device through Xcode/CoreDevice.
**the Mac just has to stay on the same network** because it owns the
`testmanagerd` session for the test's lifetime.

## Verb protocol (daemon ⇄ runner)

```
daemon → runner : { id, op, ...args }     op ∈ source|screenshot|windowSize|tap|drag|keys|press|app|ping
runner → daemon : { id, result: { success, data?, error? } }
register        : { type:"ios", udid, token, contextId }   (runner → daemon, once)
```

`tree`/`find`/`inspect` **auto-target the foreground app** (resolved via the private
XCTest AX client in `ObjCSupport.m`). `app activate <bundleId>` pins a specific app if needed.
