# PRD-15: ChatGPT Agentic Bridge — SSE Stream Interception + Read/Write Loop

**Goal:** Enable slop to drive ChatGPT's web UI as an agentic system: send prompts, read streamed responses in real-time via the API wire protocol, and iterate — the same send→receive→decide loop that `~/.cy/` uses with SQLite, but running through ChatGPT's browser UI with zero API keys.

**Scope:** Patch `inject-net.ts` to intercept fetch-based SSE (`text/event-stream`) and EventSource streams chunk-by-chunk. Add a `slop sse` command surface for tailing live streams. Add a `slop chatgpt` command that orchestrates the full send→read→iterate loop. No CDP. No API keys. Reuses Ron's existing ChatGPT Pro session cookie.

**Non-Negotiable:**
1. **No CDP.** No `chrome.debugger`. No yellow infobanner. No detection surface.
2. **No API keys.** Everything flows through the browser session — Ron's existing ChatGPT Pro login is the auth.
3. **Streaming, not completion-based.** SSE chunks must be emitted as they arrive, not after the stream closes. An agent must be able to read partial responses and decide to stop generation early.
4. **Preserve page behavior.** The fetch patch must return an identical `Response` to the page. ChatGPT's React code must never see a difference.
5. **Site-agnostic SSE interception.** The stream capture layer works on any site that uses fetch-based SSE or EventSource — not just ChatGPT. The ChatGPT-specific logic lives in a separate command layer.

---

## Evidence Sources

