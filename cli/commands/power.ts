/**
 * cli/commands/power.ts — keepawake, idle (browser actions) + delegate (reads
 * the daemon event bus for human→agent delegation intents).
 */

import { existsSync, readFileSync } from "node:fs"
import { EVENTS_PATH } from "../../shared/platform"

type Action = { type: string; [key: string]: unknown }


export function parsePowerCommand(filtered: string[]): Action {
  const cmd = filtered[0]

  if (cmd === "keepawake") {
    const sub = filtered[1]
    if (sub !== "on" && sub !== "off") {
      console.error("error: usage — interceptor keepawake on|off [--display]")
      process.exit(1)
    }
    const action: Action = { type: "keepawake", on: sub === "on" }
    if (filtered.includes("--display")) action.level = "display"
    return action
  }

  if (cmd === "idle") {
    // interceptor idle [state] [--interval <sec>]
    const action: Action = { type: "idle_state" }
    if (filtered.includes("--interval")) {
      const n = parseInt(filtered[filtered.indexOf("--interval") + 1])
      if (!isNaN(n)) action.detectionInterval = n
    }
    return action
  }

  console.error(`error: unknown power command '${cmd}'`)
  process.exit(1)
}

/**
 * `interceptor delegate log [--since <ms-epoch>] [--follow]` — print the
 * human→agent delegation intents an operator sent via the browser right-click
 * menu or a keyboard command. Reads the daemon event bus; no daemon connection
 * required.
 */
export async function runDelegateCommand(filtered: string[], jsonMode = false): Promise<void> {
  const sub = filtered[1]
  if (sub && sub !== "log") {
    console.error("error: usage — interceptor delegate log [--since <ms>] [--follow]")
    process.exit(1)
  }

  // Returns true if the line was a delegation_intent and was printed.
  const printLine = (line: string): boolean => {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line)
    } catch {
      return false
    }
    if (event.event !== "delegation_intent") return false
    if (jsonMode) {
      console.log(line)
      return true
    }
    const parts = [
      String(event.timestamp ?? ""),
      "delegation_intent",
      event.source ? `via=${event.source}` : "",
      event.command ? `cmd=${event.command}` : "",
      event.menuItemId ? `menu=${event.menuItemId}` : "",
      event.selectionText ? `selection=${JSON.stringify(String(event.selectionText).slice(0, 80))}` : "",
      event.linkUrl ? `link=${event.linkUrl}` : "",
      event.srcUrl ? `src=${event.srcUrl}` : "",
      event.pageUrl ? `page=${event.pageUrl}` : "",
    ].filter(Boolean)
    console.log(parts.join(" "))
    return true
  }

  if (filtered.includes("--follow")) {
    // Live tail, filtered to delegation intents (raw JSON lines).
    const proc = Bun.spawn(
      ["sh", "-c", `tail -f ${EVENTS_PATH} | grep --line-buffered delegation_intent`],
      { stdout: "inherit", stderr: "inherit" }
    )
    await proc.exited
    return
  }

  if (!existsSync(EVENTS_PATH)) {
    console.log("no delegation intents yet")
    return
  }
  const content = readFileSync(EVENTS_PATH, "utf-8").trim()
  if (!content) {
    console.log("no delegation intents yet")
    return
  }
  const since = filtered.includes("--since")
    ? parseInt(filtered[filtered.indexOf("--since") + 1])
    : 0
  let any = false
  for (const line of content.split("\n")) {
    if (since) {
      try {
        const ev = JSON.parse(line)
        if (new Date(ev.timestamp).getTime() < since) continue
      } catch {
        continue
      }
    }
    if (printLine(line)) any = true
  }
  if (!any) console.log("no delegation intents yet")
}
