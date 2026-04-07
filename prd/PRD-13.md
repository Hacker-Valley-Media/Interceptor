# PRD-13: Session Monitor — Capture User Actions, DOM Mutations, and Network Side Effects for Agent Replay

**Goal:** Add a `slop monitor` command surface that records a complete trace of a user's interaction session — every real click, keystroke, form change, navigation, DOM mutation, and network call the page made as a consequence — in a single sparse append-only log that an agent can read back and replay as a batch of `slop` commands. No CDP. No debugger infobanner. No pretty-printed JSON.

**Scope:** New `extension/src/content/monitor.ts` (ISOLATED world capture-phase listeners + MutationObserver + `__slop_net` subscription), new `background/capabilities/monitor.ts` (state, webNavigation wiring, event fan-out), new `cli/commands/monitor.ts` (start / stop / status / tail / export / replay-plan). Reuses the existing `EVENTS_PATH` JSONL stream in the daemon for persistence and the existing `sendToHost({ type: "event", ... })` bridge for transport.

**Non-Negotiable:**
1. **No CDP.** This PRD must not attach `chrome.debugger`. The whole point of the monitor is to be invisible to the page and to the user (no yellow infobanner, no viewport shift).
2. **Sparse format.** One event per line. No pretty-printed JSON with 80 spaces of indent. Each event ≤ ~300 bytes in the common case. Agents consume this on a budget.
3. **Capture-phase, passive.** Listeners use `{ capture: true, passive: true }` so a misbehaving page handler can never stop us from seeing the event, and we never interfere with the page's own handlers.
4. **Correlated.** Every user action is tagged with a monotonic session-local `seq` and wall-clock `ts`. Every network call fired within N ms of that action is tagged with the same `cause` seq, so an agent can read "click #7 caused /api/search fetch and 3 DOM mutations in 180ms."
5. **Replayable.** `slop monitor export --as plan` produces a plain text batch of `slop` commands reproducible without the source session — not a JSON dump.

---

## Evidence Sources

| ID | Source | Path | How to access |
|----|--------|------|---------------|
| SLOP-CONTENT | content script entry + dispatcher | `extension/src/content.ts` | `read` |
| SLOP-INJECT | MAIN-world fetch/XHR patch | `extension/src/inject-net.ts` | `read` — emits `__slop_net` CustomEvent |
| SLOP-NETBUF | net-buffer + `__slop_net` listener | `extension/src/content/net-buffer.ts` | `read` — where content script subscribes today |
| SLOP-DOMOBS | existing MutationObserver | `extension/src/content/dom-observer.ts` | `read` — sets `domDirty` flag only, doesn't emit |
| SLOP-REFREG | element ref registry (`e1`, `e2`, ...) | `extension/src/content/ref-registry.ts` | `read` — stable element IDs for replay |
| SLOP-A11Y | effective role + accessible name | `extension/src/content/a11y-tree.ts` | `read` — `getEffectiveRole`, `getAccessibleName` |
| SLOP-INPUT | click/key dispatch sequence | `extension/src/content/input-simulation.ts` | `read` — `dispatchClickSequence`, `dispatchKeySequence` |
| SLOP-TRANSPORT | extension → daemon event bridge | `extension/src/background/transport.ts` | `read` — `sendToHost({ type: "event", event, ...data })` |
| SLOP-DAEMON | daemon event persistence | `daemon/index.ts` lines 11-24 | `read` — `emitEvent()` → `appendFileSync(EVENTS_PATH, ...)` with 10MB rotation |
| SLOP-EVENTS-CLI | existing `slop events` command | `cli/commands/meta.ts` case `"events"` | `read` — tail + since filter already work |
| SLOP-PLATFORM | EVENTS_PATH config | `shared/platform.ts` | `/tmp/slop-browser-events.jsonl`, 10 MB cap |
| SLOP-ROUTER | action routing | `extension/src/background/router.ts` | `read` — where new monitor actions register |
| SLOP-MANIFEST | MV3 permissions | `extension/manifest.json` | Already has `webNavigation`, `scripting`, `tabs`, `activeTab`; no new permissions needed |
| CHR-CS | Chrome content scripts (isolated / MAIN worlds, `run_at`) | `80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/content-scripts.md` | Line 33: "Content scripts live in an isolated world" — line 144: `world` defaults to ISOLATED |
| CHR-MSG | Chrome messaging | `80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/messaging.md` | Line 12: one-time vs long-lived; line 239: `chrome.runtime.connect` for streaming |
| CHR-WEBNAV | webNavigation API | `80_Reference/docs/chrome-extensions/docs/extensions/reference/api/webNavigation.md` | Line 48: `onHistoryStateUpdated` fires on `history.pushState`; line 858: handler signature |
| CHR-SCRIPTING | scripting.executeScript / registerContentScripts | `80_Reference/docs/chrome-extensions/docs/extensions/reference/api/scripting.md` | For on-demand monitor injection instead of always-on |
| BUN-FILE | `Bun.file().writer()` FileSink | `80_Reference/docs/bun/docs/runtime/file-io.md` lines 157-200 | Incremental writes, buffered, `flush()` + `end()` |
| BUN-JSONL | `Bun.JSONL.parse()` | `80_Reference/docs/bun/docs/runtime/jsonl.md` lines 5-39 | Built-in JSONL parser for CLI-side replay |
| DOM-CAPTURE | capture-phase `addEventListener` + `composedPath()` | DOM spec (no local doc) | `{ capture: true }` fires before target's listeners; `composedPath()` crosses shadow roots |
| DOM-TRUSTED | `Event.isTrusted` | DOM spec (no local doc) | `true` for user-generated events, `false` for `dispatchEvent()` — critical to distinguish a real user click from slop's own click simulation |

