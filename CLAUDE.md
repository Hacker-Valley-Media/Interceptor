# slop-browser

Browser control CLI for AI agents. No CDP, no MCP, no API keys. You call `slop`, read the output, decide what's next.

**Binary:** `dist/slop`

## Start Here

```bash
slop open "https://example.com"        # Open, wait, return tree + text (1 command)
slop act e1                            # Click element, return updated tree + diff
slop act e2 "hello"                    # Type into field, return updated tree
slop read                              # Re-read current page (tree + text)
slop inspect                           # Tree + text + network log + headers
```

The daemon auto-starts. No setup needed.

### Legacy (still works, but prefer compound commands above)

```bash
slop tab new "https://example.com"    # Open managed tab
sleep 2                                # Wait for load
slop tree                              # See interactive elements
slop click e1                          # Click by ref
slop type e2 "hello"                   # Type into field
slop text                              # Read visible text
```

## Use Cases

The [`use-cases/`](use-cases/) folder is where proven browser workflows get turned into reusable documentation. When you figure out how to do something reliably on a live site, add a compact use-case there so later agents can follow the path instead of burning tokens rediscovering it.

## Compound Commands (Agent-Optimized)

These collapse multi-step patterns into single CLI invocations. Prefer these over the individual commands below.

```bash
slop open "https://example.com"        # tab new + wait + tree + text in one call
slop open "https://example.com" --tree-only   # Skip text
slop open "https://example.com" --text-only   # Skip tree
slop open "https://example.com" --full        # Full text (no 2000-char limit)
slop open "https://example.com" --timeout 10000  # Custom wait timeout
slop open "https://example.com" --no-wait     # Don't wait for load
slop read                              # Tree + text for current page
slop read e5                           # Tree + text for element subtree
slop read --tree-only                  # Just tree
slop read --text-only                  # Just text
slop act e5                            # Click + wait + return updated tree + diff
slop act e3 "hello"                    # Type + wait + return updated tree
slop act e5 --os                       # OS-level trusted click
slop act e5 --keys "Enter"             # Send keyboard shortcut instead
slop act e5 --no-read                  # Skip post-action tree read
slop inspect                           # Tree + text + net log + headers
slop inspect --net-only                # Just network data
slop inspect --filter api              # Filter network entries
```

## Reading Pages

```bash
slop tree                              # Interactive elements with refs (e1, e2...)
slop tree --filter all                 # Include headings + landmarks
slop text                              # All visible text
slop text e7                           # Text from specific element
slop html e5                           # HTML of element
slop find "Submit"                     # Find elements by name
slop find "Submit" --role button       # Filter by ARIA role
slop diff                              # What changed since last tree
slop state                             # DOM tree + scroll + focus (verbose)
```

## Interacting With Pages

```bash
slop click e5                          # Click element
slop click e5 --os                     # OS-level trusted click (bypasses isTrusted)
slop type e3 "hello"                   # Type into field (clears first)
slop type e3 "more" --append           # Append without clearing
slop select e7 "option-value"          # Select dropdown option
slop hover e5                          # Hover over element
slop keys "Enter"                      # Keyboard shortcut
slop keys "Control+A" --os             # OS-level keyboard
slop scroll down                       # Scroll
```

When a synthetic click doesn't trigger anything (React/Angular sites), slop auto-escalates to OS-level input. You can also force it with `--os`.

## Navigating

```bash
slop tab new "https://example.com"     # New tab (joins slop group)
slop navigate "https://other.com"      # Navigate current tab
slop tabs                              # List all tabs (* = active)
slop tab switch 12345                  # Switch to tab by ID
slop tab close                         # Close current tab
slop back                              # History back
slop forward                           # History forward
slop wait 2000                         # Wait milliseconds
slop wait-stable                       # Wait for DOM to stop changing
```

## Sniffing Network Traffic

All `fetch()` and `XMLHttpRequest` traffic is captured automatically on every page. No setup. No CDP. No debugger bar.

```bash
slop net log                           # All captured fetch/XHR requests
slop net log --filter voyager          # Filter by URL substring
slop net log --filter api.example.com  # See specific API calls
slop net log --since 1700000000000     # After timestamp
slop net log --limit 50                # Max entries (default 100)
slop net clear                         # Flush buffer
slop net headers                       # Request headers the page sent (CSRF tokens, auth)
slop net headers --filter linkedin     # Filter by URL
```

Each entry includes: `url`, `method`, `status`, `body` (full response text), `type` (fetch/xhr), `timestamp`.

### Injecting / Rewriting Requests

