# PRD-10: Daemon Resilience — Self-Healing Standalone Daemon Architecture

**Goal:** Eliminate daemon death as a failure mode. The daemon must survive Chrome's native messaging lifecycle, extension service worker termination, and network disconnects. An AI agent should never encounter "daemon not running" during a session.

**Scope:** `daemon/index.ts`, `cli/index.ts`, `extension/src/background.ts`, `shared/platform.ts`. No new binaries or dependencies. Changes are to existing components only.

**Non-Negotiable:** The daemon must stay alive independently of Chrome. The CLI must auto-recover from daemon death. The extension must reconnect transparently. Zero agent-facing downtime.

---

## Evidence Sources

| ID | Source | Path |
|----|--------|------|
| CHR-NM | Chrome native messaging | `80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/native-messaging.md` |
| CHR-SW-LIFE | Service worker lifecycle | `80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/service-workers/lifecycle.md` |
| CHR-SW-EVENTS | Service worker events | `80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/service-workers/events.md` |
| CLAUDE-ARCH | Claude in Chrome core architecture | `80_Reference/research/ClaudeExtension/06_Core_Architecture.md` |
| CLAUDE-MCP | Claude Code MCP server source | `Agent_Tools/claude-code-leak/src/utils/claudeInChrome/mcpServer.ts` |
| CLAUDE-COMMON | Claude Code socket/common utilities | `Agent_Tools/claude-code-leak/src/utils/claudeInChrome/common.ts` |
| SLOP-LOG | Daemon death log from session 2026-04-04 | `/tmp/slop-browser.log` |

---

## The Problem

### Observed Failure

During a live browsing session on 2026-04-04, the slop daemon died mid-session while browsing hackervalley.com. The agent attempted `slop navigate` and received "daemon not running (stale transport cleaned up)." The session was interrupted and required manual intervention.

**Root cause from SLOP-LOG:**
```
[2026-04-04T18:55:26.626Z] stdin ended (native port disconnected) — keeping daemon alive for socket/ws clients
```

The daemon received Chrome's stdin EOF signal, attempted to survive using a `/dev/null` reader hack, but still died. The Bun runtime exited despite active `Bun.listen` (socket) and `Bun.serve` (WS) servers.

### Why It Dies

The daemon's lifecycle is structurally coupled to Chrome's native messaging stdin pipe:

1. **Chrome spawns daemon** — The extension calls `connectNative("com.slopbrowser.host")`, Chrome launches `slop-daemon` with stdin/stdout piped for native messaging [CHR-NM].
2. **Chrome disconnects stdin** — Chrome terminates the native messaging pipe periodically, or when the service worker is killed.
3. **Service worker termination is aggressive** — "Chrome terminates a service worker... after 30 seconds of inactivity" [CHR-SW-LIFE]. When the service worker dies, the native port disconnects, sending EOF to the daemon's stdin.
4. **Bun exits on empty event loop** — Despite `Bun.listen` and `Bun.serve` holding open servers, the compiled Bun binary may exit when stdin closes and no active I/O references remain.

The existing `/dev/null` reader and `keepAliveForever()` mitigations are fragile. The daemon survived some disconnects but not all.

### Structural Comparison With Claude Code

Claude Code's architecture avoids this problem entirely:

| | slop-browser (current) | Claude Code |
|---|---|---|
| **Who starts the daemon** | Chrome via `connectNative()` | CLI starts its own MCP server process [CLAUDE-MCP] |
| **CLI ↔ Extension transport** | CLI → daemon (native msg) → extension | CLI → **Unix socket** → extension [CLAUDE-COMMON] |
| **Daemon lifecycle owner** | Chrome (tied to native messaging stdin) | CLI process (independent of Chrome) |
| **Socket path** | `/tmp/slop-browser.sock` (single global) | `/tmp/claude-mcp-browser-bridge-{user}/{pid}.sock` (per-process) [CLAUDE-COMMON] |
| **Extension connection** | Native messaging + WS fallback | Native messaging OR WebSocket bridge to Anthropic cloud [CLAUDE-ARCH §6.8] |

