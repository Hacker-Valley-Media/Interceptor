# PRD-2: Stability & Resilience Hardening

**Goal:** Eliminate silent failures, race conditions, and connection fragility across all three slop-browser layers (CLI, daemon, extension) to achieve production-grade reliability.

**Scope:** Modifications to existing files only. No new user-facing features. No architecture changes. This is infrastructure hardening of the existing message pipeline.

**Motivation:** The PRD-1 architecture works end-to-end but has 14 identified stability gaps that cause silent data loss, stale state, and unrecoverable hangs during real agent workflows. These were identified by comparing slop-browser against the Claude in Chrome extension reference implementation (v1.0.47) and grounding each gap against official Bun, Chrome Extension, and Claude Code documentation.

---

## Evidence Sources

| ID | Source | Path |
|----|--------|------|
| BUN-TCP | Bun TCP socket docs | `docs/bun/docs/runtime/networking/tcp.md` |
| BUN-HTTP | Bun HTTP server docs | `docs/bun/docs/runtime/http/server.md` |
| BUN-EXEC | Bun compiled binary docs | `docs/bun/docs/bundler/executables.md` |
| CHR-LIFE | Chrome SW lifecycle | `docs/chrome-extensions/docs/extensions/develop/concepts/service-workers/lifecycle.md` |
| CHR-NM | Chrome native messaging | `docs/chrome-extensions/docs/extensions/develop/concepts/native-messaging.md` |
| CHR-MSG | Chrome message passing | `docs/chrome-extensions/docs/extensions/develop/concepts/messaging.md` |
| CHR-STOR | Chrome storage & cookies | `docs/chrome-extensions/docs/extensions/develop/concepts/storage-and-cookies.md` |
| CHR-ALRM | Chrome alarms API | `docs/chrome-extensions/docs/extensions/reference/api/alarms.md` |
| CHR-TABS | Chrome tabs API | `docs/chrome-extensions/docs/extensions/reference/api/tabs.md` |
| CHR-TGRP | Chrome tab groups API | `docs/chrome-extensions/docs/extensions/reference/api/tabGroups.md` |
| CC-CHR | Claude Code Chrome integration | `docs/claude-code/docs/en/chrome.md` |
| CC-MCP | Claude Code MCP docs | `docs/claude-code/docs/en/mcp.md` |
| REF-EXT | Claude in Chrome extension source | `/Volumes/VRAM/80-89_Resources/80_Reference/research/ClaudeExtension/` |

All doc paths are relative to `/Volumes/VRAM/80-89_Resources/80_Reference/`.

---

## Phase 1: Message Transport Reliability

### 1.1 Length-Prefixed Framing on Unix Socket

**Problem:** The daemon parses socket data events as complete JSON: `JSON.parse(raw.toString())`. If a CLI message exceeds the OS socket buffer size, the daemon receives a partial JSON chunk, parse fails, and the request is silently dropped.

**Evidence:**
- **[BUN-TCP, lines 188-200]**: "Currently, TCP sockets in Bun do not buffer data. For performance-sensitive code, it's important to consider buffering carefully." Multiple small writes are explicitly called out as performing worse than single large writes. The docs recommend `ArrayBufferSink` with `{stream: true}` for manual buffering.
- **[CHR-NM, line 108]**: Chrome's own native messaging protocol uses "32-bit message length in native byte order" preceding each message — the same framing pattern we already implement for native messaging but skip on the socket side.

**Fix:** Add 4-byte little-endian length prefix to socket protocol (matching native messaging format). Both daemon and CLI accumulate into a buffer and only parse when `buffer.length >= 4 + declaredLength`.

