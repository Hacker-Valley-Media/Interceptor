# Raw CDP on a browser tab

`interceptor tab cdp` sends Chrome DevTools Protocol (CDP) methods to a browser tab and streams that tab's CDP events. The extension relays `chrome.debugger`, so the tab stays in the user's signed-in profile and nothing is launched with a debug port.

Use it for what no named verb covers: a live screencast, trusted input into a tab that is not showing, request interception with your own decision logic. For Electron and Chromium desktop apps use the CDP app surface instead (`interceptor macos cdp` on a Mac, `interceptor desktop cdp` on Windows and Linux).

Chromium browsers only. Safari has no `chrome.debugger`.

## CLI

```bash
interceptor tab cdp send <Domain.method> [jsonParams] [--session <id>] --tab <id>
interceptor tab cdp events [--filter Page.,Fetch.] [--no-attach] [--limit N] [--timeout ms] --tab <id>
interceptor tab cdp attach --tab <id>
interceptor tab cdp detach --tab <id>
interceptor tab cdp status
```

| Verb | What it does |
|---|---|
| `send` | Runs one CDP method and prints its result. `--json` prints `{success, data, tabId}`. A CDP error is `success: false` with `data.cdpError: {code, message}`. |
| `events` | Prints one JSON object per line: `{tabId, method, params[, sessionId]}`. Runs until Ctrl-C, `--limit` events, or `--timeout` ms. |
| `attach` | Keeps the debugger attached across calls. |
| `detach` | Ends the tab's raw session for every holder. |
| `status` | Lists the tabs with a raw session or a subscription in this profile. |

`--session <id>` targets a child CDP session (an out-of-process iframe or a worker, after `Target.setAutoAttach` with `flatten: true`).

## Sessions

Without a session, `send` attaches the debugger, runs the method and detaches. `Page.captureScreenshot` works that way. State that lives in the debugger session, such as `Page.startScreencast`, `Fetch.enable` and `Emulation.setFocusEmulationEnabled`, needs a session that stays attached.

Two things hold a session:

| Holder | Starts | Ends |
|---|---|---|
| Event subscription | `tab cdp events`, or `cdp_tab_events` on the socket | The subscriber's socket closes. Also 35 s after the daemon stops, or when the tab closes or the person cancels. |
| Explicit attach | `tab cdp attach` | `tab cdp detach`, the tab closes, or the person cancels. |

Prefer the subscription. It is released when the client exits or crashes, and when the daemon goes away. An explicit attach is not released when its caller exits.

When the last subscription on a tab ends, the extension sends `Fetch.disable` for that tab, so a request can never stay paused with no client left to answer it.

## Socket contract

Programs talk to the daemon on its IPC socket: the unix socket that `interceptor status` prints (`$TMPDIR/interceptor.sock`), or TCP `127.0.0.1:<ipc port>` on Windows. Every message in both directions is a 4-byte little-endian length followed by that many bytes of UTF-8 JSON. A frame can be up to 64 MiB.

One socket carries many requests. Each request has an `id`, and its answer carries the same `id`. Event frames have no `id`.

### Commands

```jsonc
// request
{"id": "<uuid>", "action": {"type": "cdp_tab_send", "method": "Page.captureScreenshot", "params": {"format": "jpeg"}}, "tabId": 123, "contextId": "<profile>"}
// answer
{"id": "<uuid>", "result": {"success": true, "data": {"data": "<base64>"}, "tabId": 123}}
// a CDP error
{"id": "<uuid>", "result": {"success": false, "error": "Page.foo: 'Page.foo' wasn't found", "data": {"cdpError": {"code": -32601, "message": "'Page.foo' wasn't found"}}, "tabId": 123}}
```

| `action.type` | Extra fields | `result.data` |
|---|---|---|
| `cdp_tab_send` | `method`, `params?`, `sessionId?` | The CDP result object |
| `cdp_tab_attach` | | `{tabId, alreadyAttached}` |
| `cdp_tab_detach` | | `{tabId, detached}` |
| `cdp_tab_status` | | `[{tabId, attached, session, explicit, subscriptions, fetchOwned, sharedWithCapture}]` |
| `cdp_tab_events` | `filter?: string[]`, `attach?: boolean` (default `true`) | `{subscription, tabId, attached}`; event frames follow on this socket |
| `cdp_tab_unsubscribe` | `subscription` | `{subscription, removed}` |

`tabId` selects the tab. `contextId` selects the browser profile and is required when more than one is connected (`interceptor contexts`). Tab scoping is the same as for every browser verb: the tab must be in an Interceptor tab group, and `"group": "<label>"` in the action scopes to a named group. `"anyTab": true` lifts that gate and needs the user's explicit authorization.

### Events

After a successful `cdp_tab_events`, the daemon writes event frames to the same socket, in the order Chrome raised them:

