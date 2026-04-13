export const HELP = `interceptor — browser control CLI

Compound (agent-optimized):
  interceptor open <url>                     Open URL, wait, return tree + text
  interceptor open <url> --tree-only         Skip text, return only tree
  interceptor open <url> --text-only         Skip tree, return only text
  interceptor open <url> --full              Full text instead of 2000-char summary
  interceptor open <url> --timeout <ms>      Override wait-stable timeout (default 5000)
  interceptor open <url> --no-wait           Return immediately after tab creation
  interceptor read                           Tree + text for active tab
  interceptor read <ref>                     Tree + text for element subtree
  interceptor read --tree-only               Skip text
  interceptor read --text-only               Skip tree
  interceptor act <ref>                      Click + wait + return updated tree + diff
  interceptor act <ref> "value"              Type into field + wait + return updated tree
  interceptor act <ref> --os                 Use OS-level trusted input
  interceptor act <ref> --keys "Enter"       Send keyboard shortcut instead
  interceptor act <ref> --no-read            Skip post-action tree read
  interceptor inspect                        Tree + text + network log + headers
  interceptor inspect --net-only             Skip tree/text, return only network data

State:
  interceptor state                          Current page DOM tree + metadata
  interceptor state --full                   Include static text content
  interceptor tree                           Semantic accessibility tree
  interceptor tree --filter all              Include landmarks + headings
  interceptor tree --depth N --max-chars N   Limit depth and output size
  interceptor diff                           Changes since last state/tree read
  interceptor find "query"                   Find elements by name
  interceptor find "query" --role button     Filter by role
  interceptor text                           All visible text
  interceptor text <index|ref>               Text from specific element
  interceptor html <index|ref>               HTML of specific element

Actions:
  interceptor click <index|ref>              Click element (e.g. interceptor click e5)
  interceptor click <index> --at X,Y        Click at coordinates on element
  interceptor dblclick <index> --at X,Y     Double-click at coordinates
  interceptor rightclick <index> --at X,Y   Right-click at coordinates
  interceptor type <index|ref> <text>        Type into element (clears first)
  interceptor type <index|ref> <text> --append  Type without clearing
  interceptor type "role:name" <text>        Type using semantic selector
  interceptor select <index|ref> <value>     Select dropdown option
  interceptor focus <index|ref>              Focus element
  interceptor hover <index|ref>              Hover over element
  interceptor hover <index> --from X,Y      Hover with mouse path
  interceptor drag <index> --from X,Y --to X,Y  Drag gesture on element
  interceptor drag <index> ... --steps 20   Number of intermediate moves
  interceptor drag <index> ... --duration 500  Spread over milliseconds
  interceptor keys <combo>                   Keyboard shortcut (e.g. "Control+A")

Navigation:
  interceptor navigate <url>                 Go to URL
  interceptor back                           History back
  interceptor forward                        History forward
  interceptor scroll <up|down|top|bottom>    Scroll page
  interceptor wait <ms>                      Wait milliseconds

Tabs:
  interceptor tabs                           List all tabs
  interceptor tab new [url]                  Open new tab
  interceptor tab close [id]                 Close tab
  interceptor tab switch <id>                Switch to tab

Capture:
  interceptor screenshot                     Viewport screenshot (returns data URL)
  interceptor screenshot --save              Also save to disk
  interceptor screenshot --format png        PNG format (default: jpeg)
  interceptor screenshot --quality 80        JPEG quality 0-100 (default: 50)
  interceptor screenshot --full              Full-page scroll+stitch capture
  interceptor screenshot --clip X,Y,W,H     Capture region
  interceptor screenshot --element N         Capture element bounding rect
  interceptor eval <code>                    Run JS in isolated world
  interceptor eval <code> --main             Run JS in page context

Cookies:
  interceptor cookies <domain>               List cookies
  interceptor cookies set <json>             Set cookie
  interceptor cookies delete <url> <name>    Delete cookie

Network (CDP — explicit opt-in):
  interceptor network on [patterns...]       Start intercepting (attaches debugger)
  interceptor network off                    Stop intercepting
  interceptor network log                    Print captured requests (CDP)
  interceptor network override on '<json>'   Rewrite matching requests before they leave the browser
  interceptor network override off           Disable request rewriting

Request Override (passive, no CDP):
  interceptor override "*pattern*" key=value   Override query param on matching requests
  interceptor override "*api*" limit=50 offset=0  Multiple params
  interceptor override clear                  Remove all overrides

Passive Network (always-on, no CDP):
  interceptor net log                        Passively captured fetch/XHR traffic
  interceptor net log --filter <pattern>     Filter by URL substring
  interceptor net log --since <timestamp>    Entries after timestamp
  interceptor net log --limit <n>            Max entries (default 100)
  interceptor net clear                      Flush passive capture buffer
  interceptor net headers                    Show captured request headers (CSRF, auth)
  interceptor net headers --filter <pattern> Filter headers by URL

SSE Stream Capture:
  interceptor sse log [--filter <pattern>] [--limit N]   Show completed SSE streams
  interceptor sse streams                                  List active SSE streams
  interceptor sse tail [--filter <pattern>]                Live tail SSE stream chunks

LinkedIn:
  interceptor linkedin event [url]           Extract LinkedIn event + post data via network and DOM validation
  interceptor linkedin attendees [url]       Extract LinkedIn event attendees with request override, batching, and enrichment

Headers:
  interceptor headers add <name> <value>     Add request header
  interceptor headers remove <name>          Remove header rule
  interceptor headers clear                  Clear all rules

Canvas:
  interceptor canvas list                    Discover <canvas> elements
  interceptor canvas read N                  Read canvas as data URL
  interceptor canvas read N --format png     PNG format
  interceptor canvas read N --region X,Y,W,H  Read pixel region
  interceptor canvas read N --webgl          WebGL canvas readPixels
  interceptor canvas diff <url1> <url2>      Pixel diff between images
  interceptor canvas diff --threshold 10     Per-channel tolerance
  interceptor canvas diff --image            Return diff visualization

Stream Capture:
  interceptor capture start                  Begin tabCapture stream
  interceptor capture frame                  Get current frame
  interceptor capture stop                   Stop capture

Batch:
  interceptor batch '<json_array>'           Execute multiple actions in one call
  interceptor batch '...' --stop-on-error    Halt on first failure
  interceptor batch '...' --timeout 30000    Batch timeout in ms
  interceptor wait-stable                    Wait for DOM stability (200ms default)
  interceptor wait-stable --ms 500           Custom debounce duration
  interceptor wait-stable --timeout 3000     Custom hard timeout

Scene Graph (Rich Editors):
  interceptor scene profile                    Detect the active editor strategy/profile
  interceptor scene profile --verbose          Include active capabilities and strategy details
  interceptor scene list                       List scene objects on the current editor surface
  interceptor scene list --type shape          Filter by type (image|shape|text|page|embed|slide)
  interceptor scene click <id>                 Click a scene object by its scene id
  interceptor scene dblclick <id>              Double-click a scene object
  interceptor scene select <id>                Click + verify selection change
  interceptor scene hit <x> <y>                Identify the scene object at viewport coordinates
  interceptor scene selected                   Read current selection (host-aware)
  interceptor scene text                       Read text from the active editor surface when supported
  interceptor scene text --with-html           Include inline HTML when supported
  interceptor scene insert "<text>"            Insert text into the focused editor-owned writable surface
  interceptor scene cursor-to <x> <y>          Move cursor to viewport coordinates
  interceptor scene slide list                 List all slides in a Google Slides deck
  interceptor scene slide current              Show the currently-displayed slide
  interceptor scene slide goto <index>         Navigate to slide N (0-indexed)
  interceptor scene notes [--slide N]          Read speaker notes for a slide
  interceptor scene render <id> [--save]       Render a scene object as PNG
  interceptor scene zoom                       Read current editor zoom factor
  interceptor scene ... --profile <name>       Force a profile (bypasses detection)

Recording (Session Monitor):
  interceptor monitor start ["<instruction>"]   Start recording user actions on active tab
    --instruction "..."                  Annotate with task intent for replay
  interceptor monitor stop                      End recording and emit summary
  interceptor monitor pause                     Stop emitting events without ending session
  interceptor monitor resume                    Resume an active paused session
  interceptor monitor status [--all]            Show status of current/all monitor sessions
  interceptor monitor list                      List all sessions in the event log
  interceptor monitor tail [--raw] [--current]  Live tail current session (pretty by default)
  interceptor monitor export <sessionId>        Render a session as aligned text
    --json                               Raw JSONL for the session
    --plan                               Emit a 'interceptor ...' replay script
    --with-bodies                        (P1) Merge cached response bodies

ChatGPT Agentic Bridge:
  interceptor chatgpt send "<prompt>"           Send a message, read response
    --stream                             Print tokens as they stream
  interceptor chatgpt read                      Read current conversation from DOM
  interceptor chatgpt status                    Show streaming state and model
  interceptor chatgpt conversations             List recent conversations
  interceptor chatgpt switch <conversation-id>  Navigate to conversation
  interceptor chatgpt model [name]              Read or change the active model
  interceptor chatgpt stop                      Stop current generation

Meta:
  interceptor status                         Check daemon status (local — no connection needed)
  interceptor help                           This help text

Flags:
  --json                              Output as JSON`
