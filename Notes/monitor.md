# Monitor — Session Recording for Agent Replay

## What it does

`slop monitor` records a full trace of a browser session so an agent can read it back and replay it. It observes:

- **User input:** clicks, double-clicks, right-clicks, keystrokes, form inputs, submits, focus/blur, copy/paste, throttled scroll.
- **DOM mutations:** batched 50ms windows, collapsed per user action.
- **Network:** every `fetch()` and `XMLHttpRequest` (via the existing `__slop_net` inject-script pipeline) tagged with the user action that caused it.
- **Navigation:** hard nav, `history.pushState`, reference-fragment updates, and reload (via `chrome.webNavigation.onCommitted` and `onHistoryStateUpdated` — no CDP).

The monitor writes to `/tmp/slop-browser-events.jsonl` alongside slop's existing RPC event stream. Sessions are delimited by `mon_start` / `mon_stop` records that share a common `sid`.

## Non-goals

- Recording video or screenshots — see `slop screenshot` if you need visuals.
- Perfect causality between synchronous JS stack frames — the monitor uses a 500ms time window to attribute side effects to user actions. Good enough for replay; not good enough for profiling.
- Recording the agent's own synthetic clicks as "user" input — real events have `tr: true`, synthetic `dispatchClickSequence` events have `tr: false`. The replay plan generator only replays `tr: true` events.

## Manual smoke test (5 minutes)

This assumes you have slop built and loaded, and a Chrome/Brave window with the slop-browser extension running.

### 1. Rebuild and reload the extension

```bash
bash scripts/build.sh
```

In Chrome: open `brave://extensions/` (or `chrome://extensions/`), find slop-browser, click the reload icon. Or run:
```bash
slop reload
```

### 2. Open a test page

```bash
slop tab new "https://duckduckgo.com/"
sleep 2
```

### 3. Start a recording

```bash
slop monitor start --instruction "search for 'bun runtime' and click the first result"
```

Expected output:
```
monitor started
  sessionId: 7f3e2c1a-...
  tabId:     123456789
  url:       https://duckduckgo.com/
  instruction: search for 'bun runtime' and click the first result
```

### 4. Interact with the page manually

Click into the search box. Type `bun runtime`. Press Enter. Click the first result.

### 5. Watch the live tail in another terminal (optional)

```bash
slop monitor tail
```

You should see lines like:

```
[+1.820]  input     e17  textbox "Search"                v="bun runtime"
[+2.156]  key       "Enter"
[+2.201]  mut       +8 -2 attr:4                          (cause: #2)
[+2.289]  fetch     GET /ac/ 200 1.2k                     (cause: #2)
[+2.412]  nav       history → /?q=bun+runtime             (cause: #2)
[+2.887]  mut       +37 -4 attr:12 tgts:e42,e43,e44       (cause: #2)
[+4.012]  click     e42  link    "bun.sh"                 (1021,512) trusted
[+4.045]  nav       hard → https://bun.sh/
```

### 6. Stop the recording

```bash
slop monitor stop
```

Expected:
```
monitor stopped
  sessionId: 7f3e2c1a-...
  duration:  5.2s
  events:    18
  mutations: 4
  network:   3
  nav:       2
```

### 7. Inspect the session

List all sessions in the log:
```bash
slop monitor list
```

Render the one you just made:
```bash
slop monitor export 7f3e2c1a-...
```

Emit a replay plan:
```bash
slop monitor export 7f3e2c1a-... --plan
```

Expected plan output:
```
# Replay plan for session 7f3e2c1a-...
# Instruction: search for 'bun runtime' and click the first result
# Started at: 2026-04-07T12:44:32.123Z

slop tab new "https://duckduckgo.com/"
slop wait-stable
slop click "textbox:Search"
slop type "textbox:Search" "bun runtime"
slop keys "Enter"
slop wait-stable
# slop net log --filter "/ac/" --limit 1
slop click "link:bun.sh"
slop wait-stable
```

