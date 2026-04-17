# interceptor

Browser control CLI for AI agents. No CDP, no MCP, no API keys. You call `interceptor`, read the output, decide what's next.

**Binary:** `dist/interceptor`

## Start Here

```bash
interceptor open "https://example.com"        # Open, wait, return tree + text (1 command)
interceptor act e1                            # Click element, return updated tree + diff
interceptor act e2 "hello"                    # Type into field, return updated tree
interceptor read                              # Re-read current page (tree + text)
interceptor inspect                           # Tree + text + network log + headers
```

The daemon auto-starts. When working inside this repo, prefer `./dist/interceptor ...` if `interceptor` is not on `PATH`.

### Legacy (still works, but prefer compound commands above)

```bash
interceptor tab new "https://example.com"    # Open managed tab
sleep 2                                # Wait for load
interceptor tree                              # See interactive elements
interceptor click e1                          # Click by ref
interceptor type e2 "hello"                   # Type into field
interceptor text                              # Read visible text
```

## Use Cases

The [`use-cases/`](use-cases/) folder is where proven browser workflows get turned into reusable documentation. When you figure out how to do something reliably on a live site, add a compact use-case there so later agents can follow the path instead of burning tokens rediscovering it.

## Compound Commands (Agent-Optimized)

These collapse multi-step patterns into single CLI invocations. Prefer these over the individual commands below.

```bash
interceptor open "https://example.com"        # tab new + wait + tree + text in one call
interceptor open "https://example.com" --tree-only   # Skip text
interceptor open "https://example.com" --text-only   # Skip tree
interceptor open "https://example.com" --full        # Full text (no 2000-char limit)
interceptor open "https://example.com" --timeout 10000  # Custom wait timeout
interceptor open "https://example.com" --no-wait     # Don't wait for load
interceptor read                              # Tree + text for current page
interceptor read e5                           # Tree + text for element subtree
interceptor read --tree-only                  # Just tree
interceptor read --text-only                  # Just text
interceptor act e5                            # Click + wait + return updated tree + diff
interceptor act e3 "hello"                    # Type + wait + return updated tree
interceptor act e5 --os                       # OS-level trusted click
interceptor act e5 --keys "Enter"             # Send keyboard shortcut instead
interceptor act e5 --no-read                  # Skip post-action tree read
interceptor inspect                           # Tree + text + net log + headers
interceptor inspect --net-only                # Just network data
interceptor inspect --filter api              # Filter network entries
```

## Reading Pages

```bash
interceptor tree                              # Interactive elements with refs (e1, e2...)
interceptor tree --filter all                 # Include headings + landmarks
interceptor text                              # All visible text
interceptor text e7                           # Text from specific element
interceptor html e5                           # HTML of element
interceptor find "Submit"                     # Find elements by name
interceptor find "Submit" --role button       # Filter by ARIA role
interceptor diff                              # What changed since last tree
interceptor state                             # DOM tree + scroll + focus (verbose)
```

## Interacting With Pages

```bash
interceptor click e5                          # Click element
interceptor click e5 --os                     # OS-level trusted click (bypasses isTrusted)
interceptor type e3 "hello"                   # Type into field (clears first)
interceptor type e3 "more" --append           # Append without clearing
interceptor select e7 "option-value"          # Select dropdown option
interceptor hover e5                          # Hover over element
interceptor keys "Enter"                      # Keyboard shortcut
interceptor keys "Control+A" --os             # OS-level keyboard
interceptor scroll down                       # Scroll
```

When a synthetic click doesn't trigger anything (React/Angular sites), interceptor auto-escalates to OS-level input. You can also force it with `--os`.

## Navigating

```bash
interceptor tab new "https://example.com"     # New tab (joins interceptor group)
interceptor navigate "https://other.com"      # Navigate current tab
interceptor tabs                              # List all tabs (* = active)
interceptor tab switch 12345                  # Switch to tab by ID
interceptor tab close                         # Close current tab
interceptor back                              # History back
interceptor forward                           # History forward
interceptor wait 2000                         # Wait milliseconds
interceptor wait-stable                       # Wait for DOM to stop changing
```

## Sniffing Network Traffic

All `fetch()` and `XMLHttpRequest` traffic is captured automatically on every page. No setup. No CDP. No debugger bar.

