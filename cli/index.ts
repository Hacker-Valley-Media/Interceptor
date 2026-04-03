import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { IS_WIN, SOCKET_PATH, PID_PATH, WS_PORT, connectOptions, transportLabel } from "../shared/platform"


const SLOP_TIMEOUT_MS = parseInt(process.env.SLOP_TIMEOUT || "15000")

function sendCommand(action: { type: string; [key: string]: unknown }, tabId?: number): Promise<{ id: string; result: { success: boolean; error?: string; data?: unknown; tabId?: number } }> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const shortId = id.slice(0, 8)
    process.stderr.write(`[${shortId}] → ${action.type}\n`)
    let buffer = Buffer.alloc(0)
    let resolved = false
    let socketRef: ReturnType<Awaited<ReturnType<typeof Bun.connect>>> | null = null

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        if (socketRef) try { socketRef.end() } catch {}
        reject(new Error("timeout: no response from daemon after " + (SLOP_TIMEOUT_MS / 1000) + "s. Check extension connection with 'slop status'."))
      }
    }, SLOP_TIMEOUT_MS)

    Bun.connect(connectOptions({
      open(socket) {
        socketRef = socket
        const payload = JSON.stringify({ id, action, ...(tabId !== undefined && { tabId }) })
        const encoded = Buffer.from(payload, "utf-8")
        const header = Buffer.alloc(4)
        header.writeUInt32LE(encoded.byteLength, 0)
        socket.write(Buffer.concat([header, encoded]))
      },
      data(socket, raw) {
        buffer = Buffer.concat([buffer, Buffer.from(raw)])
        if (buffer.length >= 4) {
          const msgLen = buffer.readUInt32LE(0)
          if (msgLen > 0 && msgLen <= 1024 * 1024 && buffer.length >= 4 + msgLen) {
            const json = buffer.subarray(4, 4 + msgLen).toString("utf-8")
            clearTimeout(timer)
            try {
              resolved = true
              resolve(JSON.parse(json))
            } catch {
              resolved = true
              reject(new Error("invalid response from daemon"))
            }
            socket.end()
          }
        }
      },
      close() {
        clearTimeout(timer)
        if (!resolved) {
          reject(new Error("connection closed before response"))
        }
      },
      connectError(_socket, _err) {
        clearTimeout(timer)
        reject(new Error("daemon not running. Open Chrome with the slop-browser extension loaded."))
      },
      error(_socket, err) {
        clearTimeout(timer)
        reject(err)
      }
    }))
  })
}

function sendCommandWs(action: { type: string; [key: string]: unknown }, tabId?: number): Promise<{ id: string; result: { success: boolean; error?: string; data?: unknown; tabId?: number } }> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const shortId = id.slice(0, 8)
    process.stderr.write(`[${shortId}] →ws ${action.type}\n`)

    const timer = setTimeout(() => {
      reject(new Error("timeout: no response from daemon after " + (SLOP_TIMEOUT_MS / 1000) + "s via WebSocket."))
    }, SLOP_TIMEOUT_MS)

    const ws = new WebSocket(`ws://localhost:${WS_PORT}`)
    ws.onopen = () => {
      ws.send(JSON.stringify({ id, action, ...(tabId !== undefined && { tabId }) }))
    }
    ws.onmessage = (event) => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(typeof event.data === "string" ? event.data : ""))
      } catch {
        reject(new Error("invalid response from daemon via WebSocket"))
      }
      ws.close()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error("WebSocket connection failed to daemon"))
    }
    ws.onclose = () => {
      clearTimeout(timer)
    }
  })
}

function formatState(data: { url: string; title: string; elementTree: string; focused?: string; staticText?: string; scrollPosition: { y: number; height: number; viewportHeight: number }; tabId: number }) {
  const scroll = data.scrollPosition
  let out = `url: ${data.url}\ntitle: ${data.title}\nscroll: ${scroll.y}/${scroll.height} (vh:${scroll.viewportHeight})\ntab: ${data.tabId}\nfocused: ${data.focused || "none"}\n\n${data.elementTree}`
  if (data.staticText) {
    out += `\n---\n${data.staticText}`
  }
  return out
}

