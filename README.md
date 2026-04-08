# slop-browser

## To install it:
  1. Go to chrome://extensions
  2. Enable "Developer mode"
  3. Click "Load unpacked"
  4. Select the extension/dist/ directory
Browser control for AI agents. No CDP, no MCP, no API keys. The agent calls `slop` CLI commands, reads the output, decides what to do next.

**Binary:** `dist/slop`

## Quick Start

```bash
slop tab new "https://example.com"   # Open a managed tab
sleep 2                               # Wait for load
slop tree                             # See what's interactive
slop click e1                         # Click element by ref
slop type e2 "hello world"            # Type into a field
slop text                             # Read visible text
```

The daemon auto-starts on first command. No setup needed.

## Core Concepts

**Element Refs** — `slop tree` returns elements with refs like `e1`, `e5`, `e23`. Use these to click, type, hover. Refs survive between commands until the DOM changes.

**Slop Group** — Every `slop tab new` adds tabs to a cyan "slop" group. Commands only work on tabs in this group. Your personal tabs are never touched. Use `--any-tab` to override.

**Passive Network** — All `fetch()` and `XMLHttpRequest` traffic on every page is captured automatically. No debugger, no infobanner. Query it with `slop net log`.

**Scene Graph** — Profile-driven access to visual editors that don't render to the DOM normally: Canva, Google Docs, Google Slides. Enumerate objects by stable ID, click shapes, read full document text, navigate slide decks, render pages to PNG. `slop scene` — no CDP, no vision, no screenshots needed.

**Session Monitor** — Record a user's real interactions (clicks, keystrokes, form changes, DOM mutations, network calls) as a sparse JSONL log that replays as a `slop` script. `slop monitor start` / `slop monitor stop` / `slop monitor export --plan`.

**Stealth** — Passes all major bot detection: BrowserScan (Normal), Pixelscan ("Definitely Human"), Sannysoft (all pass), CreepJS (0% headless), Fingerprint.com (notDetected), AreyouHeadless (not headless). Zero automation fingerprint.

## Commands

### Read the Page
```bash
slop tree                             # Interactive elements with refs
slop tree --filter all                # Include headings + landmarks
slop tree --depth 5                   # Limit tree depth
slop text                             # All visible text
slop text e5                          # Text from specific element
slop html e5                          # HTML of specific element
slop find "Submit"                    # Find elements by name
slop find "Submit" --role button      # Filter by ARIA role
slop diff                             # What changed since last tree read
slop state                            # Full DOM tree + scroll + focused element
```

### Interact
```bash
slop click e5                         # Click element
slop click e5 --os                    # OS-level trusted click (for sites checking isTrusted)
slop click e5 --at 10,20             # Click at offset within element
slop type e3 "hello"                  # Type into element (clears first)
slop type e3 "more" --append          # Append without clearing
slop type "textbox:Search" "query"    # Type using semantic selector (role:name)
slop select e7 "option-value"         # Select dropdown option
slop hover e5                         # Hover over element
slop keys "Control+A"                 # Keyboard shortcut
slop keys "Enter" --os               # OS-level key event
slop focus e5                         # Focus element
slop drag e5 --from 0,0 --to 100,50  # Drag gesture
slop dblclick e5                      # Double-click
slop rightclick e5                    # Right-click (context menu)
```

### Navigate
```bash
slop tab new "https://example.com"    # New tab in slop group
slop navigate "https://example.com"   # Navigate current tab
slop back                             # History back
slop forward                          # History forward
slop scroll down                      # Scroll (up/down/top/bottom)
slop wait 2000                        # Wait milliseconds
slop wait-stable                      # Wait for DOM to stop changing
```

### Tabs
```bash
slop tabs                             # List all tabs (* = active)
slop tab new "https://example.com"    # Open new tab
slop tab switch 12345                 # Switch to tab by ID
slop tab close                        # Close current tab
slop tab close 12345                  # Close specific tab
slop window new "https://example.com" # New window
slop window list                      # List all windows
```