---

## The Problem

### What Ron actually wants to do

> "I want to be able to capture exactly where the user is clicking and also what are the subsequent things that happen down the stack when something is clicked... monitor my clicks and also monitor some of those JavaScript changes that happen in the background, just so an agent can repeat this process."

Translated: Ron performs a task in the browser once, manually. slop writes down what he did AND what the page did in response. Later, an agent reads the trace, understands the flow, and replays it as a batch of `slop` commands — including knowing which XHR call produced the data it needs to extract.

This is a **teaching loop**: Ron → slop → agent. Ron demonstrates. Agent learns. Agent repeats.

### Why the pieces we already have don't cover it

| Piece we have | What it does | What's missing |
|---------------|--------------|----------------|
| `inject-net.ts` | Captures fetch/XHR passively | No correlation with user actions. A log of 200 XHRs with no "which click caused which call" is useless for replay. |
| `net-buffer.ts` | Buffers 500 net entries in content script | Buffer lives in-tab, is flushed on navigation, never written to disk. A 30-minute session is lost the moment the tab closes. |
| `dom-observer.ts` | MutationObserver sets `domDirty` flag | Doesn't emit events, doesn't remember what changed, doesn't stream. Only answers "did anything change since last tree read?" |
| `snapshot-diff.ts` | Diffs two refRegistry snapshots | Manual — you must call `cacheSnapshot()` before and `computeSnapshotDiff()` after. No streaming, no correlation to actions. |
| `input-simulation.ts` | Dispatches synthetic clicks / keys for slop's own commands | Only the *outbound* direction. Does not observe user input at all. |
| `slop events` CLI | Tails the daemon event log | Only shows slop's own request/response cycle (`request_received`, `request_complete`) — not user clicks, not page DOM, not page network. |
| `chrome.debugger` / CDP | Could in principle dispatch Input events from DevTools protocol | Shows yellow infobanner, shifts viewport [SLOP-CONTENT: comments about `chrome.debugger` infobanner], detected by anti-bot checks. Non-negotiable: **no CDP**. |

We have the low-level primitives — MutationObserver, `__slop_net`, ref registry, a11y tree, event log — but there is **no component that ties real-user input to DOM mutations to network calls into a single correlated stream, and no component that writes that stream anywhere an agent can read it later**.

That component is this PRD.

---

## Architecture

### Overview

```
┌───────────────────────── Chrome Tab ─────────────────────────┐
│                                                                │
│  MAIN world  (inject-net.ts — already exists)                  │
│  ─────────────────────────────────────────────                 │
│  window.fetch, XHR.prototype monkey-patches                    │
│              │ CustomEvent('__slop_net', detail)               │
│              ▼                                                 │
│  ISOLATED world  (content.ts + new content/monitor.ts)         │
│  ─────────────────────────────────────────────                 │
│  document.addEventListener(                                    │
│    'click' 'input' 'change' 'submit' 'keydown' 'scroll',       │
│    { capture: true, passive: true }                            │
│  )                                                             │
│  MutationObserver(document.documentElement, deep)              │
│  __slop_net listener (from net-buffer, reused)                 │
│              │                                                 │
│              ▼                                                 │
│  Monitor state                                                 │
│    seq counter                                                 │
│    cause stack (last 3 user actions within 500ms)              │
│    mutation batcher (coalesce @ 50ms)                          │
│    event serializer (sparse wire format)                       │
│              │ chrome.runtime.sendMessage({ type: 'mon_evt' }) │
└──────────────┼─────────────────────────────────────────────────┘
               ▼
┌──────────── Background Service Worker ─────────────────────────┐
│  router.ts dispatches to background/capabilities/monitor.ts    │
│    session state: { id, tabId, startedAt, paused }             │
│    webNavigation listeners (history.pushState / onCommitted)   │
│    sendToHost({ type: 'event', event: 'mon_*', ...data })      │
└──────────────┼─────────────────────────────────────────────────┘
               ▼ native messaging / websocket
┌──────────── daemon/index.ts (Bun) ─────────────────────────────┐
│  handleNativeMessage → emitEvent('mon_*', ...)                 │
│  → appendFileSync(EVENTS_PATH, line + '\n')                    │
│  → rotates at 10 MB                                            │
└──────────────┼─────────────────────────────────────────────────┘
               ▼
           /tmp/slop-browser-events.jsonl
               ▲
┌──────────── slop CLI ──────────────────────────────────────────┐
│  slop monitor start  → action: { type: 'monitor_start' }       │
│  slop monitor stop   → action: { type: 'monitor_stop' }        │
│  slop monitor status → action: { type: 'monitor_status' }      │
│  slop monitor tail   → reads EVENTS_PATH directly, filters     │
│  slop monitor export → Bun.JSONL.parse + sparse render         │
│  slop monitor plan   → emit batch of 'slop <cmd>' lines        │
└────────────────────────────────────────────────────────────────┘
```

### Why this layout

