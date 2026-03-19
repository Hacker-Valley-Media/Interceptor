# slop-browser

Agent-driven Chrome extension with CLI bridge. Gives AI agents full browser control without CDP, MCP, or API keys. The agent IS the LLM — slop-browser is a dumb actuator.

## Architecture

```
Agent → CLI (dist/slop) → Unix socket → Daemon → Native Messaging → Chrome Extension
```

Three components, one data flow:
- **CLI** (`cli/index.ts`) — Stateless socket client. Each invocation connects, sends, receives, exits.
- **Daemon** (`daemon/index.ts`) — Unix socket server + Chrome native messaging bridge. Spawned by Chrome.
- **Extension** (`extension/src/`) — MV3 Chrome extension. Background service worker routes messages; content script executes DOM actions.

## Build

```bash
bun run build          # Build all (extension + CLI binary)
```

Individual builds:
```bash
bun build extension/src/background.ts --outdir=extension/dist --target=browser
bun build extension/src/content.ts --outdir=extension/dist --target=browser
bun build cli/index.ts --compile --outfile=dist/slop
```

The daemon binary is built separately (not part of `bun run build`):
```bash
bun build daemon/index.ts --compile --outfile=daemon/slop-daemon
```

## Run

```bash
bun run daemon         # Start daemon in dev mode
bun run cli -- <cmd>   # Run CLI command in dev mode
./dist/slop <cmd>      # Run compiled CLI binary
```

## Test

```bash
bun test test/daemon-cli.test.ts
```

Integration tests only — verify daemon socket startup, PID file creation, CLI connectivity.

## Tech Stack

- **Runtime:** Bun (TypeScript, no Node.js)
- **Extension:** Chrome Manifest V3
- **IPC:** Unix domain socket + native messaging (4-byte length-prefixed JSON)
- **Dependencies:** Zero runtime deps. Dev-only: `@types/bun`, `@types/chrome`

## Code Style

- TypeScript strict mode (`strict: true` in tsconfig)
- ES modules only (`"type": "module"`)
- No comments unless logic is non-obvious
- Extension builds target `browser`; CLI/daemon target Bun standalone binary

## Key Files

| File | Purpose |
|------|---------|
| `cli/index.ts` | CLI client — all 50+ commands defined here |
| `daemon/index.ts` | Native messaging bridge + socket server |
| `extension/src/background.ts` | Service worker — message routing, Chrome APIs |
| `extension/src/content.ts` | Content script — DOM extraction, action execution |
| `extension/src/types.ts` | Shared type definitions |
| `daemon/com.slopbrowser.host.json` | Native messaging manifest |
| `scripts/build.sh` | Build orchestrator |
| `prd/PRD-1.md` | Product requirements document |

## Extension Installation

The native messaging manifest must be symlinked to Chrome's expected location:
```
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.slopbrowser.host.json
```

The manifest points to the daemon binary at the absolute path in this repo.

## Message Protocol

CLI sends JSON via Unix socket:
```json
{"id": "uuid", "action": {"type": "click", "index": 5}}
```

Daemon wraps in native messaging format (4-byte little-endian length prefix + JSON body) and forwards to the extension. Responses flow back the same path.

## Design Constraints

- No CDP — content scripts + Chrome extension APIs only (undetectable by websites)
- No internal agent loop — the calling agent drives all decisions
- No API keys or external services
- CLI returns plain text by default (LLM-optimized); `--json` for structured output
- Full event simulation for clicks/typing (realistic 6-event pointer sequence)
- Stateless CLI — no persistent connections or state between invocations

## Compiled Binaries

`dist/slop` and `daemon/slop-daemon` are ~55MB Bun-compiled arm64 Mach-O binaries. They are checked into the repo for convenience. Rebuild after code changes.

