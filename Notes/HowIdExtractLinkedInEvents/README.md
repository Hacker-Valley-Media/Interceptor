# How I’d Extract LinkedIn Events

## 2026-04-03 Initial findings

1. The existing CLI already exposed `slop network on|off|log`, but the extension did not implement the underlying capture path.
2. `background.ts` had no `network_intercept` or `network_log` route handling even though `cli/index.ts` and `extension/src/types.ts` defined those action types.
3. That meant the requested LinkedIn flow could not work yet as-is; the missing work was real network capture plus LinkedIn-specific parsing/validation.
4. The likely implementation path was:
   - capture LinkedIn page traffic in the extension,
   - persist matching request/response data,
   - parse event/post/engagement entities from those responses,
   - cross-check a subset of fields against DOM text on-screen.

## Requested output fields to support

- Thumbnail
- Event title
- Event organizer name
- Event date/time as ISO 8601 with timezone
- Attendee count
- Attendee profile names
- Linked post text attached to the event
- Poster name
- Poster follower count
- Likes / reactions
- Reposts
- Comments
- Threaded comments
- Event details tab content

## Key design constraint from Ron

No sub-agents at any point.

## What I implemented

### 1. Real network capture in the background service worker

I implemented `network_intercept` and `network_log` for real by using the existing `debugger` permission and Chrome `Network.*` events.

What it now stores per request:
- URL
- method
- resource type
- status
- request headers
- response headers
- request body if present
- response body when obtainable
- timestamp
- error text for failed requests

### 2. LinkedIn event extraction command

I added:
- `slop linkedin event [url]`
- alias: `slop linkedin-event [url]`

Flow:
1. enable network capture,
2. navigate to the LinkedIn event URL if needed,
3. wait for load + DOM stability,
4. extract visible DOM clues from the page,
5. score captured JSON responses to find the best event-related response and the best post-related response,
6. pull structured fields out of those responses,
7. merge with DOM-derived values,
8. report validation signals showing whether network values match the screen.

### 3. DOM validation action

I added a content-script action `linkedin_event_dom` that tries to pull visible page values for:
- title
- organizer name
- displayed date text
- attendee summary line
- attendee count derived from the visible summary string
- visible attendee names derived from the summary string
- thumbnail (`#ember33` first, then fallback image)
- details tab text
- post text / poster / follower text / engagement counts from the visible card

### 4. Merge strategy

The final extractor prefers network-derived values when they are available, but keeps DOM values as fallbacks.

Examples:
- `startTimeIso` / `endTimeIso` come from network parsing when found.
- `displayedDateText` remains the on-screen string for validation/reference.
- attendee count prefers network, falls back to the visible summary-derived count.
- post metrics prefer network, fall back to visible counts on the page.

## Doc grounding

I read the local docs Ron pointed me to and grounded the implementation against them.

### Chrome extension debugger docs
Source:
- `80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/reference/api/debugger.md`

Relevant grounding:
- `chrome.debugger` can target tabs with `tabId` and route events back by `tabId` through `onEvent`.
- The allowed protocol domains include `Network`.
- This confirms that using `chrome.debugger.sendCommand(..., "Network.enable")` plus `chrome.debugger.onEvent` is a supported way to instrument tab network activity from the extension.

### Declarative Net Request docs
Source:
- `80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/reference/api/declarativeNetRequest.md`

Relevant grounding:
- DNR is for blocking/modifying requests and headers.
- The docs explicitly say it works "without intercepting them and viewing their content".
- That is the key reason I did **not** use DNR for LinkedIn event extraction. DNR can help with headers, but it is not the right primitive for reading response bodies.

### Service worker WebSocket docs
Source:
- `80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/how-to/web-platform/websockets.md`

Relevant grounding:
- Chrome 116+ improves WebSocket support in extension service workers.
- The docs say the service worker can still go inactive unless messages are exchanged within the 30-second activity window.
- Example guidance uses a keepalive every 20 seconds.

Patch made from that grounding:
- I added WebSocket keepalive traffic in `background.ts` every 20 seconds.
- I added daemon-side handling to ignore `keepalive` WS messages.
- I added `minimum_chrome_version: "116"` to `extension/manifest.json` so the transport assumptions are explicit.

### Extension service worker docs
Source:
- `80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/service-workers.md`

Relevant grounding:
- The extension service worker is the central event handler and can be unloaded when dormant.
- This supports keeping network capture in the background service worker instead of pushing it into content-script-only logic.

### CanIUse WebSockets docs
Source:
- `80-89_Resources/80_Reference/docs/CanIUse/docs/features/websockets.md`

Relevant grounding:
- WebSockets have broad support and are not a speculative platform choice for the slop daemon bridge.
- This supports keeping the existing WebSocket bridge as a viable fallback transport.

## Chrome-browser docs note

I searched the local `chrome-browser` docs root Ron pointed me to for network/debugger/service-worker/websocket references and did not find a directly relevant local file there for this task. The Chrome extension docs above were the relevant grounding set.

## Validation performed

### Code presence verification
- confirmed `network_intercept`, `network_log`, `linkedin_event_extract`, `Network.enable`, `Network.getResponseBody`, and `chrome.debugger.onEvent` exist in the source tree.

### Build/test verification
- `bun build extension/src/background.ts --outdir=/tmp/slop-doccheck --target=browser`
- `bun build daemon/index.ts --target=bun --outfile=/tmp/slop-daemon-doccheck.js`
- `bun test`
- `bash scripts/build.sh --target=host`
- `./dist/slop help | rg "LinkedIn|linkedin event|network log"`

All of those passed.

## Current honesty notes

1. I overcame the missing network logging implementation in code.
2. I doc-grounded the choice of `chrome.debugger` for response capture and the WS keepalive behavior.
3. I still have **not** live-verified a real LinkedIn extraction run in this shell because the extension/daemon were not connected during the session.
4. So I can truthfully claim:
   - implementation exists,
   - docs support the chosen approach,
   - build/tests pass,
   - but a live LinkedIn end-to-end run remains to be performed in a connected browser session.

## Files changed

- `extension/src/background.ts`
- `extension/src/content.ts`
- `extension/src/types.ts`
- `cli/index.ts`
- `extension/manifest.json`
- `daemon/index.ts`
- `Notes/HowIdExtractLinkedInEvents/README.md`
