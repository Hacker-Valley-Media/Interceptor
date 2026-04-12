import { HELP } from "./help"
import { parseTabFlag } from "./parse"
import { formatState, formatTabs, formatCookies, formatResult } from "./format"
import { sendCommand, sendCommandWs, type DaemonResult, type DaemonResponse } from "./transport"
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
import { parseSseCommand } from "./commands/sse"
import { parseChatgptCommand } from "./commands/chatgpt"
import { runCompoundCommand } from "./commands/compound"
import { runOverride } from "./commands/override"

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
const SSE_CMDS = new Set(["sse"])
const CHATGPT_CMDS = new Set(["chatgpt"])
const COMPOUND_CMDS = new Set(["open", "read", "act", "inspect"])
const OVERRIDE_CMDS = new Set(["override"])

// Commands that don't require a daemon connection
const NO_DAEMON = new Set(["status", "help", "events", "session"])

// Monitor subcommands that are handled locally (no daemon needed)
const MONITOR_LOCAL_SUBCOMMANDS = new Set(["tail", "list", "export"])

function unwrapResult(response: DaemonResponse): DaemonResult {
  return response.result
}

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

  if (COMPOUND_CMDS.has(cmd)) {
    await runCompoundCommand(cmd, filtered, { jsonMode, useWs, globalTabId, anyTab })
    return
  }

  if (OVERRIDE_CMDS.has(cmd)) {
    await runOverride(filtered, { jsonMode, useWs, globalTabId })
    return
  }

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
  else if (SSE_CMDS.has(cmd))     action = parseSseCommand(filtered)
  else if (CHATGPT_CMDS.has(cmd)) action = await parseChatgptCommand(filtered, jsonMode)
  else {
    console.error(`error: unknown command '${cmd}'. Run 'slop help' for usage.`)
    process.exit(1)
  }

  // null means the command handled its own output (status, events, session)
  if (action === null) return

  if (action && action.type === "sse_tail") {
    const filter = (action.filter as string) || ""
    const timeout = (action.timeout as number) || 60000
    const startTime = Date.now()
    let offset = 0
    let lastActive = true

    while (Date.now() - startTime < timeout) {
      try {
        const chunkAction = { type: "sse_chunk", filter, since: offset }
        const resp = useWs
          ? await sendCommandWs(chunkAction, globalTabId)
          : await sendCommand(chunkAction, globalTabId)
        const result = unwrapResult(resp)
        if (result?.success && result.data) {
          const d = result.data as { active: boolean; text?: string; offset?: number }
          if (d.text) {
            process.stdout.write(d.text)
            offset = d.offset || offset
          }
          if (!d.active && lastActive) {
            // stream ended
            break
          }
          lastActive = d.active
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200))
    }
    process.exit(0)
  }

  if (action && action.type === "chatgpt_send") {
    const prompt = action.prompt as string
    const streamMode = action.stream as boolean

    // Step 1: Find the textbox
    const treeResp = useWs
      ? await sendCommandWs({ type: "get_a11y_tree", filter: "interactive" }, globalTabId)
      : await sendCommand({ type: "get_a11y_tree", filter: "interactive" }, globalTabId)
    const tree = (unwrapResult(treeResp).data || "") as string
    const match = tree.match(/\[(e\d+)\]\s+textbox\s+"Chat with ChatGPT"/)
    if (!match) {
      console.error("error: could not find ChatGPT input textbox. Is chatgpt.com open in a slop tab?")
      process.exit(1)
    }
    const inputRef = match[1]

    // Step 2: Type the prompt
    const typeAction = { type: "input_text", ref: inputRef, text: prompt }
    await (useWs
      ? sendCommandWs(typeAction, globalTabId)
      : sendCommand(typeAction, globalTabId))

    // Step 3: Press Enter
    const enterAction = { type: "send_keys", keys: "Enter" }
    await (useWs
      ? sendCommandWs(enterAction, globalTabId)
      : sendCommand(enterAction, globalTabId))

    // Step 4: Wait for SSE stream then tail it
    await new Promise(r => setTimeout(r, 1500))

    let offset = 0
    let retries = 0
    const maxWait = 120000
    const startTime = Date.now()
    let fullResponse = ""

    while (Date.now() - startTime < maxWait) {
      try {
        const chunkAction = { type: "sse_chunk", filter: "backend-api/f/conversation", since: offset }
        const resp = useWs
          ? await sendCommandWs(chunkAction, globalTabId)
          : await sendCommand(chunkAction, globalTabId)
        const result = unwrapResult(resp)
        if (result?.success && result.data) {
          const d = result.data as { active: boolean; text?: string; offset?: number }
          if (d.text) {
            if (streamMode) process.stdout.write(d.text)
            fullResponse += d.text
            offset = d.offset || offset
            retries = 0
          }
          if (!d.active && offset > 0) break
          if (!d.active && retries++ > 15) break
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200))
    }

    if (!streamMode && fullResponse) {
      // Parse SSE data lines to extract text
      const lines = fullResponse.split("\n")
      const parts: string[] = []
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const payload = line.slice(6).trim()
        if (payload === "[DONE]") break
        try {
          const obj = JSON.parse(payload)
          const content = obj?.message?.content?.parts
          if (Array.isArray(content)) {
            for (const p of content) {
              if (typeof p === "string") parts.push(p)
            }
          }
        } catch {}
      }
      const lastPart = parts[parts.length - 1] || ""
      if (jsonMode) {
        console.log(JSON.stringify({ success: true, response: lastPart }))
      } else {
        console.log(lastPart)
      }
    } else if (streamMode) {
      console.log() // trailing newline
    }

    process.exit(0)
  }

  if (action && action.type === "chatgpt_read") {
    const textAction = { type: "extract_text" }
    const resp = useWs
      ? await sendCommandWs(textAction, globalTabId)
      : await sendCommand(textAction, globalTabId)
    const result = unwrapResult(resp)
    if (result?.success) {
      const text = result.data as string
      const chatMarker = text.indexOf("ChatGPT said:")
      if (chatMarker >= 0) {
        console.log(text.slice(chatMarker))
      } else {
        console.log(text)
      }
    } else {
      console.error("error:", result?.error || "failed to read page text")
    }
    process.exit(0)
  }

  if (action && action.type === "chatgpt_status") {
    const streamsResp = useWs
      ? await sendCommandWs({ type: "sse_streams" }, globalTabId)
      : await sendCommand({ type: "sse_streams" }, globalTabId)
    const streams = (unwrapResult(streamsResp).data || []) as any[]
    const active = streams.filter((s: any) => s.url?.includes("backend-api"))

    console.log(JSON.stringify({
      streaming: active.length > 0,
      activeStreams: active.length,
      streams: active.map((s: any) => ({ url: s.url, chunks: s.chunkCount, bytes: s.totalBytes, duration: s.duration }))
    }, null, 2))
    process.exit(0)
  }

  if (action && action.type === "chatgpt_conversations") {
    const netAction = { type: "net_log", filter: "conversations?offset", limit: 1 }
    const resp = useWs
      ? await sendCommandWs(netAction, globalTabId)
      : await sendCommand(netAction, globalTabId)
    const result = unwrapResult(resp)
    if (result?.success && Array.isArray(result.data) && result.data.length > 0) {
      try {
        const body = JSON.parse(result.data[result.data.length - 1].body)
        const items = body.items || []
        for (const item of items.slice(0, 20)) {
          console.log(`${item.id}  ${item.title || "(untitled)"}  ${item.update_time || ""}`)
        }
      } catch {
        console.log("(could not parse conversations response)")
      }
    } else {
      console.log("(no cached conversations response — navigate to chatgpt.com first)")
    }
    process.exit(0)
  }

  if (action && action.type === "chatgpt_switch") {
    const convId = action.conversationId as string
    const navAction = { type: "navigate", url: `https://chatgpt.com/c/${convId}` }
    await (useWs
      ? sendCommandWs(navAction, globalTabId)
      : sendCommand(navAction, globalTabId))
    console.log("ok")
    process.exit(0)
  }

  if (action && action.type === "chatgpt_stop") {
    const treeResp = useWs
      ? await sendCommandWs({ type: "get_a11y_tree", filter: "interactive" }, globalTabId)
      : await sendCommand({ type: "get_a11y_tree", filter: "interactive" }, globalTabId)
    const tree = (unwrapResult(treeResp).data || "") as string
    const stopMatch = tree.match(/\[(e\d+)\]\s+button\s+"Stop"/)
    if (stopMatch) {
      await (useWs
        ? sendCommandWs({ type: "click", ref: stopMatch[1] }, globalTabId)
        : sendCommand({ type: "click", ref: stopMatch[1] }, globalTabId))
      console.log("stopped")
    } else {
      console.log("(no Stop button found — generation may not be active)")
    }
    process.exit(0)
  }

  if (action && action.type === "chatgpt_model") {
    const name = action.name as string | undefined
    if (!name) {
      const treeResp = useWs
        ? await sendCommandWs({ type: "get_a11y_tree", filter: "interactive" }, globalTabId)
        : await sendCommand({ type: "get_a11y_tree", filter: "interactive" }, globalTabId)
      const tree = (unwrapResult(treeResp).data || "") as string
      const modelMatch = tree.match(/\[(e\d+)\]\s+button\s+"Model selector"/)
      if (modelMatch) {
        console.log("Model selector found at", modelMatch[1])
      }
      const modelNameMatch = tree.match(/button\s+"((?:GPT|o\d|gpt)[^"]*)"/)
      if (modelNameMatch) {
        console.log("Active model:", modelNameMatch[1])
      }
    }
    process.exit(0)
  }

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
    const result = unwrapResult(response)

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
  } catch (err) {
    console.error(`error: ${(err as Error).message}`)
    process.exit(1)
  }
}

main()