### Network — Passive Capture (always on)
Every page's fetch/XHR traffic is intercepted automatically. Full response bodies included.
```bash
slop net log                          # All captured traffic
slop net log --filter voyager         # Filter by URL substring
slop net log --filter api.example.com # Any URL pattern
slop net log --since 1700000000000    # After timestamp
slop net log --limit 50              # Max entries (default 100)
slop net clear                        # Flush buffer
slop net headers                      # Captured request headers (CSRF, auth tokens)
slop net headers --filter linkedin    # Filter by URL
```

### Network — Request Overrides (rewrite before send)
Modify outgoing requests at the JavaScript level. No CDP, no debugger.
```bash
# Change a query parameter on matching URLs
slop raw '{"type":"net_override_set","rules":[{"urlPattern":"*eventAttending*","queryAddOrReplace":{"count":50}}]}'

# Clear all overrides
slop raw '{"type":"net_override_clear"}'
```

### SSE Stream Capture

slop intercepts Server-Sent Events (text/event-stream) in real-time, chunk by chunk.

```bash
slop sse streams                                  # List active SSE streams
slop sse log [--filter <pattern>] [--limit N]     # Show completed SSE streams
slop sse tail [--filter <pattern>]                # Live tail SSE chunks
```

Works automatically on any site using fetch-based SSE or EventSource. No CDP. No setup.

### ChatGPT Agentic Bridge

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

### Scene Graph (Canva, Google Docs, Google Slides)
Read and manipulate visual editors whose "canvas" is actually a DOM / SVG / hidden-iframe structure. No CDP, no debugger, no detection risk. Profile-driven — each editor has its own detection and capability set. Works today on canva.com/design/, docs.google.com/document/, and docs.google.com/presentation/.

```bash
slop scene profile                     # Detect active editor profile
slop scene profile --verbose           # Include capabilities list
slop scene list                        # Enumerate scene objects on current page
slop scene list --type shape           # Filter by type (image|shape|text|page|slide|embed)
slop scene click <id>                  # Click a scene object by stable id (Canva: LBxxxxxxxxxxxxxx)
slop scene dblclick <id>               # Double-click to enter text edit
slop scene hit <x>,<y>                 # Identify the scene object at viewport coordinates
slop scene selected                    # Read current selection (host-aware)
slop scene zoom                        # Read editor zoom factor

slop scene text                        # Read full document text (Google Docs hidden iframe mirror)
slop scene text --with-html            # Include inline HTML with data-ri offsets
slop scene insert "<text>"             # Insert text at cursor position (Google Docs)

slop scene slide list                  # List all slides in a Google Slides deck
slop scene slide current               # Show current slide index and id
slop scene slide goto <n>              # Navigate to slide <n> (URL fragment method)
slop scene slide <n>                   # Shorthand for slide goto <n>
slop scene notes                       # Read speaker notes of current slide

slop scene render <id>                 # Render a scene object as PNG data URL
slop scene render <id> --save          # Save the PNG to disk
```

**How it works per editor:**

- **Canva**: every object on the canvas is a `<div id="LB…">` with `style.transform: translate(x, y)` and `style.width/height`. The IDs are stable per-document (they survive page reloads). `scene list` enumerates them; `scene click` computes the viewport center from `getBoundingClientRect()` and dispatches a click through `elementFromPoint`.
- **Google Docs**: the page is rendered to `<canvas>` but the full document HTML lives inside a hidden iframe at `.docs-texteventtarget-iframe > [role=textbox]`, complete with `<p>` / `<span>` elements carrying `data-ri` range-index offsets. `scene text` reads it, `scene insert` writes via `document.execCommand('insertText')` on the iframe's contenteditable.
- **Google Slides**: each slide is a SVG `<g id="filmstrip-slide-N-gd…">` with a pre-rendered PNG blob URL on the child `<image>`. The real slide-navigation page ID lives on the `data-slide-page-id` attribute of the parent `.punch-filmstrip-thumbnail`. `scene slide goto` navigates by setting `window.location.hash = "#slide=id." + pageId`.

