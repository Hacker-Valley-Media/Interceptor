<p align="center">
  <img src="docs/assets/interceptor-logo-square.png" alt="Interceptor logo" width="180">
</p>

<h1 align="center">Interceptor</h1>

<p align="center">
  <strong>AI agents use your real browser and macOS apps like a human would.</strong>
</p>

<p align="center">
  No CDP. No separate automated browser. No starting from zero.
</p>

<p align="center">
  <a href="#install-in-60-seconds"><strong>Install via CLI</strong></a>
  ·
  <a href="#quick-start"><strong>Quick Start</strong></a>
  ·
  <a href="ARCHITECTURE.md"><strong>Architecture</strong></a>
  ·
  <a href="use-cases/"><strong>Use Cases</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/Hacker-Valley-Media/Interceptor?label=release" alt="Latest release">
  <img src="https://img.shields.io/github/license/Hacker-Valley-Media/Interceptor" alt="License">
  <img src="https://img.shields.io/badge/macOS-supported-black?logo=apple" alt="macOS supported">
  <img src="https://img.shields.io/badge/Chrome%20%26%20Brave-supported-4285F4?logo=googlechrome" alt="Chrome and Brave supported">
</p>

![Interceptor running cinematic overlays on top of a live website](docs/assets/interceptor-cook-mode.jpg)

Interceptor gives agents human-style control of your existing browser session so they can read pages, click, type, navigate, observe what a site is doing underneath, and learn repeatable workflows on the live web without starting from a separate automated browser.

It runs as a Chrome extension inside your actual browser, not a separate automated instance. Your cookies, your sessions, your logins, and your context stay intact. The same CLI also extends to native macOS automation through `interceptor macos`.

The agent calls `interceptor` CLI commands, reads the output, and decides what to do next. No MCP required. No API keys required.

> **Warning**
> Interceptor gives agents real autonomy over your browser and apps. Treat it like an agent, not a toy script runner.

## Why Teams Use Interceptor

- **Your real browser session**: operate inside the browser you already use, with your cookies, logins, tabs, and context intact.
- **Passive network visibility**: capture `fetch()` and `XMLHttpRequest` traffic without turning on the debugger or triggering an infobanner.
- **Teach-and-replay workflows**: record real clicks, keystrokes, DOM changes, and correlated network calls, then export a replayable `interceptor` plan.
- **Native macOS control**: inspect accessibility trees, click, type, capture speech, and monitor system-level activity through the same CLI.
- **Built for hostile pages**: avoid the standard CDP-first footprint that gets separate automated browsers flagged or blocked.

## Why Interceptor Exists

Most browser automation stacks start a separate browser and talk to it through DevTools. That is fine until the site notices, your authenticated context disappears, or your agent has to relearn a workflow from scratch.

Interceptor was built from the opposite premise: use the browser and apps the human is already using, let the agent see what is really happening underneath, and make the workflow reusable after a single live walkthrough.

## Why Interceptor Instead Of The Usual Stack?

| Capability | Interceptor | Playwright / Puppeteer / CDP-first tooling |
|---|---|---|
| Uses your existing logged-in browser profile | Yes | Usually no |
| Reads passive fetch/XHR traffic without debugger attachment | Yes | No |
| Records real human sessions and exports replay plans | Yes | Not built in |
| Extends the same CLI to native macOS apps | Yes | No |
| Avoids a separate automated browser by default | Yes | No |

## Demo Preview