```jsonc
{"type": "cdp_event", "subscription": "<uuid>", "tabId": 123, "method": "Page.screencastFrame", "params": {"data": "<base64 jpeg>", "sessionId": 7, "metadata": {}}}
```

- `filter` keeps the methods that start with one of the prefixes (`["Page.", "Fetch.requestPaused"]`). No filter means every event.
- `sessionId` at the top level is present for an event from a child CDP session.
- Each event is one frame. Nothing is batched, and frames are not written to the daemon's events file.
- Closing the socket is the unsubscribe. To end one subscription and keep the socket, send `cdp_tab_unsubscribe`.
- Send commands on the same socket or on another one. `Page.screencastFrameAck` is an ordinary `cdp_tab_send`.
- A subscriber that falls more than 64 MiB behind is dropped.

Session events use the `Interceptor.` prefix and are never filtered out:

| `method` | `params` | Meaning |
|---|---|---|
| `Interceptor.detached` | `{reason}` | The debugger left the tab. `canceled_by_user`: the person clicked Cancel on Chrome's debugging bar. `target_closed`: the tab closed. `client_detached`: a client sent `cdp_tab_detach`. The subscription stays open; a new attach resumes events. |
| `Interceptor.tabCreated` | `{tabId, openerTabId, url, windowId}` | The subscribed tab, or a tab it opened, opened a tab. The frame's `tabId` is the subscribed tab. `url` can be empty this early. |
| `Interceptor.tabRemoved` | `{tabId}` | The subscribed tab, or a tab opened from it, closed. |
| `Interceptor.subscriptionEnded` | `{reason}` | The daemon ended the subscription: `extension_restarted` or `context_disconnected`. Subscribe again. |

### Popups

A tab opened from a tab in a raw session (an OAuth window) is not in an Interceptor tab group. While the opener's session lasts, raw CDP actions on that tab pass the group gate, so a client can subscribe to it and drive it. Other verbs still need `anyTab`. Chrome shows a tab it opens with `window.open` in front of its opener; that is the browser's behavior, and `interceptor tab switch <opener>` or `interceptor window resize <id> --state minimized` undoes it.

## One debugger client per tab

Chrome gives a tab to one `chrome.debugger` client. If another extension or automation tool holds the tab, attach fails with `tab <id> already has a debugger client attached (another extension or automation tool); nothing was attached`. Interceptor does not take the tab over.

Interceptor's own users of the debugger share one attachment:

- **Network capture** (`interceptor network on`) keeps recording while a raw session is attached. Both receive every event. A raw `Network.disable` is ignored while capture is on. When the raw session ends, capture stays attached.
- **Request overrides** (`network_override` rules) continue each paused request themselves. A raw session cannot send `Fetch.enable` on a tab that has override rules, and override rules cannot be set on a tab whose raw session has `Fetch.enable` active. Each case fails with an error that names the other side.

## Background behavior

Nothing in this path activates a tab, focuses a window or raises the browser. Measured on Chrome for Testing 153 with the tab not showing in its window: `Page.captureScreenshot` returns the page, `Page.startScreencast` delivers frames as fast as they are acked, and `Input.insertText` lands in the focused field after `Emulation.setFocusEmulationEnabled`. The set of active tabs was the same before and after.

While a debugger is attached, Chrome shows its "Interceptor started debugging this browser" bar in that profile. The bar is Chrome's own notice and cannot be hidden by an extension. Its Cancel button detaches the debugger.

## Exposure

Raw CDP is the tab's full protocol surface: `Runtime.evaluate`, `Page.navigate`, `Network.getCookies`, `Input.*`. Treat it like `eval --main`.

| Layer | Rule |
|---|---|
| Transport | IPC socket only. The daemon refuses every `cdp_tab_*` action on its loopback WebSocket with `raw CDP requires local IPC`, because a web page can open a loopback WebSocket and cannot open the IPC socket. |
| Tab scope | The managed-tab gate applies, as for every browser verb. |
| Domains | Chrome limits `chrome.debugger` to its documented set of CDP domains. Interceptor adds no method allowlist: a local caller already has `eval`, `cookies` and `navigate`. |
| MCP | `tab cdp` is in the arbitrary-exec tier. It is refused unless the operator set `INTERCEPTOR_MCP_ALLOW`, and then still needs `confirm: true`. |
| Visibility | Chrome's debugging bar shows for as long as a debugger is attached. |

## Example: screencast a tab that is not showing

```bash
interceptor tab cdp events --tab 123 --filter Page.screencastFrame > frames.ndjson &
interceptor tab cdp send Page.startScreencast '{"format":"jpeg","quality":60}' --tab 123
# for each line in frames.ndjson, ack it:
interceptor tab cdp send Page.screencastFrameAck '{"sessionId":<params.sessionId>}' --tab 123
```

A client that streams should use one socket for the subscription and the acks, not one CLI process per ack.
