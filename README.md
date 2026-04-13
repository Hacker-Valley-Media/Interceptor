# Interceptor

**Interceptor** is a browser tool built from frustration.

Every browser automation framework talks to Chrome through the DevTools Protocol, and every site that cares can see it. Your agent gets detected. Your session gets blocked. You're running a separate browser instance that doesn't have your cookies, your logins, your context. You start from zero every time.

Interceptor was built because clicking through 20 rows at a time on sites that refuse to give you your own data in bulk is a waste of your life. The goal: click through a workflow once and have your agent see everything. Not just the page, but the network requests underneath it. The API calls. The pagination parameters. The auth tokens. Then intercept those requests, rewrite them, and pull back everything at once.

But it goes further than extraction. The deeper goal is this: *teach the agent by showing it*. Record a session. Let the agent watch the clicks, the keystrokes, the DOM mutations, and the network calls each action triggered. Then hand it a replay script and say, "Now do this for me. Every time. Without asking."

Interceptor doesn't use CDP. It doesn't launch a separate browser. It runs as a Chrome extension inside your actual browser. Your cookies, your sessions, your logins. It passes every major bot detection test. Sites don't know it's there.

It intercepts the DOM tree so your agent can read what's on the page. It intercepts network traffic so your agent can see the APIs behind the UI. It intercepts your workflows so your agent can learn what you do and repeat it without you.

No detection. No separate instance. No starting from zero. Your browser, your data, your workflows -- intercepted and handed to the agent.

---

The agent calls `interceptor` CLI commands, reads the output, decides what to do next. No MCP, no API keys.

## Installation

### Prerequisites