| ID | Source | Path / Reference | Finding |
|----|--------|-----------------|---------|
| SLOP-INJECT | MAIN-world fetch/XHR patch | `extension/src/inject-net.ts` | `response.clone().text().then(body => ...)` — waits for full body. SSE streams never complete, so `__slop_net` event never fires for `text/event-stream` responses. |
| SLOP-NETBUF | Content-script net buffer | `extension/src/content/net-buffer.ts` | Ring buffer of 500 entries, subscribes to `__slop_net` CustomEvent. Only receives entries after `.text()` resolves — SSE entries never arrive. |
| SLOP-INJECT-HDR | Header capture in inject-net.ts | `extension/src/inject-net.ts` lines 106-112 | `__slop_headers` event fires immediately on fetch call (before response), so ChatGPT's `POST /backend-api/f/conversation` headers ARE captured — including `Authorization`, `x-conduit-token`, `accept: text/event-stream`. |
| SLOP-MANIFEST | Content script registration | `extension/manifest.json` | `inject-net.js` runs in `world: "MAIN"` at `document_start` on `<all_urls>` with `all_frames: true`. This is how the fetch monkey-patch reaches the page's execution context. |
| SLOP-CONTENT | Content script entry | `extension/src/content.ts` | Imports `./content/net-buffer` as side-effect. Runs in ISOLATED world at `document_idle`. Listens for `__slop_net` and `__slop_headers` CustomEvents dispatched from MAIN world. |
| SLOP-MONITOR | Session monitor | `extension/src/content/monitor.ts` | Subscribes to `__slop_net` for cause-correlation. Currently only receives completed fetch/XHR — would benefit from SSE stream events for causal attribution. |
| LIVE-CAPTURE | Live ChatGPT network capture | Session 2026-04-08 01:17 CT | `POST /backend-api/f/conversation` with `accept: text/event-stream` appears in `slop net headers` (headers captured) but NOT in `slop net log` (body never resolves). `GET /backend-api/conversation/{id}/stream_status` returns `{"status":"IS_STREAMING"}`. |
| LIVE-CONDUIT | Conduit token analysis | Session 2026-04-08 01:17 CT | `GET /backend-api/f/conversation/prepare` returns a short-lived JWT (60s TTL) with `conduit_uuid` and `conduit_location` (internal IP:port). The token is passed as `x-conduit-token` header on the conversation POST. |
| LIVE-AUTH | Auth header analysis | Session 2026-04-08 01:17 CT | Bearer JWT in `Authorization` header contains: `chatgpt_plan_type: "pro"`, `email: "ronaldeddings@gmail.com"`, scopes include `model.request`, `model.read`. Token has ~8-day TTL (exp: 1776309937). |
| LIVE-TREE | ChatGPT DOM tree | Session 2026-04-08 01:17 CT | Input field is `[e98] textbox "Chat with ChatGPT" role="textbox"` (contenteditable div). Response text readable via `slop text`. Model selector at `[e94] button "Model selector"`. |
| LIVE-NAV | SPA navigation pattern | Monitor session 10d84cba | ChatGPT uses `history.pushState` for conversation switches — 12 nav events, 0 clicks/mutations captured because content script listeners were not re-armed on SPA navigation. |
| MDN-RESP-TEXT | Response.text() spec | MDN Web Docs | "The `text()` method takes a Response stream and **reads it to completion**. It returns a promise that resolves with a String." For SSE, completion = server closes connection = may never happen. |
| MDN-RS-TEE | ReadableStream.tee() spec | MDN Web Docs | "Tees the current readable stream, returning a two-element array containing the two resulting branches as new ReadableStream instances." Warning: "If only one branch is consumed, the **entire body will be enqueued in memory**." |
| MDN-RS-READER | ReadableStream.getReader() | MDN Web Docs | "Creates a reader and **locks the stream to it**. While the stream is locked, no other reader can be acquired until this one is released." Each `read()` returns `{ done, value }` with `Uint8Array` chunks. |
| MDN-EVENTSOURCE | EventSource spec | MDN Web Docs / WHATWG HTML | "An EventSource instance opens a persistent connection to an HTTP server." Internally uses the browser's fetch algorithm, but this is NOT the same as `window.fetch` — monkey-patching `window.fetch` does NOT intercept EventSource connections. Must be patched separately. |
| MDN-CLONE | Response.clone() | MDN Web Docs | "Like the underlying ReadableStream.tee api, the body of a cloned Response will signal backpressure at the rate of the faster consumer." For SSE: cloning is safe but `.text()` on the clone blocks until stream ends. |
| CHR-CS-SPA | Content scripts + SPA | Chrome Extensions docs `develop/concepts/content-scripts.md` / `get-started/tutorial/scripts-on-every-tab.md` | "Our content script won't be reinjected when this happens [SPA navigation], so we need to watch for changes to the content." Content scripts persist across `history.pushState` — they are NOT reinjected. |
| CHR-CS-MAIN | Main world injection | Chrome Extensions docs `reference/manifest/content-scripts.md` | `"world": "MAIN"` — "Choosing the MAIN world means the script will share the execution environment with the host page's JavaScript." This is how `inject-net.js` patches `window.fetch` in ChatGPT's context. |
| CHR-WEBNAV | webNavigation API | Chrome Extensions docs `reference/api/webNavigation.md` | `onHistoryStateUpdated`: "Fired when the frame's history was updated to a new URL." Fires on `history.pushState` — does NOT trigger content script reinjection but DOES fire webNavigation events. |
| CHR-WEBNAV-ORDER | Navigation event ordering | Chrome Extensions docs `reference/api/webNavigation.md` | Hard nav: `onBeforeNavigate → onCommitted → onDOMContentLoaded → onCompleted`. SPA nav: only `onHistoryStateUpdated` fires. Content script reinjection only happens on hard navigation (new document). |
| BUN-STREAMS | Bun ReadableStream docs | `80_Reference/docs/bun/docs/runtime/streams.md` | "Bun implements the Web APIs ReadableStream and WritableStream." `ReadableStream` can be consumed with `for await (const chunk of stream)` or `getReader()`. |
| BUN-FETCH | Bun fetch streaming | `80_Reference/docs/bun/docs/runtime/networking/fetch.md` | "You can also more directly access the ReadableStream object." Confirms `response.body` is a standard `ReadableStream`. |
| BUN-TEE | Bun stream tee | `80_Reference/docs/bun/docs/runtime/binary-data.md` | "To split a ReadableStream into two streams that can be consumed independently: `const [a, b] = stream.tee()`" |
| BUN-BUILD | Bun bundler browser target | `80_Reference/docs/bun/docs/bundler.md` | "Default. For generating bundles that are intended for execution by a browser. Prioritizes the 'browser' export condition." Does NOT transform `fetch`, `ReadableStream`, or web APIs — only transpiles TS/JSX, resolves modules, tree-shakes. Extension runtime is pure browser behavior. |
| BUN-SSE | Bun SSE guide | `80_Reference/docs/bun/docs/guides/http/sse.md` | "Server-Sent Events let you push a stream of text events to the browser over a single HTTP response." Server yields chunks; client consumes via `EventSource` or fetch ReadableStream. "Each yield flushes a chunk to the client." |