- **Capture-phase listeners in ISOLATED world** instead of MAIN world: we only need to OBSERVE, not to intercept. ISOLATED is already where `content.ts` and `net-buffer.ts` live, so we inherit the existing `__slop_net` subscription without crossing worlds. Capture phase + `passive: true` means page handlers can't `stopPropagation()` us and we can't block page behavior [DOM-CAPTURE].
- **MutationObserver on `document.documentElement`** instead of `document.body`: catches attribute changes on `<html>` (common in SPA theme toggles and `lang` changes) and the body-swap case some frameworks do on route transitions. Subtree + attributes + childList + characterData.
- **`chrome.runtime.sendMessage` per event** is fire-and-forget — we don't need a port because we never wait for an ack. If the service worker is asleep, MV3 wakes it [CHR-MSG]. If bursts become a problem, Phase 4 adds a batched port.
- **Daemon reuses `emitEvent()`**: no new transport. Events land in the existing `/tmp/slop-browser-events.jsonl` [SLOP-DAEMON lines 11-24], which already rotates at 10 MB [SLOP-PLATFORM: `EVENTS_MAX_SIZE = 10 * 1024 * 1024`], and `slop events` already tails it [SLOP-EVENTS-CLI]. The monitor is a new *consumer schema* on an existing pipe.
- **webNavigation.onHistoryStateUpdated** catches SPA navigation without CDP and without monkey-patching `history.pushState` [CHR-WEBNAV line 48]. The permission is already granted [SLOP-MANIFEST].

### Session lifecycle

1. `slop monitor start` → CLI sends `monitor_start` to background.
2. Background records `{ sessionId: uuid, tabId, startedAt: Date.now(), instruction?: string }`, tells the content script to arm listeners, and registers the webNavigation listener for that `tabId`.
3. Background emits `mon_start` event with the session record.
4. User interacts with the page. Content script streams `mon_*` events.
5. `slop monitor stop` → background unregisters listeners, tells content script to disarm, emits `mon_stop` with `endedAt` + counts.
6. Sessions are delimited in the event log by `mon_start` / `mon_stop` pairs containing `sessionId`. A single `EVENTS_PATH` holds multiple sessions historically — the CLI filters by `sessionId`.

### Optional instruction priming

Per Ron's ask — *"especially if a user gives the instruction beforehand"*:

```
slop monitor start --instruction "search for bun docs, open the first result, copy the first paragraph"
```

The instruction string is attached to `mon_start`. `slop monitor export` prints it as the first line of the export. An agent reading the trace has both the *intent* (what Ron wanted to do) and the *observation* (what Ron actually did). This makes the replay much more robust — the agent can tell whether a particular click was essential or an accidental misclick.

---

## Sparse Event Format

### Wire format (one JSON object per line, no pretty-printing)

Every event has the same three header fields and then a small number of type-specific fields. Field names are kept short (2-4 chars) so the common case stays under 300 bytes.

```
{"t":1775409372123,"s":0,"k":"mon_start","sid":"7f3e...","tid":413782019,"url":"https://example.com/","ins":"search for bun docs"}
{"t":1775409374001,"s":1,"k":"click","sid":"7f3e...","ref":"e42","r":"button","n":"Search","x":412,"y":187,"tr":true}
{"t":1775409374015,"s":2,"k":"input","sid":"7f3e...","ref":"e17","r":"textbox","n":"Query","v":"bun docs","ic":true}
{"t":1775409374062,"s":3,"k":"mut","sid":"7f3e...","c":1,"add":4,"rem":1,"attr":2,"cause":1}
{"t":1775409374128,"s":4,"k":"fetch","sid":"7f3e...","u":"/api/search?q=bun+docs","m":"GET","st":200,"bz":2417,"cause":1}
{"t":1775409374210,"s":5,"k":"nav","sid":"7f3e...","u":"https://example.com/search?q=bun+docs","typ":"history","cause":1}
{"t":1775409376801,"s":6,"k":"mon_stop","sid":"7f3e...","evt":24,"mut":8,"net":3,"dur":4678}
```

### Field dictionary

| Field | Meaning | Types |
|-------|---------|-------|
| `t` | Wall-clock timestamp (ms since epoch) | all |
| `s` | Monotonic seq within session | all |
| `k` | Event kind | all — one of `mon_start`, `mon_stop`, `mon_pause`, `mon_resume`, `click`, `dblclick`, `rclick`, `input`, `change`, `submit`, `key`, `scroll`, `focus`, `blur`, `copy`, `paste`, `mut`, `fetch`, `xhr`, `nav`, `reload`, `error` |
| `sid` | Session ID | all |
| `tid` | Tab ID | `mon_start`, `nav` |
| `url` | URL | `mon_start`, `nav`, `fetch`, `xhr` |
| `ins` | Instruction text (optional) | `mon_start` |
| `ref` | Element ref (`e42`) from ref-registry, assigned on demand | `click`, `input`, `change`, `submit`, `focus`, `blur`, `key` |
| `r` | Effective ARIA role (from `a11y-tree.getEffectiveRole`) | user actions on elements |
| `n` | Accessible name (from `a11y-tree.getAccessibleName`), truncated to 80 chars | user actions on elements |
| `tg` | Tag name (lowercase), only when role doesn't cover it | user actions |
| `x`, `y` | Viewport click coords | `click`, `dblclick`, `rclick` |
| `sel` | CSS selector fallback when `ref` isn't sufficient | user actions |
| `v` | Input value, truncated to 120 chars; passwords masked to `***N***` where N is length | `input`, `change` |
| `ic` | `composed` — did event cross a shadow root? | user actions |
| `tr` | `isTrusted` — true for real user events, false if slop's own `dispatchClickSequence` caused it | user actions |
| `kc` | Key combo (`Enter`, `Control+A`) | `key` |
| `sx`, `sy` | Scroll deltas | `scroll` (throttled @ 100ms) |
| `c` | Mutation batch count (how many mutations were collapsed into this `mut` event) | `mut` |
| `add`, `rem`, `attr`, `txt` | Mutations of each kind inside batch | `mut` |
| `tgts` | Up to 5 target refs affected by mutation batch | `mut` |
| `u` | URL (request URL for net, destination URL for nav) | `fetch`, `xhr`, `nav` |
| `m` | HTTP method | `fetch`, `xhr` |
| `st` | HTTP status | `fetch`, `xhr` |
| `bz` | Response body size in bytes | `fetch`, `xhr` |
| `ct` | Response content-type (first 40 chars) | `fetch`, `xhr` |
| `typ` | Navigation sub-type: `hard`, `history`, `reference` | `nav` |
| `cause` | `s` of the user action this event is attributed to | `mut`, `fetch`, `xhr`, `nav` |
| `evt`, `mut`, `net`, `dur` | Session totals | `mon_stop` |

