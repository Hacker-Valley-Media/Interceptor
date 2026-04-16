# Interceptor — Architecture

This document describes the live architecture as of PRD-32 / PRD-33 / PRD-34. It is not a tutorial — it explains *how the pieces fit*, with file references. For user-facing usage see `README.md` / `CLAUDE.md`. For change rationale see `prd/PRD-*.md`.

---

## High-Level Components

```
 ┌──────────────────────┐    Unix socket    ┌──────────────────────┐
 │ CLI (dist/interceptor)├─────────────────▶│ Daemon                │
 │  cli/commands/*.ts    │                  │ daemon/index.ts       │
 └──────────────────────┘                  └─────────┬────────────┘
                                                     │ native messaging stdio
                                                     │ + WebSocket fallback
                                                     ▼
                                          ┌─────────────────────────┐
                                          │ Chrome / Brave extension │
                                          │ extension/src/*          │
                                          │ (background SW + content │
                                          │  scripts + inject-net)   │
                                          └──────────────┬──────────┘
                                                         │ Unix socket
                                                         ▼
                                          ┌──────────────────────────┐
                                          │ macOS Bridge (Swift)     │
                                          │ interceptor-bridge/*     │
                                          │ (AX, CGEvent, Capture,   │
                                          │  Speech, Vision, NLP)    │
                                          └──────────────────────────┘
```

- **CLI** is a Bun-bundled standalone binary. It parses args, sends an action over `/tmp/interceptor.sock` to the daemon, and prints the response.
- **Daemon** is a singleton (PID at `/tmp/interceptor.pid`). Spawned automatically by Chrome via native messaging, *or* started by the CLI on demand. It bridges CLI ⇄ extension ⇄ bridge, owns event persistence, and tracks per-session monitor artifacts.
- **Extension** is an MV3 service worker plus content scripts + a MAIN-world inject script. It owns DOM capture, ref assignment, monitor session in-memory state, network monkey-patching, and scene-graph access for rich editors.
- **Bridge** is a Swift LaunchAgent-style daemon that exposes macOS-native capabilities (AX tree, CGEvent input, ScreenCaptureKit, AVFoundation audio, Vision/NLP frameworks).

---

## Monitor Subsystem (PRD-32 / PRD-33 / PRD-34)

The monitor is the most architecturally interesting subsystem. Three PRDs shaped its current form.

### Core concepts

A **session** is a user workflow (`SessionRecord`). A session has many sequential **attachments** (`AttachmentRecord`); only one attachment is "active" at a time (handoff, not fanout). An attachment is a `(tabId, documentId)` pair — keyed by document identity, not just tab identity, so reload / SPA pushState / BFCache restore all create new attachments cleanly.

Defined in [`extension/src/background/capabilities/monitor.ts`](extension/src/background/capabilities/monitor.ts).

```typescript
interface SessionRecord {
  sessionId: string
  rootTabId: number
  startedAt: number
  paused: boolean
  seq: number
  counts: { evt; mut; net; nav }
  attachments: Map<string, AttachmentRecord>
  activeAttachmentKey?: string
  lastTrustedAction?: TrustedActionRecord
}

interface AttachmentRecord {
  key: string                     // `${tabId}:${documentId}`
  tabId: number
  documentId?: string
  frameId: number
  url?: string
  openerTabId?: number
  attachedAt: number
  detachedAt?: number
  lifecycle?: string
  reason: "start" | "reload" | "history" | "fragment"
        | "child_tab" | "tab_replaced" | "focus_switch"
}
```

### Triggers that switch attachment

| Trigger | Source | Reason | Notes |
|---|---|---|---|
| `monitor_start` | CLI action | `start` | Initial attachment |
| `webNavigation.onCommitted` | top frame | `reload` / `start` | Hard nav or reload — new `documentId` |
| `webNavigation.onHistoryStateUpdated` | top frame | (no switch, URL update) | SPA pushState |
| `webNavigation.onReferenceFragmentUpdated` | top frame | (no switch, URL update) | Hash change |
| `webNavigation.onTabReplaced` | tab swap | `tab_replaced` | Prerender activation, etc. |
| `tabs.onCreated` + opener-gated heuristic | child tab | `child_tab` | **PRD-32**: child opened by trusted action on monitored tab within 5s |
| `tabs.onActivated` + group membership | manual focus | `focus_switch` | **PRD-34**: user activates another tab in the interceptor group |

`tabs.onActivated` short-circuits if `pendingChildTabs.has(tabId)` so the child-tab path always wins for child-tab cases.

### Privacy boundary

