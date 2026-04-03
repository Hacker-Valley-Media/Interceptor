# PRD-9: Cross-Platform Compatibility (macOS + Windows)

> Make slop-browser run on both macOS and Windows without regressing any existing macOS features.

## Context

PR #1 (`windows-support` branch by Ivan Mendoza) attempted to add Windows support but introduced a macOS regression and left Windows support incomplete. This PRD defines the correct path to dual-platform compatibility.

### What PR #1 got right
- Platform-conditional path selection via `process.platform === "win32"` in CLI and daemon
- WebSocket bridge concept for extension ↔ daemon communication when native messaging is unreliable
- Windows native messaging manifest (`com.slopbrowser.host.win.json`)
- `os-input-win.ts` stub as a placeholder for future Windows OS-level input

### What PR #1 got wrong
- **macOS regression**: `daemon/index.ts` unconditionally imports `./os-input-win` instead of `./os-input`, breaking all OS-level trusted input on macOS (`os_click`, `os_key`, `os_type`, `os_move`)
- **Windows IPC unproven**: Uses `\\.\pipe\slop-browser` via Bun's `unix:` socket parameter — no documentation confirms Bun supports Windows named pipes through this API
- **Windows manifest not portable**: Hardcoded path `C:\Users\Ivan\Downloads\slop-browser-main\...`
- **Tests not platform-aware**: `test/daemon-cli.test.ts` hardcodes `/tmp/` paths
- **Build script macOS-only**: `scripts/build.sh` produces only a macOS arm64 binary
- **Extension bundles committed with regression**: `extension/background.js` and `extension/content.js` were rebuilt from the regressed source

## Goals

1. Restore and preserve all existing macOS features — zero regressions
2. Add Windows support for CLI, daemon, and extension communication
3. Cross-compile build pipeline producing platform-specific binaries
4. Platform-aware test suite
5. Automated native messaging manifest installation per platform

## Non-Goals

- Linux support (future PRD)
- Implementing Windows OS-level input via `user32.dll` FFI (future PRD; stub is acceptable)
- Changing the extension's MV3 manifest or permissions
- Brave-specific workarounds beyond the WebSocket fallback

---

## Architecture Decisions

Each decision is grounded in evidence from local reference documentation.

### AD-1: Platform-conditional OS input module

**Decision**: Use dynamic `await import()` at daemon startup to load the correct OS input module based on `process.platform`.

**Evidence**:
- `daemon/os-input.ts` uses `bun:ffi` + `dlopen` on `/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics` — this path only exists on macOS
- Bun FFI docs (`/Volumes/VRAM/80-89_Resources/80_Reference/docs/bun/docs/runtime/ffi.md`): "`bun:ffi` … works with languages that support the C ABI (Zig, Rust, C/C++, C#, Nim, Kotlin, etc)." The `dlopen` call is platform-specific by nature — it loads `.dylib` on macOS, `.dll` on Windows
- PR #1's unconditional `import ... from "./os-input-win"` replaces the macOS module globally, which is why `os_click`/`os_key`/`os_type`/`os_move` all return `{ success: false, error: "not supported on Windows" }` even on macOS

**Implementation**: A thin `os-input-loader.ts` that does:
```ts
const IS_WIN = process.platform === "win32"
const mod = IS_WIN
  ? await import("./os-input-win")
  : await import("./os-input")
export const { osClick, osKey, osType, osMove, generateBezierPath, translateCoords } = mod
```

### AD-2: IPC transport — Unix domain sockets (macOS) / TCP loopback (Windows)

**Decision**: Keep Unix domain sockets on macOS. Use TCP loopback (`127.0.0.1:<port>`) on Windows instead of named pipes.

**Evidence**:
- Bun TCP docs (`/Volumes/VRAM/80-89_Resources/80_Reference/docs/bun/docs/runtime/networking/tcp.md`): `Bun.listen()` and `Bun.connect()` are documented with `hostname`/`port` parameters for TCP connections. Unix domain sockets use the `unix:` parameter.
- The Bun TCP docs do not document Windows named pipe support via `unix:`. PR #1 uses `\\.\pipe\slop-browser` with the `unix:` parameter — this is unproven.
- TCP loopback on `127.0.0.1` is universally supported and well-documented in Bun's TCP API. It adds negligible latency for local IPC.
- The daemon already runs a WebSocket server on port 19222 via `Bun.serve()`, confirming TCP networking works in this codebase.

