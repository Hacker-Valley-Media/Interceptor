import { existsSync } from "node:fs"

const SOCKET_PATH = "/tmp/slop-browser.sock"
const PID_PATH = "/tmp/slop-browser.pid"

function sendCommand(action: { type: string; [key: string]: unknown }, tabId?: number): Promise<{ id: string; result: { success: boolean; error?: string; data?: unknown; tabId?: number } }> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const shortId = id.slice(0, 8)
    process.stderr.write(`[${shortId}] → ${action.type}\n`)
    let buffer = Buffer.alloc(0)
    let resolved = false
    const startTime = Date.now()

    Bun.connect({
      unix: SOCKET_PATH,
      socket: {
        open(socket) {
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
          if (!resolved) {
            reject(new Error("connection closed before response"))
          }
        },
        connectError(_socket, err) {
          reject(new Error("daemon not running. Open Chrome with the slop-browser extension loaded."))
        },
        error(_socket, err) {
          reject(err)
        }
      }
    })
  })
}

function formatState(data: { url: string; title: string; elementTree: string; staticText?: string; scrollPosition: { y: number; height: number; viewportHeight: number }; tabId: number }) {
  const scroll = data.scrollPosition
  let out = `url: ${data.url}\ntitle: ${data.title}\nscroll: ${scroll.y}/${scroll.height} (vh:${scroll.viewportHeight})\ntab: ${data.tabId}\n\n${data.elementTree}`
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
  slop text                           All visible text
  slop text <index>                   Text from specific element
  slop html <index>                   HTML of specific element

Actions:
  slop click <index>                  Click element
  slop type <index> <text>            Type into element (clears first)
  slop type <index> <text> --append   Type without clearing
  slop select <index> <value>         Select dropdown option
  slop focus <index>                  Focus element
  slop hover <index>                  Hover over element
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
  slop screenshot                     Save screenshot, print path
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

Headers:
  slop headers add <name> <value>     Add request header
  slop headers remove <name>          Remove header rule
  slop headers clear                  Clear all rules

Meta:
  slop status                         Daemon connection info
  slop help                           This help text

Flags:
  --json                              Output as JSON`

async function main() {
  const args = process.argv.slice(2)
  const jsonMode = args.includes("--json")
  const globalTabId = parseTabFlag(args)
  const filtered = args.filter(a => a !== "--json")

  if (filtered.length === 0 || filtered[0] === "help") {
    console.log(HELP)
    return
  }

  if (!existsSync(SOCKET_PATH)) {
    console.error("error: daemon not running. Open Chrome with the slop-browser extension loaded.")
    process.exit(1)
  }

  const cmd = filtered[0]
  let action: { type: string; [key: string]: unknown }

  switch (cmd) {
    case "state":
      action = { type: "get_state", full: filtered.includes("--full"), tabId: parseTabFlag(filtered) }
      break

    case "click":
      action = { type: "click", index: parseInt(filtered[1]) }
      break

    case "type": {
      const append = filtered.includes("--append")
      const textArgs = filtered.slice(2).filter(a => a !== "--append")
      action = { type: "input_text", index: parseInt(filtered[1]), text: textArgs.join(" "), clear: !append }
      break
    }

    case "select":
      action = { type: "select_option", index: parseInt(filtered[1]), value: filtered[2] }
      break

    case "focus":
      action = { type: "focus", index: parseInt(filtered[1]) }
      break

    case "hover":
      action = { type: "hover", index: parseInt(filtered[1]) }
      break

    case "keys":
      action = { type: "send_keys", keys: filtered[1] }
      break

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

    case "screenshot":
      action = { type: "screenshot", tabId: parseTabFlag(filtered) }
      break

    case "text":
      action = filtered[1] ? { type: "extract_text", index: parseInt(filtered[1]) } : { type: "extract_text" }
      break

    case "html":
      action = { type: "extract_html", index: parseInt(filtered[1]) }
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
          action = { type: "network_log", since: filtered.includes("--since") ? parseInt(filtered[filtered.indexOf("--since") + 1]) : undefined }
          break
        default:
          console.error("error: unknown network subcommand. Use: on, off, log")
          process.exit(1)
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
        action = { type: "attr_set", index: parseInt(filtered[2]), name: filtered[3], value: filtered[4] }
      } else {
        action = { type: "attr_get", index: parseInt(filtered[1]), name: filtered[2] }
      }
      break

    case "style":
      action = { type: "style_get", index: parseInt(filtered[1]), property: filtered[2] }
      break

    case "dblclick":
      action = { type: "dblclick", index: parseInt(filtered[1]) }
      break

    case "rightclick":
      action = { type: "rightclick", index: parseInt(filtered[1]) }
      break

    case "check":
      action = { type: "check", index: parseInt(filtered[1]), checked: filtered[2] !== "false" }
      break

    case "wait_for":
      action = { type: "wait_for", selector: filtered[1], timeout: filtered[2] ? parseInt(filtered[2]) : 10000 }
      break

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

    case "raw":
      action = JSON.parse(filtered.slice(1).join(" "))
      break

    default:
      console.error(`error: unknown command '${cmd}'. Run 'slop help' for usage.`)
      process.exit(1)
  }

  try {
    const response = await sendCommand(action, globalTabId)

    if (response.result) {
      const result = response.result

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

function parseTabFlag(args: string[]): number | undefined {
  const idx = args.indexOf("--tab")
  if (idx !== -1 && args[idx + 1]) return parseInt(args[idx + 1])
  return undefined
}

main()