### Recording (Session Monitor)
Record every real user click, keystroke, form change, navigation, DOM mutation, and the network calls each action triggered — then export the trace as either a pretty timeline or a runnable `slop` replay script. No CDP, no infobanner, no detection.

```bash
slop monitor start                              # Begin recording on the active slop tab
slop monitor start --instruction "..."          # Annotate with task intent
slop monitor stop                               # End recording, print summary
slop monitor status                             # Show active session(s)
slop monitor pause                              # Stop emitting events without ending
slop monitor resume                             # Resume a paused session
slop monitor list                               # All sessions in the event log
slop monitor tail                               # Live tail current session (pretty)
slop monitor tail --raw                         # Live tail (raw JSONL)
slop monitor export <sessionId>                 # Aligned text rendering
slop monitor export <sessionId> --json          # Raw JSONL for that session
slop monitor export <sessionId> --plan          # Emit slop ... replay script
```

Each event line is sparse JSON (short keys: `t`, `s`, `k`, `sid`, `ref`, `r`, `n`, `cause`) so an agent can read a 30-minute session in a few KB. User actions get a session-monotonic `seq`; mutations and network calls fired within 500ms of an action carry `cause: <action_seq>`. Real user events have `tr: true`; slop's own synthetic clicks have `tr: false` so the replay generator can ignore them.

The replay script uses the existing semantic-selector path:
```
slop tab new "https://example.com/"
slop wait-stable
slop click "button:Search"
slop type "textbox:Query" "bun docs"
slop keys "Enter"
slop wait-stable
```

### Screenshots
```bash
slop screenshot                       # Viewport JPEG (returns data URL)
slop screenshot --save                # Save to disk
slop screenshot --full                # Full-page scroll+stitch
slop screenshot --format png          # PNG format
slop screenshot --quality 80          # JPEG quality 0-100
slop screenshot --element 5           # Capture element bounding box
```

### Data
```bash
slop cookies example.com              # List cookies for domain
slop storage                          # Read localStorage
slop storage set key value            # Write localStorage
slop eval "document.title"            # Run JS in page
slop history "search term"            # Search browser history
slop bookmarks "query"                # Search bookmarks
```

### LinkedIn
```bash
slop linkedin event <url>             # Full event extraction (no CDP)
slop linkedin event <url> --wait 3000 # Extra wait for slow pages
slop linkedin attendees <url>         # Attendees with request overrides + modal + API
slop linkedin attendees <url> --enrich-limit 5  # Limit per-attendee enrichment
```

### Batch & Raw
```bash
slop batch '[{"type":"click","ref":"e5"},{"type":"wait","ms":500},{"type":"extract_text"}]'
slop batch '...' --stop-on-error      # Halt on first failure
slop raw '{"type":"any_action","key":"value"}'  # Send any raw action
```

### Meta
```bash
slop status                           # Daemon status (local check, no connection needed)
slop help                             # Full CLI help
slop reload                           # Reload extension
slop capabilities                     # Check available input layers
```

## Flags

| Flag | Effect |
|------|--------|
| `--json` | JSON output instead of plain text |
| `--tab <id>` | Target specific tab by ID |
| `--any-tab` | Operate outside the slop group |
| `--os` | Use OS-level trusted events (macOS CGEvent) |
| `--frame <id>` | Target specific iframe |
| `--changes` | Include DOM diff in response |

## Recipes

### Extract data from an SPA
```bash
slop tab new "https://app.example.com"
sleep 3
slop tree                              # Find the data
slop net log --filter api              # See what API calls the page made
slop net headers --filter api          # Grab auth tokens from captured headers
slop text                              # Read visible content
slop tab close
```

### Fill and submit a form
```bash
slop tab new "https://example.com/form"
sleep 2
slop tree                              # Find form fields
slop type e3 "John Doe"               # Fill name
slop type e5 "john@example.com"       # Fill email
slop select e7 "option2"              # Pick dropdown
slop click e10                         # Submit
sleep 2
slop text                              # Read result
```

