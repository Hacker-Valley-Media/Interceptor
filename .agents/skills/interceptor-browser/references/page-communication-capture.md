# Page Communication Capture

P1 page communication capture covers browser APIs that are not ordinary
request/response fetches:
- `WebSocket`
- `navigator.sendBeacon`
- `BroadcastChannel`

It complements the existing passive network surfaces:
- `interceptor net log` -> fetch/XHR
- `interceptor sse log` -> EventSource/text-event-stream
- `interceptor net page-comm log` -> WebSocket/Beacon/BroadcastChannel

## Source Of Truth

The capture source is MAIN-world JavaScript wrapping, not CDP and not
`chrome.webRequest`.

Implementation anchors:
- `extension/src/inject-net.ts` wraps `WebSocket`, `navigator.sendBeacon`, and
  `BroadcastChannel`, then dispatches `__interceptor_page_comm` events.
- `extension/src/content/net-buffer.ts` buffers page communication rows and
  serves `get_page_comm_log` / `clear_page_comm_log`.
- `extension/src/net-buffer-content.ts` loads the buffer at `document_start`.
- `extension/manifest.json` orders `net-buffer-content.js` before
  `inject-net.js` and runs `inject-net.js` in the MAIN world.
- `extension/src/background/capabilities/passive-net.ts` implements
  `page_comm_enable`, `page_comm_log`, `page_comm_clear`, and status/disable.
- `test/page-comm.test.ts` guards constructor preservation, event names,
  manifest order, dynamic registration, CLI parsing, and the fact that
  `webRequest` is not the WebSocket-frame source.

## Command Surface

```bash
interceptor net page-comm log [--type ws|beacon|broadcast] [--filter <text>] [--since <30s|epoch-ms>] [--limit <n>]
interceptor net page-comm clear

interceptor net monitor on [--reload|--from-start] [--filter <match-pattern>] [--persist]
interceptor net monitor status
interceptor net monitor off

interceptor monitor start --capture page-comm [--reload|--from-start]
interceptor monitor export <session-id> --format json|har|pcapng|plan
```

Notes:
- `net monitor on --filter` configures Chrome content-script match patterns
  such as `https://example.com/*`; it is not the same as the substring filter
  used by `net page-comm log --filter`.
- `net page-comm log --filter` searches URL, BroadcastChannel name, and event
  name in the buffered entries.
- `--persist` keeps dynamic registration across extension service-worker
  restarts. Prefer leaving it off for task-scoped capture unless you need that.

## Capture Modes

Static document-start injection in the packaged extension captures new pages by
default. The explicit monitor commands are still the operator-safe controls:

- **Attach-now**: `interceptor net monitor on` injects the current tab now and
  captures future WebSocket instances, future Beacon calls, and future
  BroadcastChannel activity.
- **From-start**: `interceptor net monitor on --reload` registers the MAIN-world
  wrapper at `document_start` and reloads the tab so startup sockets/channels are
  covered.
- **Monitor session**: `interceptor monitor start --capture page-comm` writes
  page communication rows into the monitor event stream; `--reload` gives the
  same from-start guarantee.

The key boundary is time of construction. A WebSocket created before the wrapper
was present cannot be retroactively reconstructed.

## Event Shapes

WebSocket events:
- `ws_opening`: constructor called
- `ws_open`: browser opened the socket
- `ws_send`: page called `send(...)`
- `ws_message`: page received a message
- `ws_error`: socket error event
- `ws_close`: socket closed, with close code/reason/clean flag when available

Beacon events:
- `beacon`: `navigator.sendBeacon(...)` returned normally
- `beacon_error`: `sendBeacon` threw

Beacon is one-way from page JavaScript. The row records URL, POST method,
return value, and payload preview; there is no response status/body to capture
from `sendBeacon`.

BroadcastChannel events:
- `broadcast_open`
- `broadcast_send`
- `broadcast_message`
- `broadcast_error`
- `broadcast_close`

BroadcastChannel is same-origin page communication, not HTTP traffic. Use URL
filters only for the tab URL; use channel-name filters to narrow the channel.

## Payload Limits

Payload capture is a preview, not a byte-perfect packet capture:
- Text/string payload preview is capped at 4096 characters.
- JSON-like values are serialized defensively and capped.
- `ArrayBuffer` and typed-array payloads are base64-previewed.
- `Blob` captures type and size, not blob contents.
- `FormData` previews up to 50 fields and file metadata.

Use the byte counts and `truncated` flag when deciding whether the preview is
enough evidence.

## What This Does Not Cover

- HTTP fetch/XHR: use `interceptor net log`.
- EventSource/SSE: use `interceptor sse log`.
- WebTransport, WebRTC data channels, WebUSB/WebSerial, or native app sockets:
  not part of P1 page communication capture.
- Raw TLS packets, compressed wire bytes, permessage-deflate details, HTTP/2
  frames, TCP timing, or server-side messages hidden below the JavaScript API.
- Sockets created before Interceptor's wrapper was installed.

## Verification Recipe

Use this when validating an installed package or a suspected regression:

```bash
interceptor reload
interceptor open "http://127.0.0.1:<port>/p1-page-comm.html"
interceptor net monitor on --reload
# trigger or wait for WebSocket, Beacon, and BroadcastChannel activity
interceptor net page-comm log --limit 100
interceptor net page-comm log --type ws --limit 20
interceptor net page-comm log --type beacon --limit 20
interceptor net page-comm log --type broadcast --limit 20
interceptor net monitor off
```

Passing evidence includes:
- WebSocket rows containing `ws_opening`, `ws_open`, `ws_send`, `ws_message`,
  and `ws_close`.
- Beacon rows containing `beacon` with `returnValue`.
- BroadcastChannel rows containing send and receive events for the channel.
- No CDP debugger banner and no dependency on `interceptor network on`.