Override rules rewrite URLs before the page's JavaScript sends them. The page sees the modified request. The server gets the modified request. No CDP.

```bash
# Change a query parameter on matching requests
slop override "*eventAttending*" count=50

# Multiple params
slop override "*api/search*" limit=50 offset=0

# Clear overrides
slop override clear
```

This is how `slop linkedin attendees` changes LinkedIn's page size from 20→50 — the page's own JavaScript fetches attendees, but slop rewrites the request in-flight to ask for more results.

## SSE Stream Capture

slop intercepts Server-Sent Events (text/event-stream) in real-time, chunk by chunk.

```bash
slop sse streams                                  # List active SSE streams
slop sse log [--filter <pattern>] [--limit N]     # Show completed SSE streams
slop sse tail [--filter <pattern>]                # Live tail SSE chunks
```

Works automatically on any site using fetch-based SSE or EventSource. No CDP. No setup.

## ChatGPT Agentic Bridge

Drive ChatGPT's web UI programmatically — send prompts, read streamed responses via the API wire protocol, iterate.

```bash
slop chatgpt send "What is 2+2?"                  # Send and read response
slop chatgpt send "Write hello world" --stream     # Stream tokens live
slop chatgpt read                                   # Read conversation from DOM
slop chatgpt status                                 # Streaming state + model
slop chatgpt conversations                          # List recent conversations
slop chatgpt switch <conversation-id>               # Navigate to conversation
slop chatgpt stop                                   # Stop generation
```

No API keys needed. Uses your existing ChatGPT session. Auth tokens, sentinel challenges, and conduit routing are all handled by the browser automatically.

## Scene-Graph Access (Canva, Google Docs, Google Slides)

`slop scene` exposes editor objects by stable identifier so an agent can click, read, and write inside visual editors without screenshots or vision. Profile-driven: per-host detection picks the right resolver.

```bash
slop scene profile [--verbose]        # Detect host editor profile + capabilities
slop scene list [--type <t>]          # List scene objects (images, shapes, text, slides, pages)
slop scene click <id>                 # Click by stable id (Canva LB*, Slides filmstrip-slide-N-*, Docs page-N)
slop scene dblclick <id>              # Enter text-edit mode in Canva/Slides
slop scene hit <x>,<y>                # Identify object at viewport X,Y
slop scene selected                   # Read current selection label
slop scene zoom                       # Read editor zoom factor

slop scene text [--with-html]         # Read full document (Google Docs hidden iframe mirror)
slop scene insert "<text>"            # Insert at cursor (Google Docs)

slop scene slide list                 # All slides with stable IDs + blob URLs
slop scene slide current              # Current slide index + id
slop scene slide goto <n>             # Navigate via URL fragment
slop scene notes [--slide <n>]        # Read speaker notes

slop scene render <id> [--save]       # Render a scene object to PNG
```

**Architecture by editor:**

- **Canva** — every canvas object is a `<div id="LB…">` with `style.transform: translate(x, y)`. Stable across reloads.
- **Google Docs** — the canvas is opaque, but the full document HTML lives in `.docs-texteventtarget-iframe > [role=textbox]` with `data-ri` range offsets. `insert` uses `execCommand('insertText')` on the iframe contenteditable; writes are undoable via `slop keys Meta+z`.
- **Google Slides** — each slide is an SVG `<g id="filmstrip-slide-N-gd…">` with a blob-URL PNG thumbnail. `scene slide goto` sets `location.hash = "#slide=id." + pageId`. `scene render` fetches the blob and draws it into a canvas. Text-box content only appears in the text-event iframe when a text box is in edit mode — a documented caveat.

**Caveats:**
- Canva synthetic clicks require prior interactive warmup to trigger the selection state machine. Use `slop scene click <id> --os` when `scene selected` doesn't update.
- Google Docs canvas rendering means visual assertions must go through `slop scene text` (reads) or the canvas-tile `render` (pixels).
- Google Slides filmstrip thumbnails filter synthetic clicks and synthetic keys. Always use hash navigation for `slideGoto`.

## Recording Sessions

The `slop monitor` family records every real user click, keystroke, form change, navigation, DOM mutation, and the network calls each action triggered — then exports the trace as either a pretty timeline or a runnable `slop` replay script. No CDP. No infobanner.

Monitor commands (`start`, `stop`, `pause`, `resume`) auto-resolve the target tab from the slop group when `--tab` is omitted. If the content script port is disconnected (e.g. after a service worker restart or long SPA session), the extension automatically re-injects `content.js` and retries.

