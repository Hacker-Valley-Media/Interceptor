# PRD-3: Stability Hardening Phase 2 — Correctness, Safety, and Resilience

**Goal:** Eliminate the remaining stability gaps identified by comparing slop-browser against the Claude in Chrome extension reference implementation (v1.0.47), grounded in official Bun, Chrome Extension, and Claude Code documentation.

**Scope:** Fixes to existing files plus one new optional communication channel. PRD-2 addressed message transport, service worker lifecycle, request tracking, DOM state, tab scoping, observability, and graceful shutdown. This PRD covers what PRD-2 explicitly deferred or missed.

**Motivation:** PRD-2 hardened the happy-path pipeline. But 13 gaps remain that cause incorrect behavior (wrong element clicked, wrong keycode sent), silent hangs (CLI blocks forever on stale daemon), memory growth (unbounded queues), and security risks (TOCTOU on tab URLs). These were identified by reviewing the implemented PRD-2 code against the Claude in Chrome reference and re-validating against official documentation.

---

## Evidence Sources

| ID | Source | Path |
|----|--------|------|
| BUN-TCP | Bun TCP socket docs | `docs/bun/docs/runtime/networking/tcp.md` |
| BUN-HTTP | Bun HTTP server docs | `docs/bun/docs/runtime/http/server.md` |
| CHR-LIFE | Chrome SW lifecycle | `docs/chrome-extensions/docs/extensions/develop/concepts/service-workers/lifecycle.md` |
| CHR-NM | Chrome native messaging | `docs/chrome-extensions/docs/extensions/develop/concepts/native-messaging.md` |
| CHR-MSG | Chrome message passing | `docs/chrome-extensions/docs/extensions/develop/concepts/messaging.md` |
| CHR-TABS | Chrome tabs API | `docs/chrome-extensions/docs/extensions/reference/api/tabs.md` |
| CHR-TGRP | Chrome tab groups API | `docs/chrome-extensions/docs/extensions/reference/api/tabGroups.md` |
| CHR-ALRM | Chrome alarms API | `docs/chrome-extensions/docs/extensions/reference/api/alarms.md` |
| CHR-CS | Chrome content scripts | `docs/chrome-extensions/docs/extensions/develop/concepts/content-scripts.md` |
| CHR-STOR | Chrome storage | `docs/chrome-extensions/docs/extensions/develop/concepts/storage-and-cookies.md` |
| CC-CHR | Claude Code Chrome integration | `docs/claude-code/docs/en/chrome.md` |
| CC-MCP | Claude Code MCP docs | `docs/claude-code/docs/en/mcp.md` |
| CC-BP | Claude Code best practices | `docs/claude-code/docs/en/best-practices.md` |
| CC-TS | Claude Code troubleshooting | `docs/claude-code/docs/en/troubleshooting.md` |
| REF-ARCH | Claude extension architecture | `research/ClaudeExtension/06_Core_Architecture.md` |
| REF-EXT | Claude extension system | `research/ClaudeExtension/07_Extension_System.md` |
| REF-SEC | Claude extension security | `research/ClaudeExtension/08_Security_and_Sandbox.md` |

All doc paths are relative to `/Volumes/VRAM/80-89_Resources/80_Reference/`.

---

## Phase 1: CLI Robustness

### 1.1 CLI Socket Timeout

**Problem:** `Bun.connect()` in `cli/index.ts:15` has no timeout. If the daemon accepts the connection but hangs before responding (e.g., extension is disconnected, service worker is suspended), the CLI blocks indefinitely. The daemon has a 30-second request timeout, but the CLI itself has no deadline — it relies entirely on the daemon's timeout propagating back, which requires the socket to remain writable.