**Implementation**: On Windows, `Bun.listen()` and `Bun.connect()` use `hostname: "127.0.0.1", port: <SLOP_PORT>` instead of `unix: SOCKET_PATH`.

### AD-3: WebSocket bridge as Windows extension transport

**Decision**: Keep the WebSocket bridge from PR #1 as the primary extension ↔ daemon transport on Windows. Native messaging remains primary on macOS.

**Evidence**:
- Chrome native messaging docs (`/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/native-messaging.md`): "On Windows, the manifest file can be located anywhere in the file system. The application installer must create a registry key… and set the default value of that key to the full path to the manifest file."
- Same docs, Windows I/O warning: "Make sure that the program's I/O mode is set to `O_BINARY`. By default, the I/O mode is `O_TEXT`, which corrupts the message format as line breaks (`\n` = `0A`) are replaced with Windows-style line endings (`\r\n` = `0D 0A`)."
- PR #1 description: "native messaging host registration via the registry works but Brave doesn't reliably launch the daemon"
- CanIUse WebSockets (`/Volumes/VRAM/80-89_Resources/80_Reference/docs/CanIUse/docs/features/websockets.md`): 93.59% global support, full support in Chrome 16+, Edge 12+, Firefox 11+, Safari 7+
- CanIUse Service Workers (`/Volumes/VRAM/80-89_Resources/80_Reference/docs/CanIUse/docs/features/serviceworkers.md`): 92.4% global support, Chrome 45+, Safari 11.1+

The WebSocket approach is sound and avoids the `O_BINARY` I/O mode pitfall entirely.

**Implementation**: Extension background.ts attempts native messaging first. If the native host disconnects and a WebSocket connection to `ws://localhost:<WS_PORT>` succeeds, it becomes the active transport. On macOS, native messaging is expected to work and WebSocket is a fallback. On Windows, WebSocket is expected to be the primary path.

### AD-4: Cross-compile build pipeline

**Decision**: Extend `scripts/build.sh` to produce both macOS arm64 and Windows x64 binaries using Bun's `--target` flag.

**Evidence**:
- Bun executables docs (`/Volumes/VRAM/80-89_Resources/80_Reference/docs/bun/docs/bundler/executables.md`): Cross-compile targets table shows `bun-darwin-arm64`, `bun-windows-x64`, `bun-windows-x64-baseline`, and `bun-windows-arm64` are all supported.
- Same docs: "if no `.exe` extension is provided, Bun will automatically add it for Windows executables"
- Same docs, Windows-specific flags section: custom icon, metadata, and `hideConsole` are available for Windows `.exe` builds
- Current `scripts/build.sh` only runs `bun build cli/index.ts --compile --outfile=dist/slop` (host-only)

### AD-5: Native messaging manifest installation per platform

**Decision**: Provide a `scripts/install.sh` (macOS) and `scripts/install.ps1` (Windows) that handle manifest placement and registry setup.

**Evidence**:
- Chrome native messaging docs: macOS user-level path is `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.slopbrowser.host.json`
- Chrome native messaging docs: Windows requires registry key `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.slopbrowser.host` with value pointing to manifest JSON path
- Chrome native messaging docs: "On macOS and Linux, the path must be absolute. On Windows it can be relative to the directory containing the manifest file."
- Current setup uses a symlink to the repo's `daemon/com.slopbrowser.host.json`; this pattern extends to a scripted install

### AD-6: Extension connectionReady state machine

**Decision**: Refactor `connectionReady` into an explicit transport state: `"none" | "native" | "websocket"`. Never let one transport's disconnect handler clobber the other's active connection.

**Evidence**:
- Chrome extension service worker lifecycle docs (`/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/service-workers/lifecycle.md`): Extension service workers can be terminated and restarted by the browser. The `connectionReady` boolean from PR #1 is fragile — if native messaging disconnects while WebSocket is active, the reconnect loop could set `connectionReady = false` momentarily.
- PR #1 partially addressed this ("Not reset `connectionReady` on native host disconnect if the WebSocket channel is active") but used a boolean which has no concept of *which* transport is active.

---

## Phases

### Phase 1: Platform-Conditional OS Input (restore macOS, no regression)

- [x] 1.1 Create `daemon/os-input-loader.ts` that dynamically imports `./os-input` or `./os-input-win` based on `process.platform`
- [x] 1.2 Update `daemon/index.ts` to import from `./os-input-loader` instead of either concrete module
- [x] 1.3 Verify `os_click`, `os_key`, `os_type`, `os_move` work on macOS after the change (run daemon, send CLI commands)
- [x] 1.4 Verify `os-input-win.ts` stub loads without crash when `process.platform === "win32"` (unit test with mock)
- [x] 1.5 Verify existing integration tests pass: `bun test test/daemon-cli.test.ts`