**Key insight from CLAUDE-MCP:** Claude Code's MCP server is NOT the native messaging host. The native messaging host is a separate concern for extension-to-Desktop communication. The CLI's MCP server creates its own Unix socket and the extension connects to it as a client. This means the CLI process is never killed by Chrome's native messaging lifecycle.

**Key insight from CLAUDE-COMMON:**
```typescript
export function getSecureSocketPath(): string {
  if (platform() === 'win32') {
    return `\\\\.\\pipe\\${getSocketName()}`
  }
  return join(getSocketDir(), `${process.pid}.sock`)
}
```
Each Claude Code process gets its own socket. The extension scans a directory of `.sock` files to find active servers [CLAUDE-COMMON: `getAllSocketPaths()`]. This eliminates the single-socket contention problem.

### Chrome Native Messaging Lifecycle Facts

From CHR-NM:
- "Chrome starts the host in a separate process and communicates with it using standard input and standard output streams."
- "When a messaging port is created using `runtime.connectNative()`, Chrome starts native messaging host process and keeps it running until the port is destroyed."
- The port is destroyed when the service worker terminates, which happens after 30s of inactivity [CHR-SW-LIFE].

From CHR-SW-LIFE:
- "Chrome terminates a service worker when one of the following conditions is met: After 30 seconds of inactivity."
- "Connecting to a native messaging host using `chrome.runtime.connectNative()` will keep a service worker alive. If the host process crashes or is shut down, the port is closed and the service worker will terminate after timers complete." [Chrome 105+]
- "Active WebSocket connections now extend extension service worker lifetimes." [Chrome 116+]

This creates a **circular dependency**: the daemon keeps the service worker alive via native messaging, but the service worker keeps the native messaging pipe alive via `connectNative()`. If either side drops, both can cascade.

From CLAUDE-ARCH §6.1.2:
- "Under MV3, the service worker has no persistent DOM and no guaranteed uptime."
- "Connection objects are ephemeral. The native messaging port and the WebSocket bridge connection must be re-established after each restart."
- Claude's extension tracks connection state with module-level variables that "reset to `null`/`false` on restart" and uses `chrome.alarms` for scheduled reconnection.

---

## Architecture: Standalone Daemon With Auto-Spawn

### Design Principles

1. **The daemon owns its own lifecycle.** It is not spawned by Chrome. It runs as an independent background process.
2. **The CLI auto-spawns the daemon.** If the daemon is dead when a CLI command runs, the CLI starts it as a detached process.
3. **The extension connects TO the daemon** via WebSocket, not the other way around.
4. **Native messaging is optional.** When Chrome spawns the daemon via native messaging, it operates in dual mode. But the daemon survives stdin EOF.
5. **Messages queue when no extension is connected.** The daemon buffers outbound messages and drains them when the extension's WS channel registers.

### Message Flow (New)

```
Agent → CLI (dist/slop) → Unix socket → Daemon → WebSocket → Extension → Chrome APIs → Response
                                            ↑
                                 auto-spawned by CLI
                                 survives independently
```

### Daemon Two Modes

| Mode | Trigger | stdin | WS | Socket |
|------|---------|-------|----|--------|
| **Standalone** | CLI runs `slop-daemon --standalone` | Ignored | ✓ (primary transport) | ✓ |
| **Native messaging** | Chrome calls `connectNative()` | Active (reads native messages) | ✓ (fallback + bridge) | ✓ |

In both modes, the daemon runs socket + WS servers and stays alive via `keepAliveForever()`. The only difference is whether stdin is read.

### Extension Response Routing

**Problem:** When both native messaging and WS are connected, the extension sends responses on whatever transport `sendToHost()` picks — typically native messaging (preferred). But in standalone mode, the daemon's native messaging stdout goes nowhere.

**Solution:** Per-request transport tagging. When a message arrives via WS, the extension tags it with `_viaWs = true` and responds on the same transport.