Focus-follow only attaches to tabs in the cyan **interceptor tab group** (`isTabInInterceptorGroup` in [`extension/src/background/tab-group.ts`](extension/src/background/tab-group.ts)). The user's personal tabs are never auto-attached. This boundary is preserved consistently across `tab new`, `tab switch`, and now focus-follow.

### Lifecycle events

Every attachment switch emits `mon_detach` (old) + `mon_attach` (new). Reasons:

| `mon_attach.reason` | Paired `mon_detach.reason` |
|---|---|
| `start` | (none — first attach) |
| `reload` / `history` / `fragment` | `document_replaced` |
| `child_tab` | `child_tab_handoff` |
| `tab_replaced` | `tab_replaced` |
| `focus_switch` | `focus_switch_handoff` |

Plus:

| `mon_detach.reason` | Where |
|---|---|
| `user_stop` | `monitor_stop` action |
| `tab_closed` | `tabs.onRemoved` |

### Durability — three layers (PRD-32)

```
┌─────────────────────────────────┐
│  Extension memory (hot state)   │   sessions Map, activeSessionByTab
│  monitor.ts                     │   ephemeral; rebuilt on SW respawn
└─────────────────────────────────┘
                │ sendToHost (native port → daemon)
                ▼
┌─────────────────────────────────┐
│  Global rolling event log       │   /tmp/interceptor-events.jsonl
│  daemon emitEvent → appendFile  │   useful for `monitor tail`, rotates
└─────────────────────────────────┘
                │ daemon side-write per sid
                ▼
┌─────────────────────────────────────────────────────┐
│  Per-session artifact directory                      │   /tmp/interceptor-monitor-sessions/<sid>/
│  shared/monitor-artifacts.ts                         │     events.jsonl   — full session timeline
│  appendSessionEvent / appendSessionNetArtifact /     │     session.json   — metadata + attachment history
│  updateSessionMeta                                   │     net.jsonl      — persisted correlated bodies
└─────────────────────────────────────────────────────┘
```

`monitor export <sid>` prefers the per-session artifact and falls back to the global log only for legacy sessions (`hasSessionArtifacts(sid)` check in [`cli/commands/monitor.ts:93-99`](cli/commands/monitor.ts)).

### Transport resilience (PRD-33)

`chrome.runtime.Port.postMessage()` throws synchronously if the port is disconnected (Chrome runtime docs). MV3 service workers can be evicted, native ports can disconnect, and `onDisconnect` is asynchronous — so there is a window where `nativePort` is truthy but calls on it throw.

PRD-33 introduced [`extension/src/background/safe-port-post.ts`](extension/src/background/safe-port-post.ts), a pure helper with zero chrome dependency that traps the throw. [`extension/src/background/transport.ts`](extension/src/background/transport.ts) wraps both `nativePort.postMessage` call sites through it; on throw it nulls the reference, downgrades `activeTransport`, and the caller falls through to the WebSocket channel.

`monitor_stop` (and `tabs.onRemoved`) wrap their `detachAttachment` + `sendToHost(mon_stop)` in `try` and run `sessions.delete` / `activeSessionByTab.delete` / `clearPendingChildTabsForSession` in `finally`. Cleanup is now guaranteed even if transport raises.

### Network body persistence (PRD-32)

`extension/src/inject-net.ts` (MAIN world) monkey-patches `fetch` and `XHR`, dispatching `__interceptor_net` custom events with body + content-type. The content script's monitor listens for those events; when a fetch is correlated to a recent trusted user action (`cause`), it builds a redacted, capped preview (`buildBodyPreview` in [`extension/src/content/monitor.ts`](extension/src/content/monitor.ts)) and emits an enriched `fetch` / `xhr` / `sse` event with `bp` (body preview), `bt` (bytes), `trn` (truncated), `ct` (content type) fields.

Daemon-side `persistNetArtifactFromEvent` writes those bodies into `net.jsonl`. `monitor export --with-bodies` reads from `net.jsonl` first ([`cli/commands/monitor.ts:445-448`](cli/commands/monitor.ts)).

Caps: 64 KiB per entry, JSON / text / XML / JS content types only, conservative redaction of `Authorization` / `Cookie` / `Set-Cookie` / token-shaped strings / JWT-shaped tokens.

### Replay plan generation

[`buildPlan`](cli/commands/monitor.ts) walks the session events and emits a runnable `interceptor` script. Notable special cases:

- `mon_attach` with `reason === "child_tab"` → `interceptor tab new "<url>"` + `interceptor wait-stable`
- `mon_attach` with `reason === "focus_switch"` → `interceptor tab switch <tabId>` + `interceptor wait-stable` (PRD-34)
- `mut` between two actions → inserts `interceptor wait-stable`
- `nav` with `typ === "hard" | "reload"` → `interceptor navigate "<url>"`
- masked password `input` → `# TODO` line
- correlated `fetch` / `xhr` with no persisted body → `# interceptor net log --filter ...` cue line