**Evidence:**
- **[BUN-TCP, lines 116-138]**: `Bun.connect()` options include a `timeout(socket)` handler that fires for post-connection inactivity, but there is **no `connectTimeout` parameter** in the configuration object. The only connect-phase error is via `connectError(socket, error)`, which only fires if the OS-level connect fails (e.g., ECONNREFUSED). A reachable but hung daemon produces no error.
- **[CC-MCP, lines 339-340]**: Claude Code uses `MCP_TIMEOUT` environment variable with a 10-second default for MCP server startup. slop-browser has no equivalent CLI-side timeout.
- **[CC-CHR, lines 203-205]**: "The Chrome extension's service worker can go idle during extended sessions, which breaks the connection." — This is the exact scenario where the daemon receives the CLI connection but cannot forward to the extension, causing the CLI to hang.

**Fix:** Wrap the `Bun.connect()` Promise in a `setTimeout` race. If no response arrives within 15 seconds, reject the Promise, close the socket, and exit with an actionable error message. The 15-second value is chosen to be shorter than the daemon's 30-second timeout but long enough for legitimate slow operations (page load + DOM extraction).

**Files:** `cli/index.ts`

**Acceptance Criteria:**
- [x] CLI rejects with timeout error after 15 seconds of no response
- [x] Socket is explicitly closed (`socket.end()`) on timeout
- [x] Error message says: `"timeout: no response from daemon after 15s. Check extension connection with 'slop status'."`
- [x] Timeout duration configurable via `SLOP_TIMEOUT` environment variable

---

### 1.2 Tab Flag Validation

**Problem:** `parseTabFlag()` at `cli/index.ts:508-512` returns `parseInt(args[idx+1])` without validating the result. `parseInt("foo")` returns `NaN`, which propagates through the daemon as a valid `tabId` field. The daemon forwards `tabId: NaN` to the extension, which queries `chrome.tabs.get(NaN)`, receives an error, and the request fails with a confusing Chrome API error instead of a clear CLI validation error.

**Evidence:**
- **[CHR-TABS, lines 360-411]**: Tab IDs are integers. The tabs API has no handling for `NaN` — it throws `Error: Invalid tab ID` or returns undefined, depending on the API. This produces errors that don't indicate the CLI was given bad input.
- **Current code, cli/index.ts:510**: `return parseInt(args[idx + 1])` — no `isNaN()` check.

**Fix:** After `parseInt()`, check `isNaN()`. If the tab ID is not a valid integer, print `"error: --tab requires a numeric tab ID"` to stderr and `process.exit(1)`.

**Files:** `cli/index.ts`

**Acceptance Criteria:**
- [x] `parseTabFlag()` validates result is not `NaN`
- [x] Invalid `--tab` value produces a clear error and exits with code 1
- [x] Missing `--tab` value (flag present, no argument) produces a clear error

---

### 1.3 Stale Socket Detection

