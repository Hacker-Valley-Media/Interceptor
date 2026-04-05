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
  slop canvas list                    Discover canvas elements
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

Meta:
  slop status                         Check daemon status (local — no connection needed)
  slop help                           This help text

Flags:
  --json                              Output as JSON`
