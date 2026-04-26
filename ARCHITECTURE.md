# Interceptor — Architecture

This document describes the live architecture as of the current monitor, CSP-fallback, and native-capture implementation. It is not a tutorial — it explains *how the pieces fit*, with file references. For user-facing usage see `README.md` / `AGENTS.md`.

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

### CLI-first browser install

- The primary repo install path builds `dist/interceptor`, `daemon/interceptor-daemon`, and `extension/dist/`, then runs `scripts/install.sh --brave --profile <profile>`.
- `scripts/install.sh` writes native messaging host manifests for Chrome and Brave, then launches Brave with `--load-extension=extension/dist`. If Brave is already running, the script prompts before quitting and relaunching it.
- Google Chrome branded desktop builds ignore `--load-extension`; the Chrome CLI path installs native messaging metadata, but the unpacked extension must be loaded manually from `chrome://extensions`.
- `interceptor macos trust` is a permission snapshot for native macOS automation. Browser runtime health should be checked through `interceptor status`, which confirms daemon, extension, and browser bridge state.

---

## Monitor Subsystem

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
| `tabs.onCreated` + opener-gated heuristic | child tab | `child_tab` | child opened by trusted action on monitored tab within 5s |
| `tabs.onActivated` + group membership | manual focus | `focus_switch` | user activates another tab in the interceptor group |

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

### Transport resilience

`chrome.runtime.Port.postMessage()` throws synchronously if the port is disconnected (Chrome runtime docs). MV3 service workers can be evicted, native ports can disconnect, and `onDisconnect` is asynchronous — so there is a window where `nativePort` is truthy but calls on it throw.

[`extension/src/background/safe-port-post.ts`](extension/src/background/safe-port-post.ts) is a pure helper with zero chrome dependency that traps a synchronous `Port.postMessage()` throw. [`extension/src/background/transport.ts`](extension/src/background/transport.ts) wraps both `nativePort.postMessage` call sites through it; on throw it nulls the reference, downgrades `activeTransport`, and the caller falls through to the WebSocket channel.

`monitor_stop` (and `tabs.onRemoved`) wrap their `detachAttachment` + `sendToHost(mon_stop)` in `try` and run `sessions.delete` / `activeSessionByTab.delete` / `clearPendingChildTabsForSession` in `finally`. Cleanup is now guaranteed even if transport raises.

### Network body persistence (PRD-32)

`extension/src/inject-net.ts` (MAIN world) monkey-patches `fetch` and `XHR`, dispatching `__interceptor_net` custom events with body + content-type. The content script's monitor listens for those events; when a fetch is correlated to a recent trusted user action (`cause`), it builds a redacted, capped preview (`buildBodyPreview` in [`extension/src/content/monitor.ts`](extension/src/content/monitor.ts)) and emits an enriched `fetch` / `xhr` / `sse` event with `bp` (body preview), `bt` (bytes), `trn` (truncated), `ct` (content type) fields.

Daemon-side `persistNetArtifactFromEvent` writes those bodies into `net.jsonl`. `monitor export --with-bodies` reads from `net.jsonl` first ([`cli/commands/monitor.ts:445-448`](cli/commands/monitor.ts)).

Caps: 64 KiB per entry, JSON / text / XML / JS content types only, conservative redaction of `Authorization` / `Cookie` / `Set-Cookie` / token-shaped strings / JWT-shaped tokens.

### Replay plan generation

[`buildPlan`](cli/commands/monitor.ts) walks the session events and emits a runnable `interceptor` script. Notable special cases:

- `mon_attach` with `reason === "child_tab"` → `interceptor tab new "<url>"` + `interceptor wait-stable`
- `mon_attach` with `reason === "focus_switch"` → `interceptor tab switch <tabId>` + `interceptor wait-stable`
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

### Frame-aware read surfaces

`interceptor read --include-frames` is routed by `cli/commands/compound.ts` to `frames_read_tree` in `extension/src/background/capabilities/frames.ts`. The background handler uses `chrome.webNavigation.getAllFrames({ tabId })`, sends `get_a11y_tree` into each reachable frame, and rewrites non-top refs from `[eN]` to `[e<frameId>_<N>]` before returning the combined tree.