This is grounded in Claude's approach from CLAUDE-ARCH §6.4.5: Claude's extension routes tool responses back through the same native messaging port that delivered the `tool_request`. Our extension must do the same — respond on the transport that delivered the request.

---

## Implementation Phases

### Phase 1: Standalone Daemon Mode (P0)

**Files:** `daemon/index.ts`

**Work items:**
- [x] 1.1: Add `--standalone` CLI flag parsed from `process.argv`
- [x] 1.2: In standalone mode, skip all stdin reading (`process.stdin.on("data")`, `.on("end")`, `.resume()`)
- [x] 1.3: When `sendNativeMessage()` is called in standalone mode with no WS connected, queue the message instead of writing to stdout
- [x] 1.4: Implement outbound WS queue with cap (50 messages) — oldest evicted on overflow
- [x] 1.5: Drain queue automatically when extension WS channel registers (`type: "extension"`)
- [x] 1.6: In standalone mode, `sendNativeMessage()` must NEVER write to stdout (no native messaging host process stdout in standalone)
- [x] 1.7: When native messaging stdin ends (browser-spawned mode), fall back to WS-only mode instead of dying — set `stdinAlive = false` and queue subsequent messages for WS
- [x] 1.8: `keepAliveForever()` infinite async loop (`while (true) { await Bun.sleep(10_000) }`) as the definitive event-loop anchor

**Acceptance criteria:**
- [x] `daemon/slop-daemon --standalone` starts, binds socket + WS, writes PID file, and stays alive indefinitely
- [x] CLI commands work through standalone daemon when extension is connected via WS
- [x] Killing and restarting the daemon does not leave stale sockets (PID check + cleanup on startup)
- [x] Messages sent before extension WS connects are queued and delivered when it does

### Phase 2: CLI Auto-Spawn (P0)

**Files:** `cli/index.ts`

**Work items:**
- [x] 2.1: Check daemon liveness: read PID file → `process.kill(pid, 0)` → alive/dead
- [x] 2.2: When daemon is dead, clean up stale socket + PID files
- [x] 2.3: Locate `slop-daemon` binary via candidate path search (relative to CLI binary, relative to cwd, `../daemon/`, `./daemon/`)
- [x] 2.4: Spawn daemon as detached background process: `Bun.spawn([daemonPath, "--standalone"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })` + `child.unref()`
- [x] 2.5: Poll for socket readiness (250ms intervals, up to 5s timeout)
- [x] 2.6: If daemon binary not found, fall back to clear error message
- [x] 2.7: Print `"daemon not running — spawning..."` to stderr during auto-spawn (agent sees this context)

**Acceptance criteria:**
- [x] `slop tabs` with no running daemon: auto-spawns daemon, waits for socket, then executes command
- [x] Subsequent commands reuse the already-running daemon (no re-spawn)
- [x] `pkill slop-daemon && slop tabs` recovers automatically within 5s
- [x] Error message is clear when binary is missing

### Phase 3: Extension Per-Request Transport Routing (P0)

**Files:** `extension/src/background.ts`

**Work items:**
- [x] 3.1: In WS `onmessage` handler, tag incoming messages with `msg._viaWs = true` before passing to `handleDaemonMessage()`
- [x] 3.2: Store `viaWs` flag in `pendingRequests` map alongside existing `action`, `tabId`, `timestamp`, `timer`
- [x] 3.3: Add `forceWs` optional parameter to `sendToHost(msg, forceWs?)` — when true, send via WS regardless of `activeTransport`
- [x] 3.4: All response `sendToHost()` calls in `handleDaemonMessage()` pass the request's `viaWs` flag as `forceWs`
- [x] 3.5: Timeout and error responses also respect the `viaWs` flag from `pendingRequests`
- [x] 3.6: Duplicate request rejection respects the flag

**Acceptance criteria:**
- [x] Request arriving via WS gets response via WS, even when native messaging is also connected
- [x] Request arriving via native messaging gets response via native messaging
- [x] Extension works correctly in both standalone-daemon and browser-spawned-daemon scenarios
- [x] No response "leaks" to the wrong transport