**Files:** `daemon/index.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] CLI prepends 4-byte LE length header before JSON payload
- [x] Daemon accumulates socket data into buffer, reads length header, waits for complete payload
- [x] Messages up to 1MB work correctly (matching native messaging max)
- [x] Partial reads are accumulated, not parsed prematurely

---

### 1.2 Backpressure Handling on Socket Writes

**Problem:** `socket.write(response + "\n")` in the daemon has no check for write success. If the client disconnects or the socket buffer is full, the write fails silently and the response is lost.

**Evidence:**
- **[BUN-TCP, lines 188-237]**: Bun TCP sockets have no implicit buffering. The docs explicitly show that `socket.write()` can return a value less than `data.byteLength` when the socket is full, and recommend using the `drain` handler: "Corking support is planned, but in the meantime backpressure must be managed manually with the drain handler."
- **[BUN-TCP, lines 11-112]**: The `drain(socket)` event fires when "socket ready for more data" — this is the backpressure signal.

**Fix:** Check `socket.write()` return value. If partial write, queue remainder and flush in `drain` handler. Wrap all `socket.write()` calls in try/catch for disconnected socket errors.

**Files:** `daemon/index.ts`

**Acceptance Criteria:**
- [x] All `socket.write()` calls check return value
- [x] Partial writes are queued and flushed via `drain` handler
- [x] Write to closed socket is caught and logged (not thrown)
- [x] Timed-out responses to disconnected sockets don't crash daemon

---

### 1.3 Request Timeout Cleanup

**Problem:** When a 30-second timeout fires, the daemon deletes the pending request and writes an error to the socket — but the extension may still be processing the request. If the extension responds after timeout, the response arrives at the daemon with an unrecognized ID and is silently dropped. The socket write after timeout may also fail if the CLI already disconnected.

**Evidence:**
- **[CHR-NM, line 114]**: "When a messaging port is created using `runtime.connectNative()`, Chrome starts native messaging host process and keeps it running until the port is destroyed." The native messaging channel is persistent — orphaned responses WILL arrive.
- **[REF-EXT]**: Claude in Chrome tracks tool requests with IDs in both the service worker and native host, with explicit cancellation messages when requests time out.

**Fix:**
1. Wrap timeout socket write in try/catch
2. After timeout, keep the request ID in a `timedOutRequests` set for 60 seconds
3. When a response arrives for a timed-out ID, log it and discard (instead of silent drop)
4. Clear timeout timer when response arrives normally

**Files:** `daemon/index.ts`

**Acceptance Criteria:**
- [x] `clearTimeout(timer)` called when response arrives before timeout
- [x] Socket write in timeout handler wrapped in try/catch
- [x] Timed-out request IDs tracked in a TTL set
- [x] Late responses for timed-out requests logged with warning

---

## Phase 2: Service Worker Lifecycle (MV3)

### 2.1 Survive Service Worker Suspension

**Problem:** Chrome suspends MV3 service workers after 30 seconds of inactivity. When the service worker wakes, all module-level variables reset to their initial values — `nativePort` becomes `null`. The current code has no mechanism to detect this or restore state. Any in-flight request at suspension time is silently lost.

**Evidence:**
- **[CHR-LIFE, line 51]**: "After 30 seconds of inactivity. Receiving an event or calling an extension API resets this timer."
- **[CHR-LIFE, line 55]**: "Events and calls to extension APIs reset these timers, and if the service worker has gone dormant, an incoming event will revive them."
- **[CHR-LIFE, lines 59-61]**: "Any global variables you set will be lost if the service worker shuts down. Instead of using global variables, save values to storage."
- **[CHR-LIFE, line 63]**: "The Web Storage API is not available for extension service workers."
- **[CHR-LIFE, lines 112-113]**: "Connecting to a native messaging host using `chrome.runtime.connectNative()` will keep a service worker alive. If the host process crashes or is shut down, the port is closed and the service worker will terminate after timers complete." (Chrome 105+)

**Fix:** Add `chrome.runtime.onStartup` listener alongside existing `onInstalled`. Both call `connectToHost()`. Store active tab ID in `chrome.storage.session` so it survives restarts. On wake, check if `nativePort` is null and reconnect.

**Files:** `extension/src/background.ts`

**Acceptance Criteria:**
- [x] `onStartup` listener registered, calls `connectToHost()`
- [x] `onInstalled` listener registered, calls `connectToHost()`
- [x] Active tab ID persisted to `chrome.storage.session`
- [x] On any incoming message, check `nativePort` state and reconnect if null before processing
- [x] No in-memory state relied upon across potential suspension boundaries

---

### 2.2 Connection Handshake (Ping/Pong)

**Problem:** After `connectNative()`, the extension immediately begins routing messages. There's no verification that the daemon is alive and ready. If the daemon is still initializing (setting up socket server, writing PID file), early messages are lost.

**Evidence:**
- **[CHR-NM, line 114]**: "Chrome starts native messaging host process and keeps it running until the port is destroyed." The process may not be ready to handle messages immediately after spawn.
- **[REF-EXT]**: Claude in Chrome implements explicit ping/pong: sends `{type: "ping"}`, expects `{type: "pong"}` within 10 seconds. Only after pong does it consider the connection usable and sends `{type: "get_status"}`.
- **[CC-CHR, lines 205-206]**: "The Chrome extension's service worker can go idle during extended sessions, which breaks the connection." Reconnection requires explicit verification.

**Fix:** After `connectNative()`, send `{type: "ping"}`. Set a 10-second timeout. Only mark connection as ready after receiving `{type: "pong"}`. Queue any incoming CLI requests until handshake completes.

**Files:** `extension/src/background.ts`, `daemon/index.ts`

**Acceptance Criteria:**
- [x] Extension sends `{type: "ping"}` immediately after `connectNative()`
- [x] Daemon responds with `{type: "pong"}` to ping messages
- [x] Connection marked as `ready` only after pong received
- [x] 10-second timeout on handshake — retry connection on timeout
- [x] Messages queued during handshake, flushed after pong

---

### 2.3 Reconnection Mutex and Backoff

**Problem:** `onDisconnect` fires and schedules `setTimeout(connectToHost, 2000)`. If multiple disconnects fire (e.g., service worker wake + manual reconnect), parallel `connectNative()` calls stomp on each other. No exponential backoff means rapid reconnect storms during extended outages.

**Evidence:**
- **[CHR-LIFE, line 51]**: Service worker can terminate and restart multiple times, each time triggering reconnection logic.
- **[CHR-MSG, lines 309-310]**: "A Port can have multiple receivers connected at any given time. As a result, `onDisconnect` may fire more than once."
- **[REF-EXT]**: Claude in Chrome uses an `isConnecting` boolean mutex to prevent concurrent connection attempts, and tries hosts sequentially.

**Fix:** Add `isConnecting` boolean guard. Implement exponential backoff: 1s, 2s, 4s, 8s, max 30s. Reset backoff on successful connection.

**Files:** `extension/src/background.ts`

**Acceptance Criteria:**
- [x] `isConnecting` flag prevents concurrent `connectToHost()` calls
- [x] Exponential backoff with jitter: 1s → 2s → 4s → 8s → 16s → 30s cap
- [x] Backoff resets to 1s on successful connection + pong
- [x] `chrome.runtime.lastError` read and logged on disconnect

---

## Phase 3: In-Flight Request Tracking

### 3.1 Request Registry in Background Script

**Problem:** The background service worker has zero tracking of in-flight requests. When the native port dies mid-request, the daemon's 30-second timeout eventually fires, but the extension has no way to cancel, retry, or report the failure. No request correlation exists between the extension and daemon layers.

**Evidence:**
- **[CHR-NM, lines 163-165]**: "Native host has exited. The pipe to the native messaging host was broken before the message was read by Chrome." — This is a documented failure mode with no recovery in the current code.
- **[REF-EXT]**: Claude in Chrome tracks all tool requests with IDs, has explicit error responses when connections drop, and manages request lifecycle across service worker restarts.

**Fix:** Maintain a `pendingRequests: Map<string, {action, tabId, timestamp}>` in the background script. On disconnect, iterate all pending requests and send error responses back through the daemon (or log if daemon is unavailable). Set per-request timeouts.

**Files:** `extension/src/background.ts`

**Acceptance Criteria:**
- [x] `pendingRequests` map tracks all in-flight requests by ID
- [x] On native port disconnect, all pending requests get error responses
- [x] Per-request timeout (30s) with cleanup on expiry
- [x] Request map cleared on service worker shutdown
- [x] Duplicate request IDs rejected with error

---

### 3.2 Content Script sendResponse Race Condition

**Problem:** `chrome.tabs.sendMessage()` expects the content script listener to return `true` for async responses. If the action handler throws before calling `sendResponse()`, the callback never fires. The daemon hangs until its 30-second timeout.

**Evidence:**
- **[CHR-MSG, lines 54-62]**: "By default, the `sendResponse` callback must be called synchronously... To respond asynchronously, return a literal `true` (not just a truthy value) from the event listener."
- **[CHR-MSG, lines 152-153]**: "From Chrome 146, if an `onMessage` listener throws an error... the promise returned by `sendMessage()` in the sender will reject with the error's message."
- **[CHR-TABS, lines 153-162]**: Shows `chrome.runtime.lastError` checking within callbacks — the recommended error detection pattern.

**Fix:** Wrap the entire action handler in try/catch. Always call `sendResponse()` — either with the result or with `{success: false, error: message}`. Check `chrome.runtime.lastError` in the `sendMessage` callback in background.ts.

**Files:** `extension/src/content.ts`, `extension/src/background.ts`

**Acceptance Criteria:**
- [x] Content script message handler wrapped in try/catch
- [x] `sendResponse()` called in ALL code paths (success and error)
- [x] Handler returns `true` for async response
- [x] Background `sendMessage` callback checks `chrome.runtime.lastError`
- [x] Null/undefined response from content script treated as error

---

## Phase 4: DOM State Management

### 4.1 Element Validation Before Action

**Problem:** `selectorMap` is rebuilt only when `getPageState()` is called. Between state reads and action execution, the DOM can mutate freely (navigation, AJAX, timers). The content script uses stale selectors and either acts on the wrong element or gets `null` — with no indication to the agent that the state is stale.

**Evidence:**
- **[REF-EXT]**: Claude in Chrome uses ref-based accessibility tree with depth limiting and output size capping. Elements are queried by stable ref IDs, not ephemeral indices. The accessibility tree content script supports querying specific subtrees by ref ID.
- **Current code**: `selectorMap` is a simple `Map<number, string>` rebuilt from scratch on each `getPageState()` call. Between calls, any DOM mutation invalidates the map.

**Fix:** Before executing any element-targeting action (click, type, select, focus, hover, drag), re-query the selector and validate the element:
1. Check `document.querySelector(selector)` returns non-null
2. Check element is still visible (`offsetParent`, computed display/visibility`)
3. If validation fails, return `{success: false, error: "stale element [N] — run slop state to refresh"}` with actionable error message