Framed refs are round-trippable. `parseElementTarget` preserves `frameId` and `ref`, `buildReadTreeAction` passes them into `frames_read_tree`, and the frame handler filters to the requested frame before asking the content script for the subtree. Content-side `get_a11y_tree`, `extract_text`, and `extract_html` accept both `index` and `ref`, so `interceptor read e22_1 --tree-only --include-frames` returns the child-frame subtree instead of the whole multi-frame page.

### Canvas observability

`extension/src/inject-canvas.ts` runs in MAIN world and wraps canvas APIs such as `getContext`, `fillText`, `strokeText`, `fillRect`, path drawing, and image drawing. It stores a page-local `window.__interceptorCanvasObserver` with three buffers: raw operation log entries, derived objects, and registered canvas metadata. HTML canvas metadata includes DOM order as `domIndex`, which is the index shown by `interceptor canvas list`.

`extension/src/background/capabilities/canvas.ts` exposes the CLI-facing canvas actions. `canvas status` combines DOM canvas discovery with host/app-model signals. `canvas log [N]` and `canvas objects [N]` execute self-contained page-world summary functions against the observer, resolve DOM canvas index `N` to the observer's internal `canvasId`, and then filter logs or derived objects to that canvas. This keeps multi-canvas pages separated while preserving global queries when no index is supplied.

`canvas model` inspects host-specific state such as hidden Google Docs mirrors and Excalidraw-like globals/localStorage. `canvas routes` ranks passive network entries that look like canvas/editor persistence routes. `canvas read` exports pixels from DOM or WebGL canvases; `canvas ocr` is present but should be treated as experimental until its offscreen OCR path is revalidated.

### Page-world eval on strict-CSP sites

`extension/src/background/capabilities/evaluate.ts` now treats page CSP as a first-class runtime concern. On a `MAIN`-world eval failure that matches a CSP/`unsafe-eval` pattern, it installs a tab-scoped **session** `declarativeNetRequest` rule that strips `content-security-policy` and `content-security-policy-report-only`, reloads the tab, then retries once. This is the behavior proven against OpenStreetMap during live validation.

`extension/src/background/capabilities/meta.ts` also exposes `userScripts` capability diagnostics so live validation can distinguish between the `userScripts` route and the CSP-bypass fallback.

### Scene graph (rich editors)

`extension/src/content/scene/` provides per-host resolvers for Canva (LB layer ids), Google Docs (hidden text-event iframe + `data-ri` offsets), and Google Slides (filmstrip SVG + blob URLs). `interceptor scene profile` detects the host; `interceptor scene list / click / text / insert / slide` operate on the resolver.

### Tab group isolation

[`extension/src/background/tab-group.ts`](extension/src/background/tab-group.ts) maintains the cyan "interceptor" tab group. By default all interceptor commands operate only on tabs in this group; `--any-tab` opts out. Focus-follow respects this boundary.

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

For screenshot saving, `interceptor-bridge/Sources/Domains/CaptureDomain.swift` no longer relies on `FileManager.default.currentDirectoryPath` when running under `launchd`. The CLI passes its working directory (`cli/commands/macos.ts`), and the bridge falls back through Downloads, home, then temp so `interceptor macos screenshot --save` works cleanly under LaunchAgent execution.

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
| `extension/dist/inject-canvas.js` | `extension/src/inject-canvas.ts` (Bun bundle, target=browser) | MAIN-world canvas observer |
| `extension/dist/offscreen.js` | `extension/src/offscreen.ts` (Bun bundle, target=browser) | Extension offscreen worker for OCR/image helpers |

`bash scripts/build.sh` builds the extension, CLI, daemon, and macOS bridge when Swift is available. Windows builds skip the macOS bridge.

---

## Screenshot Pipeline

Two distinct capture paths share the `interceptor screenshot` surface:

### DOM render (default)

The default path renders the page's DOM directly to a canvas inside the target tab — no `chrome.tabs.captureVisibleTab`, no `chrome.tabCapture`, no browser focus or visibility requirement.