### Causality rule

When a `mut`, `fetch`, `xhr`, or `nav` event arrives, the content script looks up the **most recent user-action seq within 500ms** and writes it as `cause`. If no user action was within the window, `cause` is omitted — the side effect was autonomous (polling, timer, etc.). 500ms covers the synchronous handler chain (~0-5 ms), a short awaited step, and a network round-trip that resolves before the page re-paints.

### Response bodies are NOT streamed

The wire format carries only `bz` (size) and `ct` (content-type). The actual response body is already in the `net-buffer` ring buffer (up to 500 entries) and is retrievable via the existing `slop net log --filter <url>` mechanism. Storing bodies twice would blow up the event log. On `slop monitor export`, the exporter can optionally merge body data back in from the net buffer for the last 500 requests — see Phase 5.

### Why short field names

A 30-minute recording of an SPA session can easily produce 2,000 events. At 300 bytes/event that's 600 KB — within the 10 MB rotation cap but comfortable. If we used `{"timestamp":...,"sequence":...,"kind":"click","ref":"e42","role":"button","accessibleName":"Search",...}` we'd triple the line size. Agents tokenize JSON key names just like values. Shorter keys = more events fit in the agent's context window.

---

## CLI Surface

```
slop monitor start [--instruction "<text>"] [--tab <id>]
slop monitor stop
slop monitor pause
slop monitor resume
slop monitor status

slop monitor tail                        # live tail of current session (k != mon_*)
slop monitor tail --raw                  # no pretty rendering
slop monitor list                        # list sessions seen in EVENTS_PATH
slop monitor export <sessionId>          # pretty text rendering of a session
slop monitor export <sessionId> --json   # raw JSONL for that session
slop monitor export <sessionId> --plan   # emit 'slop <cmd>' replay script
slop monitor export <sessionId> --with-bodies
                                         # merge net-buffer bodies (if still in ring)
```

### Pretty text rendering (not --raw)

```
session 7f3e2c1a  started 2026-04-07 12:44:32  tab 413782019  https://example.com/
  instruction: search for bun docs, open first result, copy first paragraph

  [+0.000]  start
  [+1.878]  click     e42  button  "Search"           (412,187)  trusted
  [+1.892]  input     e17  textbox "Query"            v="bun docs"
  [+1.939]  mut       +4 -1 attr:2                    (cause: click#1)
  [+2.005]  fetch     GET /api/search?q=bun+docs 200  2.4 kB     (cause: click#1)
  [+2.087]  nav       history → /search?q=bun+docs    (cause: click#1)
  [+2.312]  mut       +12 -3 attr:5                   (cause: click#1)
  [+4.678]  stop      24 evt  8 mut  3 net  4.7 s
```

Columns are right-aligned so a scanning eye lines up causes with effects. `[+1.878]` is seconds since session start.

### Replay plan output (--plan)

```
# Replay plan for session 7f3e2c1a
# Instruction: search for bun docs, open first result, copy first paragraph
# Generated from /tmp/slop-browser-events.jsonl at 2026-04-07T13:02:11Z

slop tab new "https://example.com/"
slop wait-stable
slop find "Search" --role button
slop click e42
slop wait-stable
slop find "Query" --role textbox
slop type e17 "bun docs"
slop keys Enter
slop wait-stable
slop net log --filter /api/search --limit 1
slop extract-text e99
```

Notes on the plan generator:
1. It uses the original `ref` IDs only as hints — the replay actually emits `slop find "<name>" --role <role>` because refs don't survive navigation. Role + accessible name is the stable identifier.
2. If a `fetch`/`xhr` was correlated to the click and the response body is still in the net buffer, the plan emits `slop net log --filter <path>` afterward so the agent can read what the page learned.
3. Mutation events with `cause` become implicit `slop wait-stable` markers — the replay plan assumes the agent waits after each action until mutations settle.
4. Autonomous events (no `cause`) are logged as comments only: `# autonomous: fetch /api/tick (polling)`.

---

## Implementation Phases

### Phase 1: Content script monitor (P0)

**Files:** `extension/src/content/monitor.ts` (new), `extension/src/content.ts` (modified to import and register)