---

## The Problem

### What Ron wants

> "I'd like to have the ability to interact with ChatGPT from the web UI, read the traffic via the API, and then iterate based off of the responses."

Translated: Ron types a prompt in ChatGPT. An agent reads the streamed response as structured API data (not DOM scraping). The agent decides what to do next and sends the next prompt. This is the same agentic loop that `~/.cy/` (Cy) uses — but with ChatGPT as the model backend, accessed through the browser with Ron's Pro subscription.

### Why it doesn't work today

**The SSE stream body is invisible to slop.**

When Ron sends a message in ChatGPT, the page does:

```
POST /backend-api/f/conversation
Accept: text/event-stream
x-conduit-token: <JWT>
Authorization: Bearer <JWT>
```

The server responds with a long-lived SSE stream containing the model's token-by-token output. Our `inject-net.ts` does:

```typescript
// inject-net.ts — current behavior
const clone = response.clone()
clone.text().then((body) => {
  document.dispatchEvent(new CustomEvent("__slop_net", { detail: { url, method, status, body, type: "fetch", timestamp } }))
}).catch(() => {})
```

**`clone.text()` reads the Response stream to completion** [MDN-RESP-TEXT]. For SSE, the stream stays open until the server finishes generating — `.text()` blocks the entire time. For a 30-second generation, the `__slop_net` event fires 30 seconds late. For a stream that never closes (keepalive), it never fires at all.

**Result:** `slop net headers` captures the request headers (including auth). `slop net log` never captures the response body. The agent is blind to what ChatGPT said.

### Secondary problem: EventSource is not intercepted

While ChatGPT currently uses `fetch()` with `accept: text/event-stream` (not native `EventSource`), other sites may use `new EventSource(url)`. The HTML spec says EventSource uses the browser's internal fetch algorithm, but this is NOT `window.fetch` [MDN-EVENTSOURCE]. Our current patch does not cover EventSource at all.

### Tertiary problem: Monitor misses clicks on SPA navigation

The monitor session on ChatGPT captured 12 navigation events but 0 clicks, 0 mutations, 0 net events [LIVE-NAV]. This is because ChatGPT's SPA navigation via `history.pushState` does not trigger content script reinjection [CHR-CS-SPA]. The `inject-net.js` MAIN-world script persists (it was injected at `document_start` and the document didn't change), but the monitor listeners in the ISOLATED-world `content.ts` need re-arming. The `onCompleted` handler re-arms on hard navigation [CHR-WEBNAV-ORDER], but `onHistoryStateUpdated` only emits nav events — it doesn't re-arm.

---

## Architecture

### Layer 1: SSE Stream Interception (inject-net.ts)

The fetch monkey-patch must detect streaming responses and process them chunk-by-chunk instead of waiting for `.text()`.

```
Page calls fetch(url, { headers: { accept: "text/event-stream" } })
  │
  ▼
inject-net.ts patched fetch()
  │
  ├─ Call originalFetch(input, init)
  │
  ├─ Response arrives
  │    │
  │    ├─ Check: is this a stream?
  │    │   content-type contains "text/event-stream"
  │    │   OR content-type contains "text/x-sse"
  │    │   OR request accept header contains "text/event-stream"
  │    │
  │    ├─ NON-STREAM (existing path):
  │    │   clone().text().then(body => dispatch __slop_net)
  │    │
  │    └─ STREAM (new path):
  │        │
  │        ├─ Read response.body via getReader()
  │        ├─ Create new ReadableStream (pass-through)
  │        ├─ For each chunk:
  │        │   ├─ Decode with TextDecoder({ stream: true })
  │        │   ├─ Dispatch __slop_sse CustomEvent with chunk text
  │        │   ├─ Accumulate into full-body buffer
  │        │   └─ Enqueue original bytes into pass-through stream
  │        ├─ On stream end:
  │        │   └─ Dispatch __slop_net with full accumulated body
  │        │
  │        └─ Return new Response(passThrough, { headers, status, statusText })
  │            (page sees identical Response, body consumption works normally)
  │
  ▼
Page consumes response.body — sees original bytes, unmodified
```