### Phase 2: Platform-Aware IPC Transport

- [x] 2.1 Extract IPC constants into `shared/platform.ts`: socket path (macOS) vs TCP host/port (Windows), PID path, log path, events path
- [x] 2.2 Update `daemon/index.ts` to use `Bun.listen()` with `unix:` on macOS and `hostname`/`port` on Windows
- [x] 2.3 Update `cli/index.ts` to use `Bun.connect()` with `unix:` on macOS and `hostname`/`port` on Windows
- [x] 2.4 Define the TCP port for Windows IPC: default `19221` (separate from WebSocket port `19222`), configurable via `SLOP_IPC_PORT` env var
- [x] 2.5 Update PID file format to include transport type (`unix:/tmp/slop-browser.sock` or `tcp:127.0.0.1:19221`)
- [x] 2.6 Verify daemon starts and CLI connects on macOS (Unix socket path unchanged)
- [x] 2.7 Verify `bun test test/daemon-cli.test.ts` passes on macOS

### Phase 3: Extension Transport State Machine

- [x] 3.1 Replace `connectionReady: boolean` with `activeTransport: "none" | "native" | "websocket"` in `extension/src/background.ts`
- [x] 3.2 Refactor `connectNativeHost()` to set `activeTransport = "native"` on successful connection
- [x] 3.3 Refactor `connectWebSocket()` to set `activeTransport = "websocket"` on successful connection
- [x] 3.4 Guard `nativePort.onDisconnect`: only set `activeTransport = "none"` if `activeTransport === "native"`
- [x] 3.5 Guard WebSocket `onclose`: only set `activeTransport = "none"` if `activeTransport === "websocket"`
- [x] 3.6 Route outgoing messages through `activeTransport` — native messaging postMessage or WebSocket send
- [x] 3.7 Process `messageQueue` drain on any transport becoming active
- [x] 3.8 Add incoming message handler on WebSocket `onmessage` that calls `handleDaemonMessage()` for `{id, action}` payloads
- [x] 3.9 Rebuild extension bundles: `bun build extension/src/background.ts --outdir=extension/dist --target=browser` and `bun build extension/src/content.ts --outdir=extension/dist --target=browser`
- [x] 3.10 Verify macOS native messaging flow works end-to-end (load extension, start daemon, run CLI commands)

### Phase 4: WebSocket Bridge in Daemon

- [x] 4.1 Add `extensionWs` reference in daemon to track the extension's WebSocket connection
- [x] 4.2 Handle WebSocket `register` message from extension to store the `extensionWs` reference
- [x] 4.3 When daemon receives a CLI request and native messaging stdout is unavailable, forward via `extensionWs.send()`
- [x] 4.4 When daemon receives a WebSocket message with `{id, result}` from extension, route back to the pending CLI request
- [x] 4.5 Log transport used for each request: `log("forwarding via native")` or `log("forwarding via ws")`
- [x] 4.6 Graceful cleanup: clear `extensionWs` on WebSocket close
- [x] 4.7 Verify daemon logs show correct transport selection on macOS (should be "native")

### Phase 5: Cross-Compile Build Pipeline

- [x] 5.1 Update `scripts/build.sh` to accept an optional `--target` argument (default: host platform)
- [x] 5.2 Add `scripts/build.sh --target=windows` that runs `bun build cli/index.ts --compile --target=bun-windows-x64 --outfile=dist/slop.exe`
- [x] 5.3 Add `scripts/build.sh --target=windows` that also runs `bun build daemon/index.ts --compile --target=bun-windows-x64 --outfile=daemon/slop-daemon.exe`
- [x] 5.4 Add `scripts/build.sh --target=macos` that builds both `dist/slop` and `daemon/slop-daemon` for `bun-darwin-arm64`
- [x] 5.5 Add `scripts/build.sh --all` that builds for all supported targets
- [x] 5.6 Verify macOS build produces working `dist/slop` binary (run `./dist/slop status --json`)
- [x] 5.7 Verify Windows build produces `dist/slop.exe` and `daemon/slop-daemon.exe` files (file type check)

### Phase 6: Native Messaging Installation Scripts

