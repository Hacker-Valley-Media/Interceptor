# SSE Stream Interception — Architecture Notes

## How it works

`inject-net.ts` (MAIN world, `document_start`) patches `window.fetch` to detect SSE responses:

1. After `originalFetch()` resolves, check `content-type: text/event-stream` or request `accept: text/event-stream`
2. For SSE: read `response.body` via `getReader()`, create a pass-through `ReadableStream`
3. Each chunk: decode with `TextDecoder("utf-8", { stream: true })`, dispatch `__slop_sse` CustomEvent
4. On completion: dispatch `__slop_net` with full body + `__slop_sse_done` with metadata
5. Return `new Response(passThrough, { status, statusText, headers })` — page sees identical behavior

## EventSource

Also patches `window.EventSource`:
- Wraps the constructor to dispatch `__slop_sse_open`
- Intercepts `onmessage` and `addEventListener("message")` to dispatch `__slop_sse` per event
- Wraps `close()` to dispatch `__slop_sse_close`
- Preserves `instanceof EventSource` via prototype chain

## Content script buffer (net-buffer.ts)

- `activeStreams: Map<url, { chunks, totalBytes, startTime }>` — accumulates while streaming
- `completedStreams: CompletedSseEntry[]` — ring buffer of 50 completed streams
- Messages: `get_sse_log`, `get_sse_streams`, `get_sse_chunk`

## CLI commands

```bash
slop sse log [--filter <pattern>] [--limit N]
slop sse streams
slop sse tail [--filter <pattern>]
```

## Manual smoke test

1. Open chatgpt.com in a slop tab: `slop tab new "https://chatgpt.com/"`
2. Wait for load: `sleep 5`
3. Check streams are empty: `slop sse streams`
4. Type a message: `slop type e98 "Hello"` then `slop keys Enter`
5. Watch streams: `slop sse streams` — should show active stream
6. Tail the stream: `slop sse tail --filter f/conversation`
7. After completion: `slop sse log --filter f/conversation` — should show full body