**Files:** `extension/src/content.ts`

**Acceptance Criteria:**
- [x] `resolveElement(index)` validates element exists in DOM
- [x] `resolveElement(index)` validates element is visible
- [x] Stale element returns actionable error message mentioning `slop state`
- [x] All element-targeting actions call `resolveElement()` before acting
- [x] Error message includes which index was stale

---

### 4.2 MutationObserver for Stale State Detection

**Problem:** The agent has no signal that the DOM has changed since the last `slop state`. It operates on stale indices until an action fails — and some actions (click on wrong element) "succeed" against the wrong target with no error.

**Evidence:**
- **PRD-1, Phase 2**: Lists `MutationObserver` as a proven non-CDP technique in the research evidence table.
- **[REF-EXT]**: Claude in Chrome's content script uses heartbeats every 5 seconds to detect when tabs change state. The accessibility tree is rebuilt on demand, not cached.

**Fix:** Attach a `MutationObserver` on `document.body` that sets a `domDirty: boolean` flag when childList or subtree mutations occur. When `domDirty` is true and an action targets an element:
1. Include `"warning": "DOM has changed since last state read"` in the response
2. Still attempt the action (selector may still be valid)
3. Reset `domDirty` when `getPageState()` is called

**Files:** `extension/src/content.ts`