function formatTabs(tabs: { id: number; url: string; title: string; active: boolean }[]) {
  return tabs.map(t => `${t.active ? "*" : " "} ${t.id}  ${t.url}  ${t.title}`).join("\n")
}

function formatCookies(cookies: { name: string; value: string; domain: string; path: string }[]) {
  return cookies.map(c => `${c.domain}${c.path}  ${c.name}=${c.value}`).join("\n")
}

function formatResult(result: { success: boolean; error?: string; data?: unknown }, jsonMode: boolean): string {
  if (jsonMode) return JSON.stringify(result, null, 2)

  if (!result.success) return `error: ${result.error}`
  if (result.data === undefined || result.data === null) return "ok"
  if (typeof result.data === "string") return result.data
  if (typeof result.data === "number" || typeof result.data === "boolean") return String(result.data)
  return JSON.stringify(result.data, null, 2)
}

const HELP = `slop — browser control CLI

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

Network:
  slop network on [patterns...]       Start intercepting
  slop network off                    Stop intercepting
  slop network log                    Print captured requests
  slop network override on '<json>'   Rewrite matching requests before they leave the browser
  slop network override off           Disable request rewriting

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
  slop status                         Daemon connection info
  slop help                           This help text

Flags:
  --json                              Output as JSON`

async function main() {
  const args = process.argv.slice(2)
  const jsonMode = args.includes("--json")
  const useWs = args.includes("--ws")
  const anyTab = args.includes("--any-tab")
  const globalTabId = parseTabFlag(args)
  const tabIdx = args.indexOf("--tab")
  const tabFilterSet = new Set(["--json", "--ws", "--any-tab"])
  if (tabIdx !== -1) { tabFilterSet.add("--tab"); if (args[tabIdx + 1]) tabFilterSet.add(args[tabIdx + 1]) }
  const filtered = args.filter(a => !tabFilterSet.has(a))

  if (filtered.length === 0 || filtered[0] === "help") {
    console.log(HELP)
    return
  }

  if (!useWs) {
    if (!IS_WIN && !existsSync(SOCKET_PATH)) {
      console.error("error: daemon not running. Open Chrome with the slop-browser extension loaded.")
      process.exit(1)
    }

    if (existsSync(PID_PATH)) {
      try {
        const pidContent = readFileSync(PID_PATH, "utf-8").trim()
        const pid = parseInt(pidContent.split("\n")[0])
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 0)
          } catch {
            if (!IS_WIN) {
              try { unlinkSync(SOCKET_PATH) } catch {}
            }
            try { unlinkSync(PID_PATH) } catch {}
            console.error("error: daemon not running (stale transport cleaned up). Open Chrome with the slop-browser extension loaded.")
            process.exit(1)
          }
        }
      } catch {}
    } else if (!IS_WIN && existsSync(SOCKET_PATH)) {
      try { unlinkSync(SOCKET_PATH) } catch {}
      console.error("error: daemon not running (stale socket cleaned up). Open Chrome with the slop-browser extension loaded.")
      process.exit(1)
    } else if (IS_WIN) {
      console.error(`error: daemon not running (${transportLabel()}). Open Chrome with the slop-browser extension loaded.`)
      process.exit(1)
    }
  }

  const cmd = filtered[0]
  let action: { type: string; [key: string]: unknown }

  switch (cmd) {
    case "state":
      action = { type: "get_state", full: filtered.includes("--full"), tabId: parseTabFlag(filtered) }
      break

    case "click": {
      const useOs = filtered.includes("--os")
      const target = parseElementTarget(filtered[1])
      if (useOs) {
        const clickAction: Record<string, unknown> = { type: "os_click", ...target }
        if (filtered.includes("--at")) {
          const atParts = filtered[filtered.indexOf("--at") + 1].split(",").map(Number)
          clickAction.x = atParts[0]
          clickAction.y = atParts[1]
        }
        action = clickAction
      } else if (target.semantic) {
        const clickAction: Record<string, unknown> = { type: "find_and_click", name: target.semantic.name, role: target.semantic.role }
        if (filtered.includes("--at")) {
          const atParts = filtered[filtered.indexOf("--at") + 1].split(",").map(Number)
          clickAction.x = atParts[0]
          clickAction.y = atParts[1]
        }
        action = clickAction
      } else {
        const clickAction: Record<string, unknown> = { type: "click", ...target }
        if (filtered.includes("--at")) {
          const atParts = filtered[filtered.indexOf("--at") + 1].split(",").map(Number)
          clickAction.x = atParts[0]
          clickAction.y = atParts[1]
        }
        action = clickAction
      }
      break
    }

    case "type": {
      const append = filtered.includes("--append")
      const useOs = filtered.includes("--os")
      const target = parseElementTarget(filtered[1])
      const textArgs = filtered.slice(2).filter(a => a !== "--append" && a !== "--os")
      if (useOs) {
        action = { type: "os_type", ...target, text: textArgs.join(" ") }
      } else if (target.semantic) {
        action = { type: "find_and_type", name: target.semantic.name, role: target.semantic.role, inputText: textArgs.join(" "), clear: !append }
      } else {
        action = { type: "input_text", ...target, text: textArgs.join(" "), clear: !append }
      }
      break
    }

    case "select":
      action = { type: "select_option", ...parseElementTarget(filtered[1]), value: filtered[2] }
      break

    case "focus":
      if (!filtered[1]) {
        action = { type: "get_focus" }
      } else {
        action = { type: "focus", ...parseElementTarget(filtered[1]) }
      }
      break

    case "blur":
      action = { type: "blur" }
      break

    case "click-at": {
      const coords = filtered[1]?.split(",").map(Number)
      if (!coords || coords.length !== 2 || coords.some(isNaN)) {
        console.error("error: click-at requires X,Y coordinates. Usage: slop click-at 500,300")
        process.exit(1)
      }
      action = { type: "click_at", x: coords[0], y: coords[1] }
      break
    }

    case "what-at": {
      const coords = filtered[1]?.split(",").map(Number)
      if (!coords || coords.length !== 2 || coords.some(isNaN)) {
        console.error("error: what-at requires X,Y coordinates. Usage: slop what-at 500,300")
        process.exit(1)
      }
      action = { type: "what_at", x: coords[0], y: coords[1] }
      break
    }

    case "regions":
      action = { type: "regions" }
      break

    case "frames":
      action = { type: "frames_list" }
      break

    case "modals":
      action = { type: "modals" }
      break

    case "panels":
      action = { type: "panels" }
      break

    case "session": {
      if (filtered[1] === "start") {
        const sessionPath = "/tmp/slop-browser-session.pid"
        const { writeFileSync } = await import("node:fs")
        writeFileSync(sessionPath, `${process.pid}\n${Date.now()}`)
        console.log(`session started (pid: ${process.pid})`)
        console.log("session mode: batch commands recommended for best performance")
        return
      }
      if (filtered[1] === "end") {
        const sessionPath = "/tmp/slop-browser-session.pid"
        try { unlinkSync(sessionPath) } catch {}
        console.log("session ended")
        return
      }
      console.error("error: usage: slop session start|end")
      process.exit(1)
    }

    case "hover": {
      const hoverAction: Record<string, unknown> = { type: "hover", ...parseElementTarget(filtered[1]) }
      if (filtered.includes("--from")) {
        const fromParts = filtered[filtered.indexOf("--from") + 1].split(",").map(Number)
        hoverAction.fromX = fromParts[0]
        hoverAction.fromY = fromParts[1]
      }
      if (filtered.includes("--steps")) hoverAction.steps = parseInt(filtered[filtered.indexOf("--steps") + 1])
      action = hoverAction
      break
    }

    case "drag": {
      const dragAction: Record<string, unknown> = { type: "drag", ...parseElementTarget(filtered[1]) }
      if (filtered.includes("--from")) {
        const fromParts = filtered[filtered.indexOf("--from") + 1].split(",").map(Number)
        dragAction.fromX = fromParts[0]
        dragAction.fromY = fromParts[1]
      }
      if (filtered.includes("--to")) {
        const toParts = filtered[filtered.indexOf("--to") + 1].split(",").map(Number)
        dragAction.toX = toParts[0]
        dragAction.toY = toParts[1]
      }
      if (filtered.includes("--steps")) dragAction.steps = parseInt(filtered[filtered.indexOf("--steps") + 1])
      if (filtered.includes("--duration")) dragAction.duration = parseInt(filtered[filtered.indexOf("--duration") + 1])
      action = dragAction
      break
    }

    case "keys": {
      if (filtered.includes("--os")) {
        const parts = filtered[1].split("+")
        const key = parts[parts.length - 1]
        const modifiers = parts.slice(0, -1)
        action = { type: "os_key", key, modifiers }
      } else {
        action = { type: "send_keys", keys: filtered[1] }
      }
      break
    }

    case "navigate":
      action = { type: "navigate", url: filtered[1] }
      break

    case "back":
      action = { type: "go_back" }
      break

    case "forward":
      action = { type: "go_forward" }
      break

    case "scroll":
      action = { type: "scroll", direction: filtered[1] as "up" | "down" | "top" | "bottom", amount: filtered.includes("--amount") ? parseInt(filtered[filtered.indexOf("--amount") + 1]) : undefined }
      break

    case "wait":
      action = { type: "wait", ms: parseInt(filtered[1]) }
      break

    case "screenshot": {
      if (filtered.includes("--background")) {
        const bgAction: Record<string, unknown> = { type: "screenshot_background" }
        if (filtered.includes("--format")) bgAction.format = filtered[filtered.indexOf("--format") + 1]
        if (filtered.includes("--quality")) bgAction.quality = parseInt(filtered[filtered.indexOf("--quality") + 1])
        action = bgAction
        break
      }
      const ssAction: Record<string, unknown> = { type: "screenshot" }
      if (filtered.includes("--save")) ssAction.save = true
      if (filtered.includes("--format")) ssAction.format = filtered[filtered.indexOf("--format") + 1]
      if (filtered.includes("--quality")) ssAction.quality = parseInt(filtered[filtered.indexOf("--quality") + 1])
      if (filtered.includes("--full")) ssAction.full = true
      if (filtered.includes("--clip")) {
        const clipParts = filtered[filtered.indexOf("--clip") + 1].split(",").map(Number)
        ssAction.clip = { x: clipParts[0], y: clipParts[1], width: clipParts[2], height: clipParts[3] }
      }
      if (filtered.includes("--element")) ssAction.element = parseInt(filtered[filtered.indexOf("--element") + 1])
      action = ssAction
      break
    }

    case "text":
      action = filtered[1] ? { type: "extract_text", ...parseElementTarget(filtered[1]) } : { type: "extract_text" }
      break

    case "html":
      action = { type: "extract_html", ...parseElementTarget(filtered[1]) }
      break

    case "eval": {
      const world = filtered.includes("--main") ? "MAIN" : "ISOLATED"
      const code = filtered.slice(1).filter(a => a !== "--main").join(" ")
      action = { type: "evaluate", code, world }
      break
    }

    case "tabs":
      action = { type: "tab_list" }
      break

    case "tab":
      switch (filtered[1]) {
        case "new":
          action = { type: "tab_create", url: filtered[2] }
          break
        case "close":
          action = filtered[2] ? { type: "tab_close", tabId: parseInt(filtered[2]) } : { type: "tab_close" }
          break
        case "switch":
          action = { type: "tab_switch", tabId: parseInt(filtered[2]) }
          break
        default:
          console.error("error: unknown tab subcommand. Use: new, close, switch")
          process.exit(1)
      }
      break

    case "cookies":
      switch (filtered[1]) {
        case "set":
          action = { type: "cookies_set", cookie: JSON.parse(filtered[2]) }
          break
        case "delete":
          action = { type: "cookies_delete", url: filtered[2], name: filtered[3] }
          break
        default:
          action = { type: "cookies_get", domain: filtered[1] }
          break
      }
      break

    case "network":
      switch (filtered[1]) {
        case "on":
          action = { type: "network_intercept", patterns: filtered.slice(2), enabled: true }
          break
        case "off":
          action = { type: "network_intercept", patterns: [], enabled: false }
          break
        case "log":
          action = {
            type: "network_log",
            since: filtered.includes("--since") ? parseInt(filtered[filtered.indexOf("--since") + 1]) : undefined,
            limit: filtered.includes("--limit") ? parseInt(filtered[filtered.indexOf("--limit") + 1]) : undefined
          }
          break
        case "override":
          if (filtered[2] === "on") {
            action = { type: "network_override", enabled: true, rules: JSON.parse(filtered[3] || "[]") }
            break
          }
          if (filtered[2] === "off") {
            action = { type: "network_override", enabled: false, rules: [] }
            break
          }
          console.error("error: unknown network override subcommand. Use: on, off")
          process.exit(1)
        default:
          console.error("error: unknown network subcommand. Use: on, off, log, override")
          process.exit(1)
      }
      break

    case "linkedin":
      if (filtered[1] === "event") {
        action = {
          type: "linkedin_event_extract",
          url: filtered[2],
          waitMs: filtered.includes("--wait") ? parseInt(filtered[filtered.indexOf("--wait") + 1]) : undefined
        }
        break
      }
      if (filtered[1] === "attendees") {
        action = {
          type: "linkedin_attendees_extract",
          url: filtered[2],
          waitMs: filtered.includes("--wait") ? parseInt(filtered[filtered.indexOf("--wait") + 1]) : undefined,
          enrichLimit: filtered.includes("--enrich-limit") ? parseInt(filtered[filtered.indexOf("--enrich-limit") + 1]) : undefined
        }
        break
      }
      console.error("error: unknown linkedin subcommand. Use: event, attendees")
      process.exit(1)

    case "linkedin-event":
      action = {
        type: "linkedin_event_extract",
        url: filtered[1],
        waitMs: filtered.includes("--wait") ? parseInt(filtered[filtered.indexOf("--wait") + 1]) : undefined
      }
      break

    case "headers":
      switch (filtered[1]) {
        case "add":
          action = { type: "headers_modify", rules: [{ operation: "set", header: filtered[2], value: filtered[3] }] }
          break
        case "remove":
          action = { type: "headers_modify", rules: [{ operation: "remove", header: filtered[2] }] }
          break
        case "clear":
          action = { type: "headers_modify", rules: [] }
          break
        default:
          console.error("error: unknown headers subcommand. Use: add, remove, clear")
          process.exit(1)
      }
      break

    case "status":
      action = { type: "status" }
      break

    case "reload":
      action = { type: "reload_extension" }
      break

    case "meta":
      action = { type: "meta" }
      break

    case "links":
      action = { type: "links" }
      break

    case "images":
      action = { type: "images" }
      break

    case "forms":
      action = { type: "forms" }
      break

    case "page_info":
    case "info":
      action = { type: "page_info" }
      break

    case "query":
      action = { type: "query", selector: filtered[1] }
      break

    case "exists":
      action = { type: "exists", selector: filtered[1] }
      break

    case "count":
      action = { type: "count", selector: filtered[1] }
      break

    case "table":
      action = filtered[1] ? { type: "table_data", selector: filtered[1] } : { type: "table_data" }
      break

    case "attr":
      if (filtered[1] === "set") {
        action = { type: "attr_set", ...parseElementTarget(filtered[2]), name: filtered[3], value: filtered[4] }
      } else {
        action = { type: "attr_get", ...parseElementTarget(filtered[1]), name: filtered[2] }
      }
      break

    case "style":
      action = { type: "style_get", ...parseElementTarget(filtered[1]), property: filtered[2] }
      break

    case "dblclick": {
      const dblAction: Record<string, unknown> = { type: "dblclick", ...parseElementTarget(filtered[1]) }
      if (filtered.includes("--at")) {
        const atParts = filtered[filtered.indexOf("--at") + 1].split(",").map(Number)
        dblAction.x = atParts[0]
        dblAction.y = atParts[1]
      }
      action = dblAction
      break
    }

    case "rightclick": {
      const rcAction: Record<string, unknown> = { type: "rightclick", ...parseElementTarget(filtered[1]) }
      if (filtered.includes("--at")) {
        const atParts = filtered[filtered.indexOf("--at") + 1].split(",").map(Number)
        rcAction.x = atParts[0]
        rcAction.y = atParts[1]
      }
      action = rcAction
      break
    }

    case "check":
      action = { type: "check", ...parseElementTarget(filtered[1]), checked: filtered[2] !== "false" }
      break

    case "wait_for":
      action = { type: "wait_for", selector: filtered[1], timeout: filtered[2] ? parseInt(filtered[2]) : 10000 }
      break

    case "wait-stable": {
      const wsMs = filtered.includes("--ms") ? parseInt(filtered[filtered.indexOf("--ms") + 1]) : 200
      const wsTimeout = filtered.includes("--timeout") ? parseInt(filtered[filtered.indexOf("--timeout") + 1]) : 5000
      action = { type: "wait_stable", ms: wsMs, timeout: wsTimeout }
      break
    }

    case "batch": {
      if (!filtered[1]) {
        console.error("error: batch requires a JSON array of actions. Usage: slop batch '[{\"type\":\"click\",\"ref\":\"e5\"}, ...]'")
        process.exit(1)
      }
      try {
        const batchActions = JSON.parse(filtered[1])
        if (!Array.isArray(batchActions)) {
          console.error("error: batch argument must be a JSON array")
          process.exit(1)
        }
        const batchTimeout = filtered.includes("--timeout") ? parseInt(filtered[filtered.indexOf("--timeout") + 1]) : 30000
        action = { type: "batch", actions: batchActions, stopOnError: filtered.includes("--stop-on-error"), timeout: batchTimeout }
      } catch (e) {
        console.error(`error: invalid JSON for batch: ${(e as Error).message}`)
        process.exit(1)
      }
      break
    }

    case "clipboard":
      if (filtered[1] === "write") {
        action = { type: "clipboard_write", text: filtered.slice(2).join(" ") }
      } else {
        action = { type: "clipboard_read" }
      }
      break

    case "storage":
      if (filtered[1] === "set") {
        action = { type: "storage_write", key: filtered[2], value: filtered[3], storageType: filtered.includes("--session") ? "session" : "local" }
      } else if (filtered[1] === "delete") {
        action = { type: "storage_delete", key: filtered[2], storageType: filtered.includes("--session") ? "session" : "local" }
      } else {
        action = { type: "storage_read", key: filtered[1], storageType: filtered.includes("--session") ? "session" : "local" }
      }
      break

    case "history":
      if (filtered[1] === "delete") {
        action = { type: "history_delete", url: filtered[2] }
      } else {
        action = { type: "history_search", query: filtered[1] || "", maxResults: filtered[2] ? parseInt(filtered[2]) : 20 }
      }
      break

    case "bookmarks":
      if (filtered[1] === "add") {
        action = { type: "bookmark_create", title: filtered[2], url: filtered[3] }
      } else if (filtered[1] === "delete") {
        action = { type: "bookmark_delete", id: filtered[2] }
      } else if (filtered[1] === "tree") {
        action = { type: "bookmark_tree" }
      } else {
        action = { type: "bookmark_search", query: filtered[1] || "" }
      }
      break

    case "downloads":
      if (filtered[1] === "start") {
        action = { type: "downloads_start", url: filtered[2], filename: filtered[3] }
      } else if (filtered[1] === "cancel") {
        action = { type: "downloads_cancel", downloadId: parseInt(filtered[2]) }
      } else {
        action = { type: "downloads_search", query: filtered[1] }
      }
      break

    case "window":
      switch (filtered[1]) {
        case "new":
          action = { type: "window_create", url: filtered[2], incognito: filtered.includes("--incognito") }
          break
        case "close":
          action = { type: "window_close", windowId: parseInt(filtered[2]) }
          break
        case "focus":
          action = { type: "window_focus", windowId: parseInt(filtered[2]) }
          break
        case "resize":
          action = { type: "window_resize", windowId: filtered[2] ? parseInt(filtered[2]) : undefined, width: parseInt(filtered[3]), height: parseInt(filtered[4]) }
          break
        case "list":
          action = { type: "window_list" }
          break
        default:
          action = { type: "window_list" }
      }
      break

    case "frames":
      action = { type: "frames_list" }
      break

    case "sessions":
      if (filtered[1] === "restore") {
        action = { type: "session_restore", sessionId: filtered[2] }
      } else {
        action = { type: "session_list", maxResults: filtered[1] ? parseInt(filtered[1]) : 10 }
      }
      break

    case "notify":
      action = { type: "notification_create", title: filtered[1], message: filtered.slice(2).join(" ") }
      break

    case "search":
      action = { type: "search_query", query: filtered.slice(1).join(" ") }
      break

    case "clear":
      action = { type: "browsing_data_remove", types: filtered.slice(1), since: filtered.includes("--since") ? parseInt(filtered[filtered.indexOf("--since") + 1]) : 0 }
      break

    case "events": {
      const eventsPath = "/tmp/slop-browser-events.jsonl"
      if (!existsSync(eventsPath)) {
        console.log("no events yet")
        return
      }
      const tail = filtered.includes("--tail")
      if (tail) {
        const proc = Bun.spawn(["tail", "-f", eventsPath], { stdout: "inherit", stderr: "inherit" })
        await proc.exited
      } else {
        const since = filtered.includes("--since") ? parseInt(filtered[filtered.indexOf("--since") + 1]) : 0
        const content = readFileSync(eventsPath, "utf-8").trim()
        if (!content) { console.log("no events yet"); return }
        const lines = content.split("\n")
        for (const line of lines) {
          try {
            const event = JSON.parse(line)
            if (since && new Date(event.timestamp).getTime() < since) continue
            console.log(`${event.timestamp} ${event.event}${event.requestId ? ` [${event.requestId.slice(0, 8)}]` : ""}${event.action ? ` ${event.action}` : ""}${event.duration !== undefined ? ` ${event.duration}ms` : ""}${event.error ? ` error=${event.error}` : ""}`)
          } catch {}
        }
      }
      return
    }

    case "tree": {
      if (filtered.includes("--native")) {
        const depthIdx = filtered.indexOf("--depth")
        action = { type: "cdp_tree", depth: depthIdx !== -1 ? parseInt(filtered[depthIdx + 1]) : undefined }
        break
      }
      const depthIdx = filtered.indexOf("--depth")
      const filterIdx = filtered.indexOf("--filter")
      const maxCharsIdx = filtered.indexOf("--max-chars")
      action = {
        type: "get_a11y_tree",
        depth: depthIdx !== -1 ? parseInt(filtered[depthIdx + 1]) : 15,
        filter: filterIdx !== -1 ? filtered[filterIdx + 1] : "interactive",
        maxChars: maxCharsIdx !== -1 ? parseInt(filtered[maxCharsIdx + 1]) : 50000
      }
      break
    }

    case "find": {
      const roleIdx = filtered.indexOf("--role")
      const limitIdx = filtered.indexOf("--limit")
      const queryParts = filtered.slice(1).filter(a => a !== "--role" && a !== "--limit" && (roleIdx === -1 || a !== filtered[roleIdx + 1]) && (limitIdx === -1 || a !== filtered[limitIdx + 1]))
      action = {
        type: "find_element",
        query: queryParts.join(" "),
        role: roleIdx !== -1 ? filtered[roleIdx + 1] : undefined,
        limit: limitIdx !== -1 ? parseInt(filtered[limitIdx + 1]) : 10
      }
      break
    }

    case "diff":
      action = { type: "diff" }
      break

    case "canvas":
      switch (filtered[1]) {
        case "list":
          action = { type: "canvas_list" }
          break
        case "read": {
          const crAction: Record<string, unknown> = { type: "canvas_read", canvasIndex: parseInt(filtered[2]) }
          if (filtered.includes("--format")) crAction.format = filtered[filtered.indexOf("--format") + 1]
          if (filtered.includes("--quality")) crAction.quality = parseInt(filtered[filtered.indexOf("--quality") + 1])
          if (filtered.includes("--webgl")) crAction.webgl = true
          if (filtered.includes("--region")) {
            const rp = filtered[filtered.indexOf("--region") + 1].split(",").map(Number)
            crAction.region = { x: rp[0], y: rp[1], width: rp[2], height: rp[3] }
          }
          action = crAction
          break
        }
        case "diff": {
          const cdAction: Record<string, unknown> = { type: "canvas_diff", image1: filtered[2], image2: filtered[3] }
          if (filtered.includes("--threshold")) cdAction.threshold = parseInt(filtered[filtered.indexOf("--threshold") + 1])
          if (filtered.includes("--image")) cdAction.returnImage = true
          action = cdAction
          break
        }
        default:
          console.error("error: unknown canvas subcommand. Use: list, read, diff")
          process.exit(1)
      }
      break

    case "capture":
      switch (filtered[1]) {
        case "start":
          action = { type: "capture_start" }
          break
        case "frame": {
          const cfAction: Record<string, unknown> = { type: "capture_frame" }
          if (filtered.includes("--format")) cfAction.format = filtered[filtered.indexOf("--format") + 1]
          if (filtered.includes("--quality")) cfAction.quality = parseInt(filtered[filtered.indexOf("--quality") + 1])
          action = cfAction
          break
        }
        case "stop":
          action = { type: "capture_stop" }
          break
        default:
          console.error("error: unknown capture subcommand. Use: start, frame, stop")
          process.exit(1)
      }
      break

    case "capabilities":
      action = { type: "capabilities" }
      break

    case "raw":
      action = JSON.parse(filtered.slice(1).join(" "))
      break

    default:
      console.error(`error: unknown command '${cmd}'. Run 'slop help' for usage.`)
      process.exit(1)
  }

  if (anyTab) action.anyTab = true
  if (filtered.includes("--changes")) action.changes = true
  const frameIdx = args.indexOf("--frame")
  if (frameIdx !== -1 && args[frameIdx + 1]) {
    action.frameId = parseInt(args[frameIdx + 1])
  }

  try {
    const response = useWs ? await sendCommandWs(action, globalTabId) : await sendCommand(action, globalTabId)

    if (response.result) {
      const result = response.result

      if (result.success && result.data && typeof result.data === "object" && (result.data as Record<string, unknown>).save && (result.data as Record<string, unknown>).dataUrl) {
        const d = result.data as Record<string, unknown>
        const dataUrl = d.dataUrl as string
        const base64 = dataUrl.split(",")[1]
        const ext = (d.format as string) === "png" ? "png" : "jpg"
        const filename = `slop-screenshot-${Date.now()}.${ext}`
        const bytes = Buffer.from(base64, "base64")
        await Bun.write(filename, bytes)
        d.filePath = `${process.cwd()}/${filename}`
        delete d.save
        process.stderr.write(`saved: ${d.filePath}\n`)
      }

      if (!jsonMode && result.success) {
        switch (action.type) {
          case "get_state":
            console.log(formatState(result.data as Parameters<typeof formatState>[0]))
            return
          case "tab_list":
            console.log(formatTabs(result.data as Parameters<typeof formatTabs>[0]))
            return
          case "cookies_get":
            console.log(formatCookies(result.data as Parameters<typeof formatCookies>[0]))
            return
        }
      }

      console.log(formatResult(result, jsonMode))
    } else {
      console.log(formatResult(response as unknown as { success: boolean; error?: string; data?: unknown }, jsonMode))
    }
  } catch (err) {
    console.error(`error: ${(err as Error).message}`)
    process.exit(1)
  }
}

function parseElementTarget(arg: string): { index?: number; ref?: string; semantic?: { role: string; name: string } } {
  if (/^e\d+$/.test(arg)) return { ref: arg }
  const n = parseInt(arg)
  if (!isNaN(n)) return { index: n }
  const colonIdx = arg.indexOf(":")
  if (colonIdx > 0) {
    return { semantic: { role: arg.slice(0, colonIdx), name: arg.slice(colonIdx + 1) } }
  }
  return { ref: arg }
}

function parseTabFlag(args: string[]): number | undefined {
  const idx = args.indexOf("--tab")
  if (idx === -1) return undefined
  if (!args[idx + 1]) {
    console.error("error: --tab requires a numeric tab ID")
    process.exit(1)
  }
  const tabId = parseInt(args[idx + 1])
  if (isNaN(tabId)) {
    console.error(`error: --tab requires a numeric tab ID, got '${args[idx + 1]}'`)
    process.exit(1)
  }
  return tabId
}

main()
