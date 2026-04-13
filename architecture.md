# Architecture

## Top-Level Flow

`interceptor` follows a four-layer path:

1. `cli/` parses commands, global flags, and output formatting.
2. `extension/src/background/` owns routing, Chrome APIs, tab policy, transport selection, and background-only capability modules.
3. `extension/src/content/` owns DOM interaction, in-page buffers, scene profiles, semantic selectors, and action execution inside tabs.
4. `daemon/` owns native messaging, websocket fallback, OS-level trusted input, and event/log files.

## Runtime Surfaces

The repo intentionally spans multiple TypeScript runtime environments:

- **Bun host code**: `cli/**`, `daemon/**`, `shared/**`, `scripts/**`, `test/**`
- **Extension service worker / background**: `extension/src/background/**`
- **Content scripts and page-facing browser code**: `extension/src/content/**`
- **MAIN-world injected browser code**: `extension/src/inject-net.ts`

These surfaces do not share the same ambient globals. Bun host code relies on Bun runtime types and socket APIs, while extension code relies on DOM, Web Worker, and Chrome extension APIs.

## TypeScript Layout

The repo now uses runtime-aware TypeScript configs instead of a single mixed ambient environment:

- `tsconfig.base.json`
  - shared strict compiler rules
- `tsconfig.host.json`
  - Bun host code and tests
  - `types: ["bun"]`
- `tsconfig.extension.json`
  - browser and extension code under `extension/src/**`
  - `lib: ["ESNext", "DOM", "DOM.Iterable", "WebWorker"]`
  - `types: ["chrome"]`
- `tsconfig.json`
  - top-level strict repo check covering both host and extension code

This split restores real static checking without excluding the extension surface or weakening strict mode.

## File Map

### CLI

- `cli/index.ts` - main command dispatcher plus special-case orchestration for `chatgpt send` and `chatgpt read`
- `cli/help.ts` - global help text
- `cli/parse.ts` - shared target parsing for refs, indexes, and semantic selectors
- `cli/commands/*.ts` - command-family parsers
- `cli/transport.ts` - host-side daemon transport over Bun sockets and websocket fallback

### Background Extension

- `extension/src/background.ts` - startup wiring
- `extension/src/background/transport.ts` - native messaging plus websocket fallback
- `extension/src/background/message-dispatch.ts` - request lifecycle, active-tab lookup, interceptor-group enforcement
- `extension/src/background/router.ts` - action routing to background capabilities or content script
- `extension/src/background/tab-group.ts` - interceptor tab-group policy
- `extension/src/background/linkedin-orchestration.ts` - LinkedIn event and attendees flows
- `extension/src/background/capabilities/*.ts` - Chrome API and background-only capability handlers

### Content Script

- `extension/src/content.ts` - action multiplexer inside the page
- `extension/src/content/actions/*.ts` - click, type, scroll, hover, drag, focus, wait
- `extension/src/content/data/*.ts` - text/html extraction, query helpers, forms, storage, clipboard
- `extension/src/content/find.ts` - semantic lookup and `find_and_*` helpers
- `extension/src/content/net-buffer.ts` - passive fetch/XHR and SSE buffers exposed to the background
- `extension/src/content/monitor.ts` - monitor capture inside the page
- `extension/src/content/scene/engine.ts` - scene dispatcher and profile selection
- `extension/src/content/scene/profiles/*.ts` - editor-specific scene-graph logic

### Native Host And Shared Platform

- `daemon/index.ts` - native messaging server, websocket bridge, OS-event execution
- `daemon/os-input*.ts` - platform-specific trusted input
- `shared/platform.ts` - socket, PID, log, and events paths

## Verification Surfaces

Use the verification command that matches the change you made:

- `bun run typecheck`
  - strict static checking across Bun host code and extension code
- `bun test`
  - runtime tests and parser/helper coverage
- `bash scripts/build.sh`
  - compiled host binaries and extension bundle build

For changes that cross host/extension boundaries, touch transport, or modify Chrome API usage, run all three.

## Build Outputs

- `scripts/build.sh` builds the extension plus host binaries
- `dist/interceptor` is the compiled CLI on host and macOS target builds
- `daemon/interceptor-daemon` is the compiled daemon on host and macOS target builds
- `extension/dist/` is the unpacked extension directory to load or reload in Chrome/Brave
