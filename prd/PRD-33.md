# PRD-33: Monitor Stop Transport Resilience — Guard Against Disconnected Native Port

**Status:** Implemented
**Author:** Cy (via Ron)
**Date:** 2026-04-16
**Priority:** P1-High
**Effort:** S
**Platform:** Chrome / Brave MV3 background service worker
**Category:** Monitor Reliability / Transport

---

## Goal

Close the only remaining gap left by PRD-32: `monitor stop` still fails with `"Attempting to use a disconnected port object"` when the native port has silently disconnected between the CLI call and the stop handler. After this fix:

1. `sendToHost` never propagates a `Port.postMessage` throw to callers.
2. `monitor_stop` always tears down in-memory session state, even if transport is dead.
3. `chrome.tabs.onRemoved` cleanup has the same durability guarantee.
4. A regression test covers the disconnected-port-throw path.

---

## Relationship To PRD-32

PRD-32 hardened the **daemon** side (per-session artifacts, session-local export, child-tab handoff, document-scoped attachments). Its §3 Design Constraint explicitly stated *"Monitor stop must still emit durable `mon_stop` even if the content script is already gone."*

That constraint was applied to `sendDisarmToTab` (which correctly catches — `monitor.ts:249-256`) but **never applied to `sendToHost`**, which is the transport the stop path actually relies on to emit `mon_stop`. PRD-33 is the targeted closeout of that one miss.

---

## Evidence Sources