- [Bun](https://bun.sh/) runtime
- Chrome or Brave browser

### Build

```bash
git clone https://github.com/Hacker-Valley-Media/interceptor.git
cd interceptor
bash scripts/build.sh
```

This produces three artifacts:

| Artifact | Path |
|----------|------|
| CLI binary | `dist/interceptor` |
| Background daemon | `daemon/interceptor-daemon` |
| Chrome extension | `extension/dist/` |

### Install the CLI

Add the binary to your PATH:

```bash
cp dist/interceptor /usr/local/bin/
```

### Install the Chrome Extension

1. Open Chrome or Brave and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `extension/dist/` directory from this repo
5. The interceptor extension icon should appear in your toolbar

### Register Native Messaging (macOS)

The CLI communicates with the extension via Chrome's native messaging protocol. Run the install script to register the manifest:

```bash
bash scripts/install.sh
```

### Verify

```bash
interceptor status    # Should report daemon status
```

## Development Verification

Use the verification command that matches the kind of change you made:

```bash
bun run typecheck    # Static typing across Bun host code and extension code
bun test             # Runtime tests and CLI/parser coverage
bash scripts/build.sh # Build compiled host binaries and extension bundles
```

- Run `bun run typecheck` when you change TypeScript types, runtime wiring, Chrome API usage, Bun socket usage, or any code that crosses host/extension boundaries.
- Run `bun test` when you change parser behavior, monitor/scene helpers, or any logic already covered by the repo test suite.
- Run `bash scripts/build.sh` when you need to verify the actual host binaries and extension bundles still compile.
- For changes that affect browser behavior or shared infrastructure, run all three.

## Quick Start

```bash
interceptor open "https://example.com"       # Open, wait, return tree + text (1 command)
interceptor act e1                            # Click element, return updated tree + diff
interceptor act e2 "hello world"              # Type into field, return updated tree
interceptor read                              # Re-read current page (tree + text)
interceptor inspect                           # Tree + text + network log + headers
```

Once installed, the daemon auto-starts on first command. No manual launch needed.

The legacy individual commands (`interceptor tab new`, `interceptor tree`, `interceptor click`, etc.) still work, but the compound commands above are preferred — they reduce round-trips and agent deliberation time.

## Core Concepts

**Element Refs** — `interceptor tree` returns elements with refs like `e1`, `e5`, `e23`. Use these to click, type, hover. Refs survive between commands until the DOM changes.

**Interceptor Group** — Every `interceptor tab new` adds tabs to a cyan "interceptor" group. Commands only work on tabs in this group. Your personal tabs are never touched. Use `--any-tab` to override.

**Passive Network** — All `fetch()` and `XMLHttpRequest` traffic on every page is captured automatically. No debugger, no infobanner. Query it with `interceptor net log`.

**Scene Graph** — Profile-driven access to visual editors that don't render to the DOM normally: Canva, Google Docs, Google Slides. Enumerate objects by stable ID, click shapes, read full document text, navigate slide decks, render pages to PNG. `interceptor scene` — no CDP, no vision, no screenshots needed.

**Session Monitor** — Record a user's real interactions (clicks, keystrokes, form changes, DOM mutations, network calls) as a sparse JSONL log that replays as a `interceptor` script. `interceptor monitor start` / `interceptor monitor stop` / `interceptor monitor export --plan`. Monitor auto-resolves the active interceptor-managed tab when called without `--tab`, and automatically re-injects the content script if the port is disconnected (common on long-lived SPA tabs).

**Stealth** — Passes all major bot detection: BrowserScan (Normal), Pixelscan ("Definitely Human"), Sannysoft (all pass), CreepJS (0% headless), Fingerprint.com (notDetected), AreyouHeadless (not headless). Zero automation fingerprint.

**Use Cases** — The [`use-cases/`](use-cases/) folder is the cookbook for workflows we have already proven in live pages. When a browser workflow is discovered or stabilized, document the exact path there so future agents can reuse it instead of rediscovering it.

## Commands

### Compound Commands (Agent-Optimized)

These collapse multi-step patterns into single CLI invocations:

```bash
interceptor open "https://example.com"        # Open URL, wait, return tree + text
interceptor open "https://example.com" --tree-only   # Skip text
interceptor open "https://example.com" --text-only   # Skip tree
interceptor open "https://example.com" --full        # Full text (no 2000-char limit)
interceptor open "https://example.com" --no-wait     # Don't wait for load
interceptor read                              # Tree + text for current page
interceptor read e5                           # Tree + text for element subtree
interceptor read --tree-only                  # Just tree
interceptor act e5                            # Click + wait + return updated tree + diff
interceptor act e3 "hello"                    # Type + wait + return updated tree
interceptor act e5 --os                       # OS-level trusted click
interceptor act e5 --keys "Enter"             # Send keyboard shortcut instead
interceptor act e5 --no-read                  # Skip post-action tree read
interceptor inspect                           # Tree + text + network log + headers
interceptor inspect --net-only                # Just network data
interceptor inspect --filter api              # Filter network entries
```

### Read the Page
```bash
interceptor tree                             # Interactive elements with refs
interceptor tree --filter all                # Include headings + landmarks
interceptor tree --depth 5                   # Limit tree depth
interceptor text                             # All visible text
interceptor text e5                          # Text from specific element
interceptor html e5                          # HTML of specific element
interceptor find "Submit"                    # Find elements by name
interceptor find "Submit" --role button      # Filter by ARIA role
interceptor diff                             # What changed since last tree read
interceptor state                            # Full DOM tree + scroll + focused element
```

### Interact
```bash
interceptor click e5                         # Click element
interceptor click e5 --os                    # OS-level trusted click (for sites checking isTrusted)
interceptor click e5 --at 10,20             # Click at offset within element
interceptor type e3 "hello"                  # Type into element (clears first)
interceptor type e3 "more" --append          # Append without clearing
interceptor type "textbox:Search" "query"    # Type using semantic selector (role:name)
interceptor select e7 "option-value"         # Select dropdown option
interceptor hover e5                         # Hover over element
interceptor keys "Control+A"                 # Keyboard shortcut
interceptor keys "Enter" --os               # OS-level key event
interceptor focus e5                         # Focus element
interceptor drag e5 --from 0,0 --to 100,50  # Drag gesture
interceptor dblclick e5                      # Double-click
interceptor rightclick e5                    # Right-click (context menu)
```

### Navigate
```bash
interceptor tab new "https://example.com"    # New tab in interceptor group
interceptor navigate "https://example.com"   # Navigate current tab
interceptor back                             # History back
interceptor forward                          # History forward
interceptor scroll down                      # Scroll (up/down/top/bottom)
interceptor wait 2000                        # Wait milliseconds
interceptor wait-stable                      # Wait for DOM to stop changing
```

### Tabs
```bash
interceptor tabs                             # List all tabs (* = active)
interceptor tab new "https://example.com"    # Open new tab
interceptor tab switch 12345                 # Switch to tab by ID
interceptor tab close                        # Close current tab
interceptor tab close 12345                  # Close specific tab
interceptor window new "https://example.com" # New window
interceptor window list                      # List all windows
```

### Network — Passive Capture (always on)
Every page's fetch/XHR traffic is intercepted automatically. Full response bodies included.
```bash
interceptor net log                          # All captured traffic
interceptor net log --filter voyager         # Filter by URL substring
interceptor net log --filter api.example.com # Any URL pattern
interceptor net log --since 1700000000000    # After timestamp
interceptor net log --limit 50              # Max entries (default 100)
interceptor net clear                        # Flush buffer
interceptor net headers                      # Captured request headers (CSRF, auth tokens)
interceptor net headers --filter linkedin    # Filter by URL
```

### Network — Request Overrides (rewrite before send)
Modify outgoing requests at the JavaScript level. No CDP, no debugger.
```bash
# Change a query parameter on matching URLs
interceptor override "*eventAttending*" count=50

# Multiple params
interceptor override "*api/search*" limit=50 offset=0

# Clear all overrides
interceptor override clear
```

### SSE Stream Capture

interceptor intercepts Server-Sent Events (text/event-stream) in real-time, chunk by chunk.

```bash
interceptor sse streams                                  # List active SSE streams
interceptor sse log [--filter <pattern>] [--limit N]     # Show completed SSE streams
interceptor sse tail [--filter <pattern>]                # Live tail SSE chunks
```

Works automatically on any site using fetch-based SSE or EventSource. No CDP. No setup.

### ChatGPT Agentic Bridge

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

### Scene Graph (Canva, Google Docs, Google Slides)
Read and manipulate visual editors whose "canvas" is actually a DOM / SVG / hidden-iframe structure. No CDP, no debugger, no detection risk. Profile-driven — each editor has its own detection and capability set. Works today on canva.com/design/, docs.google.com/document/, and docs.google.com/presentation/.

```bash
interceptor scene profile                     # Detect active editor profile
interceptor scene profile --verbose           # Include capabilities list
interceptor scene list                        # Enumerate scene objects on current page
interceptor scene list --type shape           # Filter by type (image|shape|text|page|slide|embed)
interceptor scene click <id>                  # Click a scene object by stable id (Canva: LBxxxxxxxxxxxxxx)
interceptor scene dblclick <id>               # Double-click to enter text edit
interceptor scene hit <x>,<y>                 # Identify the scene object at viewport coordinates
interceptor scene selected                    # Read current selection (host-aware)
interceptor scene zoom                        # Read editor zoom factor

interceptor scene text                        # Read full document text (Google Docs hidden iframe mirror)
interceptor scene text --with-html            # Include inline HTML with data-ri offsets
interceptor scene insert "<text>"             # Insert text at cursor position (Google Docs)

interceptor scene slide list                  # List all slides in a Google Slides deck
interceptor scene slide current               # Show current slide index and id
interceptor scene slide goto <n>              # Navigate to slide <n> (URL fragment method)
interceptor scene slide <n>                   # Shorthand for slide goto <n>
interceptor scene notes                       # Read speaker notes of current slide

interceptor scene render <id>                 # Render a scene object as PNG data URL
interceptor scene render <id> --save          # Save the PNG to disk
```

**How it works per editor:**

- **Canva**: every object on the canvas is a `<div id="LB…">` with `style.transform: translate(x, y)` and `style.width/height`. The IDs are stable per-document (they survive page reloads). `scene list` enumerates them; `scene click` computes the viewport center from `getBoundingClientRect()` and dispatches a click through `elementFromPoint`.
- **Google Docs**: the page is rendered to `<canvas>` but the full document HTML lives inside a hidden iframe at `.docs-texteventtarget-iframe > [role=textbox]`, complete with `<p>` / `<span>` elements carrying `data-ri` range-index offsets. `scene text` reads it, `scene insert` writes via `document.execCommand('insertText')` on the iframe's contenteditable.
- **Google Slides**: each slide is a SVG `<g id="filmstrip-slide-N-gd…">` with a pre-rendered PNG blob URL on the child `<image>`. The real slide-navigation page ID lives on the `data-slide-page-id` attribute of the parent `.punch-filmstrip-thumbnail`. `scene slide goto` navigates by setting `window.location.hash = "#slide=id." + pageId`.

### Recording (Session Monitor)
Record every real user click, keystroke, form change, navigation, DOM mutation, and the network calls each action triggered — then export the trace as either a pretty timeline or a runnable `interceptor` replay script. No CDP, no infobanner, no detection.

Monitor commands (`start`, `stop`, `pause`, `resume`) auto-resolve the target tab from the interceptor group when `--tab` is omitted. If the content script port is disconnected (e.g. after a service worker restart or long SPA session), the extension automatically re-injects `content.js` and retries — no `interceptor reload` needed.

```bash
interceptor monitor start                              # Begin recording on the active interceptor tab
interceptor monitor start --instruction "..."          # Annotate with task intent
interceptor monitor stop                               # End recording, print summary
interceptor monitor status                             # Show active session(s)
interceptor monitor pause                              # Stop emitting events without ending
interceptor monitor resume                             # Resume a paused session
interceptor monitor list                               # All sessions in the event log
interceptor monitor tail                               # Live tail current session (pretty)
interceptor monitor tail --raw                         # Live tail (raw JSONL)
interceptor monitor export <sessionId>                 # Aligned text rendering
interceptor monitor export <sessionId> --json          # Raw JSONL for that session
interceptor monitor export <sessionId> --plan          # Emit interceptor ... replay script
```

Each event line is sparse JSON (short keys: `t`, `s`, `k`, `sid`, `ref`, `r`, `n`, `cause`) so an agent can read a 30-minute session in a few KB. User actions get a session-monotonic `seq`; mutations and network calls fired within 500ms of an action carry `cause: <action_seq>`. Real user events have `tr: true`; interceptor's own synthetic clicks have `tr: false`. The replay-plan generator automatically includes synthetic clicks when no real user events exist in the session (common when an agent drove the browser). Use `--include-synthetic` to force inclusion regardless.

The replay script uses the existing semantic-selector path:
```
interceptor tab new "https://example.com/"
interceptor wait-stable
interceptor click "button:Search"
interceptor type "textbox:Query" "bun docs"
interceptor keys "Enter"
interceptor wait-stable
```

### Screenshots
```bash
interceptor screenshot                       # Viewport JPEG (returns data URL)
interceptor screenshot --save                # Save to disk
interceptor screenshot --full                # Full-page scroll+stitch
interceptor screenshot --format png          # PNG format
interceptor screenshot --quality 80          # JPEG quality 0-100
interceptor screenshot --element 5           # Capture element bounding box
```

### Data
```bash
interceptor cookies example.com              # List cookies for domain
interceptor storage                          # Read localStorage
interceptor storage set key value            # Write localStorage
interceptor eval "document.title"            # Run JS in page
interceptor history "search term"            # Search browser history
interceptor bookmarks "query"                # Search bookmarks
```

### LinkedIn
```bash
interceptor linkedin event <url>             # Full event extraction (no CDP)
interceptor linkedin event <url> --wait 3000 # Extra wait for slow pages
interceptor linkedin attendees <url>         # Attendees with request overrides + modal + API
interceptor linkedin attendees <url> --enrich-limit 5  # Limit per-attendee enrichment
```

### Batch & Raw
```bash
interceptor batch '[{"type":"click","ref":"e5"},{"type":"wait","ms":500},{"type":"extract_text"}]'
interceptor batch '...' --stop-on-error      # Halt on first failure
interceptor raw '{"type":"any_action","key":"value"}'  # Send any raw action
```

### Meta
```bash
interceptor status                           # Daemon status (local check, no connection needed)
interceptor help                             # Full CLI help
interceptor reload                           # Reload extension
interceptor capabilities                     # Check available input layers
```

## Flags

| Flag | Effect |
|------|--------|
| `--json` | JSON output instead of plain text |
| `--tab <id>` | Target specific tab by ID |
| `--any-tab` | Operate outside the interceptor group |
| `--os` | Use OS-level trusted events (macOS CGEvent) |
| `--frame <id>` | Target specific iframe |
| `--changes` | Include DOM diff in response |

## Recipes

### Extract data from an SPA
```bash
interceptor tab new "https://app.example.com"
sleep 3
interceptor tree                              # Find the data
interceptor net log --filter api              # See what API calls the page made
interceptor net headers --filter api          # Grab auth tokens from captured headers
interceptor text                              # Read visible content
interceptor tab close
```

### Fill and submit a form
```bash
interceptor tab new "https://example.com/form"
sleep 2
interceptor tree                              # Find form fields
interceptor type e3 "John Doe"               # Fill name
interceptor type e5 "john@example.com"       # Fill email
interceptor select e7 "option2"              # Pick dropdown
interceptor click e10                         # Submit
sleep 2
interceptor text                              # Read result
```

### Monitor network traffic from any page
```bash
interceptor tab new "https://app.example.com"
sleep 3
interceptor net log --filter api              # See all API calls with full response bodies
interceptor net headers --filter api          # See request headers (auth, CSRF, cookies)
# Navigate around — capture keeps running
interceptor click e5
sleep 2
interceptor net log --filter api --limit 5    # See latest calls
```

### Override API requests (change page size, params)
```bash
interceptor tab new "https://app.example.com"
sleep 2
# Push override: change page_size to 100 on any matching URL
interceptor override "*api/list*" page_size=100
# Now interact — when the page fetches, the URL is rewritten before it fires
interceptor click e5                          # Trigger a load
sleep 2
interceptor net log --filter api/list         # See the rewritten request + response
interceptor override clear                    # Clean up
```

### LinkedIn event extraction (full flow, no CDP)
```bash
interceptor linkedin event "https://www.linkedin.com/events/1234567890/?viewAsMember=true"
# Returns: title, organizer, ISO dates, timezone, attendee count + names,
#          poster name, follower count, likes, reposts, comments, UGC post ID,
#          details text, thumbnail URL, validation checks
```

### Interact with sites that check isTrusted
```bash
interceptor tab new "https://strict-site.com"
sleep 2
interceptor tree
interceptor click e5 --os                     # OS-level CGEvent click (genuinely trusted)
interceptor type e3 "text" --os               # OS-level keystrokes
```

### Read a Google Doc programmatically
```bash
interceptor tab new "https://docs.google.com/document/d/<id>/edit"
sleep 5
interceptor scene profile                     # -> google-docs
interceptor scene text                        # Full document text from hidden iframe mirror
interceptor scene text --with-html            # Full HTML model with data-ri offsets
interceptor scene insert "new paragraph at cursor"
interceptor keys "Meta+z"                     # Undo the insert
```

### Manipulate a Canva design
```bash
interceptor tab new "https://www.canva.com/design/<id>/edit"
sleep 6
interceptor scene profile                     # -> canva
interceptor scene list --type shape           # Every LB layer that's a shape
interceptor scene zoom                        # Current editor zoom factor
interceptor scene hit 537,516                 # What's at this viewport coord?
interceptor scene click LBKfjtRwQHt7D0Cf      # Click a layer by stable id
```

### Navigate and render Google Slides
```bash
interceptor tab new "https://docs.google.com/presentation/d/<id>/edit"
sleep 6
interceptor scene slide list                  # All slides with stable IDs + blob URLs
interceptor scene slide goto 5                # Navigate via URL fragment
interceptor scene slide current               # Verify index 5 is now active
interceptor scene notes                       # Read speaker notes for current slide
interceptor scene render filmstrip-slide-3-gd02e148143_0_6 --save  # PNG of slide 3
```

### Record a user session and replay it
```bash
# With Ron at the keyboard:
interceptor monitor start --instruction "search bun docs, open first result, copy paragraph"
# ... Ron interacts for 60 seconds ...
interceptor monitor stop                      # Prints session summary
interceptor monitor list                      # Shows all historical sessions
interceptor monitor export <sessionId>        # Aligned text rendering
interceptor monitor export <sessionId> --plan # Replayable script of interceptor commands
```

### Diff canvas pixels between two renders (the OTHER `interceptor canvas`)
```bash
interceptor canvas list                       # Discover <canvas> elements (HTMLCanvasElement)
interceptor canvas read 0 --format png        # Read canvas as data URL
interceptor canvas diff url1.png url2.png     # Pixel diff between images
```

## What NOT to Do

- **Don't take screenshots to understand a page** — use `interceptor tree` and `interceptor text`. Screenshots waste tokens.
- **Don't chain commands without sleep** — the extension needs time to process. `sleep 1` between actions.
- **Don't interact with tabs outside the interceptor group** without `--any-tab`.
- **Don't use CDP commands** (`interceptor network on`) unless you have a specific reason. Passive capture (`interceptor net log`) sees everything without the debugger infobanner.
- **Don't start the daemon manually** — it auto-starts on first command.

## Credits

- [Ron Eddings](https://github.com/ronaldeddings/) created Interceptor.
- [Pedram Amini](https://github.com/pedramamini/) provided early feedback on the project. Pedram's platform, Maestro, was used as part of developing this project.
- [Daniel Miessler](https://github.com/danielmiessler/) was building an AI community, and through that community I learned about his tool PAI and got support from fellow AI tinkerers and engineers to finish the initial build of this project.
