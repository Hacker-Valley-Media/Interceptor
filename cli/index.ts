import { HELP } from "./help"
import { parseTabFlag } from "./parse"
import { formatState, formatTabs, formatCookies, formatResult } from "./format"
import { sendCommand, sendCommandWs } from "./transport"
import { ensureDaemon } from "./daemon-spawn"
import { parseStateCommand } from "./commands/state"
import { parseActionsCommand } from "./commands/actions"
import { parseNavigationCommand } from "./commands/navigation"
import { parseTabsCommand } from "./commands/tabs"
import { parseNetworkCommand } from "./commands/network"
import { parseScreenshotCommand } from "./commands/screenshot"
import { parseLinkedinCommand } from "./commands/linkedin"
import { parseDataCommand } from "./commands/data"
import { parseMetaCommand } from "./commands/meta"
import { parseEvalCommand } from "./commands/eval"
import { parseBatchCommand } from "./commands/batch"
import { parseMonitorCommand } from "./commands/monitor"
import { parseSceneCommand } from "./commands/scene"

// Command → module routing
const STATE_CMDS = new Set(["state", "tree", "diff", "find", "text", "html"])
const ACTION_CMDS = new Set(["click", "type", "select", "focus", "blur", "hover", "drag", "dblclick", "rightclick", "check", "keys", "click-at", "what-at", "regions"])
const NAV_CMDS = new Set(["navigate", "back", "forward", "scroll", "wait", "wait-stable", "wait_for"])
const TAB_CMDS = new Set(["tabs", "tab", "window", "frames", "session"])
const NET_CMDS = new Set(["network", "net", "headers"])
const SS_CMDS = new Set(["screenshot", "canvas", "capture"])
const LI_CMDS = new Set(["linkedin", "linkedin-event"])
const DATA_CMDS = new Set(["cookies", "storage", "history", "bookmarks", "downloads", "clear", "clipboard"])
const META_CMDS = new Set(["status", "reload", "meta", "links", "images", "forms", "info", "page_info", "query", "exists", "count", "table", "attr", "style", "events", "search", "notify", "sessions", "capabilities", "modals", "panels"])
const EVAL_CMDS = new Set(["eval"])
const BATCH_CMDS = new Set(["batch", "raw"])
const MONITOR_CMDS = new Set(["monitor"])
const SCENE_CMDS = new Set(["scene"])

// Commands that don't require a daemon connection
const NO_DAEMON = new Set(["status", "help", "events", "session"])

// Monitor subcommands that are handled locally (no daemon needed)
const MONITOR_LOCAL_SUBCOMMANDS = new Set(["tail", "list", "export"])

async function main() {
  const args = process.argv.slice(2)
  const jsonMode = args.includes("--json")
  const useWs = args.includes("--ws")
  const anyTab = args.includes("--any-tab")
  const globalTabId = parseTabFlag(args)

  // Build filtered args (strip global flags)
  const tabIdx = args.indexOf("--tab")
  const tabFilterSet = new Set(["--json", "--ws", "--any-tab"])
  if (tabIdx !== -1) { tabFilterSet.add("--tab"); if (args[tabIdx + 1]) tabFilterSet.add(args[tabIdx + 1]) }
  const filtered = args.filter(a => !tabFilterSet.has(a))

  if (filtered.length === 0 || filtered[0] === "help") {
    console.log(HELP)
    return
  }

  const cmd = filtered[0]
  let needsDaemon = !NO_DAEMON.has(cmd)
  if (cmd === "monitor" && filtered[1] && MONITOR_LOCAL_SUBCOMMANDS.has(filtered[1])) {
    needsDaemon = false
  }

  if (needsDaemon && !useWs) {
    await ensureDaemon()
  }

  // Dispatch to command module
  let action: { type: string; [key: string]: unknown } | null

  if (STATE_CMDS.has(cmd))       action = parseStateCommand(filtered)
  else if (ACTION_CMDS.has(cmd)) action = parseActionsCommand(filtered)
  else if (NAV_CMDS.has(cmd))    action = parseNavigationCommand(filtered)
  else if (TAB_CMDS.has(cmd))    action = await parseTabsCommand(filtered)
  else if (NET_CMDS.has(cmd))    action = parseNetworkCommand(filtered)
  else if (SS_CMDS.has(cmd))     action = parseScreenshotCommand(filtered)
  else if (LI_CMDS.has(cmd))     action = parseLinkedinCommand(filtered)
  else if (DATA_CMDS.has(cmd))   action = parseDataCommand(filtered)
  else if (META_CMDS.has(cmd))   action = await parseMetaCommand(filtered, jsonMode)
  else if (EVAL_CMDS.has(cmd))   action = parseEvalCommand(filtered)
  else if (BATCH_CMDS.has(cmd))  action = parseBatchCommand(filtered)
  else if (MONITOR_CMDS.has(cmd)) action = await parseMonitorCommand(filtered, jsonMode)
  else if (SCENE_CMDS.has(cmd))   action = await parseSceneCommand(filtered, jsonMode)
  else {
    console.error(`error: unknown command '${cmd}'. Run 'slop help' for usage.`)
    process.exit(1)
  }

  // null means the command handled its own output (status, events, session)
  if (action === null) return

  // Apply global modifiers
  if (anyTab) action.anyTab = true
  if (filtered.includes("--changes")) action.changes = true
  const frameIdx = args.indexOf("--frame")
  if (frameIdx !== -1 && args[frameIdx + 1]) {
    action.frameId = parseInt(args[frameIdx + 1])
  }

  try {
    const response = useWs
      ? await sendCommandWs(action, globalTabId)
      : await sendCommand(action, globalTabId)

    if (response.result) {
      const result = response.result

      // Screenshot save-to-disk post-processing
      if (result.success && result.data && typeof result.data === "object" &&
          (result.data as Record<string, unknown>).save &&
          (result.data as Record<string, unknown>).dataUrl) {
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

      // Pretty-print known result types
      if (!jsonMode && result.success) {
        if (action.type === "get_state") {
          console.log(formatState(result.data as Parameters<typeof formatState>[0]))
          return
        }
        if (action.type === "tab_list") {
          console.log(formatTabs(result.data as Parameters<typeof formatTabs>[0]))
          return
        }
        if (action.type === "cookies_get") {
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

main()