1. **Library injection.** `extension/src/screenshot-runner.ts` is a small bundle entry that imports a vendored copy of `html-to-image` and assigns it to `globalThis.__interceptor_h2i`. The bundle is built to `extension/dist/screenshot-runner.js` (~30 KB) and loaded on demand via `chrome.scripting.executeScript({ files: ["screenshot-runner.js"], world: "ISOLATED" })`. It is **not** registered as a `content_scripts` entry — pages that never get screenshotted pay no cost.
2. **CORS clearance.** Before the render, the SW installs a `chrome.declarativeNetRequest` session rule (`extension/src/background/capabilities/screenshot-cors.ts`) scoped to `tabIds: [tabId]` and `resourceTypes: [image, font, media, stylesheet, xmlhttprequest]`. The rule sets `Access-Control-Allow-Origin: *`, removes `Access-Control-Allow-Credentials`, and sets `Cross-Origin-Resource-Policy: cross-origin` for the duration of the capture, then is removed in a `try/finally`. The rule lifecycle mirrors the CSP-bypass rule used by `evaluate.ts`.
3. **Render.** `extension/src/content/dom-screenshot.ts` resolves the target node by mode (`full` → `document.documentElement`, `element` → refRegistry lookup, `selector` → `querySelector`, `region` → full + in-frame canvas crop) and calls `__interceptor_h2i.toPng`/`toJpeg`. Options include `cacheBust: true`, `imagePlaceholder` (a 1×1 transparent PNG), and `fetchRequestInit: { mode: "cors", cache: "no-cache" }`. If the first attempt throws a tainted-canvas error, the handler retries with a `filter` that excludes `<img>`, `<picture>`, `<video>`, and `<canvas>` so structural captures still succeed when third-party assets cannot be CORS-cleansed.
4. **Region crop in-frame.** For `--region`, the content script renders the full page once and then crops via a regular `<canvas>.drawImage` + `toDataURL` inside the same frame, so the inter-process message back to the SW carries only the cropped result instead of a multi-MB full-page payload.

### Pixel-true compositor capture (`--pixel`)

`--pixel` opts into the legacy `chrome.tabs.captureVisibleTab` path. It produces compositor-accurate output (hardware video frames, GPU filters, exact compositor pixels) but requires the browser window to be visible and focused. Single-viewport captures complete in ~50 ms when the window is focused.

`--pixel --full` scrolls the page and captures one viewport-sized strip per scroll position. Strip cadence is set above 1 second to clear Chrome's `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` quota (default 2/sec). Strips are stitched together inside the SW using `OffscreenCanvas` + `createImageBitmap` + `convertToBlob` — explicitly **not** routed through the offscreen-document `stitch` handler, because the IPC return path for multi-MB stitched results is unreliable.

### Transport routing

Screenshot responses can carry tens to hundreds of KB of base64 dataUrl. Empirical testing on Brave/Chromium showed the native-messaging port silently drops messages above ~50 KB despite the documented 1 MB cap, so the CLI auto-enables WebSocket transport for any `screenshot` invocation (`cli/index.ts`). `--no-ws` overrides if the user wants the native path.

---

## Implementation Notes

Recent major additions reflected in this document:

- DOM-render screenshot pipeline as the default capture path; `--pixel` retains the legacy `captureVisibleTab` route as an opt-in
- per-tab CORS-clearance session DNR rule scoped to subresource fetches during a capture
- in-SW `OffscreenCanvas` stitching for `--pixel --full` so multi-MB responses no longer round-trip through the offscreen document
- automatic WebSocket routing for `screenshot` CLI invocations
- CLI-first Brave install path through `scripts/install.sh --brave --profile <profile>`
- frame-targeted `read --include-frames` with subtree refs preserved end-to-end
- canvas observer summaries that filter `log` and `objects` by DOM canvas index
- document-scoped monitor sessions with child-tab handoff and focus-follow
- transport hardening around disconnected native ports
- strict-CSP `eval --main` fallback via tab-scoped CSP stripping and retry
- launchd-safe macOS screenshot saving