```bash
slop monitor start                              # Begin recording on the active slop tab
slop monitor start --instruction "..."          # Annotate with task intent
slop monitor stop                               # End recording, print summary
slop monitor status                             # Active session(s)
slop monitor pause                              # Stop emitting without ending
slop monitor resume                             # Resume a paused session
slop monitor list                               # All sessions in the event log
slop monitor tail [--raw]                       # Live tail of the current session
slop monitor export <sessionId>                 # Aligned text rendering
slop monitor export <sessionId> --json          # Raw JSONL
slop monitor export <sessionId> --plan          # Replay script (slop ... lines)
slop monitor export <sessionId> --plan --include-synthetic  # Include agent-driven clicks in plan
```

Event records are sparse — short keys (`t`, `s`, `k`, `sid`, `ref`, `r`, `n`, `v`, `cause`) so a 30-minute session reads in a few KB. User actions get a session-monotonic `seq`; mutations and network calls fired within 500ms of an action carry `cause: <seq>`. Real user events have `tr: true`; slop's own synthetic clicks have `tr: false`. The replay-plan generator automatically includes synthetic clicks when no real user events exist in the session (common when an agent drove the browser). Use `--include-synthetic` to force inclusion regardless.

The replay plan uses semantic selectors that survive DOM churn:
```
slop tab new "https://example.com/"
slop wait-stable
slop click "button:Search"
slop type "textbox:Query" "bun docs"
slop keys "Enter"
slop wait-stable
```

When the user runs the replay, slop's `find_and_click` / `find_and_type` re-resolves each selector against the live DOM — no stale ref problems.

The monitor stores sessions in `/tmp/slop-browser-events.jsonl` (the same file `slop events` already tails). Sessions are delimited by `mon_start` / `mon_stop` events with the same `sid`. Multiple sessions coexist historically and `slop monitor list` shows them all.

## Screenshots

```bash
slop screenshot                        # Viewport JPEG (returns data URL)
slop screenshot --save                 # Save to disk as file
slop screenshot --full                 # Full-page scroll+stitch
slop screenshot --format png           # PNG format
slop screenshot --quality 80           # JPEG quality 0-100
slop screenshot --element 5            # Capture specific element
```

## LinkedIn Extraction

### Event Data (no CDP)
```bash
slop linkedin event "https://www.linkedin.com/events/1234567890/"
slop linkedin event "https://www.linkedin.com/events/1234567890/?viewAsMember=true" --wait 3000
```

Returns: title, organizer name, ISO start/end timestamps, timezone, attendee count, 250 attendee names, poster name, poster follower count, likes, reposts, comments, UGC post ID, event details text. Cross-validated against DOM.

### Attendees (no CDP)
```bash
slop linkedin attendees "https://www.linkedin.com/events/1234567890/"
slop linkedin attendees "https://www.linkedin.com/events/1234567890/" --enrich-limit 10
```

Opens Manage Attendees modal, paginates it, calls voyager API (up to 250), merges results. Automatically pushes request overrides to change page size 20→50. `--enrich-limit` controls per-attendee profile/company API enrichment (default: all, which is slow for 250+).

## Stealth

slop passes every major bot detection site:
- **BrowserScan**: Normal (all checks)
- **CreepJS**: 0% headless, 0% stealth
- **Fingerprint.com**: `"notDetected"`
- **Sannysoft**: All passed
- **Pixelscan**: "You're Definitely a Human"
- **AreyouHeadless**: "You are not Chrome headless"

No CDP is used for any default operation. Network capture is done by monkey-patching `fetch`/`XHR` in the page's JavaScript context — invisible to detection.

## The Slop Group

Every `slop tab new` and `slop window new` adds tabs to a cyan "slop" tab group. By default, slop only operates on tabs in this group — the user's personal tabs are never touched.

Pass `--any-tab` to operate on any tab.

## Flags

| Flag | Effect |
|------|--------|
| `--json` | JSON output instead of plain text |
| `--tab <id>` | Target specific tab by ID |
| `--any-tab` | Operate outside the slop group |
| `--os` | OS-level trusted input (CGEvent) |
| `--frame <id>` | Target iframe |
| `--changes` | Include DOM diff in response |

## Typical Flows

### Fill out a form
```bash
slop open "https://app.example.com/signup"
slop act e5 "user@example.com"
slop act e7 "password123"
slop act e9                            # Submit button
slop read                              # Read result
```

### Extract API data from an SPA
```bash
slop open "https://app.example.com/dashboard"
slop inspect --filter api              # Tree + text + API network calls + headers
```