```bash
interceptor net log                           # All captured fetch/XHR requests
interceptor net log --filter voyager          # Filter by URL substring
interceptor net log --filter api.example.com  # See specific API calls
interceptor net log --since 1700000000000     # After timestamp
interceptor net log --limit 50                # Max entries (default 100)
interceptor net clear                         # Flush buffer
interceptor net headers                       # Request headers the page sent (CSRF tokens, auth)
interceptor net headers --filter linkedin     # Filter by URL
```

Each entry includes: `url`, `method`, `status`, `body` (full response text), `type` (fetch/xhr), `timestamp`.

### Injecting / Rewriting Requests

Override rules rewrite URLs before the page's JavaScript sends them. The page sees the modified request. The server gets the modified request. No CDP.

```bash
# Change a query parameter on matching requests
interceptor override "*eventAttending*" count=50

# Multiple params
interceptor override "*api/search*" limit=50 offset=0

# Clear overrides
interceptor override clear
```

This is how `interceptor linkedin attendees` changes LinkedIn's page size from 20→50 — the page's own JavaScript fetches attendees, but interceptor rewrites the request in-flight to ask for more results.

## SSE Stream Capture

interceptor intercepts Server-Sent Events (text/event-stream) in real-time, chunk by chunk.

```bash
interceptor sse streams                                  # List active SSE streams
interceptor sse log [--filter <pattern>] [--limit N]     # Show completed SSE streams
interceptor sse tail [--filter <pattern>]                # Live tail SSE chunks
```

Works automatically on any site using fetch-based SSE or EventSource. No CDP. No setup.

## ChatGPT Agentic Bridge

Drive ChatGPT's web UI programmatically — send prompts, read streamed responses via the API wire protocol, iterate.

```bash
interceptor chatgpt send "What is 2+2?"                  # Send and read response
interceptor chatgpt send "Write hello world" --stream     # Stream tokens live
interceptor chatgpt read                                   # Read conversation from DOM
interceptor chatgpt status                                 # Streaming state + model
interceptor chatgpt conversations                          # List recent conversations
interceptor chatgpt switch <conversation-id>               # Navigate to conversation
interceptor chatgpt stop                                   # Stop generation
```

No API keys needed. Uses your existing ChatGPT session. Auth tokens, sentinel challenges, and conduit routing are all handled by the browser automatically.

## Scene-Graph Access (Canva, Google Docs, Google Slides)

`interceptor scene` exposes editor objects by stable identifier so an agent can click, read, and write inside visual editors without screenshots or vision. Profile-driven: per-host detection picks the right resolver.

```bash
interceptor scene profile [--verbose]        # Detect host editor profile + capabilities
interceptor scene list [--type <t>]          # List scene objects (images, shapes, text, slides, pages)
interceptor scene click <id>                 # Click by stable id (Canva LB*, Slides filmstrip-slide-N-*, Docs page-N)
interceptor scene dblclick <id>              # Enter text-edit mode in Canva/Slides
interceptor scene hit <x>,<y>                # Identify object at viewport X,Y
interceptor scene selected                   # Read current selection label
interceptor scene zoom                       # Read editor zoom factor

interceptor scene text [--with-html]         # Read full document (Google Docs hidden iframe mirror)
interceptor scene insert "<text>"            # Insert at cursor (Google Docs)

interceptor scene slide list                 # All slides with stable IDs + blob URLs
interceptor scene slide current              # Current slide index + id
interceptor scene slide goto <n>             # Navigate via URL fragment
interceptor scene notes [--slide <n>]        # Read speaker notes

interceptor scene render <id> [--save]       # Render a scene object to PNG
```

**Architecture by editor:**

- **Canva** — every canvas object is a `<div id="LB…">` with `style.transform: translate(x, y)`. Stable across reloads.
- **Google Docs** — the canvas is opaque, but the full document HTML lives in `.docs-texteventtarget-iframe > [role=textbox]` with `data-ri` range offsets. `insert` uses `execCommand('insertText')` on the iframe contenteditable; writes are undoable via `interceptor keys Meta+z`.
- **Google Slides** — each slide is an SVG `<g id="filmstrip-slide-N-gd…">` with a blob-URL PNG thumbnail. `scene slide goto` sets `location.hash = "#slide=id." + pageId`. `scene render` fetches the blob and draws it into a canvas. Text-box content only appears in the text-event iframe when a text box is in edit mode — a documented caveat.

**Caveats:**
- Canva synthetic clicks require prior interactive warmup to trigger the selection state machine. Use `interceptor scene click <id> --os` when `scene selected` doesn't update.
- Google Docs canvas rendering means visual assertions must go through `interceptor scene text` (reads) or the canvas-tile `render` (pixels).
- Google Slides filmstrip thumbnails filter synthetic clicks and synthetic keys. Always use hash navigation for `slideGoto`.

