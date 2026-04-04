# slop-browser

Browser control for AI agents. No CDP, no MCP, no API keys. You drive — slop actuates.

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

Every slop command is stateless. The daemon auto-starts if not running.

## Core Concepts

### The Slop Group
Every tab created by slop joins a **cyan "slop" tab group**. By default, slop only operates on tabs in this group — your personal tabs are never touched. Pass `--any-tab` to override.

### Element Refs
`slop tree` returns elements with stable refs like `e1`, `e5`, `e23`. Use these to click, type, hover, etc. Refs survive between commands until the DOM changes.

### Passive Network Capture
All `fetch()` and `XMLHttpRequest` traffic is intercepted on every page automatically. No CDP, no debugger, no infobanner. Query captured traffic anytime:

```bash
slop net log                          # All captured requests
slop net log --filter linkedin.com    # Filter by URL
slop net headers                      # Captured request headers (CSRF, auth)
slop net clear                        # Flush buffer
```

## Command Reference

### Page State
```bash
slop state                            # DOM tree + scroll position + focused element
slop state --full                     # Include visible text content
slop tree                             # Accessibility tree (interactive elements only)
slop tree --filter all                # Include headings + landmarks
slop tree --depth N                   # Limit depth
slop diff                             # Changes since last tree/state read
slop text                             # All visible text
slop text e5                          # Text from specific element
slop html e5                          # HTML of specific element
slop find "query"                     # Find elements by name/text
slop find "query" --role button       # Filter by ARIA role
```

### Actions
```bash
slop click e5                         # Click element
slop click e5 --os                    # OS-level trusted click (CGEvent)
slop click e5 --at 10,20             # Click at coordinates within element
slop dblclick e5                      # Double-click
slop rightclick e5                    # Right-click (context menu)
slop type e3 "hello"                  # Type into element (clears first)
slop type e3 "more" --append          # Type without clearing
slop type "textbox:Search" "query"    # Type using semantic selector
slop select e7 "option-value"         # Select dropdown option
slop hover e5                         # Hover over element
slop hover e5 --from 100,200         # Hover with mouse path
slop drag e5 --from 0,0 --to 100,50  # Drag gesture
slop keys "Control+A"                 # Keyboard shortcut
slop keys "Enter" --os               # OS-level key event
slop focus e5                         # Focus element
slop click-at 500,300                 # Click at viewport coordinates
```

### Navigation
```bash
slop navigate "https://example.com"   # Go to URL
slop back                             # History back
slop forward                          # History forward
slop scroll down                      # Scroll down
slop scroll up                        # Scroll up
slop scroll top                       # Scroll to top
slop scroll bottom                    # Scroll to bottom
slop wait 2000                        # Wait milliseconds
slop wait-stable                      # Wait for DOM stability
slop wait-stable --ms 500             # Custom debounce
```

### Tabs & Windows
```bash
slop tabs                             # List all tabs (* = active, managed = in slop group)
slop tab new "https://example.com"    # Open new tab in slop group
slop tab close                        # Close current tab
slop tab close 12345                  # Close specific tab
slop tab switch 12345                 # Switch to tab
slop window new "https://example.com" # New window (tab joins slop group)
slop window list                      # List all windows
```

### Passive Network (always-on, no CDP)
```bash
slop net log                          # All passively captured fetch/XHR traffic
slop net log --filter voyager         # Filter by URL substring
slop net log --since 1700000000000    # Entries after timestamp
slop net log --limit 50               # Max entries (default 100)
slop net clear                        # Flush capture buffer
slop net headers                      # Captured request headers (CSRF tokens, auth)
slop net headers --filter linkedin    # Filter headers by URL
```

### Network Interception (CDP — explicit opt-in)
```bash
slop network on                       # Start CDP capture (attaches debugger)
slop network on "api" "graphql"       # Capture matching patterns only
slop network off                      # Stop CDP capture
slop network log                      # Print CDP-captured requests
slop network override on '<json>'     # Rewrite requests before they leave browser
slop network override off             # Disable overrides
```

### Screenshots & Capture
```bash
slop screenshot                       # Viewport screenshot (JPEG, returns data URL)
slop screenshot --save                # Save to disk
slop screenshot --full                # Full-page scroll+stitch
slop screenshot --format png          # PNG format
slop screenshot --quality 80          # JPEG quality 0-100
slop screenshot --element 5           # Capture element bounding rect
slop screenshot --background          # Background tab via tabCapture
```

### JavaScript Evaluation
```bash
slop eval "document.title"            # Run JS in isolated world
slop eval "window.location" --main    # Run JS in page context
```

### Cookies & Storage
```bash
slop cookies example.com              # List cookies for domain
slop cookies set '{"url":"...","name":"...","value":"..."}'
slop storage                          # Read localStorage
slop storage set key value            # Write localStorage
slop storage --session                # Use sessionStorage
```

### LinkedIn Extraction
```bash
slop linkedin event <url>             # Extract event data (passive capture, no CDP)
slop linkedin event <url> --wait 3000 # Extra wait time for slow pages
slop linkedin attendees <url>         # Extract attendees with modal + API
```

### Canvas Intelligence
```bash
slop canvas list                      # Discover canvas elements
slop canvas read 0                    # Read canvas as data URL
slop canvas read 0 --webgl            # WebGL readPixels
slop canvas diff <url1> <url2>        # Pixel diff between images
```

### Batch & Advanced
```bash
slop batch '[{"type":"click","ref":"e5"},{"type":"wait","ms":500}]'
slop batch '...' --stop-on-error      # Halt on first failure
slop raw '{"type":"evaluate","code":"1+1"}'  # Send raw action JSON
slop capabilities                     # Check available layers
```

### History, Bookmarks, Downloads
```bash
slop history "search term"            # Search history
slop bookmarks "query"                # Search bookmarks
slop downloads                        # List recent downloads
```

### Meta
```bash
slop status                           # Daemon status (local check, no connection)
slop reload                           # Reload extension
slop help                             # Full help text
```

## Flags

| Flag | Effect |
|------|--------|
| `--json` | JSON output instead of plain text |
| `--tab <id>` | Target specific tab by ID |
| `--any-tab` | Operate outside the slop group |
| `--os` | Use OS-level input (trusted events) |
| `--frame <id>` | Target specific iframe |
| `--changes` | Include DOM diff in response |

## Typical Agent Flow

```bash
# 1. Open a page
slop tab new "https://app.example.com/dashboard"
sleep 3

# 2. Understand what's on screen
slop tree

# 3. Interact
slop click e12                        # Click a button
slop tree                             # See what changed
slop type e15 "search query"          # Fill a field
slop click e16                        # Submit

# 4. Read results
slop text                             # Get visible text
slop net log --filter api             # Check what API calls fired

# 5. Clean up
slop tab close
```

## What NOT to Do

- Don't take screenshots for inspection — use `tree` and `text`
- Don't start the daemon manually — it auto-starts
- Don't chain rapid-fire commands without `sleep` — the extension needs processing time
- Don't interact with tabs outside the slop group without `--any-tab`

## Build

```bash
bun run build                         # Build everything (extension + CLI + daemon)
bash scripts/build.sh --target=macos  # macOS only
bash scripts/build.sh --target=windows # Windows only
```

## Install Extension

```bash
bash scripts/install.sh               # macOS — symlinks native messaging manifest
```

Then load `extension/dist/` as an unpacked extension in Chrome/Brave.