**Why pass-through ReadableStream, not tee():**
- `tee()` buffers the slower branch unboundedly [MDN-RS-TEE]. If our observer reads slowly (unlikely but possible under heavy load), the page's consumption backs up.
- A pass-through stream reads once, copies to both our observer and the output stream, zero buffering beyond the current chunk.
- The page gets a `new Response(stream, originalResponseInit)` that behaves identically to the original [BUN-BUILD confirms Bun build doesn't transform Response constructor].

**Why not clone().getReader():**
- `clone()` internally calls `tee()` [MDN-CLONE]. Same buffering concern. And we'd still need to construct a new Response for the page since the original body was consumed by our reader.

### Layer 2: EventSource Interception (inject-net.ts)

```
Page calls new EventSource(url, options)
  │
  ▼
inject-net.ts patched EventSource constructor
  │
  ├─ Create real EventSource via OriginalEventSource(url, options)
  ├─ Dispatch __slop_sse_open { url, withCredentials }
  ├─ Wrap onmessage / addEventListener("message") to dispatch
  │   __slop_sse { url, data, event, lastEventId, origin }
  ├─ Wrap onerror / addEventListener("error") to dispatch
  │   __slop_sse_error { url }
  ├─ Wrap close() to dispatch __slop_sse_close { url }
  └─ Return wrapped EventSource (preserves instanceof via prototype chain)
```

### Layer 3: Content Script SSE Buffer (net-buffer.ts extension)

```
MAIN world                          ISOLATED world
inject-net.ts                       content/net-buffer.ts
  │                                   │
  ├─ __slop_sse { url, chunk }  ──►  │ SSE ring buffer (per-URL)
  ├─ __slop_sse_open { url }    ──►  │ Active stream registry
  ├─ __slop_sse_close { url }   ──►  │ Stream completion
  │                                   │
  │                                   ├─ get_sse_log message handler
  │                                   ├─ get_sse_streams message handler
  │                                   └─ sse_tail message handler (live)
```

**SSE buffer design:**
- Per-URL accumulator: concatenates chunks for each active stream URL
- Ring buffer of last 50 completed SSE sessions (URL + full body + timestamp)
- Active stream list: URLs currently streaming, with accumulated text so far
- Monitor integration: each `__slop_sse` chunk dispatches as a separate event for cause-correlation

### Layer 4: Background + CLI Surface

**New background handlers:**

| Message | Handler | Returns |
|---------|---------|---------|
| `sse_log` | Query SSE buffer | Completed + active streams |
| `sse_streams` | List active streams | URLs, durations, byte counts |
| `sse_tail` | Subscribe to live chunks for a URL pattern | Streaming via port |

**New CLI commands:**

```bash
slop sse log [--filter <pattern>] [--limit N]     # Show captured SSE streams
slop sse streams                                    # List active SSE streams
slop sse tail [--filter <pattern>]                  # Live tail SSE chunks
```

### Layer 5: ChatGPT Agentic Command

```bash
slop chatgpt send "What is 2+2?"                  # Type + Enter + wait + read response
slop chatgpt send "What is 2+2?" --stream          # Stream chunks to stdout as they arrive
slop chatgpt read                                   # Read current conversation from DOM
slop chatgpt status                                 # Is it streaming? Model? Conversation ID?
slop chatgpt conversations                          # List recent conversations
slop chatgpt switch <conversation-id>               # Navigate to conversation
slop chatgpt model [model-name]                     # Read or change model
slop chatgpt stop                                   # Stop generation (click Stop button)
```

**`slop chatgpt send` flow:**

```
1. slop tree → find textbox "Chat with ChatGPT"
2. slop type <ref> "<prompt>"
3. slop keys "Enter"
4. Poll: slop sse streams --filter "backend-api/f/conversation"
   → wait until stream appears
5. slop sse tail --filter "backend-api/f/conversation"
   → read SSE chunks, parse ChatGPT wire format:
     data: {"message":{"id":"...","content":{"parts":["token"]}}}
     data: [DONE]
6. Accumulate parts, print to stdout
7. Return structured JSON: { conversationId, messageId, model, response, usage }
```

**Why DOM-read is the fallback, not the primary:**
- DOM scraping (`slop text`) gives you the rendered markdown but loses structure (message IDs, model info, token counts, tool calls, code execution results)
- SSE stream gives you the raw wire format with full metadata — identical to what the OpenAI API returns
- DOM-read is the fallback when SSE capture fails (e.g., page was already open before slop loaded)

---

## ChatGPT Wire Protocol (from live capture)

### Conversation flow

```
1. GET  /backend-api/sentinel/chat-requirements/prepare   → { prepare_token }
2. GET  /backend-api/sentinel/chat-requirements/finalize   → { persona, token, expire_after }
3. GET  /backend-api/f/conversation/prepare                → { conduit_token: <JWT> }
4. POST /backend-api/f/conversation                        → SSE stream
     Headers:
       Authorization: Bearer <session-jwt>
       x-conduit-token: <conduit-jwt>
       OpenAI-Sentinel-Chat-Requirements-Token: <token>
       OpenAI-Sentinel-Turnstile-Token: <cloudflare>
       OpenAI-Sentinel-Proof-Token: <pow>
       accept: text/event-stream
       Content-Type: application/json
5. GET  /backend-api/conversation/{id}/stream_status       → { status: "IS_STREAMING" | "FINISHED" }
6. GET  /backend-api/conversations?offset=0&limit=28       → conversation list with titles
```

### Sentinel tokens (anti-bot)

ChatGPT uses three sentinel tokens on each conversation POST:
- **Chat-Requirements-Token**: obtained via prepare→finalize flow, expires in ~540s
- **Turnstile-Token**: Cloudflare turnstile challenge (generated by page JS)
- **Proof-Token**: Proof-of-work computed by page JS

These tokens are computed by ChatGPT's own JavaScript. Because slop drives the real browser UI, the page computes these automatically — we never need to generate them ourselves. This is why the browser-UI approach is superior to raw API access for anti-bot bypass.

### Conduit token (routing)

The conduit JWT routes the SSE stream to a specific backend server:

```json
{
  "conduit_uuid": "d0707ca090f04bc89b4a0b632029751e",
  "conduit_location": "10.131.103.199:8308",
  "cluster": "unified-120",
  "iat": 1775611054,
  "exp": 1775611114
}
```

60-second TTL. The page calls `/f/conversation/prepare` immediately before each message send to get a fresh token.

---

## Implementation Phases

### Phase 1: SSE Stream Interception in inject-net.ts (P0)

**Files:** `extension/src/inject-net.ts`

- [x] 1.1: Add stream detection after `originalFetch.call()` resolves. Check: `response.headers.get("content-type")?.includes("text/event-stream")` OR the original request had `accept: text/event-stream` in init headers.
- [x] 1.2: For detected streams, read `response.body` via `getReader()`. Do NOT call `clone()` or `text()`.
- [x] 1.3: Create a pass-through `ReadableStream` that:
  - Reads chunks from the original reader
  - Decodes each chunk with `new TextDecoder("utf-8", { stream: true })` [BUN-STREAMS]
  - Dispatches `__slop_sse` CustomEvent with `{ url, method, status, chunk: decodedText, seq: chunkIndex, timestamp }`
  - Accumulates decoded text into a buffer
  - Enqueues the original `Uint8Array` bytes (not the decoded text) into the pass-through stream
- [x] 1.4: On stream completion (`reader.read()` returns `{ done: true }`):
  - Dispatch `__slop_net` with the full accumulated body (same format as existing non-stream capture)
  - Dispatch `__slop_sse_done` with `{ url, method, status, totalChunks, totalBytes, duration }`
  - Close the pass-through stream controller
- [x] 1.5: On stream error:
  - Dispatch `__slop_sse_error` with `{ url, error: message }`
  - Error the pass-through stream controller so the page sees the error naturally
- [x] 1.6: Return `new Response(passThrough, { status: response.status, statusText: response.statusText, headers: response.headers })` to the page. The page's code reads from this Response identically to the original.
- [x] 1.7: Non-stream responses continue through the existing `clone().text()` path unchanged.
- [x] 1.8: Guard against double-reading: if `response.bodyUsed` is already true (edge case where page consumed body before our patch runs), fall back to existing path and skip stream interception.

**Acceptance criteria:**
- [x] `slop net log --filter "f/conversation"` shows the ChatGPT SSE response body after stream completes
- [x] ChatGPT page behavior is identical — response renders in the UI, no errors in console
- [x] A `__slop_sse` event fires for each chunk during streaming, before the stream completes
- [x] The existing non-stream fetch capture (regular JSON APIs) is unaffected

### Phase 2: EventSource Interception in inject-net.ts (P1)

**Files:** `extension/src/inject-net.ts`

- [x] 2.1: Save `const OriginalEventSource = window.EventSource`.
- [x] 2.2: Create a wrapper class that extends or wraps `OriginalEventSource`:
  - Constructor: create real `OriginalEventSource(url, options)`, dispatch `__slop_sse_open` CustomEvent
  - Proxy `onmessage`, `onerror`, `onopen` setters to intercept and forward
  - Override `addEventListener` to wrap `"message"` listeners with interception
  - On each message: dispatch `__slop_sse` with `{ url, data: event.data, event: event.type, lastEventId: event.lastEventId }`
  - On close: dispatch `__slop_sse_close`
  - Preserve `readyState`, `url`, `withCredentials` as pass-through getters
- [x] 2.3: Set `window.EventSource = WrappedEventSource`. Preserve `window.EventSource.CONNECTING`, `OPEN`, `CLOSED` constants.
- [x] 2.4: Ensure `instanceof OriginalEventSource` still works by setting prototype correctly.

**Acceptance criteria:**
- [x] Sites using `new EventSource(url)` have their SSE messages captured in `slop sse log`
- [x] `slop sse streams` shows active EventSource connections
- [x] Page code using `instanceof EventSource` still works

### Phase 3: Content Script SSE Buffer (P0)

**Files:** `extension/src/content/net-buffer.ts` (extend)

- [x] 3.1: Add `__slop_sse` event listener alongside existing `__slop_net` listener.
- [x] 3.2: Maintain `activeStreams: Map<string, { url, method, status, chunks: string[], startTime, lastChunkTime }>` — keyed by URL.
- [x] 3.3: On `__slop_sse` event: append chunk to the URL's accumulator, update `lastChunkTime`.
- [x] 3.4: On `__slop_sse_done` event: move accumulated data to `completedStreams` ring buffer (cap 50), remove from `activeStreams`.
- [x] 3.5: Handle `get_sse_log` message from background: return completed streams, filtered by URL pattern, limited by count.
- [x] 3.6: Handle `get_sse_streams` message: return active stream metadata (URL, chunk count, byte count, duration).
- [x] 3.7: Handle `get_sse_chunk` message: return accumulated text for a specific active stream URL (for `slop sse tail`).
- [x] 3.8: Forward `__slop_sse` events to monitor (if armed) as `k: "sse"` events with `url`, `bz` (chunk size), `cause` correlation.

**Acceptance criteria:**
- [x] `slop sse streams` shows an active ChatGPT stream while generating
- [x] `slop sse log` shows completed streams with full response body
- [x] Monitor session includes `sse` events correlated to the click that triggered the prompt

### Phase 4: Background + CLI SSE Commands (P0)

**Files:** `extension/src/background/capabilities/passive-net.ts` (extend), `cli/commands/network.ts` (extend or new `cli/commands/sse.ts`), `cli/index.ts`, `cli/help.ts`

- [x] 4.1: Add `sse_log`, `sse_streams`, `sse_chunk` handlers to background passive-net capability. Route `get_sse_*` messages to the active tab's content script.
- [x] 4.2: Add `slop sse log [--filter] [--limit]` CLI command. Sends `{ type: "sse_log", filter, limit }` to background.
- [x] 4.3: Add `slop sse streams` CLI command. Sends `{ type: "sse_streams" }`. Prints active stream URLs, durations, chunk counts.
- [x] 4.4: Add `slop sse tail [--filter]` CLI command. Polls `sse_chunk` every 200ms and prints new text since last poll. Exits when stream completes.
- [x] 4.5: Register SSE commands in CLI dispatch and help text.

**Acceptance criteria:**
- [x] `slop sse log --filter backend-api` shows captured ChatGPT streams
- [x] `slop sse streams` shows active streams in real-time
- [x] `slop sse tail --filter f/conversation` prints tokens as ChatGPT generates them

### Phase 5: ChatGPT Agentic Command (P1)

**Files:** `cli/commands/chatgpt.ts` (new), `cli/index.ts`

- [x] 5.1: `slop chatgpt send "<prompt>"` — orchestrates the full flow:
  - Find textbox via `slop tree` + find `textbox "Chat with ChatGPT"`
  - Type prompt via `input_text` action
  - Send via `send_keys "Enter"`
  - Wait for SSE stream to appear via `sse_streams --filter f/conversation`
  - Tail stream via `sse_chunk` polling
  - Parse ChatGPT SSE wire format (each `data:` line is JSON with `message.content.parts[]`)
  - Print accumulated response to stdout
  - Return structured result: `{ conversationId, messageId, model, response }`
- [x] 5.2: `slop chatgpt send "<prompt>" --stream` — same flow but prints each chunk to stdout as it arrives instead of waiting for completion.
- [x] 5.3: `slop chatgpt read` — reads current conversation from DOM via `extract_text` on the main content area. Parses message boundaries from "You said:" / "ChatGPT said:" markers.
- [x] 5.4: `slop chatgpt status` — combines `sse_streams` (is it generating?) + `tree` analysis (model selector text, conversation ID from URL).
- [x] 5.5: `slop chatgpt conversations` — uses `slop net log --filter "conversations?offset"` to read the cached conversation list from the API response already in the net buffer.
- [x] 5.6: `slop chatgpt switch <id>` — navigates to `/c/<id>` via `navigate` action.
- [x] 5.7: `slop chatgpt model [name]` — reads current model from model selector button text. If name provided, clicks selector and chooses model.
- [x] 5.8: `slop chatgpt stop` — finds and clicks the "Stop" button if currently streaming.
- [x] 5.9: `slop chatgpt loop` — enters an interactive agent loop: reads stdin for prompts, sends each, reads response, prints, repeats. Ctrl+C to exit. This is the "agentic" mode where an outer agent (Cy) can pipe prompts and read responses.

**Acceptance criteria:**
- [x] `slop chatgpt send "What is 2+2?"` returns the response text
- [x] `slop chatgpt send "Write hello world in Python" --stream` shows tokens appearing in real-time
- [x] `slop chatgpt status` shows model name and streaming state
- [x] `slop chatgpt loop` can be driven by an outer process piping prompts to stdin

### Phase 6: Monitor SPA Re-arm Fix (P0)

**Files:** `extension/src/background/capabilities/monitor.ts`

- [x] 6.1: In the `onHistoryStateUpdated` handler, after emitting the `nav` event, re-send `monitor_arm` to the tab's content script. The content script persists across SPA navigation [CHR-CS-SPA] but may have lost its armed state if it was a fresh injection. The `arm()` function in `content/monitor.ts` is idempotent (returns early if already armed), so this is safe.
- [x] 6.2: Verify that `inject-net.js` MAIN-world script also persists across SPA navigation. Since it's injected at `document_start` and the document doesn't change on `history.pushState` [CHR-CS-SPA, CHR-WEBNAV-ORDER], it should persist. Verify this by checking `window.__slop_net_installed` after SPA navigation.

**Acceptance criteria:**
- [x] Monitor session on ChatGPT captures clicks, keystrokes, and mutations during SPA navigation between conversations
- [x] `slop monitor export <sid>` shows click + input + mutation + fetch events, not just nav events

### Phase 7: Documentation + Tests (P1)

**Files:** `README.md`, `CLAUDE.md`, `Notes/sse.md` (new), `Notes/chatgpt.md` (new), `test/sse.test.ts` (new)

- [x] 7.1: Add `## SSE Stream Capture` section to README.md and CLAUDE.md
- [x] 7.2: Add `## ChatGPT Agentic Bridge` section to README.md and CLAUDE.md with full `slop chatgpt` command reference
- [x] 7.3: Create `Notes/sse.md` with SSE interception architecture notes and manual smoke test
- [x] 7.4: Create `Notes/chatgpt.md` with ChatGPT wire protocol documentation from live capture analysis
- [x] 7.5: Create `test/sse.test.ts` — unit tests for SSE chunk parsing, event dispatch, buffer management
- [x] 7.6: Create `test/chatgpt.test.ts` — unit tests for ChatGPT SSE wire format parsing (`data:` line extraction, `[DONE]` detection, message content assembly)

**Acceptance criteria:**
- [x] `bun test` passes with new SSE and ChatGPT tests
- [x] Documentation covers the full flow from `slop chatgpt send` to response

---

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Pass-through ReadableStream breaks ChatGPT's body consumption | Medium | Page shows error, no response renders | Return original response if pass-through construction fails. Feature-flag via `__slop_sse_enabled` global. Test extensively on ChatGPT, Claude.ai, and Gemini. |
| ChatGPT CSP blocks the patched Response constructor | Low | SSE interception silently fails | `inject-net.js` already runs in MAIN world at `document_start` — `new Response()` and `ReadableStream` are standard constructors, not script execution. CSP restricts script-src, not object construction. Verified: ChatGPT's CSP allows `wss://*.chatgpt.com` and does not restrict `Response` or `ReadableStream`. |
| High-frequency chunk events overwhelm content script message passing | Medium | Events dropped, monitor misses data | Batch SSE chunks in inject-net.ts — accumulate for 100ms before dispatching a single `__slop_sse` event with all pending chunks concatenated. Configurable via `__slop_sse_batch_ms`. |
| ChatGPT changes wire protocol (SSE format, endpoint URLs) | Certain (over time) | ChatGPT commands break | SSE interception layer is site-agnostic. Only `cli/commands/chatgpt.ts` contains ChatGPT-specific parsing. Isolate all site-specific logic there. Document wire format in `Notes/chatgpt.md` for future reference. |
| EventSource wrapper breaks `instanceof` checks | Medium | Page code that checks `event.target instanceof EventSource` fails | Set `WrappedEventSource.prototype = Object.create(OriginalEventSource.prototype)` and ensure `.constructor` points to wrapper. |
| Memory leak from accumulated SSE body in inject-net.ts | Medium | Tab memory grows during long streams | Cap accumulated body at 10MB. Beyond that, stop accumulating but continue dispatching chunks. The `__slop_net` completion event will have a truncated body with a `truncated: true` flag. |
| `bodyUsed` check fails — response body already consumed before our patch | Low | SSE interception skipped for that request | Graceful fallback: if `response.body === null` or `response.bodyUsed === true`, skip SSE interception and dispatch only the headers event. |
| SPA re-arm sends `monitor_arm` when no monitor is active | Low | Unnecessary message, content script ignores it | `arm()` checks `if (armed) return` — safe to call redundantly. Background only sends re-arm if `activeSessionByTab.has(tabId)`. |
| Bun build transforms ReadableStream constructor or async iteration | Very Low | Pass-through stream construction fails at runtime | Bun docs confirm: "At the moment Bun does not attempt to down-convert syntax" [BUN-BUILD]. ReadableStream is a browser global, not a Bun shim. |

---

## Open Questions for Ron

1. **ChatGPT-first or generic-first?** Phase 1-4 (SSE interception) is site-agnostic. Phase 5 (chatgpt commands) is ChatGPT-specific. Should I also build `slop claude send` and `slop gemini send` in this PRD, or keep it ChatGPT-focused and generalize later?

2. **Stream output format** — When `slop chatgpt send --stream` prints tokens, should it print raw SSE `data:` lines, parsed text-only tokens, or structured JSON per chunk?

3. **Conversation state persistence** — Should `slop chatgpt` track conversation state (current conversation ID, message history) in the daemon's event log, or is the browser tab the single source of truth?

4. **Model selection** — ChatGPT Pro has GPT-4o, o1, o3, o4-mini, etc. Should `slop chatgpt send` default to whatever model is selected in the UI, or should it support `--model o3` to change before sending?

5. **Multi-turn context** — For `slop chatgpt loop`, should the agent be able to read previous messages in the conversation (via the SSE capture or DOM scraping), or does it only see the current turn's response?

6. **Phase ordering** — P0 phases (1, 3, 4, 6) are the SSE plumbing + monitor fix. P1 phases (2, 5, 7) are EventSource, ChatGPT commands, and docs. Agree?

---

## Success Metrics

1. **SSE chunks visible in real-time.** `slop sse tail --filter f/conversation` prints ChatGPT tokens as they stream — under 100ms latency from server chunk to CLI output.
2. **Full response captured.** `slop sse log --filter f/conversation` shows the complete SSE body after stream finishes, including all `data:` lines and `[DONE]` marker.
3. **Page behavior preserved.** ChatGPT renders the response identically with and without slop loaded. No console errors. No broken streaming.
4. **Agentic loop works.** An outer process can run `slop chatgpt send "prompt"`, read the stdout response, decide the next prompt, and loop — with structured JSON output including conversation ID and model info.
5. **Monitor captures everything on SPA.** A monitor session on ChatGPT captures clicks, keystrokes, mutations, AND SSE network events — not just navigation.
6. **Zero CDP.** `chrome.debugger` never appears in any code path.
7. **Zero API keys.** No OpenAI API key needed. Auth flows through Ron's browser session.