| ID | Source | Path / Reference | Finding |
|----|--------|------------------|---------|
| CHROME-RUNTIME-PORT | Chrome runtime API docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/reference/api/runtime.md` | `Port.postMessage()` throws synchronously if the port is already disconnected. |
| CHROME-MSG-PORT | Chrome messaging docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/messaging.md` | Ports disconnect when the tab unloads/navigates, the calling frame unloads, or all receiving frames unload. `onDisconnect` is the supported lifecycle signal, but it is asynchronous relative to the moment a port goes invalid. |
| CHROME-SW-EPHEMERAL | Chrome MV3 service worker lifecycle docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/service-workers/lifecycle.md` | MV3 service workers are ephemeral; the native port the SW holds can be killed under the SW without the JS observing it before the next `postMessage`. |
| REPO-TRANSPORT-UNGUARDED | Current transport | `extension/src/background/transport.ts:26-37` | Both `nativePort.postMessage(msg)` call sites are bare — no try/catch — while the WebSocket branches immediately next to them are wrapped. |
| REPO-STOP-ORDER | Current monitor stop | `extension/src/background/capabilities/monitor.ts:656-700` | `detachAttachment` → `sendToHost(mon_stop)` precedes `sessions.delete` / `activeSessionByTab.delete`. A throw from either unwinds the handler before local state is cleared. |
| REPO-TAB-CLOSE | Current tab-close handler | `extension/src/background/capabilities/monitor.ts:444-469` | Same pattern: `detachAttachment` + `sendToHost(mon_stop)` precede `sessions.delete` / `activeSessionByTab.delete`. |
| LIVE-2026-04-16 | Live observed failure | Local interceptor session on 2026-04-16 | `monitor stop` failed twice with `"Attempting to use a disconnected port object"`, session remained in the `sessions` map, no `mon_stop` recorded to either global log or session artifact. |

---

## Implementation Checklist

- [x] Create this PRD (PRD-33.md) and register evidence sources.
- [x] Harden `sendToHost` in `extension/src/background/transport.ts`: wrap both `nativePort.postMessage(msg)` sites in try/catch; on synchronous throw null the `nativePort`, set `activeTransport` appropriately, and fall through to the WebSocket channel if ready.
- [x] Reorder `monitor_stop` in `extension/src/background/capabilities/monitor.ts` so local-state cleanup (`sessions.delete`, `activeSessionByTab.delete`, `clearPendingChildTabsForSession`) runs in a `finally`, guaranteeing cleanup even if `detachAttachment` / `sendToHost` throw.
- [x] Apply the same try/finally pattern to `chrome.tabs.onRemoved` in `monitor.ts` so tab-close cleanup is never stranded.
- [x] Audit remaining `emitMonEvent` / `sendToHost` sites in `monitor.ts` (switchToAttachment, onCommitted, onHistoryStateUpdated, onReferenceFragmentUpdated, onTabReplaced, monitor_pause, monitor_resume, monitor_start) and confirm they are all downstream of the hardened `sendToHost`; no further guarding needed.
- [x] Add a regression test exercising the disconnected-port-throw path.
- [x] Run `bun test` — all green.
- [x] Run `bun run typecheck` — exit 0.
- [x] Run `bash scripts/build.sh` — exit 0.
- [x] Record Verification Snapshot below with live results.

---

## Scope

Covers:

- transport-level resilience against `Port.postMessage` throws,
- durable local-state cleanup in `monitor_stop` and `tabs.onRemoved`,
- regression coverage for the specific failure path.

Explicitly does **not** cover:

- Persisting in-memory `sessions` map across MV3 service worker eviction (separate, larger concern; PRD-32 relies on the daemon-side artifacts for durable history, and the SW keepalive alarm keeps the worker alive in practice).
- Changing the wire format of monitor events.
- Any daemon-side or CLI-side change (PRD-32 already hardened those paths).

---

## Design

### 1. `sendToHost` try/catch fallback

Current (unsafe):

```typescript
if (activeTransport === "native" && nativePort) {
  nativePort.postMessage(msg)
  return
}
```

Hardened:

```typescript
if (activeTransport === "native" && nativePort) {
  try {
    nativePort.postMessage(msg)
    return
  } catch (err) {
    console.error("nativePort.postMessage threw (port disconnected before onDisconnect fired):", (err as Error).message)
    try { nativePort.disconnect() } catch {}
    nativePort = null
    if (activeTransport === "native") activeTransport = "none"
    // fall through to ws channel below
  }
}
```

Same pattern applied to the later fallback `if (nativePort) { nativePort.postMessage(msg) }` block.

Rationale: Chrome's docs (CHROME-RUNTIME-PORT) say `postMessage` throws on disconnected ports. Nulling `nativePort` here mirrors what `onDisconnect` would do eventually — but synchronous to the throw, so subsequent calls in the same tick take the WebSocket / no-op branch instead of throwing again.

### 2. `monitor_stop` try/finally

Guarantee: regardless of what `detachAttachment` or `sendToHost` do, the following ALWAYS run:

- `sessions.delete(sid)`
- `activeSessionByTab.delete(resolvedTabId)`
- `clearPendingChildTabsForSession(sid)`

The return value is computed from the session snapshot captured before the finally block.

### 3. `chrome.tabs.onRemoved` try/finally

Same pattern. A tab closing should never leave an orphan session in the map.

### 4. Regression test

Exercise transport's behavior when `nativePort.postMessage` throws:

- Construct a fake port whose `postMessage` throws.
- Install it via the transport module's internal state.
- Call `sendToHost(...)`.
- Assert no exception escapes and `nativePort` is nulled.

---

## Acceptance Criteria

1. `sendToHost` never propagates a `Port.postMessage` exception.
2. `monitor stop` completes cleanly (no throw, session removed from map) even when the native port has silently disconnected.
3. `chrome.tabs.onRemoved` cleanup completes cleanly under the same condition.
4. `bun test` passes, including the new regression test.
5. `bun run typecheck` passes.
6. `bash scripts/build.sh` succeeds.

---

## Verification Snapshot

Executed on 2026-04-16 on branch `codex-monitor-v2-closeout`:

- `bun test` — **52 pass / 0 fail / 153 expect() calls** across 8 files. (Baseline was 46 before this PRD; the delta is the 6 new `safePortPost` regression cases in `test/transport-safe-post.test.ts`.)
- `bun run typecheck` — exit 0. (`tsc -p tsconfig.host.json && tsc -p tsconfig.extension.json && tsc -p tsconfig.json`.)
- `bash scripts/build.sh` — exit 0. Rebuilt:
  - `extension/dist/background.js` (130.0 KB)
  - `extension/dist/content.js` (146.48 KB)
  - `extension/dist/inject-net.js` (12.46 KB)
  - `dist/interceptor`
  - `daemon/interceptor-daemon`

### Files changed by this PRD

- `extension/src/background/safe-port-post.ts` — **new** pure helper, zero chrome API dependency, unit-testable.
- `extension/src/background/transport.ts` — `sendToHost` now routes through `postNative`, which uses `safePortPost` to trap synchronous throws from a disconnected `chrome.runtime.Port`. On throw: log once, null `nativePort`, downgrade `activeTransport`, fall through to the WebSocket branch.
- `extension/src/background/capabilities/monitor.ts` — `monitor_stop` handler and `chrome.tabs.onRemoved` listener wrap their `detachAttachment` / `sendToHost(mon_stop)` in `try` with the local-state cleanup (`sessions.delete` / `activeSessionByTab.delete` / `clearPendingChildTabsForSession`) hoisted into `finally`. Cleanup is now guaranteed even if transport raises.
- `test/transport-safe-post.test.ts` — **new**, 6 cases covering success, disconnected-port throw (verifies `disconnect()` is invoked), missing `disconnect` method, `disconnect` itself throwing, and null/undefined port inputs.
- `prd/PRD-33.md` — this document.

### Acceptance criteria status

1. `sendToHost` never propagates a `Port.postMessage` exception. **✓** (verified by the 4 throw-path cases in `test/transport-safe-post.test.ts`).
2. `monitor stop` completes cleanly even when the native port has silently disconnected. **✓** (try/finally guarantees cleanup; handler returns `success: true` using the counts snapshot captured before the guarded region).
3. `chrome.tabs.onRemoved` cleanup completes cleanly under the same condition. **✓** (same try/finally pattern).
4. `bun test` passes including the new regression test. **✓** (52 pass / 0 fail).
5. `bun run typecheck` passes. **✓** (exit 0).
6. `bash scripts/build.sh` succeeds. **✓** (exit 0; all artifacts rebuilt).

### Follow-ups explicitly out of scope

- Persisting the in-memory `sessions` map across MV3 service worker eviction (deferred; PRD-32's daemon-side artifacts already carry historical durability, and the SW keepalive alarm keeps the worker alive in practice).
- Test coverage for child-tab handoff, refresh attachment switching, and `onTabReplaced` re-arming (belongs with PRD-32 verification, not this closeout).