[![Preview from the current Interceptor walkthrough](docs/assets/interceptor-demo-preview.jpg)](https://hacker-valley-media.github.io/Interceptor/walkthrough.html)

Click the preview to watch the current walkthrough. It shows the CLI flow and live browser overlays working together in the same session.

## Install In 60 Seconds

The primary local install path is CLI-first. Brave is the recommended browser target because it accepts `--load-extension` from the install script.

```bash
git clone https://github.com/Hacker-Valley-Media/Interceptor.git
cd Interceptor
bun install
bash scripts/build.sh
bash scripts/install.sh --brave --profile Default
./dist/interceptor status
```

If Brave is already open, the install script asks before quitting and relaunching it with `extension/dist/` loaded. If you want `interceptor` on your `PATH`, symlink `dist/interceptor` into a directory already on your shell path; otherwise use `./dist/interceptor` from the repo.

## Quick Start

Examples below assume `interceptor` is on your `PATH`. From a repo install, use `./dist/interceptor` if you have not added a symlink.

```bash
interceptor open "https://example.com"       # Open, wait, return tree + text (1 command)
interceptor act e1                            # Click element, return updated tree + diff
interceptor act e2 "hello world"              # Type into field, return updated tree
interceptor read                              # Re-read current page (tree + text)
interceptor inspect                           # Tree + text + network log + headers
```

Once installed, the daemon auto-starts on first command. No manual launch needed.

The legacy individual commands (`interceptor tab new`, `interceptor tree`, `interceptor click`, etc.) still work, but the compound commands above are preferred — they reduce round-trips and agent deliberation time.

## Agent Instructions

`AGENTS.md` is the canonical repo instruction file for agentic tools. `CLAUDE.md` remains in the repo as a compatibility file for tools that still expect that filename.

Shared repo-local skills live under [`.agents/skills/`](.agents/skills/). For cross-tool compatibility, [`.codex/skills`](.codex/skills), [`.claude/skills`](.claude/skills), and [`.gemini/skills`](.gemini/skills) all point at the same backing directory.

## Detailed Installation

### Option 1: Brave CLI Install (Recommended)

#### Prerequisites

- [Bun](https://bun.sh/) runtime
- Brave Browser

#### Build and Install

```bash
git clone https://github.com/Hacker-Valley-Media/Interceptor.git
cd Interceptor
bun install
bash scripts/build.sh
bash scripts/install.sh --brave --profile Default
```

This builds the host binaries and extension, writes native messaging manifests, and relaunches Brave with the unpacked extension from `extension/dist/`. Use `bash scripts/install.sh --brave --profiles` to list profile directories before choosing a non-default profile.

This path produces and uses these artifacts:

| Artifact | Path |
|----------|------|
| CLI binary | `dist/interceptor` |
| Background daemon | `daemon/interceptor-daemon` |
| Chrome extension | `extension/dist/` |

#### Put the CLI on PATH

Run commands from the repo with `./dist/interceptor ...`, or symlink the binary into an existing PATH directory:

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/dist/interceptor" ~/.local/bin/interceptor
```

#### Chrome Development Path

Google Chrome ignores `--load-extension` in branded desktop builds. `scripts/install.sh --chrome` still writes the native messaging manifest, but load the extension manually:

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `extension/dist/`

#### Uninstall

```bash
bash scripts/uninstall.sh
```

### Verify

```bash
./dist/interceptor status    # Should report daemon, extension, and browser bridge status
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

## macOS Bridge (development)

The Brave CLI browser install does not require the macOS bridge. Use the standalone `interceptor-bridge` path below when developing or debugging native macOS automation.

### Build and Install

```bash
bash scripts/build-bridge.sh
bash scripts/install-bridge.sh
```

Requires full Xcode (not just Command Line Tools) — the bridge links Apple frameworks including ScreenCaptureKit, Speech, Vision, and NaturalLanguage.

### Permissions

After installing, check and grant required permissions:

```bash
interceptor macos trust
```

Treat `interceptor macos trust` as a permission snapshot. Use `interceptor status` to confirm the daemon, helper, and bridge socket are actually alive before debugging native runtime failures.

| Permission | Required | What It Enables |
|-----------|----------|-----------------|
| Accessibility | Yes | UI element inspection, clicking, typing, window management |
| Screen Recording | No | Screenshots, screen capture, vision analysis |
| Microphone | No | Speech recognition, voice activity detection |

Grant permissions in: System Settings → Privacy & Security → [Permission] → Interceptor

---

## Core Concepts

**Element Refs** — `interceptor tree` returns elements with refs like `e1`, `e5`, `e23`. Use these to click, type, hover. Refs survive between commands until the DOM changes.

**Interceptor Group** — Every `interceptor tab new` adds tabs to a cyan "interceptor" group. Commands only work on tabs in this group. Your personal tabs are never touched. Use `--any-tab` to override.

**Passive Network** — All `fetch()` and `XMLHttpRequest` traffic on every page is captured automatically. No debugger, no infobanner. Query it with `interceptor net log`.

**Scene Graph** — Profile-driven access to visual editors that don't render to the DOM normally: Canva, Google Docs, Google Slides. Enumerate objects by stable ID, click shapes, read full document text, navigate slide decks, render pages to PNG. `interceptor scene` — no CDP, no vision, no screenshots needed.

**Session Monitor** — Record a user's real interactions (clicks, keystrokes, form changes, DOM mutations, network calls) as a sparse event stream that replays as an `interceptor` script. Sessions are **document-scoped and tab-following**: a single recording survives refreshes and SPA navigation, automatically hands off to child tabs that the monitored page opens (e.g. Canva's "Create new design"), and follows you when you manually switch focus between tabs in the interceptor group. Personal tabs outside the cyan interceptor group are never auto-attached. Each session writes its own durable artifact directory (`/tmp/interceptor-monitor-sessions/<sid>/`) so exports don't depend on a rolling log, and `monitor stop` is transport-resilient — it cannot throw on a disconnected native port. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full monitor model.

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
interceptor read --include-style              # Inline computed styles (display, color, opacity, etc.) on each element
interceptor read --include-frames             # Walk every reachable frame; refs from non-top frames are e<frameId>_<n>
interceptor read e2_7 --include-frames        # Read only a framed element subtree
interceptor style inject --css "button{outline:3px solid red}" # Inject stylesheet into all frames
interceptor style inject --css "body{zoom:1.1}" --top-only     # Inject only into the top frame
interceptor style remove <handle>             # Remove a previously injected stylesheet
interceptor act e2_7                          # Act on element in frame 2 (routed automatically)
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

A session follows your focus across the interceptor tab group. Switch to another in-group tab and the monitor emits `mon_detach (reason: focus_switch_handoff)` + `mon_attach (reason: focus_switch)` and starts capturing there. Child tabs that the monitored page opens itself (via a trusted click) take the dedicated child-tab handoff path (`reason: child_tab`). Tabs outside the cyan interceptor group are never auto-attached. Reloads and SPA history/fragment navigations create new document-scoped attachments on the same tab (`reason: reload` / `history` / `fragment`).

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
interceptor monitor export <sessionId> --with-bodies   # Include persisted net-body context when available
```

Each event line is sparse JSON (short keys: `t`, `s`, `k`, `sid`, `ref`, `r`, `n`, `cause`) so an agent can read a 30-minute session in a few KB. User actions get a session-monotonic `seq`; mutations and network calls fired within 500ms of an action carry `cause: <action_seq>`. Real user events have `tr: true`; interceptor's own synthetic clicks have `tr: false`. The replay-plan generator automatically includes synthetic clicks when no real user events exist in the session (common when an agent drove the browser). Use `--include-synthetic` to force inclusion regardless.

The rolling live event stream lives in `/tmp/interceptor-events.jsonl`. Export prefers per-session artifacts under `/tmp/interceptor-monitor-sessions/<sessionId>/` (one directory per session containing `events.jsonl`, `session.json`, and `net.jsonl`) and falls back to the rolling event log for legacy sessions. `--with-bodies` uses persisted correlated net-body artifacts when present (body previews are capped at 64 KiB, redact `Authorization` / `Cookie` / token-shaped strings, and only persist JSON / text content types) and otherwise leaves `interceptor net log` hints in the replay output.

The replay script uses semantic selectors that survive DOM churn, and for multi-tab sessions it emits explicit tab-handoff lines:
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

### Screenshots

Default capture is **DOM render** — no `chrome.tabs.captureVisibleTab` in the hot path. Works regardless of window focus, macOS Space, or service-worker activation context. A vendored `html-to-image` bundle is injected on demand and paired with a per-tab CORS-clearance DNR rule. Use `--pixel` for compositor-accurate capture (requires Chrome focused).

```bash
interceptor screenshot                       # Default DOM-render full-page (works without focus)
interceptor screenshot --save                # Also save to disk
interceptor screenshot --selector "h1"       # Capture matching element (off-screen supported)
interceptor screenshot --element 5           # Capture by ref/index from a recent read
interceptor screenshot --region X,Y,W,H      # Render full + crop to region in content script
interceptor screenshot --scale 2             # Override pixel ratio
interceptor screenshot --pixel               # Pixel-true compositor capture (legacy captureVisibleTab)
interceptor screenshot --pixel --full        # Pixel-true full-page (scroll + in-SW stitch)
interceptor screenshot --format png          # PNG (default for DOM render)
interceptor screenshot --quality 80          # JPEG quality 0-100
```

`screenshot` invocations are auto-routed through the WebSocket transport because base64 dataUrl responses larger than ~50KB are unreliable over the native-messaging port on Brave/Chromium. Override with `--no-ws` if needed.

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

### Inspect and read canvas-heavy pages
```bash
interceptor canvas list                       # Discover <canvas> elements (HTMLCanvasElement)
interceptor canvas status                     # Canvas list + host/model/observer signals
interceptor canvas log                        # Captured drawing operations across canvases
interceptor canvas log 0 --kind fillText      # Drawing operations for canvas index 0
interceptor canvas objects 0 --kind text      # Derived objects for canvas index 0
interceptor canvas model                      # Host-state and app-model signals
interceptor canvas routes --filter save       # First-party canvas-related network routes
interceptor canvas read 0 --format png        # Read canvas as data URL
interceptor canvas diff url1.png url2.png     # Pixel diff between images
```

Canvas indexes come from the DOM canvas order reported by `canvas list`. The observer-backed `log` and `objects` commands resolve that DOM index to the internal observer `canvasId`, so `canvas log 0` and `canvas log 1` stay separated on multi-canvas pages. `canvas ocr` exists as an experimental command, but use `canvas read` when you need a stable image export.

## macOS Native Control

`interceptor macos` extends the same agent-first pattern to native macOS applications. No screenshots, no vision models. Structured AX trees, trusted input, real-time audio intelligence, and system-wide event monitoring.

### How It Works

When the native bridge is installed, the daemon routes `macos_` commands to the bridge over Unix socket. Same CLI binary, same wire format, same ref convention (`e1`, `e2`, ...). Browser automation through Brave works through the CLI install path without the native bridge.

```
CLI ──unix──▸ Daemon ──native-msg──▸ Chrome Extension (web commands)
                    ──unix──▸ Native Bridge (macOS commands)
```

### Agent Quick Start (macOS)

```bash
interceptor macos tree                           # AX tree for frontmost app (like interceptor tree for the browser)
interceptor macos find "Save" --role button      # Find elements
interceptor macos click e5                       # Click by ref (CGEvent — OS-level trusted)
interceptor macos type e3 "hello"                # Type into element
interceptor macos keys "Meta+S"                  # Keyboard shortcut
interceptor macos apps                           # List running apps
interceptor macos app activate "Finder"          # Bring app to front
interceptor macos move e1 --x 0 --y 25           # Move window
interceptor macos resize e1 --width 672 --height 983  # Resize window
```

### Compound Commands

```bash
interceptor macos open "Finder"                  # Activate + tree + windows (one call)
interceptor macos read                           # Tree + frontmost app info
interceptor macos act e5                         # Click + wait + updated tree
interceptor macos act e3 "hello"                 # Type + wait + updated tree
interceptor macos inspect                        # Tree + apps + frontmost info
```

### Audio Intelligence

```bash
interceptor macos listen start                   # Real-time speech recognition
interceptor macos listen transcript              # Get current transcript
interceptor macos vad start                      # Voice activity detection (RMS-based)
interceptor macos sounds start                   # Sound classification (300+ built-in types)
interceptor macos audio output start             # Capture system audio
```

### On-Device Vision & NLP

```bash
interceptor macos vision text                    # OCR frontmost window
interceptor macos vision faces                   # Face detection
interceptor macos vision hands                   # Hand pose (21-joint model)
interceptor macos nlp entities "Ron in Austin"   # Named entity recognition
interceptor macos nlp sentiment "great product"  # Sentiment analysis
interceptor macos ai prompt "Summarize this"     # On-device LLM (macOS 26+)
```

### macOS Monitor (Teach and Replay)

Same pattern as the browser monitor. Record what the user does across native apps, export a replayable script.

```bash
interceptor macos monitor start --instruction "Show me how you file expenses"
# ... user works in native apps ...
interceptor macos monitor stop                   # Summary: 230 events, 2 minutes
interceptor macos monitor export <sid>           # Pretty timeline with timestamps
interceptor macos monitor export <sid> --plan    # Replayable interceptor macos commands
```

Captures clicks, keystrokes, scrolls, app switches — annotated with AX element roles and names. Same sparse JSON format as the browser monitor.

### Virtual Displays & Streaming

```bash
interceptor macos display list                   # Physical + virtual displays
interceptor macos display create 1920x1080       # Create virtual display (CGVirtualDisplay)
interceptor macos stream start --app "Finder"    # Continuous screen stream
interceptor macos stream frame                   # Latest frame as JPEG data URL
```

### Permissions

```bash
interceptor macos trust                          # Check all permissions with exact System Settings paths
interceptor macos trust --prompt                 # Ask macOS to register Interceptor in Accessibility
interceptor macos trust --walkthrough            # Prompt + open the next relevant Privacy pane
```

| Permission | Required | Enables |
|-----------|----------|---------|
| Accessibility | Yes | AX tree, input, window management |
| Screen Recording | No | Screenshots, capture, vision |
| Microphone | No | Speech recognition, VAD, sound classification |

## What NOT to Do

- **Don't take screenshots to understand a page** — use `interceptor tree` and `interceptor text`. Screenshots waste tokens.
- **Don't chain commands without sleep** — the extension needs time to process. `sleep 1` between actions.
- **Don't interact with tabs outside the interceptor group** without `--any-tab`.
- **Don't use CDP commands** (`interceptor network on`) unless you have a specific reason. Passive capture (`interceptor net log`) sees everything without the debugger infobanner.
- **Don't start the daemon manually** — it auto-starts on first command.

## Credits

- [Ron Eddings](https://github.com/ronaldeddings/) created Interceptor.
- [Pedram Amini](https://github.com/pedramamini/) provided early feedback on the project. Pedram's platform, [Maestro](https://runmaestro.ai), was used as part of developing this project.
- [Daniel Miessler](https://github.com/danielmiessler/) for graciously coming up with the name `Interceptor` and EPIC project, [PAI](https://github.com/danielmiessler/PAI))