**Acceptance Criteria:**
- [x] `MutationObserver` watches `{childList: true, subtree: true}` on `document.body`
- [x] `domDirty` flag set on mutation, cleared on `getPageState()`
- [x] Action responses include `warning` field when `domDirty` is true
- [x] Observer disconnected on content script unload
- [x] Observer does not fire on attribute-only changes (too noisy)

---

## Phase 5: Tab Scoping

### 5.1 Explicit Tab Targeting

**Problem:** The extension resolves the target tab via `chrome.tabs.query({active: true, currentWindow: true})`. If the user switches tabs between `slop state` and `slop click`, the action executes on the wrong tab. The agent has no control over which tab receives the action.

**Evidence:**
- **[CHR-TABS, lines 184-192]**: Shows `chrome.tabs.query({ active: true, lastFocusedWindow: true })` — this is inherently racy. Tab focus can change between query and action.
- **[CHR-TGRP, line 13]**: "Use the `chrome.tabGroups` API to interact with the browser's tab grouping system." Tab groups provide isolation for automated tabs.
- **[REF-EXT]**: Claude in Chrome implements a full `TabGroupManager` class that isolates automated tabs into Chrome tab groups. All tool execution is scoped to the managed group, preventing accidental automation of user's personal tabs.

**Fix:**
1. Accept optional `tabId` in all action messages
2. When `tabId` is provided, use it directly (no query)
3. When `tabId` is omitted, fall back to active tab query (current behavior)
4. Return `tabId` in every response so the agent can pin to a specific tab
5. CLI adds `--tab <id>` flag to all action commands