## Recording Sessions

The `interceptor monitor` family records every real user click, keystroke, form change, navigation, DOM mutation, and the network calls each action triggered — then exports the trace as either a pretty timeline or a runnable `interceptor` replay script. No CDP. No infobanner.

Monitor commands (`start`, `stop`, `pause`, `resume`) auto-resolve the target tab from the interceptor group when `--tab` is omitted. If the content script port is disconnected (e.g. after a service worker restart or long SPA session), the extension automatically re-injects `content.js` and retries.

Active sessions automatically follow you across the interceptor tab group. If you switch focus to another tab in the cyan group, the monitor detaches from the previous tab and attaches to the new one (`mon_detach reason: focus_switch_handoff` + `mon_attach reason: focus_switch`). Tabs outside the interceptor group are never auto-attached. Child tabs opened by a trusted action on the monitored page (e.g. Canva's "Create new design") still take the dedicated child-tab handoff path (`reason: child_tab`).

```bash
interceptor monitor start                              # Begin recording on the active interceptor tab
interceptor monitor start --instruction "..."          # Annotate with task intent
interceptor monitor stop                               # End recording, print summary
interceptor monitor status                             # Active session(s)
interceptor monitor pause                              # Stop emitting without ending
interceptor monitor resume                             # Resume a paused session
interceptor monitor list                               # All sessions in the event log
interceptor monitor tail [--raw]                       # Live tail of the current session
interceptor monitor export <sessionId>                 # Aligned text rendering
interceptor monitor export <sessionId> --json          # Raw JSONL
interceptor monitor export <sessionId> --plan          # Replay script (interceptor ... lines)
interceptor monitor export <sessionId> --plan --include-synthetic  # Include agent-driven clicks in plan
interceptor monitor export <sessionId> --with-bodies   # Include persisted net-body context when available
```

Event records are sparse — short keys (`t`, `s`, `k`, `sid`, `ref`, `r`, `n`, `v`, `cause`) so a 30-minute session reads in a few KB. User actions get a session-monotonic `seq`; mutations and network calls fired within 500ms of an action carry `cause: <seq>`. Real user events have `tr: true`; interceptor's own synthetic clicks have `tr: false`. The replay-plan generator automatically includes synthetic clicks when no real user events exist in the session (common when an agent drove the browser). Use `--include-synthetic` to force inclusion regardless.

The replay plan uses semantic selectors that survive DOM churn, and emits explicit tab-handoff lines for multi-tab sessions (`interceptor tab new "<url>"` for child-tab handoffs, `interceptor tab switch <tabId>` for focus-switch handoffs):
```
interceptor tab new "https://example.com/"
interceptor wait-stable
interceptor click "button:Search"
interceptor type "textbox:Query" "bun docs"
interceptor keys "Enter"
# focus-switch to tab 1729165117 (https://www.youtube.com/)
interceptor tab switch 1729165117
interceptor wait-stable
interceptor click "button:Play"
```

For the full monitor architecture (session vs attachment, document identity, child-tab handoff, focus-follow, durable artifacts, transport resilience), see [`ARCHITECTURE.md`](ARCHITECTURE.md).

When the user runs the replay, interceptor's `find_and_click` / `find_and_type` re-resolves each selector against the live DOM — no stale ref problems.

The rolling live event stream lives in `/tmp/interceptor-events.jsonl` (the same file `interceptor events` tails). Export prefers per-session artifacts under `/tmp/interceptor-monitor-sessions/<sessionId>/` when available and falls back to the rolling event log for legacy sessions.

## Screenshots

```bash
interceptor screenshot                        # Viewport JPEG (returns data URL)
interceptor screenshot --save                 # Save to disk as file
interceptor screenshot --full                 # Full-page scroll+stitch
interceptor screenshot --format png           # PNG format
interceptor screenshot --quality 80           # JPEG quality 0-100
interceptor screenshot --element 5            # Capture specific element
```

## LinkedIn Extraction

### Event Data (no CDP)
```bash
interceptor linkedin event "https://www.linkedin.com/events/1234567890/"
interceptor linkedin event "https://www.linkedin.com/events/1234567890/?viewAsMember=true" --wait 3000
```

Returns: title, organizer name, ISO start/end timestamps, timezone, attendee count, 250 attendee names, poster name, poster follower count, likes, reposts, comments, UGC post ID, event details text. Cross-validated against DOM.

### Attendees (no CDP)
```bash
interceptor linkedin attendees "https://www.linkedin.com/events/1234567890/"
interceptor linkedin attendees "https://www.linkedin.com/events/1234567890/" --enrich-limit 10
```

Opens Manage Attendees modal, paginates it, calls voyager API (up to 250), merges results. Automatically pushes request overrides to change page size 20→50. `--enrich-limit` controls per-attendee profile/company API enrichment (default: all, which is slow for 250+).

## Stealth

interceptor passes every major bot detection site:
- **BrowserScan**: Normal (all checks)
- **CreepJS**: 0% headless, 0% stealth
- **Fingerprint.com**: `"notDetected"`
- **Sannysoft**: All passed
- **Pixelscan**: "You're Definitely a Human"
- **AreyouHeadless**: "You are not Chrome headless"

No CDP is used for any default operation. Network capture is done by monkey-patching `fetch`/`XHR` in the page's JavaScript context — invisible to detection.

## The Interceptor Group

Every `interceptor tab new` and `interceptor window new` adds tabs to a cyan "interceptor" tab group. By default, interceptor only operates on tabs in this group — the user's personal tabs are never touched.

Pass `--any-tab` to operate on any tab.

## Flags

| Flag | Effect |
|------|--------|
| `--json` | JSON output instead of plain text |
| `--tab <id>` | Target specific tab by ID |
| `--any-tab` | Operate outside the interceptor group |
| `--os` | OS-level trusted input (CGEvent) |
| `--frame <id>` | Target iframe |
| `--changes` | Include DOM diff in response |

## Typical Flows

### Fill out a form
```bash
interceptor open "https://app.example.com/signup"
interceptor act e5 "user@example.com"
interceptor act e7 "password123"
interceptor act e9                            # Submit button
interceptor read                              # Read result
```

### Extract API data from an SPA
```bash
interceptor open "https://app.example.com/dashboard"
interceptor inspect --filter api              # Tree + text + API network calls + headers
```

### Monitor a page for changes
```bash
interceptor open "https://example.com/status"
# ... time passes ...
interceptor diff                              # What changed
interceptor read                              # Current state
```

### Navigate a multi-step flow
```bash
interceptor open "https://example.com"
interceptor act e12                           # Click "Next", get updated tree
interceptor act e5 "search query"             # Fill field
interceptor act e8                            # Submit
interceptor read                              # Read results
interceptor tab close
```

### Read and write a Google Doc
```bash
interceptor tab new "https://docs.google.com/document/d/<id>/edit"
sleep 5
interceptor scene profile                     # → google-docs
interceptor scene text                        # Full document text (from hidden iframe mirror)
interceptor scene text --with-html            # Include inline HTML + data-ri offsets
interceptor scene insert "hello from interceptor"    # Insert at cursor position
interceptor keys "Meta+z"                     # Undo the insert (execCommand writes are undoable)
```

### Navigate a Google Slides deck
```bash
interceptor tab new "https://docs.google.com/presentation/d/<id>/edit"
sleep 6
interceptor scene slide list                  # Every slide with stable IDs + blob URLs
interceptor scene slide goto 5                # Navigate via URL fragment (synthetic clicks/keys do not work)
interceptor scene slide current               # Verify new index
interceptor scene notes                       # Read speaker notes
interceptor scene render <slide-id> --save    # Save slide as PNG
```

### Hit Canva objects by stable layer ID
```bash
interceptor tab new "https://www.canva.com/design/<id>/edit"
sleep 6
interceptor scene profile                     # → canva
interceptor scene list --type shape           # Every LB layer classified as a shape
interceptor scene hit 537,516                 # Identify what's at a viewport coordinate
interceptor scene click LBKfjtRwQHt7D0Cf      # Click by stable id
interceptor scene zoom                        # Current editor zoom factor
```

### Record a user session and replay it
```bash
interceptor monitor start --instruction "search for bun docs, open first result"
# ... user interacts for 30–60 seconds ...
interceptor monitor stop                      # Summary: evt / mut / net / nav counts + duration
interceptor monitor list                      # All sessions in /tmp/interceptor-events.jsonl
interceptor monitor export <sessionId>        # Pretty-aligned timeline
interceptor monitor export <sessionId> --plan # Replayable script (one interceptor cmd per line)
```

## What NOT to Do

- Don't use screenshots to understand pages — use `interceptor tree`, `interceptor text`, or `interceptor scene list` / `interceptor scene text`
- Don't start the daemon manually — it auto-starts on first command
- Don't chain commands without `sleep` — the extension needs time to process
- Don't interact with tabs outside the interceptor group without `--any-tab`
- Don't use `interceptor network on` (CDP) unless you specifically need raw debugger capture — it shows a yellow bar and can be detected
- Don't confuse `interceptor canvas` (HTMLCanvasElement pixel access — `list` / `read` / `diff`) with `interceptor scene` (DOM / SVG / iframe scene-graph access in visual editors)
- Don't synthetic-click Google Slides filmstrip thumbnails — use `interceptor scene slide goto <n>` which navigates via the URL fragment

## Reference

Run `interceptor help` for the complete command list. Key commands not covered above:

```bash
interceptor cookies example.com              # List cookies for domain
interceptor storage                          # Read localStorage
interceptor eval "document.title"            # Run JS (isolated world)
interceptor eval "window.foo" --main         # Run JS (page context, awaits promises)
interceptor eval --main "fetch(url).then(r => r.json())"  # Async eval returns resolved value
interceptor history "search"                 # Search browser history
interceptor bookmarks "query"                # Search bookmarks
interceptor batch '[{"type":"click","ref":"e5"},{"type":"wait","ms":500}]'  # Batch actions
interceptor status                           # Daemon status (local check)
interceptor canvas list                      # Discover HTMLCanvasElement nodes (NOT `interceptor scene`)
interceptor canvas read 0 --format png       # Read canvas bytes as data URL
interceptor canvas diff a.png b.png          # Pixel diff between two images
```

For deeper notes, see `Notes/monitor.md` and `Notes/scene.md` in this repo.

---

## macOS Native Control

`interceptor macos` gives agents the same structured control over native macOS applications that `interceptor` gives over the browser. No screenshots, no vision models, no coordinate guessing. Structured accessibility trees, real-time audio/speech, on-device intelligence, and OS-level trusted input.

The native bridge (`interceptor-bridge`) runs as a LaunchAgent and communicates with the daemon over Unix socket. Same CLI, same wire format, same ref system.

### Quick Start (macOS)

```bash
interceptor macos open "Finder"                  # Activate + tree + window info
interceptor macos read                           # Tree for frontmost app
interceptor macos act e5                         # Click + wait + updated tree
interceptor macos act e3 "hello"                 # Type + wait + updated tree
interceptor macos inspect                        # Tree + apps + frontmost info
```

### Accessibility (AX Tree)

```bash
interceptor macos tree                           # AX tree for frontmost app
interceptor macos tree --app "Finder"            # Specific app
interceptor macos tree --filter interactive      # Only actionable elements (default)
interceptor macos tree --depth 5                 # Limit depth
interceptor macos find "Save" --role button      # Find elements by name/role
interceptor macos inspect e5                     # All attributes + actions for ref
interceptor macos value e5                       # Read element value
interceptor macos value e5 "new text"            # Set element value
interceptor macos action e5 press                # Perform AX action
interceptor macos focused                        # Current focused element
interceptor macos windows                        # All windows with frames
interceptor macos windows --app "Finder"         # Specific app
```

Refs (`e1`, `e2`, ...) work the same as browser refs. AXObserver auto-invalidates when the tree changes.

### Apps & Windows

```bash
interceptor macos apps                           # List running apps (name, pid, bundle ID)
interceptor macos app activate "Finder"          # Bring to front
interceptor macos app hide "Finder"              # Hide
interceptor macos app quit "Finder"              # Quit
interceptor macos app launch "com.apple.finder"  # Launch by bundle ID
interceptor macos frontmost                      # Current frontmost app
interceptor macos move e1 --x 0 --y 25           # Move window
interceptor macos resize e1 --width 672 --height 983  # Resize window
```

### Input (CGEvent — OS-level trusted)

```bash
interceptor macos click e5                       # Click AX element by ref
interceptor macos click 500,300                  # Click at coordinates
interceptor macos click e5 --double              # Double-click
interceptor macos click e5 --right               # Right-click
interceptor macos type e5 "hello world"          # Focus + type
interceptor macos type "hello world"             # Type at current focus
interceptor macos keys "Meta+C"                  # Keyboard shortcut
interceptor macos scroll e5 --down 300           # Scroll
interceptor macos drag e5 e8                     # Drag between elements
```

When AX actions fail, interceptor auto-escalates to CGEvent click using the element's frame coordinates.

### Menu Traversal

```bash
interceptor macos menu                           # Frontmost app's full menu tree
interceptor macos menu --app "Finder"            # Specific app
interceptor macos menu "File" "New Folder"       # Invoke menu item by path
```

### Screen Capture (ScreenCaptureKit)

```bash
interceptor macos screenshot                     # Frontmost window
interceptor macos screenshot --app "Finder"      # Specific app
interceptor macos screenshot --save              # Save to disk
interceptor macos capture start                  # Start continuous 30fps capture
interceptor macos capture frame                  # Get latest frame
interceptor macos capture stop                   # Stop
```

### Speech & Audio

```bash
interceptor macos listen start                   # Start speech recognition
interceptor macos listen stop                    # Stop + return transcript
interceptor macos listen transcript              # Current transcript
interceptor macos listen tail                    # Poll-friendly transcript stream
interceptor macos vad start                      # Voice activity detection
interceptor macos vad status                     # Is someone speaking? + RMS level
interceptor macos sounds start                   # Sound classification (300+ types)
interceptor macos sounds status                  # Current detected sounds
interceptor macos audio output start             # Capture system audio
interceptor macos audio input start              # Capture microphone
```

### Vision & NLP (on-device)

```bash
interceptor macos vision faces                   # Detect faces in frontmost window
interceptor macos vision text                    # OCR
interceptor macos vision hands                   # Hand pose detection
interceptor macos vision bodies                  # Body pose detection
interceptor macos nlp entities "Ron in Austin"   # Named entity recognition
interceptor macos nlp sentiment "great product"  # Sentiment analysis
interceptor macos nlp language "bonjour"         # Language detection
```

### Monitor (macOS)

```bash
interceptor macos monitor start                  # Record all user interactions
interceptor macos monitor start --instruction "Show me how you file expenses"
interceptor macos monitor stop                   # Stop + summary
interceptor macos monitor tail                   # Live event stream
interceptor macos monitor export <sid>           # Pretty timeline
interceptor macos monitor export <sid> --plan    # Replayable interceptor macos script
```

Captures clicks, keystrokes, scrolls, app switches with timestamps and AX element annotations. Same sparse JSON format as browser monitor.

### Display & Streaming

```bash
interceptor macos display list                   # All displays (physical + virtual)
interceptor macos display create 1920x1080       # Create virtual display
interceptor macos display remove <id>            # Remove virtual display
interceptor macos stream start --app "Finder"    # Start screen stream
interceptor macos stream frame                   # Latest frame
interceptor macos stream fps                     # Current FPS
interceptor macos stream stop                    # Stop
```

### Other Domains

```bash
interceptor macos trust                          # Check all permissions with System Settings paths
interceptor macos clipboard read                 # Read clipboard
interceptor macos clipboard tail                 # Monitor clipboard changes
interceptor macos files watch ~/Desktop          # Watch directory for changes
interceptor macos notifications tail             # Live notification stream
interceptor macos ai prompt "Summarize this"     # On-device LLM (macOS 26+, Apple Intelligence)
```

### Typical macOS Flows

```bash
# Resize browser and open a URL
interceptor macos app activate "Brave Browser"
interceptor macos windows --app "Brave Browser"
interceptor macos move e1 --x 0 --y 25
interceptor macos resize e1 --width 672 --height 983
interceptor macos keys "Meta+t"
interceptor macos keys "Meta+l"
interceptor macos type "https://example.com"
interceptor macos keys "Return"

# Watch a user, learn the workflow, replay it
interceptor macos monitor start --instruction "file an expense"
# ... user works ...
interceptor macos monitor stop
interceptor macos monitor export <sid> --plan    # Get replayable script
```

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
interceptor reload                            # Reload extension in browser
pkill interceptor-daemon                      # Next command auto-respawns
```

### Extension install (DMG — recommended)
```bash
bash scripts/build-dmg.sh              # Build DMG installer
# Open dist/Interceptor-v0.7.0-macOS.dmg, double-click Install Interceptor
# Select browser + profile → done
```

### Extension install (manual)
```bash
bash scripts/install.sh                # macOS — native messaging manifest
```
Then load `extension/dist/` as unpacked extension in Chrome/Brave.

### Silent inject (scripted)
```bash
python3 scripts/inject.py --browser brave --profile Default \
  --extension-src extension/dist --daemon-path daemon/interceptor-daemon
```
