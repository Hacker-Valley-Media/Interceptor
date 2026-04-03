# slop-browser

Agent-driven Chrome extension with CLI bridge. Gives AI agents full browser control without CDP, MCP, or API keys. The agent IS the LLM — slop-browser is a dumb actuator.

## Architecture

```text
macOS:   Agent → CLI (dist/slop) → Unix socket → Daemon → Native Messaging / WebSocket → Chrome Extension
Windows: Agent → CLI (dist/slop.exe) → TCP loopback → Daemon → Native Messaging / WebSocket → Chrome Extension
```

Three components, one data flow:
- **CLI** (`cli/index.ts`) — Stateless client. Uses Unix sockets on macOS and TCP loopback on Windows.
- **Daemon** (`daemon/index.ts`) — Local IPC server + Chrome native messaging bridge + WebSocket bridge. Usually spawned by the browser.
- **Extension** (`extension/src/`) — MV3 Chrome extension. Background service worker routes messages; content script executes DOM actions.

Platform-specific transport config lives in `shared/platform.ts`.

## Build

```bash
bun run build                    # Build extension + host-platform CLI + host-platform daemon
bash scripts/build.sh            # Same as above
bash scripts/build.sh --target=macos
bash scripts/build.sh --target=windows
bash scripts/build.sh --all
```

Individual builds:
```bash
bun build extension/src/background.ts --outdir=extension/dist --target=browser
bun build extension/src/content.ts --outdir=extension/dist --target=browser
bun build cli/index.ts --compile --outfile=dist/slop
bun build daemon/index.ts --compile --outfile=daemon/slop-daemon
```

Cross-platform examples:
```bash
bun build cli/index.ts --compile --target=bun-windows-x64 --outfile=dist/slop.exe
bun build daemon/index.ts --compile --target=bun-windows-x64 --outfile=daemon/slop-daemon.exe
bun build cli/index.ts --compile --target=bun-darwin-arm64 --outfile=dist/slop
bun build daemon/index.ts --compile --target=bun-darwin-arm64 --outfile=daemon/slop-daemon
```

## Run

```bash
bun run daemon                # Start daemon in dev mode
bun run cli -- <cmd>          # Run CLI in dev mode
./dist/slop <cmd>             # Run compiled macOS CLI
./dist/slop --ws <cmd>        # Force WebSocket transport
./daemon/slop-daemon          # Run compiled macOS daemon directly
```

Windows equivalents:
```powershell
.\dist\slop.exe <cmd>
.\dist\slop.exe --ws <cmd>
.\daemon\slop-daemon.exe
```

## Test

```bash
bun test
bun test test/daemon-cli.test.ts
```

Current test coverage verifies:
- PID file creation
- current-platform transport availability
- CLI connectivity to the daemon
- `os-input-loader` exports
- platform helper resolution for `darwin` and `win32`

## Tech Stack

- **Runtime:** Bun (TypeScript, no Node.js)
- **Extension:** Chrome Manifest V3
- **IPC:** Unix domain socket on macOS, TCP loopback on Windows, native messaging, and WebSocket fallback/bridge
- **Dependencies:** Zero runtime deps. Dev-only: `@types/bun`, `@types/chrome`

## Code Style

- TypeScript strict mode (`strict: true` in tsconfig)
- ES modules only (`"type": "module"`)
- No comments unless logic is non-obvious
- Extension builds target `browser`; CLI/daemon target Bun standalone binary

## Key Files

| File | Purpose |
|------|---------|
| `cli/index.ts` | CLI client — all commands defined here |
| `daemon/index.ts` | Native messaging bridge + local IPC server + WebSocket bridge |
| `daemon/os-input-loader.ts` | Platform-selecting OS-input module loader |
| `daemon/os-input.ts` | macOS CoreGraphics OS-input implementation |
| `daemon/os-input-win.ts` | Windows OS-input stub |
| `shared/platform.ts` | Shared transport/path configuration for macOS and Windows |
| `extension/src/background.ts` | Service worker — message routing, transport state machine, Chrome APIs |
| `extension/src/content.ts` | Content script — DOM extraction, action execution |
| `daemon/com.slopbrowser.host.json` | Native messaging manifest template |
| `scripts/build.sh` | Cross-platform build orchestrator |
| `scripts/install.sh` | macOS native-messaging installer |
| `scripts/install.ps1` | Windows native-messaging installer |
| `prd/PRD-9.md` | Cross-platform implementation PRD |

## Extension Installation

macOS:
```bash
bash scripts/install.sh
```

This generates `daemon/.generated/com.slopbrowser.host.json` and symlinks it into:
```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.slopbrowser.host.json
~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.slopbrowser.host.json
```

Windows:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

This generates the manifest and writes registry keys for:
```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.slopbrowser.host
HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.slopbrowser.host
```

## Message Protocol

CLI sends framed JSON to the daemon over the current platform transport:
```json
{"id": "uuid", "action": {"type": "click", "index": 5}}
```

Transport details:
- macOS CLI ↔ daemon: Unix socket
- Windows CLI ↔ daemon: TCP loopback (`127.0.0.1:19221` by default)
- daemon ↔ extension: native messaging and/or WebSocket bridge

Native messaging uses 4-byte little-endian length-prefixed JSON. WebSocket messages are plain JSON objects.

## Design Constraints

- No CDP — content scripts + Chrome extension APIs only (undetectable by websites)
- No internal agent loop — the calling agent drives all decisions
- No API keys or external services
- CLI returns plain text by default (LLM-optimized); `--json` for structured output
- Full event simulation for clicks/typing (realistic 6-event pointer sequence)
- Stateless CLI — no persistent connections or state between invocations

## Compiled Binaries

Host/macOS builds produce:
- `dist/slop`
- `daemon/slop-daemon`

Windows builds produce:
- `dist/slop.exe`
- `daemon/slop-daemon.exe`

`dist/` and `daemon/.generated/` are ignored. `daemon/slop-daemon` remains the checked-in host daemon binary; rebuild after code changes.