### Monitor network traffic from any page
```bash
slop tab new "https://app.example.com"
sleep 3
slop net log --filter api              # See all API calls with full response bodies
slop net headers --filter api          # See request headers (auth, CSRF, cookies)
# Navigate around — capture keeps running
slop click e5
sleep 2
slop net log --filter api --limit 5    # See latest calls
```

### Override API requests (change page size, params)
```bash
slop tab new "https://app.example.com"
sleep 2
# Push override: change page_size to 100 on any matching URL
slop raw '{"type":"net_override_set","rules":[{"urlPattern":"*api/list*","queryAddOrReplace":{"page_size":100}}]}'
# Now interact — when the page fetches, the URL is rewritten before it fires
slop click e5                          # Trigger a load
sleep 2
slop net log --filter api/list         # See the rewritten request + response
slop raw '{"type":"net_override_clear"}'  # Clean up
```

### LinkedIn event extraction (full flow, no CDP)
```bash
slop linkedin event "https://www.linkedin.com/events/1234567890/?viewAsMember=true"
# Returns: title, organizer, ISO dates, timezone, attendee count + names,
#          poster name, follower count, likes, reposts, comments, UGC post ID,
#          details text, thumbnail URL, validation checks
```

### Interact with sites that check isTrusted
```bash
slop tab new "https://strict-site.com"
sleep 2
slop tree
slop click e5 --os                     # OS-level CGEvent click (genuinely trusted)
slop type e3 "text" --os               # OS-level keystrokes
```

### Read a Google Doc programmatically
```bash
slop tab new "https://docs.google.com/document/d/<id>/edit"
sleep 5
slop scene profile                     # -> google-docs
slop scene text                        # Full document text from hidden iframe mirror
slop scene text --with-html            # Full HTML model with data-ri offsets
slop scene insert "new paragraph at cursor"
slop keys "Meta+z"                     # Undo the insert
```

### Manipulate a Canva design
```bash
slop tab new "https://www.canva.com/design/<id>/edit"
sleep 6
slop scene profile                     # -> canva
slop scene list --type shape           # Every LB layer that's a shape
slop scene zoom                        # Current editor zoom factor
slop scene hit 537,516                 # What's at this viewport coord?
slop scene click LBKfjtRwQHt7D0Cf      # Click a layer by stable id
```

### Navigate and render Google Slides
```bash
slop tab new "https://docs.google.com/presentation/d/<id>/edit"
sleep 6
slop scene slide list                  # All slides with stable IDs + blob URLs
slop scene slide goto 5                # Navigate via URL fragment
slop scene slide current               # Verify index 5 is now active
slop scene notes                       # Read speaker notes for current slide
slop scene render filmstrip-slide-3-gd02e148143_0_6 --save  # PNG of slide 3
```

### Record a user session and replay it
```bash
# With Ron at the keyboard:
slop monitor start --instruction "search bun docs, open first result, copy paragraph"
# ... Ron interacts for 60 seconds ...
slop monitor stop                      # Prints session summary
slop monitor list                      # Shows all historical sessions
slop monitor export <sessionId>        # Aligned text rendering
slop monitor export <sessionId> --plan # Replayable script of slop commands
```

### Diff canvas pixels between two renders (the OTHER `slop canvas`)
```bash
slop canvas list                       # Discover <canvas> elements (HTMLCanvasElement)
slop canvas read 0 --format png        # Read canvas as data URL
slop canvas diff url1.png url2.png     # Pixel diff between images
```

## What NOT to Do

- **Don't take screenshots to understand a page** — use `slop tree` and `slop text`. Screenshots waste tokens.
- **Don't chain commands without sleep** — the extension needs time to process. `sleep 1` between actions.
- **Don't interact with tabs outside the slop group** without `--any-tab`.
- **Don't use CDP commands** (`slop network on`) unless you have a specific reason. Passive capture (`slop net log`) sees everything without the debugger infobanner.
- **Don't start the daemon manually** — it auto-starts on first command.