- [x] 1.1: Create `content/monitor.ts` with module-level state: `armed`, `sessionId`, `startedAt`, `seq`, `recentUserActions: Array<{seq, t}>` (cap 16), `mutationBatch: []`, `mutationFlushTimer: null`.
- [x] 1.2: Export `arm(sessionId: string, startedAt: number)` — sets `armed=true`, resets `seq=0`, attaches listeners.
- [x] 1.3: Export `disarm()` — removes all listeners, flushes any pending mutation batch, sets `armed=false`.
- [x] 1.4: Attach capture-phase listeners to `document` for: `click`, `dblclick`, `contextmenu`, `input`, `change`, `submit`, `keydown`, `focus`, `blur`, `copy`, `paste`, `scroll`. Options: `{ capture: true, passive: true }`.
- [x] 1.5: Each listener: build a compact event object using `composedPath()[0]` as the target (handles shadow DOM), resolve `ref` via `getOrAssignRef`, pull `r`, `n` from `getEffectiveRole` / `getAccessibleName`, include `tr: event.isTrusted`. Scroll events throttle to one per 100ms (deltas accumulated).
- [x] 1.6: Password masking: if target is `input[type=password]`, emit `v: "***" + length + "***"` not raw text.
- [x] 1.7: Value truncation: any `v` field is `.slice(0, 120)` + `"…"` when longer.
- [x] 1.8: Each user-action emit also pushes `{seq, t}` onto `recentUserActions` (cap at 16, drop oldest).
- [x] 1.9: MutationObserver on `document.documentElement` with `{ childList: true, subtree: true, attributes: true, characterData: true }`. On each batch callback: increment counters (add/rem/attr/txt), collect up to 5 affected refs via `getOrAssignRef`, set a 50ms debounce timer to emit a single `mut` event.
- [x] 1.10: `mut` emit: look up `cause` by walking `recentUserActions` backward for entries within 500ms; omit `cause` if none. Emit event and reset batch.
- [x] 1.11: Subscribe to `__slop_net` (reuse pattern from `net-buffer.ts`, but a separate listener so it works even if net-buffer is disabled). On each entry: look up `cause` same way, emit `fetch` or `xhr` event with `bz = body.length`, `ct = headers['content-type']?.slice(0,40)`.
- [x] 1.12: Handle message `monitor_arm { sessionId, startedAt }` → call `arm`, reply `{ success: true }`.
- [x] 1.13: Handle message `monitor_disarm` → call `disarm`, reply with `{ evt, mut, net }` counts.
- [x] 1.14: All emits go through a single `emit(obj)` helper that does `chrome.runtime.sendMessage({ type: "mon_evt", obj })` — no formatting here, background serializes.
- [x] 1.15: Emitter must never throw. Wrap every field lookup in try/catch. A broken event is dropped, never crashes the monitor.
- [x] 1.16: Import `content/monitor.ts` side-effect from `content.ts` so it's in every frame.

**Acceptance criteria:**
- [x] Real user click on a page produces one `click` event with `tr: true`. *(verified by code: capture-phase listener reads `e.isTrusted`; live verification per `Notes/monitor.md` smoke test)*
- [x] slop's own `dispatchClickSequence` produces a `click` event with `tr: false`. *(verified by code; the `buildPlan` unit test exercises the `tr:false` filter end-to-end)*
- [x] Typing into a password field never emits the raw value — only masked length. *(verified by `buildPlan emits TODO for masked password inputs` unit test plus the `isPasswordLike` + `maskedValue` content-script helpers)*
- [x] 50 consecutive `attributes` mutations collapse into a single `mut` event with `attr: 50` and up to 5 target refs. *(verified by code: 50ms debounce + per-batch `attr` counter + `tgts` slice 0..5)*
- [x] A fetch that fires 80 ms after a click carries `cause: <click_seq>`. *(verified by `findCause` walking `recentUserActions` ring within 500ms; `buildPlan` test asserts cause-tagged plans)*
- [x] A polling fetch with no preceding user action carries no `cause` field. *(verified by code: cause is omitted when no recent action; plan generator emits `# autonomous` comment)*
- [x] Scroll events throttle to one per 100ms. *(verified by code: `handleScroll` debounce timer + accumulated `sx`/`sy` deltas)*
- [x] Disarming flushes any pending mutation batch and stops all listeners. *(verified by code: `disarm()` calls `flushMutationBatch()` and detaches every listener)*

### Phase 2: Background capability + webNavigation + session state (P0)

**Files:** `extension/src/background/capabilities/monitor.ts` (new), `extension/src/background/router.ts` (register), `extension/src/background/transport.ts` (no change — reuse `sendToHost` path)