### Monitor a page for changes
```bash
slop open "https://example.com/status"
# ... time passes ...
slop diff                              # What changed
slop read                              # Current state
```

### Navigate a multi-step flow
```bash
slop open "https://example.com"
slop act e12                           # Click "Next", get updated tree
slop act e5 "search query"             # Fill field
slop act e8                            # Submit
slop read                              # Read results
slop tab close
```

### Read and write a Google Doc
```bash
slop tab new "https://docs.google.com/document/d/<id>/edit"
sleep 5
slop scene profile                     # → google-docs
slop scene text                        # Full document text (from hidden iframe mirror)
slop scene text --with-html            # Include inline HTML + data-ri offsets
slop scene insert "hello from slop"    # Insert at cursor position
slop keys "Meta+z"                     # Undo the insert (execCommand writes are undoable)
```

### Navigate a Google Slides deck
```bash
slop tab new "https://docs.google.com/presentation/d/<id>/edit"
sleep 6
slop scene slide list                  # Every slide with stable IDs + blob URLs
slop scene slide goto 5                # Navigate via URL fragment (synthetic clicks/keys do not work)
slop scene slide current               # Verify new index
slop scene notes                       # Read speaker notes
slop scene render <slide-id> --save    # Save slide as PNG
```

### Hit Canva objects by stable layer ID
```bash
slop tab new "https://www.canva.com/design/<id>/edit"
sleep 6
slop scene profile                     # → canva
slop scene list --type shape           # Every LB layer classified as a shape
slop scene hit 537,516                 # Identify what's at a viewport coordinate
slop scene click LBKfjtRwQHt7D0Cf      # Click by stable id
slop scene zoom                        # Current editor zoom factor
```

### Record a user session and replay it
```bash
slop monitor start --instruction "search for bun docs, open first result"
# ... user interacts for 30–60 seconds ...
slop monitor stop                      # Summary: evt / mut / net / nav counts + duration
slop monitor list                      # All sessions in /tmp/slop-browser-events.jsonl
slop monitor export <sessionId>        # Pretty-aligned timeline
slop monitor export <sessionId> --plan # Replayable script (one slop cmd per line)
```

## What NOT to Do

- Don't use screenshots to understand pages — use `slop tree`, `slop text`, or `slop scene list` / `slop scene text`
- Don't start the daemon manually — it auto-starts on first command
- Don't chain commands without `sleep` — the extension needs time to process
- Don't interact with tabs outside the slop group without `--any-tab`
- Don't use `slop network on` (CDP) unless you specifically need raw debugger capture — it shows a yellow bar and can be detected
- Don't confuse `slop canvas` (HTMLCanvasElement pixel access — `list` / `read` / `diff`) with `slop scene` (DOM / SVG / iframe scene-graph access in visual editors)
- Don't synthetic-click Google Slides filmstrip thumbnails — use `slop scene slide goto <n>` which navigates via the URL fragment

## Reference

Run `slop help` for the complete command list. Key commands not covered above:

```bash
slop cookies example.com              # List cookies for domain
slop storage                          # Read localStorage
slop eval "document.title"            # Run JS (isolated world)
slop eval "window.foo" --main         # Run JS (page context, awaits promises)
slop eval --main "fetch(url).then(r => r.json())"  # Async eval returns resolved value
slop history "search"                 # Search browser history
slop bookmarks "query"                # Search bookmarks
slop batch '[{"type":"click","ref":"e5"},{"type":"wait","ms":500}]'  # Batch actions
slop status                           # Daemon status (local check)
slop canvas list                      # Discover HTMLCanvasElement nodes (NOT `slop scene`)
slop canvas read 0 --format png       # Read canvas bytes as data URL
slop canvas diff a.png b.png          # Pixel diff between two images
```

For deeper notes, see `Notes/monitor.md` and `Notes/scene.md` in this repo.

---

## Development Reference

### Build
```bash
bash scripts/build.sh                  # Build extension + CLI + daemon
bash scripts/build.sh --target=macos   # macOS only
bun test                               # Run tests
```

### After code changes
```bash
bun build extension/src/background.ts --outdir=extension/dist --target=browser
bun build extension/src/content.ts --outdir=extension/dist --target=browser
bun build extension/src/inject-net.ts --outdir=extension/dist --target=browser
cp extension/manifest.json extension/dist/
slop reload                            # Reload extension in browser
pkill slop-daemon                      # Next command auto-respawns
```

### Extension install
```bash
bash scripts/install.sh                # macOS — native messaging manifest
```
Then load `extension/dist/` as unpacked extension in Chrome/Brave.
