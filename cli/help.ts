// Per-command help — extracted from the HELP string below by matching lines
// that begin with "  interceptor <cmd> ". User types `interceptor <cmd> --help`
// (or `-h`) and gets exactly the slice for that command.
export function helpForCommand(cmd: string): string | null {
  const lines = HELP.split("\n")
  const matched: string[] = []
  for (const line of lines) {
    const m = line.match(/^\s+interceptor\s+(\S+)\b/)
    if (m && m[1] === cmd) {
      matched.push(line)
    }
  }
  if (!matched.length) return null
  return [
    `interceptor ${cmd} — usage`,
    "",
    ...matched,
    "",
    `Run 'interceptor help' for the full command list, or 'interceptor ${cmd} -h' is an alias for --help.`,
  ].join("\n")
}

export const HELP = `interceptor — browser control CLI

Flags:
  -V, --version                       Print version, build SHA, and build date
  --json                              Output as JSON
  --context <id>                      Target a specific browser context (see: interceptor contexts)

Compound (agent-optimized):
  interceptor open <url>                     Open URL in a background tab (default), wait, return tree + text
  interceptor open <url> --activate          Foreground the new tab (explicit opt-in; background-first contract)
  interceptor open <url> --tree-only         Skip text, return only tree
  interceptor open <url> --text-only         Skip tree, return only text
  interceptor open <url> --full              Full text instead of 2000-char summary
  interceptor open <url> --timeout <ms>      Override wait-stable timeout (default 5000)
  interceptor open <url> --no-wait           Return immediately after tab creation
  interceptor open <url> --reuse             Navigate the most recent Interceptor-group tab instead of opening a new one (cleans up long automation runs)
  interceptor open <url> --reuse --activate  Navigate the reused tab and bring it to the foreground
  interceptor read                           Tree + text for active tab
  interceptor read <ref>                     Tree + text for element subtree
  interceptor read --tree-only               Skip text
  interceptor read --text-only               Skip tree
  interceptor read --markdown                Render page text as markdown (preserves headings/bold/lists/tables)
  interceptor read --include-style           Inline computed styles per element
  interceptor read --include-frames          Walk all reachable frames (non-top refs are e<frameId>_<n>)
  interceptor read --tree-format compact     Compact tree (>-depth + [ref|role|name|attr=val]); agent context economy
  interceptor read --tree-format verbose     Indented legacy tree (default; humans prefer this)
  interceptor style inject --css "<rules>"  Inject a stylesheet; returns a handle (all frames by default)
  interceptor style inject --css "<rules>" --top-only   Inject only into the top frame
  interceptor style remove <handle>          Remove a previously injected stylesheet
  interceptor act <ref>                      Click + wait + return updated tree + diff
  interceptor act <ref> "value"              Type into field + wait + return updated tree
  interceptor act <ref> --trusted            Use HID-sourced trusted input (page sees isTrusted: true)
  interceptor act <ref> --keys "Enter"       Send keyboard shortcut instead
  interceptor act <ref> --no-read            Skip post-action tree read
  interceptor inspect                        Tree + text + network log + headers
  interceptor inspect --net-only             Skip tree/text, return only network data

Research (deep-research mode — local, no daemon, no browser):
  interceptor research                       Print the one-screen deep-research playbook + rubric
  interceptor research --full                Print the extended playbook + verb cookbook
  interceptor research init <slug>           Scaffold a source ledger (links.json, insights.md, sources/)
  interceptor research init <slug> --effort quick|standard|exhaustive   Set the breadth floor (8 / 20 / 40)
  interceptor research add <url> --note "..."  Append a lead to the ledger
  interceptor research note "<insight>"      Append a running insight
  interceptor research status [<slug>]       Rubric readout: sources vs floor, domains, saturation, verdict

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
  interceptor text --markdown                All visible text rendered as markdown
  interceptor text <ref> --markdown          Element text rendered as markdown
  interceptor html <index|ref>               HTML of specific element

Actions:
  interceptor click <index|ref>              Click element (e.g. interceptor click e5)
  interceptor click <index> --at X,Y        Click at coordinates on element
  interceptor dblclick <index> --at X,Y     Double-click at coordinates
  interceptor rightclick <index> --at X,Y   Right-click at coordinates
  interceptor type <index|ref> <text>        Type into element (clears first)
  interceptor type <index|ref> <text> --append  Type without clearing
  interceptor type "role:name" <text>        Type using semantic selector (e.g. "button:Submit")
  interceptor click "text:<query>"            Click first element whose textContent matches (e.g. "text:Save")
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
  interceptor tab new [url]                  Open new tab in background (default)
  interceptor tab new [url] --activate       Open new tab and foreground it (explicit opt-in)
  interceptor tab close [id]                 Close tab
  interceptor tab switch <id>                Switch to tab (explicit focus move)

Capture:
  interceptor screenshot                     Full-page DOM-render screenshot (default — works without focus)
  interceptor screenshot --selector "h1"    Capture only the matching element
  interceptor screenshot --element N         Capture element by ref (off-screen elements supported)
  interceptor screenshot --region X,Y,W,H   Capture page region (rendered + cropped)
  interceptor screenshot --scale 2           Override pixel ratio (e.g. retina from 1x display)
  interceptor screenshot --pixel             Pixel-true compositor capture (legacy captureVisibleTab — requires Chrome focused)
  interceptor screenshot --save              Save to disk; result has filePath, no dataUrl
  interceptor screenshot --format png        Output format: png (default), jpeg, or webp
  interceptor screenshot --quality 80        Encode quality 0-100 (defaults: png 92, jpeg 92, webp 85)
  interceptor screenshot --target-max-long-edge 1568   Clamp output long edge in pixels (auto-resize at capture)
  interceptor screenshot --clip X,Y,W,H     [deprecated alias for --region]
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
  interceptor net monitor on [--reload]      Arm WebSocket/Beacon/BroadcastChannel capture
  interceptor net monitor off                Disable dynamic page-communication capture
  interceptor net monitor status             Show dynamic capture config
  interceptor net page-comm log              Captured WebSocket/Beacon/BroadcastChannel events
  interceptor net page-comm log --type ws    Filter by ws|beacon|broadcast
  interceptor net page-comm clear            Flush page-communication buffer
  interceptor net headers                    Show captured request headers (CSRF, auth)
  interceptor net headers --filter <pattern> Filter headers by URL

SSE Stream Capture:
  interceptor sse log [--filter <pattern>] [--limit N]   Show completed SSE streams
  interceptor sse streams                                  List active SSE streams
  interceptor sse tail [--filter <pattern>]                Live tail SSE stream chunks

Headers:
  interceptor headers add <name> <value>     Add request header
  interceptor headers remove <name>          Remove header rule
  interceptor headers clear                  Clear all rules

Canvas:
  interceptor canvas list                    Discover <canvas> elements
  interceptor canvas status                  Summary of canvases, host signals, and observer state
  interceptor canvas log [N]                 Read captured canvas operations (optionally for canvas N)
  interceptor canvas log --kind fillText     Filter log by kind (comma-separated)
  interceptor canvas objects [N]             Read derived canvas objects (optionally for canvas N)
  interceptor canvas objects --kind text     Filter derived objects by kind
  interceptor canvas model                   Inspect host-state and app-model signals
  interceptor canvas routes                  Inspect candidate first-party canvas-related routes
  interceptor canvas ocr N                   OCR text from canvas N
  interceptor canvas ocr N --region X,Y,W,H  OCR a canvas crop
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
    --task "..."                         Create/attach a task-scoped monitor envelope
    --mode human-observe|human-teach|agent-record|mixed
  interceptor monitor stop                      End recording and emit summary
  interceptor monitor stop --task <taskId>      Stop a task envelope, preserving source artifacts
  interceptor monitor pause                     Stop emitting events without ending session
  interceptor monitor resume                    Resume an active paused session
  interceptor monitor status [--all]            Show status of current/all monitor sessions
  interceptor monitor status --task <taskId>    Show task envelope status
  interceptor monitor task attach <taskId> <sid> Attach an existing source session
  interceptor monitor task snapshot <taskId>    Snapshot source artifacts under the task root
  interceptor monitor task quality <taskId>     Show task capture readiness gates
  interceptor monitor task compile-blueprint <taskId>  Enforce blueprint-readiness gate
  interceptor monitor list                      List all sessions in the event log
  interceptor monitor tail [--raw] [--current]  Live tail current session (pretty by default)
  interceptor monitor export <sessionId>        Render a session as aligned text
  interceptor monitor export --task <taskId>    Render task JSON/timeline/transcript/segments/quality
    --json                               Raw JSONL for the session
    --plan                               Emit a 'interceptor ...' replay script
    --with-bodies                        (P1) Merge cached response bodies

Meta:
  interceptor contexts                       List IDs of all connected browser contexts (use with --context)
  interceptor init                           First-run preflight: verify daemon, bridge, and extension are reachable
  interceptor init --verbose                 Same as 'init', plus a per-component reachability breakdown
  interceptor status                         Check daemon status (local — no connection needed)
  interceptor status --verbose               Daemon + bridge + extension probe with per-component diagnostics
  interceptor status --explain               Alias for --verbose with extra rationale per component
  interceptor help                           This help text

macOS App Internals:
  interceptor macos cdp connect <port> [--host H] [--app NAME] [--url HINT]
                                             Attach to an Electron/Chromium app debug port
  interceptor macos cdp discover             List running Electron/Chromium apps + CDP/debug-port status
  interceptor macos cdp launch <app> [--port N] --confirm
                                             Quit + relaunch with --remote-debugging-port (loses unsaved state)
  interceptor macos cdp targets|attach|detach|status|raw ...
                                             Manage cdp:<id> contexts
  interceptor macos cdp app discover         List Electron apps + extension attach state
  interceptor macos cdp app attach <app> [--pid N] [--inspect-port N] [--allow-sigusr1]
                                             SIGUSR1 + loadExtension path, registering app:<name>
  interceptor macos cdp app detach|status ... Manage app:<name> extension contexts
  interceptor macos runtime discover|enable|disable|status|signid
                                             Manage in-process runtime agents for runtime:<app> contexts
  interceptor macos runtime tree|read|eval|mutate|intercept|screenshot ...
                                             Drive an enabled runtime:<app> context

macOS Bridge (full install only):
  Background-first by contract (mirrors the browser surface in 'Tabs' and 'open' above):
  the only verbs that move the user's frontmost window or active tab are
  'macos app activate', 'macos open --activate', 'open --activate',
  'tab new --activate', 'tab switch <id>', and 'window focus <id>'.
  Every other 'macos *' verb and every routine 'open'/'tab new' leaves focus alone.

  Compound (agent-optimized):
  interceptor macos open <app>               Tree + windows + app info (no foregrounding)
  interceptor macos open <app> --activate    Explicit foregrounding opt-in
  interceptor macos read [--app <name>]      Tree + frontmost app info
  interceptor macos act <ref>                Click ref via AX press → no focus change
  interceptor macos act <ref> "<text>"       Type via AX value-set → no focus change
  interceptor macos inspect [--app <name>]   Tree + apps snapshot + frontmost info
  interceptor macos inspect <ref>            Full attributes for a ref

  Accessibility (AX):
  interceptor macos tree [--app <name>]      AX tree for app (or frontmost)
  interceptor macos tree --filter interactive|all   Filter (default interactive)
  interceptor macos tree --depth N --max-chars N    Limit depth and output size
  interceptor macos find "<query>" [--role button] [--app <name>]
  interceptor macos value <ref> ["<text>"]   Read or set element value
  interceptor macos action <ref> press|increment|decrement|...
  interceptor macos focused [--app <name>]   Currently focused element
  interceptor macos windows [--app <name>]   All windows with frames
  interceptor macos move <ref> --x N --y N
  interceptor macos resize <ref> --width N --height N

  Input (AX-first, PID-routed CGEvent fallback):
    Refs route through AX. --app/--pid route via CGEvent.postToPid (no focus change).
    Bare coordinates fall back to system HID tap (legacy: follows frontmost).
  interceptor macos click <ref>              AX press
  interceptor macos click X,Y --app <name>   Coordinate click via postToPid
  interceptor macos click X,Y                Coordinate click via system HID (legacy)
  interceptor macos click <ref> --double|--right
  interceptor macos type <ref> "<text>"      AX value-set on text-bearing role
  interceptor macos type "<text>" --app <name>   Type via postToPid keys
  interceptor macos keys "Meta+A" [--app <name>|--pid N]
  interceptor macos scroll up|down|left|right N [--app <name>] [--times N] [--interval-ms N]
  interceptor macos drag <fromRef> <toRef> [--app <name>]
  interceptor macos drag X1,Y1 X2,Y2 [--app <name>]

  Apps & Windows:
  interceptor macos apps                     List running apps with PIDs
  interceptor macos app activate <name>      Foreground an app (explicit opt-in)
  interceptor macos app hide|unhide|quit <name>
  interceptor macos app launch <bundleId>    Launch by bundle id (background-first)
  interceptor macos frontmost                Currently frontmost app

  Menu Traversal:
  interceptor macos menu [--app <name>]                   List menu bar
  interceptor macos menu "Window" "Bring All to Front"    Invoke menu path

  Capture (works on occluded / minimized / cross-Space windows):
  interceptor macos screenshot [--app <name>] [--display N] [--save] [--format jpeg|png|webp]
  interceptor macos screenshot --target-max-long-edge 1568   Resize at capture
  interceptor macos screenshot --mode display              Full-screen
  interceptor macos screenshot --save                      Result payload key is "filePath" (not "path")
  interceptor macos capture start [--app <name>]
  interceptor macos capture frame [--timeout-ms 3000]      Block briefly for first frame; default 3000ms
  interceptor macos capture stop

  Scripts and Apple Events (cross-app routing without raising):
  interceptor macos script run --jxa '<jxa>'
  interceptor macos script run --jxa '<jxa>' --args '["a","b"]'
  interceptor macos script run --bundle <id> --jxa '<jxa>'
  interceptor macos script run --jsc '<javascript-core>'
  interceptor macos script run --jsc 'run = argv => argv.join("|")' --args '["a","b"]'
  interceptor macos script run --jsc 'host.sqlite("/tmp/example.sqlite", "select 1")' --jsc-host sqlite
  interceptor macos script run --jsc 'host.sh("pwd").stdout' --jsc-host shell
  interceptor macos script run --script '<applescript>'
  interceptor macos intent dispatch --bundle <id> --script '<applescript>'
  interceptor macos intent dispatch --bundle <id> --jxa '<jxa>'
  interceptor macos intent warmup <bundleId>...
  Note: --javascript is deprecated and aliases --jxa.

  System & Filesystem:
  interceptor macos clipboard read|write|tail
  interceptor macos notifications tail [--app <name>] [--limit N]
  interceptor macos notifications log [--app <pat>] [--limit N]   Buffered distributed notifications
  interceptor macos files recent [--filter <pat>] [--limit N]
  interceptor macos files watch <path> [--filter <pat>]            Emit file_change events for path
  interceptor macos files open                                     lsof-derived list of open files under $HOME
  interceptor macos fs read|write|search <path|query>
  interceptor macos url get|post <url> [--header "K: V"] [--body <data>]
  interceptor macos log query --predicate '...' [--since <ts>] [--limit N]

  Audio / Speech / Vision / NLP / AI:
  interceptor macos listen status|start|stop [--device <name>]
  interceptor macos vad status|start|stop
  interceptor macos sounds status|start|stop [--filter <pat>]
  interceptor macos audio output|input start|stop [--app <name>] [--save]
  interceptor macos vision text|faces|hands|bodies [--app <name>]
  interceptor macos nlp entities|language|sentiment|tokens "<text>"
  interceptor macos nlp similar "<word1>" "<word2>"
  interceptor macos ai status|prompt "<prompt>"

  Recording & Replay:
  interceptor macos monitor start [--instruction "<intent>"]
                                  [--task "<task|taskId>"] [--mode human-observe|human-teach|agent-record|mixed]
                                  [--app <name>|<bundleId>] [--apps a,b,c] [--all-apps]
                                  [--include input|files|clipboard|network|notifications|log|speech]
                                  [--exclude key|mouse-moved]
                                  [--frames <fps>] [--vision-text]
                                  [--frame-format jpeg|png|webp]   # default jpeg
                                  [--frame-quality 0..100]         # default 80
                                  [--frame-max-long-edge <px>]     # resize at capture
                                  [--tap]                          # CGEventTap fallback
                                  [--watch-path <path>] [--watch-paths p1,p2,...]
                                  [--log-predicate "<NSPredicate format>"]
  interceptor macos monitor stop | pause | resume | status [--sid <sid>]
  interceptor macos monitor tail [--sid <sid>] [--limit N] [--raw]
  interceptor macos monitor list
  interceptor macos monitor export <sid> [--plan|--json] [--limit N]
                                  Permissions: Accessibility always required;
                                               --frames adds Screen Recording;
                                               --include speech adds Microphone.
                                  Multi-session: N concurrent sessions supported;
                                               disambiguate with --sid <sid> on
                                               stop/pause/resume/status/tail.

  Display / Stream / Container / Overlays:
  interceptor macos display list|set <resolution> [--id N] [--hidpi] [--hz N]
  interceptor macos stream start|status|stop [--sid N] [--app <name>] [--virtual <res>]
  interceptor macos container run <image> [--cmd "..."] [--env K=V] [--volume host:container[:mode]]
  interceptor macos overlay start|stop|list|status|eval|ctl|verbs

  Trust & Permissions (status vocabulary: granted | denied | not_determined | restricted):
  interceptor macos trust                    Permission snapshot. Top-level fields
                                             accessibility / screenRecording / microphone
                                             are status strings; permissions[] carries the
                                             same status plus 'limitation' on AX / Screen.
  interceptor macos trust --no-prompt        Force read-only — overrides every prompt flag.
  interceptor macos trust --prompt           Fire all three TCC prompts (non-blocking — Mic
                                             returns 'not_determined' + pending_user_action
                                             until user answers; re-poll trust to observe).
  interceptor macos trust --walkthrough      Prompt all three + open the next missing pane.
  interceptor macos trust --accessibility-prompt   Prompt only Accessibility (returns Bool only;
                                                   not_determined unobservable per Apple API).
  interceptor macos trust --screen-prompt    Prompt only Screen Recording (same Apple constraint).
  interceptor macos trust --microphone-prompt   Prompt only Microphone (only surface where Apple
                                                exposes notDetermined / restricted).

  Personal data, distribution, and document domains:

  Documents (no TCC):
  interceptor macos pdf info|text|outline|annotations|forms|images|find|attributes|permissions|annotate|strip|merge|split <path>
  interceptor macos pdf forms set <path> --field <name> --value <string> [--out <out>]
  interceptor macos pdf find <path> "<query>" [--case-sensitive]
  interceptor macos pdf merge <p1> <p2> ... --out <out>
  interceptor macos pdf split <path> --pages <range> --out <out>
  interceptor macos detect types | run "<text>" | file <path>            (NSDataDetector + DDMatch* on macOS 12+)
  interceptor macos detect run "<text>" [--types link,phone,address,email,calendarEvent,money,flight,shipping]
  interceptor macos translate status|languages|availability|prepare|text|batch|file|stop    (Translation, macOS 15+)
  interceptor macos translate text "<text>" --from <bcp47> --to <bcp47>
  interceptor macos thumbnail <path> [--size N|WxH] [--scale N] [--types icon,thumbnail,lowQuality] [--save] [--out <path>] [--format png|jpeg|heic]
  interceptor macos thumbnail batch <p1> <p2> ... [--size N]

  Personal data (TCC-gated):
  interceptor macos auth status|confirm|invalidate|domain-state                   (LocalAuthentication)
  interceptor macos auth confirm "<reason>" [--policy biometry|any|biometry-or-watch] [--reuse <seconds>]
  interceptor macos calendar status|request|list|default|sources|create-calendar|delete-calendar|events|event|create|update|delete|move|refresh-sources|reset|tail   (EventKit events)
  interceptor macos calendar create --title "..." --start <ISO8601> --end <ISO8601> [--calendar <id>] [--all-day] [--alarm <offset|absolute>]
  interceptor macos reminders status|request|lists|default|all|incomplete|completed|create|update|complete|uncomplete|delete   (EventKit reminders)
  interceptor macos contacts status|request|containers|groups|list|contact|me|find|create|update|delete|vcard|import-vcard|current-token|changes
  interceptor macos contacts find "<query>" | --email <addr> | --phone <num>
  interceptor macos photos status|request|albums|album|assets|asset|export|export-video|export-live|thumbnail|favorite|hide|delete|add-to-album|remove-from-album|import|import-video|current-token|changes
  interceptor macos location status|request|request-temporary-accuracy|current|monitor|significant|visits|heading|geocode|reverse|distance|postal-geocode
  interceptor macos location current                                              (one-shot CLLocationManager.requestLocation)
  interceptor macos location reverse <lat,lng>
  interceptor macos music status|request|subscription|search|search-suggest|charts|recommendations|library|library-search|song|album|artist|playlist|play|pause|resume|stop|next|previous|seek|queue|repeat|shuffle|now-playing
  interceptor macos music search "<term>" [--types song,album,artist,playlist,curator,genre]
  interceptor macos music library --type song|album|artist|playlist|track [--filter ...] [--sort ...]

  Distribution:
  interceptor macos appintent list|registered|donate|update-parameters|supports   (AppIntents — macOS 13+)
  interceptor macos maps search "<query>" [--region lat,lng,latSpan,lngSpan] [--types address,pointOfInterest,physicalFeature]
  interceptor macos maps directions --from "<addr>" --to "<addr>" [--transport auto|walking|transit|any]
  interceptor macos maps eta --from "<addr>" --to "<addr>"
  interceptor macos share services [--for <path>]
  interceptor macos share airdrop <path> [--recipient "<handle>"]
  interceptor macos share email <path> [--to a@x,b@y] [--subject "..."] [--body "..."]
  interceptor macos share message <path> [--to <handle>] [--body "..."]
  interceptor macos share named <service-name> <path>

  Notifications (UN extension to existing notifications domain):
  interceptor macos notifications status|request|settings|post|schedule-after|schedule-at|schedule-cron|cancel|cancel-all|pending|delivered|dismiss|dismiss-all
  interceptor macos notifications post --title "..." --body "..." [--sound default] [--badge N] [--category <id>]
  interceptor macos notifications categories list|register|clear`