- [x] 2.1: Create `background/capabilities/monitor.ts` with module-level `sessions: Map<sessionId, { tabId, startedAt, instruction?, counts: { evt, mut, net, nav }, seq, paused, url }>` and `activeSessionByTab: Map<tabId, sessionId>`.
- [x] 2.2: Handle `monitor_start` action: generate `sessionId = crypto.randomUUID()`, read tab URL, record session, emit `mon_start` via `sendToHost({ type: "event", event: "mon_start", sid, tid, url, ins: instruction, t, s })`, then send `monitor_arm` to content script.
- [x] 2.3: Handle `monitor_stop` action: look up session by tab, send `monitor_disarm` to content script, emit `mon_stop` with counts and `dur`, delete session.
- [x] 2.4: Handle `monitor_status` action: returns `{ active, sessions[] }` with per-session counts, url, instruction, ageMs; supports per-tab lookup via `action.tabId`.
- [x] 2.5: Handle `monitor_pause` / `monitor_resume` actions: update `paused` flag on session, emit `mon_pause` / `mon_resume` events, re-arm content script on resume.
- [x] 2.6: `chrome.webNavigation.onHistoryStateUpdated` listener registered once; emits `nav` event with `typ: "history"`, `u`, `tt`, `tq` for active session tabs only (frameId === 0).
- [x] 2.7: `chrome.webNavigation.onCommitted` listener registered once; emits `nav` event with `typ: "hard"` (or `"reload"` when `transitionType === "reload"`), plus reference-fragment updates as `typ: "reference"`.
- [x] 2.8: `chrome.webNavigation.onCompleted` fires after hard navigation; background re-sends `monitor_arm` to the tab so the freshly-injected content script re-arms. Background tracks the per-session `seq` counter so it survives navigation (global monotonic within session).
- [x] 2.9: `chrome.runtime.onMessage` listener registered via `registerMonitorListeners()` handles `mon_evt` from content scripts: uses `sender.tab.id` + `sender.frameId`, looks up active session, strips `k`, calls `emitMonEvent(session, kind, payload)` which adds `sid`, `s`, `t` and forwards via `sendToHost({ type: "event", event: kind, ... })`.
- [x] 2.10: Register monitor action types in `background/router.ts` `MONITOR_ACTIONS` set: `monitor_start`, `monitor_stop`, `monitor_status`, `monitor_pause`, `monitor_resume`, plus added `monitor_status` to `needsTab` no-tab list in `message-dispatch.ts`.

**Acceptance criteria:**
- [x] `monitor_start` returns `{ sessionId }` and the content script is armed. *(verified by code: handler returns `data: { sessionId, tabId, startedAt, url, instruction }`; `sendArmToTab` follows)*
- [x] `monitor_stop` returns `{ sessionId, evt, mut, net, dur }` and the content script is disarmed. *(verified by code: handler returns full counts and dur; `sendDisarmToTab` follows)*
- [x] A hard navigation during an active session results in events continuing to land in the same `sessionId`. *(verified by code: `chrome.webNavigation.onCompleted` re-fires `monitor_arm` with the original sessionId)*
- [x] `history.pushState` in the page produces a `nav` event with `typ: "history"`. *(verified by code: `onHistoryStateUpdated` emits `typ: "history"`)*
- [x] Closing the tab implicitly stops the session — background's `chrome.tabs.onRemoved` emits `mon_stop` with reason `tab_closed`. *(verified by code: `chrome.tabs.onRemoved` listener inside `registerWebNavListenersOnce` emits `mon_stop` with `reason: "tab_closed"`)*

### Phase 3: Daemon passthrough (P0 — minimal change)

**Files:** `daemon/index.ts` (verify, no logic change)

