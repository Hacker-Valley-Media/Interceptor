# slop-browser

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

## What NOT to Do

- **Don't take screenshots to understand a page** — use `slop tree` and `slop text`. Screenshots waste tokens.
- **Don't chain commands without sleep** — the extension needs time to process. `sleep 1` between actions.
- **Don't interact with tabs outside the slop group** without `--any-tab`.
- **Don't use CDP commands** (`slop network on`) unless you have a specific reason. Passive capture (`slop net log`) sees everything without the debugger infobanner.
- **Don't start the daemon manually** — it auto-starts on first command.
