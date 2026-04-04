# slop-browser

Give AI agents full browser control. No CDP, no MCP, no API keys. `slop` is a CLI — the agent calls it, reads the output, decides what to do next.

**Binary:** `dist/slop`

## Agent Quick Start

```bash
slop tab new "https://example.com"    # Open managed tab
sleep 2                                # Wait for load
slop tree                              # See interactive elements
slop click e1                          # Click by ref
slop type e2 "hello"                   # Type into field
slop text                              # Read visible text
slop net log                           # See all network traffic
```

## Core Commands

### Page Interaction
```bash
slop tree                              # Interactive elements with refs (e1, e2...)
slop tree --filter all                 # Include headings + landmarks
slop click e5                          # Click element
slop click e5 --os                     # OS-level trusted click (bypasses isTrusted checks)
slop type e3 "text"                    # Type into field (clears first)
slop type e3 "text" --append           # Append without clearing
slop text                              # All visible text
slop text e7                           # Text from specific element
slop diff                              # What changed since last tree/state
slop find "Submit"                     # Find elements by name
slop find "Submit" --role button       # Filter by ARIA role
```

### Navigation
```bash
slop tab new "https://example.com"     # New managed tab (in slop group)
slop navigate "https://example.com"    # Navigate current tab
slop tabs                              # List all tabs
slop tab switch 12345                  # Switch to tab by ID
slop back                              # History back
slop scroll down                       # Scroll page
```

### Passive Network Capture (always-on, no CDP)
All fetch/XHR traffic is intercepted automatically on every page. No setup required.
```bash
slop net log                           # All captured traffic
slop net log --filter linkedin.com     # Filter by URL substring
slop net log --filter voyager          # API calls only
slop net log --since 1700000000000     # After timestamp
slop net clear                         # Flush buffer
slop net headers                       # Captured request headers (CSRF, auth)
slop net headers --filter linkedin     # Filter headers by URL
```

### CDP Network (explicit opt-in — shows debugger bar)
```bash
slop network on                        # Attach debugger, start capture
slop network log                       # Print CDP-captured requests
slop network off                       # Detach debugger
slop network override on '[rules]'     # Rewrite requests before they leave browser
```

### LinkedIn Extraction
```bash
slop linkedin event <url>              # Full event extraction (passive capture, no CDP)
slop linkedin event <url> --wait 3000  # Custom wait for slow pages
slop linkedin attendees <url>          # Attendee extraction with modal + API
```

### Screenshots & Canvas
```bash
slop screenshot                        # Viewport JPEG (data URL)
slop screenshot --full                 # Full-page scroll+stitch
slop screenshot --save                 # Save to disk
slop canvas list                       # Discover canvas elements
slop canvas read 0                     # Read canvas pixels
```

### JavaScript & Data
```bash
slop eval "document.title"             # Run JS (ISOLATED world)
slop eval "window.foo" --main          # Run JS (MAIN world — page context)
slop cookies example.com               # List cookies
slop storage                           # Read localStorage
```

## Key Patterns

### The Slop Group
Every `tab new` and `window new` adds tabs to a cyan "slop" group. Commands only work on tabs in this group by default. Use `--any-tab` to break out.

### Passive Network — How It Works
`inject-net.ts` runs in every page's MAIN world at `document_start`. It monkey-patches `fetch()` and `XMLHttpRequest`, cloning every response and emitting it as a `CustomEvent`. The content script buffers these (ring buffer, cap 500). Background queries the buffer on demand.

```
Page calls fetch()/XHR → inject-net.ts clones response → CustomEvent → content.ts buffer → slop net log
```

No CDP. No debugger. No infobanner. No race conditions.

### Trusted Events (OS-Level Input)
For sites that check `event.isTrusted`, use `--os` flag. This routes through CoreGraphics CGEvent (macOS) — genuinely trusted kernel-level input.
```bash
slop click e5 --os                     # Trusted click
slop type e3 "text" --os               # Trusted keystrokes
slop keys "Control+A" --os             # Trusted keyboard shortcut
```

---

## Architecture

```text
macOS:   Agent → CLI (dist/slop) → Unix socket → Daemon → Native Messaging / WebSocket → Chrome Extension
Windows: Agent → CLI (dist/slop.exe) → TCP loopback → Daemon → Native Messaging / WebSocket → Chrome Extension
```

Three components:
- **CLI** (`cli/index.ts`) — Stateless client. Each command opens a socket, sends, receives, exits.
- **Daemon** (`daemon/index.ts`) — IPC server + Chrome native messaging + WebSocket bridge. Auto-spawned by CLI.
- **Extension** (`extension/src/`) — MV3 Chrome extension. Three scripts:
  - `inject-net.ts` — MAIN world, `document_start`. Passive fetch/XHR capture.
  - `content.ts` — ISOLATED world, `document_idle`. DOM interaction, net buffer, action execution.
  - `background.ts` — Service worker. Message routing, Chrome APIs, LinkedIn extraction.

## Build

```bash
bun run build                    # Full build (extension + CLI + daemon)
bash scripts/build.sh            # Same
bash scripts/build.sh --all      # All platforms
```

Individual:
```bash
bun build extension/src/background.ts --outdir=extension/dist --target=browser
bun build extension/src/content.ts --outdir=extension/dist --target=browser
bun build extension/src/inject-net.ts --outdir=extension/dist --target=browser
bun build cli/index.ts --compile --outfile=dist/slop
bun build daemon/index.ts --compile --outfile=daemon/slop-daemon
```

## Test

```bash
bun test
```

## Key Files

| File | Purpose |
|------|---------|
| `cli/index.ts` | CLI — all commands |
| `daemon/index.ts` | IPC server + native messaging + WebSocket bridge |
| `extension/src/inject-net.ts` | MAIN world — passive fetch/XHR interception |
| `extension/src/content.ts` | ISOLATED world — DOM, actions, net buffer |
| `extension/src/background.ts` | Service worker — routing, Chrome APIs, LinkedIn |
| `extension/src/linkedin/` | LinkedIn extraction pipeline (29 files) |
| `shared/platform.ts` | Cross-platform transport config |
| `scripts/build.sh` | Build orchestrator |

## Code Style

- TypeScript strict, ES modules only
- No comments unless non-obvious
- Extension: `--target browser`. CLI/daemon: Bun standalone binary.
- Zero runtime deps

## Design Constraints

- No CDP for default operations — content scripts + Chrome APIs only
- No internal agent loop — the calling agent drives all decisions
- No API keys or external services
- CLI returns plain text by default; `--json` for structured output
- Stateless CLI — no persistent connections between invocations

## Daemon Lifecycle

Auto-spawns on first command. Stays alive indefinitely. Kill with `pkill slop-daemon` — next command respawns it.

```bash
cat /tmp/slop-browser.log     # Daemon log
cat /tmp/slop-browser.pid     # PID + transport
ls /tmp/slop-browser.sock     # Socket alive check
slop status                   # Local diagnostic (no daemon connection needed)
```

## Extension Installation

macOS: `bash scripts/install.sh`
Windows: `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1`