- [x] 3.1: Verify `handleNativeMessage` with `{ type: "event", event, ...data }` already calls `emitEvent(event, data)` [SLOP-DAEMON lines 90-93]. No change needed.
- [x] 3.2: Verify `EVENTS_MAX_SIZE = 10 MB` rotation works for the heavier event volume [SLOP-PLATFORM].
- [x] 3.3: Consider (but don't require) swapping the current `appendFileSync(EVENTS_PATH, ...)` to a persistent `Bun.file(EVENTS_PATH).writer()` FileSink for higher throughput [BUN-FILE lines 157-200]. **Deferred** — current append rate is fine for v1.
- [x] 3.X: **Patch the daemon ws handler** to route `{ type: "event" }` messages from the extension ws channel into `handleNativeMessage`. Pre-patch, the ws path only handled `"extension"`, `"keepalive"`, and `id+result` pairs — `type:"event"` messages would have fallen through to the action-request branch and been dropped. Three-line addition mirrors the stdin path.

**Acceptance criteria:**
- [x] Daemon writes monitor events to `/tmp/slop-browser-events.jsonl` with no code change for the native messaging path. The ws fallback path required a 3-line patch (item 3.X) so monitor events sent via ws also persist.
- [x] Rotation at 10 MB still keeps the tail half of events. *(no change to existing rotation logic in `daemon/index.ts` `emitEvent`)*

### Phase 4: CLI commands (P0)

**Files:** `cli/commands/monitor.ts` (new), `cli/index.ts` (register `MONITOR_CMDS` set), `cli/help.ts` (add section)

- [x] 4.1: Create `cli/commands/monitor.ts` with `parseMonitorCommand(filtered: string[]): Action | null`.
- [x] 4.2: Subcommand `start`: build `{ type: "monitor_start", instruction: string|undefined }`. Instruction comes from `--instruction "..."` or positional string after `start`.
- [x] 4.3: Subcommand `stop`: `{ type: "monitor_stop" }`.
- [x] 4.4: Subcommand `status`: `{ type: "monitor_status" }`.
- [x] 4.5: Subcommand `pause` / `resume`: `{ type: "monitor_pause" }` / `{ type: "monitor_resume" }`.
- [x] 4.6: Subcommand `tail`: returns `null` (handled locally). Reads `EVENTS_PATH`, starts a live tail via `tail -f` Bun subprocess [pattern exists in `cli/commands/meta.ts` case `"events"`], filters events by `k` prefix `mon_*` + `click`/`input`/... and pretty-renders unless `--raw`. The --current flag (default) tails only the most recent active session.
- [x] 4.7: Subcommand `list`: reads `EVENTS_PATH` via `Bun.JSONL.parse` [BUN-JSONL], groups by `sid`, prints `sessionId  startedAt  tabUrl  duration  eventCount`.
- [x] 4.8: Subcommand `export <sessionId>`: reads + filters + pretty-renders or emits raw with `--json`. Aligns columns like the sample above. Uses relative `[+s.ms]` time from session start.
- [x] 4.9: Subcommand `export <sessionId> --plan`: walks events, emits `slop ...` command lines per causality rules.
- [x] 4.10: Subcommand `export <sessionId> --with-bodies`: additionally issues `slop net log --filter <url>` for each correlated fetch/xhr and embeds the body as a fenced block in the output. Best-effort: if the buffer rotated, emits `(body unavailable)`.
- [x] 4.11: Add `MONITOR_CMDS = new Set(["monitor"])` to `cli/index.ts`. Dispatch subcommand inside `parseMonitorCommand`.
- [x] 4.12: `NO_DAEMON` inclusion: `tail`, `list`, `export` are local-only (they read `EVENTS_PATH` directly). `start`, `stop`, `status`, `pause`, `resume` require the daemon.
- [x] 4.13: Help text added to `cli/help.ts` under a new `monitor` section.

**Acceptance criteria:**
- [x] `slop monitor start` prints the `sessionId` and confirms active. *(verified: cli wires `monitor_start` action; daemon returns `data: { sessionId, ... }` which `formatResult` prints)*
- [x] `slop monitor tail` streams pretty-rendered events live. *(verified: `tail -f -n 0 EVENTS_PATH` subprocess + per-line JSON parse + `renderEvent` pretty render unless `--raw`)*
- [x] `slop monitor stop` prints session summary. *(verified: handler returns `data: { sessionId, dur, evt, mut, net, nav, contentDisarm }`)*
- [x] `slop monitor list` shows all sessions historically in the log. *(verified by unit test `listSessions groups by sid and returns counts`)*
- [x] `slop monitor export <sid>` renders the aligned text format. *(verified by unit test `renderSession produces aligned text`)*
- [x] `slop monitor export <sid> --plan` produces a replay script where each `slop <cmd>` line is executable from a clean tab. *(verified by 4 unit tests covering happy path, synthetic filtering, masked passwords, and hard-vs-history nav)*

### Phase 5: Replay plan generator quality (P1)

**Files:** `cli/commands/monitor.ts` (extend)

- [x] 5.1: Plan always opens with `slop tab new "<url from mon_start>"` and `slop wait-stable`.
- [x] 5.2: Click events emit `slop click "role:name"` (uses existing semantic-selector path that maps to `find_and_click`). If role/name are empty, fall back to ref or CSS selector stored in `sel`.
- [x] 5.3: Input events emit `slop type "role:name" "<v>"` — escaping double quotes via `escapeArg`.
- [x] 5.4: Key events emit `slop keys "<kc>"`.
- [x] 5.5: Between any two user actions with an intervening `mut` event, insert `slop wait-stable`.
- [x] 5.6: Navigation events: if `typ=hard`, emit `slop navigate "<u>"` + `slop wait-stable`. If `typ=history` or `typ=reference`, skip (the click that caused it already did the work).
- [x] 5.7: Correlated fetch/xhr where the agent likely wants the body: emit `# slop net log --filter "<u>" --limit 1` as a commented cue (becomes live with `--with-bodies`).
- [x] 5.8: Autonomous net calls: comment-only, not in the executable path.
- [x] 5.9: Password-masked inputs: plan emits `# TODO: type into <role>:<name> — original value was masked (length N)`. Agent must provide the real value.

**Acceptance criteria:**
- [x] A plan generated from a real session can be fed to a shell (executing each `slop ...` line) and reproduce the observed side effects on a fresh tab. *(structural verification: plan emits `slop tab new`, `slop wait-stable`, `slop click "role:name"`, `slop type "role:name" "value"`, `slop keys "..."`, `slop navigate` — every emitted command exists in the existing CLI surface; live end-to-end run is documented in `Notes/monitor.md` as the manual smoke test)*

### Phase 6: Documentation + smoke test (P1)

**Files:** `README.md`, `CLAUDE.md`, `Notes/monitor.md` (new)

- [x] 6.1: Add `slop monitor` section to `README.md` after `Sniffing Network Traffic`.
- [x] 6.2: Add `slop monitor` section to `CLAUDE.md` under a new `## Recording Sessions` heading.
- [x] 6.3: Create `Notes/monitor.md` with: instructions for a manual smoke test (open page, search, click a result, `slop monitor stop`, `slop monitor export`), and a sample rendered session.
- [x] 6.4: Add monitor smoke test to `bun test` — unit-tests the sparse format reader, renderer, plan generator, escape rules, masked input handling, and synthetic-vs-real filtering by writing fixtures into EVENTS_PATH. 10 tests, all passing.

**Acceptance criteria:**
- [x] Documentation reflects the full monitor flow. *(README, CLAUDE.md, and `Notes/monitor.md` all updated)*
- [x] `bun test` includes a monitor smoke test that passes. *(10 unit tests in `test/monitor.test.ts`, all passing alongside the original 5 daemon-cli tests)*

---

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Capture-phase listener breaks a page's event handling | Very Low | Page breakage | `{ passive: true }` forbids us from calling `preventDefault()`, and we never call `stopPropagation` [DOM-CAPTURE]. We are purely observers. |
| MutationObserver firehose on a noisy page (animations, React rerenders) | Medium | Event log floods, 10 MB rotates too fast | 50 ms debounce + batch collapsing (one `mut` event per batch with counts). Only up to 5 target refs per batch, not per mutation. |
| Password or credit card fields leak into `v` | High without mitigation | PII leak | Mandatory masking for `input[type=password]`. `input[autocomplete=cc-*]` also masked. Whole `input`/`change` events on those targets emit only length, never value. |
| Shadow DOM elements don't have stable refs | Medium | Replay fails to find target | `composedPath()[0]` gives the real target; `getOrAssignRef` already handles shadow elements. If still no ref, fall back to `sel` CSS selector built from `composedPath()`. |
| Cross-origin iframes can't be observed from the top frame | Certain | Events in those frames invisible | Manifest declares `all_frames: true` [SLOP-MANIFEST], so content.ts runs in each frame including subframes — each frame has its own monitor. Background tags events with `frameId` so the CLI can show them. Cross-origin-isolated iframes that block extensions (rare) are documented as a limitation. |
| Hard navigation loses in-memory `seq` counter | High | Seq restarts at 0 mid-session | Persist seq to `sessionStorage` under `__slop_mon_seq`. Same-origin navigations survive; cross-origin navigations get a new counter, documented. |
| Service worker goes idle during long recording session | Medium | Events dropped or re-ordered | Existing `registerAlarmListener` keeps the SW warm with a 30s alarm [SLOP-TRANSPORT]. Monitor events flow through the same path as everything else, so if the SW stays alive for requests it stays alive for monitor events. |
| Real user click and slop synthetic click both emit `k:click` and replay gets confused | Medium | Replay loops forever | `tr` field distinguishes real (true) from synthetic (false). `--plan` generator filters `tr != false` — we only replay the real clicks. |
| 10 MB rotation cuts a session in half | Medium | Incomplete export | Sessions are delimited by `sid` — `export` works on whatever lines remain. For critical recordings, Phase 6.3 can add `--output <file>` to spawn a separate writer that persists to a chosen file outside rotation. |
| `sendMessage` rate limit or queue overflow under burst | Medium | Events dropped | Fire-and-forget `chrome.runtime.sendMessage` has no hard rate limit in MV3. If observed, Phase 4 adds `chrome.runtime.connect` port + batched flush (N events or 100ms, whichever first) [CHR-MSG line 239]. |
| User never clicks `stop` — session bloats forever | Medium | Event log fills, rotation kicks in | `monitor_status` surfaces session age; background auto-emits `mon_stop` with reason `idle_timeout` after 30 minutes of no user events. Configurable. |
| LinkedIn or similar SPA detects capture-phase listeners via `getEventListeners` | Very Low | Anti-bot flag | `getEventListeners` is a DevTools-only API; pages can't call it. Capture-phase listeners on `document` are extremely common (analytics libs, React, etc.) and are not a detection signal. |

---

## Open Questions for Ron

These are decisions I held back on because they affect Ron's day-to-day use, not correctness:

1. **Default output location** — `/tmp/slop-browser-events.jsonl` is the current path and is shared with all other slop events (`request_received`, `os_action`, etc.). Do you want monitor sessions to land in a separate file like `/tmp/slop-browser-monitor.jsonl`? Pro: clean. Con: two streams to tail, `slop events` stops seeing them. My default: reuse the single file, delimit by `sid`.
2. **Instruction priming UX** — Is `slop monitor start --instruction "..."` enough, or do you want an interactive prompt (`slop monitor start` then type the instruction in and hit Enter)?
3. **Record on which tab** — Default is the active slop-group tab. Should `slop monitor start --any-tab` be allowed so you can record in your personal browsing tab? (This is the only slop feature that would touch non-slop-group tabs.)
4. **Scroll events** — Do you care about scrolling as a recorded action, or is that just noise? My default: throttled at 100ms, emitted as `k:scroll` with accumulated deltas. Easy to suppress with `--no-scroll` on start.
5. **Export format default** — Pretty text or raw JSONL? My default: pretty with `--json` flag for raw.
6. **Body capture** — Do you want `--with-bodies` to be the default for `export`? It makes exports much larger but immediately useful to an agent.
7. **Phase ordering** — Phases 1-4 are P0 (ship the core). Phase 5 (plan quality) and Phase 6 (docs + test) are P1. Agree or reshuffle?

---

## Success Metrics

1. **One command starts recording.** `slop monitor start` arms all listeners, no setup.
2. **Real user click on any page produces one line in the event log with `tr: true`, `ref`, `r`, `n`, `x`, `y` populated — in under 50 ms.**
3. **A click that triggers a fetch and 20 DOM mutations produces exactly three events: `click`, `fetch` (with `cause` set to click's seq), `mut` (with `cause` set to click's seq and `c: 20`).**
4. **`slop monitor export <sid> --plan` produces a replay script that, when run against a fresh tab, reproduces the observed DOM end-state and network calls to within the `--json` diff tolerance.**
5. **Zero CDP debugger attachments during recording.** `chrome.debugger` must not appear in any code path added by this PRD.
6. **A 30-minute recording on a normal SPA stays under 2 MB** (with the debouncing and truncation rules enforced).
7. **No page breakage.** Before/after smoke test on 5 real sites (LinkedIn, Gmail, YouTube, GitHub, Google Docs) shows identical page behavior with monitor armed vs disarmed.
