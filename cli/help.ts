export const HELP = `slop — browser control CLI

State:
  slop state                          Current page DOM tree + metadata
  slop state --full                   Include static text content
  slop tree                           Semantic accessibility tree
  slop tree --filter all              Include landmarks + headings
  slop tree --depth N --max-chars N   Limit depth and output size
  slop diff                           Changes since last state/tree read
  slop find "query"                   Find elements by name
  slop find "query" --role button     Filter by role
  slop text                           All visible text
  slop text <index|ref>               Text from specific element
  slop html <index|ref>               HTML of specific element

Actions:
  slop click <index|ref>              Click element (e.g. slop click e5)
  slop click <index> --at X,Y        Click at coordinates on element
  slop dblclick <index> --at X,Y     Double-click at coordinates
  slop rightclick <index> --at X,Y   Right-click at coordinates
  slop type <index|ref> <text>        Type into element (clears first)
  slop type <index|ref> <text> --append  Type without clearing
  slop type "role:name" <text>        Type using semantic selector
  slop select <index|ref> <value>     Select dropdown option
  slop focus <index|ref>              Focus element
  slop hover <index|ref>              Hover over element
  slop hover <index> --from X,Y      Hover with mouse path
  slop drag <index> --from X,Y --to X,Y  Drag gesture on element
  slop drag <index> ... --steps 20   Number of intermediate moves
  slop drag <index> ... --duration 500  Spread over milliseconds
  slop keys <combo>                   Keyboard shortcut (e.g. "Control+A")

Navigation:
  slop navigate <url>                 Go to URL
  slop back                           History back
  slop forward                        History forward
  slop scroll <up|down|top|bottom>    Scroll page
  slop wait <ms>                      Wait milliseconds

Tabs:
  slop tabs                           List all tabs
  slop tab new [url]                  Open new tab
  slop tab close [id]                 Close tab
  slop tab switch <id>                Switch to tab

Capture:
  slop screenshot                     Viewport screenshot (returns data URL)
  slop screenshot --save              Also save to disk
  slop screenshot --format png        PNG format (default: jpeg)
  slop screenshot --quality 80        JPEG quality 0-100 (default: 50)
  slop screenshot --full              Full-page scroll+stitch capture
  slop screenshot --clip X,Y,W,H     Capture region
  slop screenshot --element N         Capture element bounding rect
  slop eval <code>                    Run JS in isolated world
  slop eval <code> --main             Run JS in page context

Cookies:
  slop cookies <domain>               List cookies
  slop cookies set <json>             Set cookie
  slop cookies delete <url> <name>    Delete cookie

Network (CDP — explicit opt-in):
  slop network on [patterns...]       Start intercepting (attaches debugger)
  slop network off                    Stop intercepting
  slop network log                    Print captured requests (CDP)
  slop network override on '<json>'   Rewrite matching requests before they leave the browser
  slop network override off           Disable request rewriting

Passive Network (always-on, no CDP):
  slop net log                        Passively captured fetch/XHR traffic
  slop net log --filter <pattern>     Filter by URL substring
  slop net log --since <timestamp>    Entries after timestamp
  slop net log --limit <n>            Max entries (default 100)
  slop net clear                      Flush passive capture buffer
  slop net headers                    Show captured request headers (CSRF, auth)
  slop net headers --filter <pattern> Filter headers by URL

LinkedIn:
  slop linkedin event [url]           Extract LinkedIn event + post data via network and DOM validation
  slop linkedin attendees [url]       Extract LinkedIn event attendees with request override, batching, and enrichment

Headers:
  slop headers add <name> <value>     Add request header
  slop headers remove <name>          Remove header rule
  slop headers clear                  Clear all rules

Canvas:
  slop canvas list                    Discover <canvas> elements
  slop canvas read N                  Read canvas as data URL
  slop canvas read N --format png     PNG format
  slop canvas read N --region X,Y,W,H  Read pixel region
  slop canvas read N --webgl          WebGL canvas readPixels
  slop canvas diff <url1> <url2>      Pixel diff between images
  slop canvas diff --threshold 10     Per-channel tolerance
  slop canvas diff --image            Return diff visualization

Stream Capture:
  slop capture start                  Begin tabCapture stream
  slop capture frame                  Get current frame
  slop capture stop                   Stop capture

Batch:
  slop batch '<json_array>'           Execute multiple actions in one call
  slop batch '...' --stop-on-error    Halt on first failure
  slop batch '...' --timeout 30000    Batch timeout in ms
  slop wait-stable                    Wait for DOM stability (200ms default)
  slop wait-stable --ms 500           Custom debounce duration
  slop wait-stable --timeout 3000     Custom hard timeout

Scene Graph (Canva, Google Docs, Google Slides):
  slop scene profile                    Detect active editor profile (canva/google-docs/google-slides/generic)
  slop scene profile --verbose          Include the list of supported capabilities
  slop scene list                       List scene objects on current editor
  slop scene list --type shape          Filter by type (image|shape|text|page|embed|slide)
  slop scene click <id>                 Click a scene object by its stable id
  slop scene dblclick <id>              Double-click a scene object
  slop scene select <id>                Click + verify selection change
  slop scene hit <x> <y>                Identify the scene object at viewport coordinates
  slop scene selected                   Read current selection (host-aware)
  slop scene text                       Read document text (Google Docs)
  slop scene text --with-html           Include inline HTML + data-ri offsets
  slop scene insert "<text>"            Insert text at cursor (Google Docs)
  slop scene cursor-to <x> <y>          Move cursor to viewport coordinates
  slop scene slide list                 List all slides in a Google Slides deck
  slop scene slide current              Show the currently-displayed slide
  slop scene slide goto <index>         Navigate to slide N (0-indexed)
  slop scene notes [--slide N]          Read speaker notes for a slide
  slop scene render <id> [--save]       Render a scene object as PNG
  slop scene zoom                       Read current editor zoom factor
  slop scene ... --profile <name>       Force a profile (bypasses detection)

Recording (Session Monitor):
  slop monitor start ["<instruction>"]   Start recording user actions on active tab
    --instruction "..."                  Annotate with task intent for replay
  slop monitor stop                      End recording and emit summary
  slop monitor pause                     Stop emitting events without ending session
  slop monitor resume                    Resume an active paused session
  slop monitor status [--all]            Show status of current/all monitor sessions
  slop monitor list                      List all sessions in the event log
  slop monitor tail [--raw] [--current]  Live tail current session (pretty by default)
  slop monitor export <sessionId>        Render a session as aligned text
    --json                               Raw JSONL for the session
    --plan                               Emit a 'slop ...' replay script
    --with-bodies                        (P1) Merge cached response bodies

Meta:
  slop status                         Check daemon status (local — no connection needed)
  slop help                           This help text

Flags:
  --json                              Output as JSON`