**Files:** `extension/src/background.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] All action messages accept optional `tabId` field
- [x] Provided `tabId` used directly without active tab query
- [x] Missing `tabId` falls back to active tab (backward compatible)
- [x] Every response includes `tabId` of the tab that was acted on
- [x] CLI `--tab <id>` flag added to all action commands
- [x] `slop state` response includes `tabId` prominently

---

## Phase 6: Observability

### 6.1 Request Tracing Across Layers

**Problem:** When a request fails, there's no way to trace it across the three layers (CLI → daemon → extension). The daemon logs to `/tmp/slop-browser.log` but the extension and CLI have no correlated logging. Debugging requires manually matching UUIDs across separate log sources.

**Evidence:**
- **[CC-MCP, lines 921-945]**: Claude Code has explicit MCP output limits and timeout configuration — observable thresholds. slop-browser has no equivalent observability.
- **[BUN-TCP, lines 29-47]**: Bun's shared handler model means errors in one socket affect all sockets on the same server — correlated logging is essential.

**Fix:** Add lightweight tracing:
1. CLI prints request ID to stderr on send (visible in Claude Code verbose mode)
2. Daemon logs request ID + action type on receive and response
3. Extension logs request ID + action type + duration in console
4. All timeout/error messages include the request ID

**Files:** `cli/index.ts`, `daemon/index.ts`, `extension/src/background.ts`

**Acceptance Criteria:**
- [x] CLI prints `[request-id] → action_type` to stderr
- [x] Daemon logs `[request-id] recv action_type` and `[request-id] resp {success/error} {duration}ms`
- [x] Extension console logs `[request-id] executing action_type` and `[request-id] complete {duration}ms`
- [x] All error messages include request ID
- [x] Tracing adds < 1ms overhead per request

---

## Phase 7: Graceful Shutdown

### 7.1 Daemon Graceful Shutdown

**Problem:** The daemon handles `SIGTERM` and `SIGINT` by calling `process.exit(0)`, which cleans up the socket and PID files. But in-flight requests in `pendingRequests` are silently dropped — CLI clients hang until their own timeout fires.

**Evidence:**
- **[BUN-HTTP, lines 243-261]**: Bun HTTP server supports graceful shutdown: "By default, `stop()` allows in-flight requests and WebSocket connections to complete. Pass `true` to immediately terminate all connections." The same pattern should apply to socket servers.
- **[BUN-TCP, lines 99-112]**: `server.stop(true)` closes active connections. `server.unref()` lets process exit even if server is listening.

**Fix:** On SIGTERM/SIGINT:
1. Stop accepting new socket connections
2. Send timeout errors to all pending requests
3. Close socket server
4. Clean up PID/socket files
5. Exit

**Files:** `daemon/index.ts`

**Acceptance Criteria:**
- [x] SIGTERM/SIGINT drain pending requests with error responses
- [x] Socket server stopped before PID file cleanup
- [x] Pending CLI clients receive `{success: false, error: "daemon shutting down"}` instead of hanging
- [x] Clean exit within 2 seconds of signal

---

## Implementation Order

Phases are independent and can be parallelized, but recommended order by stability ROI:

| Phase | Impact | Effort | Priority |
|-------|--------|--------|----------|
| 1.1 Message framing | Eliminates silent data loss on large payloads | Small | P0 |
| 2.1 SW lifecycle | Eliminates hangs after 30s idle | Medium | P0 |
| 3.2 sendResponse fix | Eliminates 30s hangs on content script errors | Small | P0 |
| 2.2 Ping/pong handshake | Eliminates lost messages during startup | Small | P1 |
| 2.3 Reconnection mutex | Eliminates reconnection storms | Small | P1 |
| 4.1 Element validation | Eliminates wrong-element actions | Small | P1 |
| 3.1 Request registry | Enables error recovery on disconnect | Medium | P1 |
| 1.2 Backpressure | Eliminates silent write failures | Small | P1 |
| 1.3 Timeout cleanup | Eliminates orphaned request state | Small | P2 |
| 4.2 MutationObserver | Proactive stale state warnings | Medium | P2 |
| 5.1 Tab scoping | Eliminates wrong-tab actions | Medium | P2 |
| 6.1 Request tracing | Enables cross-layer debugging | Small | P2 |
| 7.1 Graceful shutdown | Clean exit without hanging clients | Small | P2 |

---

## What This PRD Does NOT Cover

| Topic | Why Excluded |
|-------|-------------|
| Dual-channel fallback (WebSocket) | Architecture change, not hardening. Future PRD. |
| Tab group isolation | Requires new Chrome permission + UI. Future PRD. |
| Session recording/replay | New feature, not stability. Future PRD. |
| Heartbeat/keepalive | Low ROI — native messaging connection already keeps SW alive per [CHR-LIFE, line 112]. |
| CLI retry logic | Agent (Claude Code) already manages retries. CLI should fail fast. |
| Element ref IDs (replacing indices) | Fundamental content script redesign. Future PRD. |

---

## Files Modified

| File | Changes |
|------|---------|
| `daemon/index.ts` | Length-prefixed socket framing, backpressure, timeout cleanup, ping handler, graceful shutdown, request tracing |
| `cli/index.ts` | Length-prefixed socket framing, `--tab` flag, request ID stderr logging |
| `extension/src/background.ts` | SW lifecycle listeners, ping/pong, reconnection mutex+backoff, request registry, tab scoping, request tracing |
| `extension/src/content.ts` | sendResponse try/catch, element validation, MutationObserver, DOM dirty warning |

No new files. No new dependencies. No architecture changes.