---

## Other Subsystems (Brief)

### Network capture

- **Passive (no CDP):** `extension/src/inject-net.ts` monkey-patches `fetch` and `XHR` in MAIN world. Content script's `extension/src/content/net-buffer.ts` keeps a rolling 500-entry buffer per page. `interceptor net log` reads it.
- **SSE:** `inject-net.ts` recognizes `text/event-stream` responses, dispatches per-chunk events; `net-buffer.ts` assembles streams.
- **Active (CDP-based):** `extension/src/background/cdp.ts` + `cdp-network-actions.ts` provide raw debugger network capture for cases where passive isn't enough. Shows the yellow infobanner — opt-in.

### Scene graph (rich editors)

`extension/src/content/scene/` provides per-host resolvers for Canva (LB layer ids), Google Docs (hidden text-event iframe + `data-ri` offsets), and Google Slides (filmstrip SVG + blob URLs). `interceptor scene profile` detects the host; `interceptor scene list / click / text / insert / slide` operate on the resolver.

### Tab group isolation

[`extension/src/background/tab-group.ts`](extension/src/background/tab-group.ts) maintains the cyan "interceptor" tab group. By default all interceptor commands operate only on tabs in this group; `--any-tab` opts out. PRD-34's focus-follow respects this boundary.

### Transport routing (daemon)

The daemon talks to the extension via three channels, routed by [`daemon/outbound-routing.ts`](daemon/outbound-routing.ts):

- **Native messaging stdio** — when daemon was spawned by Chrome
- **WebSocket** (`ws://localhost:19222`) — fallback / preferred for action requests
- **Native relay** — secondary daemon instances become transparent stdin/stdout bridges to the singleton (eliminates the every-30-second native-host disconnect noise; introduced in [#28](https://github.com/Hacker-Valley-Media/interceptor/pull/28))

### macOS bridge

[`interceptor-bridge/`](interceptor-bridge/) is a Swift Package binary launched as a LaunchAgent. It exposes:

- AX tree + CGEvent input (`AccessibilityDomain`, `InputDomain`, `AppsDomain`, `MenuDomain`)
- ScreenCaptureKit (`CaptureDomain`, `StreamDomain`, `DisplayDomain`)
- AVFoundation + speech + sound classification (`SpeechDomain`, `SoundDomain`, `AudioDomain`)
- Vision + NLP + on-device LLM (`VisionDomain`, `NLPDomain`, `IntelligenceDomain`)
- File watch / notifications / clipboard (`FilesDomain`, `NotificationsDomain`, `ClipboardDomain`)
- Native macOS monitor (`MonitorDomain`) — same JSON event schema as browser monitor

Communication: CLI / daemon → Unix socket (`/tmp/interceptor-bridge.sock`) → bridge router → domain handler → CGEvent / AX / etc.

---

## Build Outputs

| Artifact | Source | Purpose |
|---|---|---|
| `dist/interceptor` | `cli/index.ts` (Bun bundle + compile) | Standalone CLI binary |
| `daemon/interceptor-daemon` | `daemon/index.ts` (Bun bundle + compile) | Singleton daemon |
| `dist/interceptor-bridge` | `swift build -c release` | macOS native bridge |
| `extension/dist/background.js` | `extension/src/background.ts` (Bun bundle, target=browser) | MV3 service worker |
| `extension/dist/content.js` | `extension/src/content.ts` (Bun bundle, target=browser) | Content script |
| `extension/dist/inject-net.js` | `extension/src/inject-net.ts` (Bun bundle, target=browser) | MAIN-world net interceptor |

`bash scripts/build.sh` builds the extension + CLI + daemon. The Swift bridge is built separately via `bash scripts/build-bridge.sh` (it requires Swift toolchain).

---

## PRD Index

| PRD | Subject | Status |
|---|---|---|
| [PRD-32](prd/PRD-32.md) | Document-scoped sessions, child-tab handoff, durable artifacts, body persistence | Implemented |
| [PRD-33](prd/PRD-33.md) | Transport resilience — `monitor stop` non-throw on disconnected port | Implemented |
| [PRD-34](prd/PRD-34.md) | Focus-follow — auto-attach to manually switched tabs in the interceptor group | Implemented |

Older PRDs (`PRD-18` through `PRD-31`) document the evolution from single-tab monitor and pre-compound-command CLI to today's architecture; consult them for historical context.