### Phase 4: `slop status` Local Diagnostic (P1)

**Files:** `cli/index.ts`

**Work items:**
- [x] 4.1: `slop status` bypasses daemon connectivity check entirely (no socket connection)
- [x] 4.2: Check PID file existence and process liveness via `process.kill(pid, 0)`
- [x] 4.3: Check socket file existence
- [x] 4.4: Report daemon state, PID, socket path, transport in plain text
- [x] 4.5: `--json` mode returns structured JSON
- [x] 4.6: When daemon is not running, print helpful hint about auto-spawn behavior
- [x] 4.7: Remove "Check extension connection with 'slop status'" from timeout error messages — replace with actionable message

**Acceptance criteria:**
- [x] `slop status` never fails, never connects to daemon, always returns useful info
- [x] Agents can run `slop status` without triggering error cascades
- [x] Timeout errors no longer recommend `slop status` (breaks agent loops)

### Phase 5: README & CLAUDE.md Agent Documentation (P1)

**Files:** `README.md`, `CLAUDE.md`, `~/.pi/agent/skills/slop/SKILL.md`

**Work items:**
- [x] 5.1: README leads with Quick Start: `slop tab new <url>` → `sleep 2` → `slop tree` → interact
- [x] 5.2: README documents slop group behavior — default sandbox, `--any-tab` escape hatch
- [x] 5.3: README documents auto-spawn — "daemon starts automatically on first command"
- [x] 5.4: README Agent Rules section: always start with `tab new`, never run `status` as pre-flight, use `tree` not screenshots, wait after navigation
- [x] 5.5: CLAUDE.md updates daemon lifecycle section to document standalone mode
- [x] 5.6: CLAUDE.md removes old "browser spawns daemon" as sole path — documents both modes
- [x] 5.7: SKILL.md removes contradictory "check status if timeouts" advice
- [x] 5.8: SKILL.md adds slop group explanation and `--any-tab` flag

**Acceptance criteria:**
- [x] An agent reading README.md knows exactly how to start a session and interact with pages
- [x] No documentation recommends `slop status` as a pre-flight check
- [x] Daemon auto-spawn behavior is documented in all three files
- [x] Slop group sandboxing is documented with escape hatch

### Phase 6: Window Create Tab Group Fix (P1)

**Files:** `extension/src/background.ts`

**Work items:**
- [x] 6.1: `window_create` handler adds first tab to slop group via `addTabToSlopGroup()`
- [x] 6.2: Return `groupId` in window create response
- [x] 6.3: Skip group assignment for incognito windows

**Acceptance criteria:**
- [x] `slop window new "https://example.com"` creates a window with the tab in the slop group
- [ ] `slop window new --incognito "https://example.com"` does NOT attempt group assignment *(Brave doesn't support extension tab groups in incognito)*
- [x] Consistent behavior between `tab new` and `window new` *(code verified)*

---

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Dual daemon (browser + CLI both spawn) | Medium | Commands route to wrong daemon, timeouts | PID file check before spawn; port 19222 bind fails for second daemon |
| Extension WS reconnect delay | Medium | First command after daemon restart times out | Queue + drain pattern; 15s timeout accommodates reconnect |
| Bun compiled binary event loop empty | Low (mitigated) | Daemon exits unexpectedly | `keepAliveForever()` infinite async loop is definitive anchor |
| CLI can't find daemon binary | Low | Auto-spawn fails | Multi-path candidate search; clear error message as fallback |
| Chrome 116+ WS keepalive extends service worker | N/A (beneficial) | Service worker stays alive longer when WS is active | Works in our favor — active WS to daemon keeps SW alive [CHR-SW-LIFE] |

---

## Success Metrics

1. **Zero "daemon not running" errors during agent sessions** — the daemon either survives or auto-recovers within one command cycle
2. **Agent session continuity** — an agent can browse for 30+ minutes without daemon interruption
3. **Cold start latency < 6s** — from dead daemon to first successful command response
4. **Extension reconnect transparent** — agent never sees WS/native transport details, just command results