- [x] 6.1 Create `scripts/install.sh` for macOS: symlinks `daemon/com.slopbrowser.host.json` to `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- [x] 6.2 Update `daemon/com.slopbrowser.host.json` to use a `__DAEMON_PATH__` placeholder, with `install.sh` performing `sed` replacement with the actual absolute path
- [x] 6.3 Create `scripts/install.ps1` for Windows: generates `com.slopbrowser.host.json` with correct path, writes registry key `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.slopbrowser.host`
- [x] 6.4 Add Brave browser support in install scripts: macOS Brave path is `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/`, Windows Brave registry is `HKEY_CURRENT_USER\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.slopbrowser.host`
- [x] 6.5 Remove hardcoded `com.slopbrowser.host.win.json` with Ivan-specific path; replace with template
- [x] 6.6 Verify `scripts/install.sh` works on macOS (check symlink exists at expected path)

### Phase 7: Platform-Aware Test Suite

- [x] 7.1 Extract test constants into shared platform helper: `SOCKET_PATH`, `PID_PATH` use same logic as `shared/platform.ts`
- [x] 7.2 Update `test/daemon-cli.test.ts` to use platform-aware paths
- [x] 7.3 Add test: daemon starts and writes PID file on current platform
- [x] 7.4 Add test: CLI connects to daemon on current platform
- [x] 7.5 Add test: `os-input-loader.ts` loads correct module for current platform
- [x] 7.6 Add test: platform constants resolve correctly for both `win32` and `darwin`
- [x] 7.7 Verify all tests pass on macOS: `bun test`

---

## File Changes Summary

| File | Action | Phase |
|------|--------|-------|
| `daemon/os-input-loader.ts` | Create | 1 |
| `daemon/os-input.ts` | Unchanged | — |
| `daemon/os-input-win.ts` | Keep from PR #1 | — |
| `daemon/index.ts` | Modify import, IPC transport, WS bridge | 1, 2, 4 |
| `shared/platform.ts` | Create | 2 |
| `cli/index.ts` | Use shared platform constants, TCP fallback | 2 |
| `extension/src/background.ts` | Transport state machine, WS handler | 3 |
| `extension/dist/background.js` | Rebuild | 3 |
| `extension/dist/content.js` | Rebuild | 3 |
| `scripts/build.sh` | Cross-compile support | 5 |
| `scripts/install.sh` | Create (macOS) | 6 |
| `scripts/install.ps1` | Create (Windows) | 6 |
| `daemon/com.slopbrowser.host.json` | Template with placeholder | 6 |
| `daemon/com.slopbrowser.host.win.json` | Remove; replaced by template | 6 |
| `test/daemon-cli.test.ts` | Platform-aware paths | 7 |
| `shared/platform.ts` | Used by tests | 7 |

## Verification Criteria

After all phases, the following must be true:

1. **macOS**: `bun test` passes, daemon starts on Unix socket, CLI connects, `os_click`/`os_key`/`os_type`/`os_move` work via CoreGraphics FFI, extension connects via native messaging
2. **Windows**: daemon starts on TCP loopback, CLI connects, `os_*` commands return stub errors (expected), extension connects via WebSocket bridge, native messaging manifest installable via PowerShell script
3. **Build**: `scripts/build.sh` produces macOS arm64 binaries; `scripts/build.sh --target=windows` produces Windows x64 binaries
4. **No regression**: every CLI command that worked on macOS before PR #1 still works identically after this PRD

## Reference Sources

| Source | Path | Used For |
|--------|------|----------|
| Bun cross-compile | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/bun/docs/bundler/executables.md` | AD-4: `--target` flags, supported platforms table |
| Bun TCP API | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/bun/docs/runtime/networking/tcp.md` | AD-2: `Bun.listen()`/`Bun.connect()` with hostname/port |
| Bun FFI | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/bun/docs/runtime/ffi.md` | AD-1: `dlopen` platform behavior |
| Bun WebSockets | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/bun/docs/runtime/http/websockets.md` | AD-3: server-side WebSocket support |
| Chrome native messaging | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/native-messaging.md` | AD-3, AD-5: manifest locations, registry, O_BINARY warning |
| Chrome service worker lifecycle | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/service-workers/lifecycle.md` | AD-6: termination/restart behavior |
| Chrome messaging | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/messaging.md` | AD-3: extension message passing patterns |
| CanIUse WebSockets | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/CanIUse/docs/features/websockets.md` | AD-3: 93.59% global support confirmation |
| CanIUse Service Workers | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/CanIUse/docs/features/serviceworkers.md` | AD-3: 92.4% global support confirmation |
| PR #1 | `https://github.com/Hacker-Valley-Media/slop-browser/pull/1` | Problem statement, existing work to preserve |
