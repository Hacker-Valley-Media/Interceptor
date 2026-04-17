/**
 * cli/commands/meta.ts — status, reload, meta, links, images, forms, info, query, exists, count,
 *                        table, attr, style, events, search, notify, sessions, capabilities,
 *                        modals, panels
 *
 * Returns null for "status" and "events" (handled locally, no daemon connection needed).
 */

import { existsSync, readFileSync } from "node:fs"
import { IS_WIN, SOCKET_PATH, PID_PATH, transportLabel } from "../../shared/platform"
import { parseElementTarget } from "../parse"

type Action = { type: string; [key: string]: unknown }

export async function parseMetaCommand(filtered: string[], jsonMode = false): Promise<Action | null> {
  const cmd = filtered[0]

  switch (cmd) {
    case "status": {
      const statusLines: string[] = []
      const sockExists = !IS_WIN && existsSync(SOCKET_PATH)
      let daemonPid: number | null = null
      let daemonAlive = false
      let transport = "unknown"
      if (existsSync(PID_PATH)) {
        try {
          const pidContent = readFileSync(PID_PATH, "utf-8").trim()
          const lines = pidContent.split("\n")
          daemonPid = parseInt(lines[0])
          transport = lines[1] || transportLabel()
          if (!isNaN(daemonPid)) {
            try { process.kill(daemonPid, 0); daemonAlive = true } catch { daemonAlive = false }
          }
        } catch {}
      }
      statusLines.push(`daemon: ${daemonAlive ? "running" : "not running"}`)
      if (daemonPid) statusLines.push(`pid: ${daemonPid}`)
      statusLines.push(`socket: ${sockExists ? SOCKET_PATH : "not found"}`)
      statusLines.push(`transport: ${transport}`)

      // PRD-35: bridge health. The bridge powers `interceptor macos *` and is
      // installed as a user LaunchAgent by the DMG installer.
      const BRIDGE_PID_PATH = "/tmp/interceptor-bridge.pid"
      const BRIDGE_SOCK_PATH = "/tmp/interceptor-bridge.sock"
      const bridgeSockExists = !IS_WIN && existsSync(BRIDGE_SOCK_PATH)
      let bridgePid: number | null = null
      let bridgeAlive = false
      if (existsSync(BRIDGE_PID_PATH)) {
        try {
          bridgePid = parseInt(readFileSync(BRIDGE_PID_PATH, "utf-8").trim())
          if (!isNaN(bridgePid)) {
            try { process.kill(bridgePid, 0); bridgeAlive = true } catch { bridgeAlive = false }
          }
        } catch {}
      }
      statusLines.push("")
      statusLines.push(`bridge: ${bridgeAlive ? "running" : "not running"}`)
      if (bridgePid) statusLines.push(`  pid: ${bridgePid}`)
      statusLines.push(`  socket: ${bridgeSockExists ? BRIDGE_SOCK_PATH : "not found"}`)
      if (!bridgeAlive) {
        statusLines.push("  hint: 'interceptor macos *' commands require the bridge. If you installed")
        statusLines.push("        via DMG, launchctl should auto-start it. Try 'launchctl load ~/Library/LaunchAgents/com.interceptor.bridge.plist'")
      }

      if (!daemonAlive) {
        statusLines.push("")
        statusLines.push("hint: run any interceptor command and the daemon will auto-start.")
        statusLines.push("ensure Chrome/Brave has the Interceptor extension loaded for browser control.")
      }
      if (jsonMode) {
        console.log(JSON.stringify({
          daemon: daemonAlive,
          pid: daemonPid,
          socket: sockExists ? SOCKET_PATH : null,
          transport,
          bridge: bridgeAlive,
          bridgePid,
          bridgeSocket: bridgeSockExists ? BRIDGE_SOCK_PATH : null
        }, null, 2))
      } else {
        console.log(statusLines.join("\n"))
      }
      return null
    }

    case "events": {
      const eventsPath = "/tmp/interceptor-events.jsonl"
      if (!existsSync(eventsPath)) {
        console.log("no events yet")
        return null
      }
      const tail = filtered.includes("--tail")
      if (tail) {
        const proc = Bun.spawn(["tail", "-f", eventsPath], { stdout: "inherit", stderr: "inherit" })
        await proc.exited
      } else {
        const since = filtered.includes("--since")
          ? parseInt(filtered[filtered.indexOf("--since") + 1])
          : 0
        const content = readFileSync(eventsPath, "utf-8").trim()
        if (!content) { console.log("no events yet"); return null }
        const lines = content.split("\n")
        for (const line of lines) {
          try {
            const event = JSON.parse(line)
            if (since && new Date(event.timestamp).getTime() < since) continue
            console.log(`${event.timestamp} ${event.event}${event.requestId ? ` [${event.requestId.slice(0, 8)}]` : ""}${event.action ? ` ${event.action}` : ""}${event.duration !== undefined ? ` ${event.duration}ms` : ""}${event.error ? ` error=${event.error}` : ""}`)
          } catch {}
        }
      }
      return null
    }

    case "reload":
      return { type: "reload_extension" }

    case "meta":
      return { type: "meta" }

    case "links":
      return { type: "links" }

    case "images":
      return { type: "images" }

    case "forms":
      return { type: "forms" }

    case "page_info":
    case "info":
      return { type: "page_info" }

    case "query":
      return { type: "query", selector: filtered[1] }

    case "exists":
      return { type: "exists", selector: filtered[1] }

    case "count":
      return { type: "count", selector: filtered[1] }

    case "table":
      return filtered[1]
        ? { type: "table_data", selector: filtered[1] }
        : { type: "table_data" }

    case "attr":
      if (filtered[1] === "set") {
        return { type: "attr_set", ...parseElementTarget(filtered[2]), name: filtered[3], value: filtered[4] }
      } else {
        return { type: "attr_get", ...parseElementTarget(filtered[1]), name: filtered[2] }
      }

    case "style":
      return { type: "style_get", ...parseElementTarget(filtered[1]), property: filtered[2] }

    case "search":
      return { type: "search_query", query: filtered.slice(1).join(" ") }

    case "notify":
      return { type: "notification_create", title: filtered[1], message: filtered.slice(2).join(" ") }

    case "sessions":
      if (filtered[1] === "restore") {
        return { type: "session_restore", sessionId: filtered[2] }
      } else {
        return { type: "session_list", maxResults: filtered[1] ? parseInt(filtered[1]) : 10 }
      }

    case "capabilities":
      return { type: "capabilities" }

    case "modals":
      return { type: "modals" }

    case "panels":
      return { type: "panels" }

    default:
      console.error(`error: unknown meta command '${cmd}'`)
      process.exit(1)
  }
}