### 8. Replay it

Manually pipe the plan's `slop` lines into a shell, or save to a file and run line-by-line. The existing `slop batch` command accepts JSON arrays of raw actions but the plan output is shell commands by design (readable by humans, auditable before execution).

## Troubleshooting

### "no active monitor session on tab N"
Either the monitor was never started on that tab, or the tab was closed and its session was auto-ended with reason `tab_closed`. Check:
```bash
slop monitor status --all
```

### The tail shows nothing
Check that the extension is loaded and the content script actually received `monitor_arm`. Force a reload:
```bash
slop reload
slop monitor stop
slop monitor start
```

### Events look out of order
The monitor assigns `seq` monotonically per-session inside the background service worker, but messages from content scripts in multiple frames may arrive at the background in an order slightly different from their local timestamps. The `t` (wall-clock ms) field is the ground truth — `slop monitor export` sorts by `t` before rendering.

### Passwords are showing up in the log
They shouldn't be. `input[type=password]` values are masked to `***<length>***` unconditionally before the event is emitted. If you see a plaintext password in a `k:input` event, file a bug — the site probably uses `type=text` with a custom masking widget, which is a different leak class. Mitigation: use `slop monitor pause` while entering secrets.

### Custom credit-card fields leak
The monitor also masks any input whose `autocomplete` attribute starts with `cc-` or whose `name`/`id` matches `/card|cvv|credit/i`. Anything outside those heuristics will leak its value. When in doubt, `slop monitor pause`.

## File layout

- `extension/src/content/monitor.ts` — capture-phase listeners, mutation batcher, `__slop_net` subscriber, content-side message handlers (`monitor_arm`, `monitor_disarm`), `emit()` helper.
- `extension/src/background/capabilities/monitor.ts` — session map, `handleMonitorActions` entry point, `chrome.runtime.onMessage` listener for `mon_evt` messages, `chrome.webNavigation` listeners for nav attribution, `chrome.tabs.onRemoved` for tab-close detection.
- `cli/commands/monitor.ts` — `parseMonitorCommand`, local `tail`/`list`/`export` handlers, pretty-text renderer, `--plan` generator.
- `daemon/index.ts` — no logic change. The existing `{type:"event"}` path in `handleNativeMessage` already appends to `EVENTS_PATH`; a 3-line fix routes the same messages through the ws fallback channel.

## How correlation works

Every user-action event pushes `{seq, t}` onto an in-frame ring buffer (cap 16). When a `mut` batch flushes or a `__slop_net` event arrives, the emitter walks the ring backward looking for the most recent user action within 500 ms — that's the `cause`. If no action is in-window, `cause` is omitted and the event is autonomous (polling, timer, etc.).

This is intentionally a heuristic. It can be wrong in two directions:
- A network call fired by `setTimeout(..., 400)` after a click will be attributed to the click. Usually fine — it IS a consequence of the click.
- A network call fired more than 500 ms after a click is marked autonomous even if the click caused it (async chain with delays). Tighten or loosen the window in `monitor.ts` `CAUSE_WINDOW_MS` if your workflow needs it.

## Limits

- **10 MB log rotation.** The daemon keeps the tail half when the file exceeds 10 MB. A long session can be truncated — `slop monitor list` will still see the `mon_start` / `mon_stop` pair if both survive the rotation.
- **Cross-origin iframes** that block content script injection are invisible to the monitor. This matches the existing `slop tree` / `slop net log` behavior.
- **`os_click` events** generated by `slop click --os` produce real OS-level mouse events. To the monitor they look identical to human clicks (`tr: true`). Cross-reference against the `request_received` log in the same event file to distinguish.
- **Hard cross-origin navigation** resets the content script's local `seq` counter to 0. The background assigns a global `seq` when relaying events, so the exported log is still monotonically increasing.