**Problem:** `cli/index.ts:154` checks `existsSync(SOCKET_PATH)` to determine if the daemon is running. But after a daemon crash (SIGKILL, OOM, power loss), the socket file persists as a stale artifact. The CLI connects to the stale socket, the OS accepts the connection to the dead file, and the CLI hangs until timeout (if #1.1 is implemented) or forever (if not).

**Evidence:**
- **[BUN-TCP, lines 116-138]**: `Bun.connect()` with `unix` option connects to a Unix domain socket file. If the file exists but no process is listening, the OS returns `ECONNREFUSED` and `connectError` fires. However, on macOS, the behavior for stale sockets can vary — some states produce `ECONNREFUSED` immediately, others produce a hang with no error.
- **Current code, daemon/index.ts:216**: PID file is written at `PID_PATH` (`/tmp/slop-browser.pid`) with the daemon's PID and socket path. This file exists but is never checked by the CLI.
- **[CC-CHR, lines 195-205]**: Claude Code documents that the extension can become disconnected, requiring manual reconnection. A stale socket produces the same symptom — commands appear to send but nothing happens.

**Fix:** Before connecting, read the PID file. Extract the PID. Use `process.kill(pid, 0)` (signal 0 = existence check, no actual signal sent) to verify the daemon process is still alive. If the process doesn't exist, delete the stale socket and PID files and print `"error: daemon not running (stale socket cleaned up). Open Chrome with the slop-browser extension loaded."`.

**Files:** `cli/index.ts`

**Acceptance Criteria:**
- [x] CLI reads PID file and verifies daemon process is alive before connecting
- [x] Stale socket + PID files cleaned up automatically when daemon is dead
- [x] Error message distinguishes "daemon not running" from "daemon not responding"
- [x] If PID file is missing but socket exists, treats as stale

---

## Phase 2: Content Script Correctness

### 2.1 Fixed Position Element Visibility

**Problem:** `isVisible()` at `content.ts:102-108` uses `offsetParent` as the primary visibility signal. Elements with `position: fixed` or `position: sticky` have `null` offsetParent (per CSSOM spec) but are fully visible and interactive. This causes the agent to miss navbars, modals, sticky headers, cookie consent banners, floating action buttons, and chat widgets — some of the most common interaction targets on modern websites.

**Evidence:**
- **[REF-EXT]**: Claude in Chrome uses an accessibility tree with ref-based querying (`07_Extension_System.md:919-930`) that doesn't rely on `offsetParent` for visibility. Its content script directly uses Chrome's accessibility APIs which correctly report fixed elements as visible.
- **CSSOM specification**: `offsetParent` returns `null` for elements with `position: fixed` because they are positioned relative to the viewport, not a parent element. This is correct per spec but breaks the heuristic.
- **Current code, content.ts:103**: `if (!(el as HTMLElement).offsetParent && el.tagName !== "BODY") return false` — only exempts `<body>`. Fixed/sticky elements are incorrectly hidden.

**Fix:** Before the `offsetParent` check, read `getComputedStyle(el).position`. If it is `"fixed"` or `"sticky"`, skip the `offsetParent` check entirely (the element is positioned relative to the viewport, so `offsetParent` is irrelevant). Keep the subsequent `display: none`, `visibility: hidden`, and zero-dimension checks.

**Files:** `extension/src/content.ts`

**Acceptance Criteria:**
- [x] Elements with `position: fixed` are detected as visible
- [x] Elements with `position: sticky` are detected as visible
- [x] `display: none` and `visibility: hidden` still correctly hide fixed/sticky elements
- [x] Zero-dimension fixed elements still correctly hidden
- [x] Common targets work: navbars, modals, cookie banners, floating buttons

---

### 2.2 Special Key Code Lookup

**Problem:** `dispatchKeySequence()` at `content.ts:610` generates key codes as `` `Key${key.toUpperCase()}` `` for all keys. This produces `"KeyENTER"`, `"KeyTAB"`, `"KeyESCAPE"`, `"KeyBACKSPACE"`, `"KeySPACE"`, etc. Real DOM key codes for these keys are `"Enter"`, `"Tab"`, `"Escape"`, `"Backspace"`, `"Space"`. Websites that check `event.code` (common in keyboard shortcut handlers, game inputs, and accessibility code) will not recognize these synthesized events.

**Evidence:**
- **[REF-EXT]**: Claude in Chrome uses CDP's `Input.dispatchKeyEvent` (`06_Core_Architecture.md`) which sends correct W3C key codes. slop-browser uses synthetic `KeyboardEvent` dispatching, which requires correct `code` values to be interpreted by page scripts.
- **W3C UI Events KeyboardEvent code values specification**: Defines `"Enter"`, `"Tab"`, `"Escape"`, `"Backspace"`, `"Space"`, `"ArrowUp"`, `"ArrowDown"`, `"ArrowLeft"`, `"ArrowRight"`, `"Delete"`, `"Home"`, `"End"`, `"PageUp"`, `"PageDown"`, `"F1"`-`"F12"` as the standard code values. Character keys use `"KeyA"`-`"KeyZ"` and `"Digit0"`-`"Digit9"`.
- **Current code, content.ts:610**: `code: \`Key${key.toUpperCase()}\`` — no special key handling.

**Fix:** Add a lookup table mapping key names to their correct W3C `code` values. For single-character alphabetic keys, use the existing `Key${upper}` pattern. For everything else, use the lookup table.

```typescript
const KEY_CODES: Record<string, string> = {
  Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace",
  Space: "Space", Delete: "Delete", Home: "Home", End: "End",
  PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
}
```

**Files:** `extension/src/content.ts`

**Acceptance Criteria:**
- [x] `Enter`, `Tab`, `Escape`, `Backspace`, `Space` produce correct `code` values
- [x] Arrow keys produce `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`
- [x] F1-F12 produce correct codes
- [x] Single alphabetic characters still produce `KeyA`-`KeyZ`
- [x] Digit keys produce `Digit0`-`Digit9`
- [x] Unknown keys fall back to `Key${upper}` (backward compatible)

---

### 2.3 MutationObserver Cleanup

**Problem:** The `domObserver` at `content.ts:54-60` attaches a `MutationObserver` on `document.body` but never disconnects it. PRD-2 acceptance criteria 4.2 explicitly requires "Observer disconnected on content script unload" but no cleanup handler was implemented. On SPA pages where the content script survives across route changes, the observer accumulates callback overhead. On full navigation, the content script is destroyed by Chrome, but the observer's internal references may delay GC of the content script's scope.

**Evidence:**
- **[CHR-CS, lines 301-307]**: "The tab containing the port is unloaded (for example, if the tab is navigated). The frame where `connect()` was called has unloaded." — Content scripts are destroyed on navigation, but observers attached to `document.body` may fire during the unload process, causing errors if the content script's other state has been torn down.
- **[REF-EXT]**: Claude in Chrome's content script uses heartbeats with explicit cleanup: the static indicator "auto-removes if heartbeat fails (extension context invalidated)" (`07_Extension_System.md:420-427`). This is explicit lifecycle management.
- **PRD-2, Phase 4.2 acceptance criteria**: "Observer disconnected on content script unload" — marked as complete but not implemented.

**Fix:** Add a `beforeunload` event listener that calls `domObserver.disconnect()`. Also add a `document.addEventListener("visibilitychange", ...)` handler that disconnects when the page becomes hidden (prevents observer firing during tab suspension).

**Files:** `extension/src/content.ts`

**Acceptance Criteria:**
- [x] `beforeunload` listener disconnects `domObserver`
- [x] Observer does not fire callbacks after page starts unloading
- [x] SPA route changes do not accumulate observers (single observer, reconnected if needed)

---

## Phase 3: Extension Memory Safety

### 3.1 Message Queue Bounds

**Problem:** `messageQueue` at `background.ts:5` is an unbounded array. Messages are queued when the native port is connecting (handshake not yet complete). If the daemon is down and the agent sends commands rapidly, the queue grows without limit. Each queued message contains the full action payload. A burst of `get_state` requests with large DOM trees could consume significant memory in the service worker.

**Evidence:**
- **[CHR-LIFE, lines 49-55]**: "After 30 seconds of inactivity... Chrome terminates a service worker." But a service worker processing messages is NOT idle — it stays alive. An unbounded queue being processed keeps the worker alive while consuming increasing memory.
- **[CHR-NM, line 108]**: "The maximum size of a single message from the native messaging host is 1 MB" — a queue of 50 messages could consume 50 MB.
- **[REF-ARCH, lines 1734-1735]**: Claude in Chrome's retry mechanisms "use fixed delays (800ms initial, then 500ms) without exponential backoff or jitter. Under load, this could produce message storms." Even the reference implementation acknowledges this risk.
- **[CHR-STOR, lines 29-33]**: "Local Storage and Session Storage are not [available in service workers]." — Cannot offload queue to localStorage. Would need IndexedDB, adding complexity.

**Fix:** Cap `messageQueue` at 50 entries. When the cap is reached, reject the oldest message with `{success: false, error: "message queue full — daemon not connected"}`. Log a warning when the queue exceeds 25 entries (50% capacity).

**Files:** `extension/src/background.ts`

**Acceptance Criteria:**
- [x] `messageQueue` capped at 50 entries
- [x] Oldest messages evicted when cap reached, with error response sent to daemon
- [x] Warning logged at 50% capacity
- [x] Queue drains normally after daemon reconnects (existing behavior preserved)

---

### 3.2 Orphaned Request Error Propagation

**Problem:** When `onDisconnect` fires at `background.ts:45-49`, pending requests are logged and cleared from the map, but no error response is sent back through the native port. The port is already `null` at this point, so `sendToHost()` silently drops the response. The daemon's 30-second timeout eventually fires, but during those 30 seconds, the CLI hangs for every in-flight request at disconnect time.

**Evidence:**
- **[CHR-NM, lines 114-115]**: "Chrome starts native messaging host process and keeps it running until the port is destroyed." When the port is destroyed (onDisconnect), the native host process (daemon) is still running and still has pending requests. It needs to be notified that those requests will never complete.
- **[CHR-MSG, lines 309-310]**: "A Port can have multiple receivers connected at any given time. As a result, `onDisconnect` may fire more than once." — Multiple disconnect events could race with each other during cleanup.
- **[REF-ARCH, lines 657-694]**: Claude in Chrome tracks pending requests and sends explicit error responses on disconnect before clearing state.
- **Current code, background.ts:38-49**: `nativePort = null` is set on line 38, before the pending request cleanup loop on lines 45-49. By the time the loop runs, `sendToHost()` on line 563 checks `if (nativePort)` and silently returns.

**Fix:** Before setting `nativePort = null`, iterate pending requests and send error responses through the still-live port. Then set `nativePort = null` and clear the map.

**Files:** `extension/src/background.ts`

**Acceptance Criteria:**
- [x] Error responses sent for all pending requests BEFORE port is nulled
- [x] Each error response includes the original request ID
- [x] Error message: `"native port disconnected"`
- [x] Pending request timers cleared to prevent double-fire
- [x] Port reference saved to local variable before nulling to avoid race

---

## Phase 4: Security Hardening

### 4.1 TOCTOU URL Verification

**Problem:** Between the time the agent runs `slop state` (reading the page URL) and `slop click` (executing an action), the tab URL can change via user navigation, JavaScript redirect, or timer-based redirect. The action executes on whatever page is now loaded, which may be a different domain. For security-sensitive actions like `evaluate` (JS execution) or `cookies_get`, this means code intended for `example.com` could execute on `bank.com`.

**Evidence:**
- **[CHR-TABS, lines 360-411]**: `tab.url` is "the last committed URL of the main frame." `tab.pendingUrl` shows "the URL the tab is navigating to, before it has committed." Between a query and an action, the tab can commit a navigation, changing `tab.url`. No Chrome API provides atomic URL-locked execution.
- **[REF-EXT, 07_Extension_System.md, lines 919-930]**: Claude in Chrome implements explicit TOCTOU mitigation: `const url = tab.url; const securityResult = await j(tab.id, url, "JavaScript execution"); if (securityResult) return securityResult;` — checks URL immediately before execution and rejects if it changed.
- **[REF-SEC, 08_Security_and_Sandbox.md, lines 761-789]**: Documents the security pattern in detail with anti-circumvention measures.
- **[CC-BP, lines 27-45]**: "Give Claude a way to verify its work" — but no TOCTOU protection documented, meaning slop-browser must implement its own.

**Fix:** For security-sensitive actions (`evaluate`, `cookies_get`, `cookies_set`, `cookies_delete`, `storage_read`, `storage_write`), query `chrome.tabs.get(tabId)` immediately before execution and compare the URL against the URL from the original request (if provided via a new optional `expectedUrl` field). If they don't match, return `{success: false, error: "tab URL changed since last state read — expected {expected}, got {actual}"}`.

**Files:** `extension/src/background.ts`

**Acceptance Criteria:**
- [x] `evaluate` action validates tab URL before execution
- [x] Cookie actions validate tab URL before execution
- [x] Storage actions validate tab URL before execution
- [x] New optional `expectedUrl` field accepted in action messages
- [x] URL mismatch returns actionable error with both URLs
- [x] Non-sensitive actions (click, type, scroll) skip URL check for performance

---

## Phase 5: Keepalive and Resilience

### 5.1 Alarm-Based Keepalive

**Problem:** The native messaging connection keeps the service worker alive per Chrome docs. But if the daemon becomes unresponsive (not crashed — just hung), the native port stays open and the service worker stays alive in a broken state. There is no health check to detect a wedged daemon. Additionally, if the native port disconnects and reconnection enters the exponential backoff cycle (up to 30 seconds), the service worker may terminate during the backoff wait.

**Evidence:**
- **[CHR-LIFE, lines 49-55]**: "After 30 seconds of inactivity. Receiving an event or calling an extension API resets this timer." — During reconnection backoff, if no other events arrive, the worker terminates.
- **[CHR-ALRM, lines 11, 193]**: "Starting in Chrome 120, the minimum alarm interval has been reduced from 1 minute to 30 seconds." — Alarms fire `onAlarm` events, which revive dormant service workers. A 30-second alarm ensures the worker never terminates during reconnection.
- **[REF-ARCH, lines 700-715]**: Claude in Chrome uses a heartbeat mechanism with 5-second intervals to detect stale sessions. Combined with alarms for recovery after service worker restart.
- **[REF-ARCH, lines 799-906]**: Claude in Chrome uses `chrome.alarms` for scheduled task retry with `retry_prompt_{id}` secondary alarms.

**Fix:**
1. Create a `chrome.alarms.create("keepalive", { periodInMinutes: 0.5 })` alarm (30-second interval, the minimum allowed).
2. In the `onAlarm` handler, check if `nativePort` is null. If so, call `connectToHost()`.
3. If `nativePort` is not null, send a `{type: "ping"}` through the port. If no `{type: "pong"}` arrives within 5 seconds, disconnect the port and trigger reconnection.
4. On successful reconnection, the alarm continues ticking as a health check.

**Files:** `extension/src/background.ts`, `daemon/index.ts`

**Acceptance Criteria:**
- [x] Keepalive alarm created on extension startup
- [x] Alarm handler reconnects if `nativePort` is null
- [x] Alarm handler pings daemon if port is connected
- [x] Missing pong within 5 seconds triggers disconnect + reconnect
- [x] Alarm survives service worker restart (Chrome persists alarms)
- [x] Daemon responds to ping with pong (already implemented in PRD-2)

---

### 5.2 Dual-Channel Fallback (WebSocket Bridge)

**Problem:** slop-browser has a single communication channel: CLI → daemon → native messaging → extension. If any link in this chain breaks (daemon crash, native port disconnect, extension suspension), all commands fail. Claude in Chrome operates two independent channels (native messaging + WebSocket bridge) so that either can fail independently.

**Evidence:**
- **[REF-ARCH, lines 933-972]**: Claude in Chrome maintains native messaging and a WebSocket bridge to `wss://bridge.claudeusercontent.com` simultaneously. Tool requests try native first, fall back to bridge: `return { success: nativeSuccess || bridgeSuccess }`.
- **[REF-ARCH, lines 959-960]**: Reconnection uses `Promise.all([connectNativeHost(), connectBridge()])` to restore both channels in parallel.
- **[CC-CHR, lines 195-205]**: All Claude Code Chrome recovery paths are manual. A second channel would eliminate most of these.
- **[CHR-NM, lines 163-165]**: "The pipe to the native messaging host was broken before the message was read by Chrome" — a documented native messaging failure mode that a secondary channel would survive.

**Fix:** Add a local WebSocket server to the daemon (e.g., `ws://localhost:19222`). The extension connects to this WebSocket as a secondary channel. When the native messaging port is unavailable, messages route through WebSocket instead. The CLI can also connect directly via WebSocket, bypassing the Unix socket + native messaging chain entirely for faster local development.

**Files:** `daemon/index.ts`, `extension/src/background.ts`

**Acceptance Criteria:**
- [x] Daemon starts a WebSocket server alongside the Unix socket server
- [x] Extension connects to WebSocket as secondary channel
- [x] Messages route through native messaging by default, WebSocket as fallback
- [x] CLI supports `--ws` flag for direct WebSocket connection
- [x] Either channel can fail independently without affecting the other
- [x] WebSocket port configurable via environment variable

---

## Phase 6: Tab Isolation

### 6.1 Tab Group Manager

**Problem:** `slop state` and `slop click` operate on whatever tab is active (or whichever `--tab` ID is provided). There is no isolation between the agent's automated tabs and the user's personal tabs. If the user is browsing and the agent sends `slop click 5`, the click may land on the user's bank page. Even with `--tab`, the agent must track tab IDs manually, and a tab ID can become invalid if the user closes it.

**Evidence:**
- **[CHR-TGRP, lines 11-13]**: "Use the `chrome.tabGroups` API to interact with the browser's tab grouping system." Tab groups provide visual and logical isolation.
- **[REF-ARCH, lines 657-694]**: Claude in Chrome implements `TabGroupManager` with full lifecycle: creation, adoption of orphaned groups after SW restart, and cleanup when empty. All tool execution is scoped to the managed group.
- **[REF-ARCH, lines 722-735]**: Static indicator heartbeat validates tabs are in managed groups, preventing automation of unmanaged tabs.
- **[CHR-TABS, lines 184-192]**: `chrome.tabs.query({ active: true, lastFocusedWindow: true })` is "inherently racy" — focus can change between query and action.

**Fix:**
1. On first `tab_create` from the agent, create a Chrome tab group titled "slop" with a distinctive color (e.g., cyan).
2. All new tabs created by slop commands are automatically added to this group.
3. All actions that resolve a tab (the `needsTab` path) validate the target tab is in the slop group before executing. If not, return `{success: false, error: "tab {id} is not in the slop group — use 'slop tab new' to create managed tabs"}`.
4. `slop tabs` output marks which tabs are in the managed group.
5. On service worker restart, adopt orphaned tabs that were in the group (Chrome preserves tab groups across restarts).

**Files:** `extension/src/background.ts`

**Acceptance Criteria:**
- [x] Agent tabs are grouped in a visible "slop" tab group
- [x] New `tab_create` tabs automatically join the group
- [x] Actions on non-grouped tabs are rejected with actionable error
- [x] `tab_list` response indicates group membership
- [x] Orphaned group is adopted after service worker restart
- [x] Group is dissolved when last managed tab is closed
- [x] Opt-out: `--any-tab` flag allows action on any tab (escape hatch)

---

## Phase 7: Observability

### 7.1 Structured Event Logging

**Problem:** PRD-2 added request tracing (shortId + duration in daemon logs and extension console.log). But the extension's console.log is only visible if DevTools is open on the service worker page, and the CLI's stderr output is only visible in verbose mode. There is no unified log sink, no structured format for machine parsing, and no way to retroactively diagnose failures.

**Evidence:**
- **[CC-TS, lines 883-891]**: Claude Code's `/doctor` command checks for MCP configuration errors, context usage warnings, and plugin loading errors. This is reactive. slop-browser needs proactive event capture.
- **[CC-MCP, lines 921-945]**: Claude Code has output warning thresholds (10K tokens) and configurable limits (25K default). slop-browser has no equivalent observability thresholds.
- **[REF-ARCH]**: Claude in Chrome sends analytics events to Sentry (errors), Segment (analytics), Datadog (session replay), and Honeycomb (tracing) at critical junctures: `native_host_success`, `bridge_initiated`, `mcp_connected`, `scheduled_task.executed`, `tab.switch.error`.

**Fix:**
1. Daemon: log structured JSON events to `/tmp/slop-browser-events.jsonl` (one JSON object per line). Fields: `{timestamp, requestId, event, action, duration, success, error}`.
2. Extension: send events to the daemon via a new `{type: "event", ...}` native message type. Daemon writes these to the same events file.
3. CLI: add `slop events [--tail] [--since <timestamp>]` command to read the events file.
4. Events emitted: `request_received`, `request_forwarded`, `request_complete`, `request_timeout`, `connection_established`, `connection_lost`, `reconnection_attempt`, `queue_warning` (>25 entries), `keepalive_ping`, `keepalive_timeout`.

**Files:** `daemon/index.ts`, `extension/src/background.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] Events written to `/tmp/slop-browser-events.jsonl` in structured JSON
- [x] Extension events forwarded to daemon via native messaging
- [x] `slop events` command reads and displays events
- [x] `slop events --tail` follows the file for real-time monitoring
- [x] Events include request IDs for cross-layer correlation
- [x] Event file auto-rotated at 10 MB (truncate oldest half)

---

## Implementation Order

| Phase | Impact | Effort | Priority | Depends On |
|-------|--------|--------|----------|------------|
| 2.1 Fixed position visibility | Eliminates missed navbars/modals/banners | Tiny | P0 | None |
| 2.2 Special key codes | Eliminates broken keyboard shortcuts | Tiny | P0 | None |
| 1.2 Tab flag validation | Eliminates NaN propagation | Tiny | P0 | None |
| 1.1 CLI socket timeout | Eliminates indefinite CLI hangs | Small | P0 | None |
| 1.3 Stale socket detection | Eliminates misleading connection errors | Small | P0 | None |
| 2.3 MutationObserver cleanup | Eliminates observer leak on unload | Tiny | P1 | None |
| 3.1 Message queue bounds | Eliminates unbounded memory growth | Small | P1 | None |
| 3.2 Orphaned request errors | Reduces CLI hang time on disconnect | Small | P1 | None |
| 4.1 TOCTOU URL verification | Eliminates cross-domain execution risk | Medium | P1 | None |
| 5.1 Alarm-based keepalive | Detects wedged daemon, prevents SW death | Small | P1 | PRD-2 ping/pong |
| 7.1 Structured event logging | Enables retroactive failure diagnosis | Medium | P2 | None |
| 6.1 Tab group manager | Isolates agent tabs from user tabs | Medium | P2 | None |
| 5.2 Dual-channel fallback | Eliminates single point of failure | Large | P2 | 7.1 (for debugging) |

---

## What This PRD Does NOT Cover

| Topic | Why Excluded |
|-------|-------------|
| Element ref IDs (replacing indices) | Fundamental content script redesign. Requires accessibility tree integration. Future PRD. |
| Session recording/replay | New feature, not stability. Future PRD. |
| Permission denial circuit breaker | Low severity — agent already handles errors. Monitor via 7.1 first. |
| CLI retry logic | Agent (Claude Code) manages retries. CLI should fail fast with clear errors. |
| Native messaging 1 MB response limit | Rare in practice. Large responses (full HTML) are already truncated. Monitor via 7.1. |

---

## Files Modified

| File | Changes |
|------|---------|
| `cli/index.ts` | Socket timeout (#1.1), tab flag validation (#1.2), stale socket detection (#1.3), events command (#7.1) |
| `daemon/index.ts` | Event logging (#7.1), WebSocket server (#5.2) |
| `extension/src/background.ts` | Queue bounds (#3.1), orphaned request errors (#3.2), TOCTOU check (#4.1), keepalive alarm (#5.1), tab group manager (#6.1), WebSocket channel (#5.2), event forwarding (#7.1) |
| `extension/src/content.ts` | Fixed position visibility (#2.1), key code lookup (#2.2), observer cleanup (#2.3) |
| `extension/manifest.json` | `tabGroups` permission (#6.1), alarms permission (#5.1) |

No new source files. Two new Chrome extension permissions (`tabGroups`, `alarms`). One new optional dependency (WebSocket for #5.2).
