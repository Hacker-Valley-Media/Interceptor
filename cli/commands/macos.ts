/**
 * cli/commands/macos.ts — interceptor macos <subcommand>
 *
 * Parses `interceptor macos` subcommands into macos_ prefixed action objects
 * that get routed to the native bridge via the daemon.
 */

import { sendCommand, sendCommandWs, type DaemonResponse } from "../transport"

type Action = { type: string; [key: string]: unknown }
type Result = { success: boolean; error?: string; data?: unknown }

function unwrap(resp: DaemonResponse): Result {
  return resp.result
}

async function send(
  action: Action,
  tabId?: number,
  useWs = false
): Promise<Result> {
  try {
    const resp = useWs
      ? await sendCommandWs(action, tabId)
      : await sendCommand(action, tabId)
    return unwrap(resp)
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export async function runMacosCommand(
  filtered: string[],
  opts: { jsonMode?: boolean; useWs?: boolean; globalTabId?: number }
): Promise<void> {
  const action = parseMacosCommand(filtered)
  if (!action) process.exit(1)

  const result = await send(action, opts.globalTabId, opts.useWs)

  if (!result.success) {
    console.error("error:", result.error || "unknown error")
    process.exit(1)
  }

  if (opts.jsonMode) {
    console.log(JSON.stringify(result.data, null, 2))
  } else if (typeof result.data === "string") {
    console.log(result.data)
  } else if (result.data !== undefined && result.data !== null) {
    console.log(JSON.stringify(result.data, null, 2))
  } else {
    console.log("ok")
  }
}

export function parseMacosCommand(filtered: string[]): Action | null {
  const sub = filtered[1]
  if (!sub) {
    console.error("error: interceptor macos requires a subcommand. Examples:")
    console.error("  interceptor macos tree")
    console.error("  interceptor macos apps")
    console.error("  interceptor macos click e5")
    console.error("  interceptor macos trust")
    process.exit(1)
  }

  switch (sub) {
    // ── Accessibility ──
    case "tree":
      return {
        type: "macos_tree",
        app: flagVal(filtered, "--app"),
        pid: flagInt(filtered, "--pid"),
        filter: flagVal(filtered, "--filter") || "interactive",
        depth: flagInt(filtered, "--depth") || 10,
      }

    case "find": {
      const query = filtered[2]
      if (!query) { console.error("error: interceptor macos find requires a query"); process.exit(1) }
      return {
        type: "macos_find",
        query,
        app: flagVal(filtered, "--app"),
        role: flagVal(filtered, "--role"),
      }
    }

    case "inspect": {
      const ref = filtered[2]
      if (!ref) { console.error("error: interceptor macos inspect requires a ref (e.g. e5)"); process.exit(1) }
      return { type: "macos_inspect", ref }
    }

    case "value": {
      const ref = filtered[2]
      if (!ref) { console.error("error: interceptor macos value requires a ref"); process.exit(1) }
      const newValue = filtered[3]
      return { type: "macos_value", ref, ...(newValue !== undefined && { value: newValue }) }
    }

    case "action": {
      const ref = filtered[2]
      if (!ref) { console.error("error: interceptor macos action requires a ref"); process.exit(1) }
      const actionName = filtered[3] || "press"
      return { type: "macos_action", ref, action: actionName }
    }

    case "focused":
      return { type: "macos_focused", app: flagVal(filtered, "--app") }

    case "windows":
      return { type: "macos_windows", app: flagVal(filtered, "--app") }

    // ── Text ──
    case "text": {
      const ref = filtered[2]
      if (!ref) { console.error("error: interceptor macos text requires a ref"); process.exit(1) }
      const mode = filtered.includes("--selection") ? "selection" : filtered.includes("--visible") ? "visible" : "full"
      return { type: "macos_text", ref, mode }
    }

    // ── Menu ──
    case "menu": {
      const items = filtered.slice(2).filter(a => !a.startsWith("--"))
      return {
        type: "macos_menu",
        ...(items.length > 0 && { items }),
        app: flagVal(filtered, "--app"),
        pid: flagInt(filtered, "--pid"),
      }
    }

    // ── Trust ──
    case "trust":
      return { type: "macos_trust" }

    // ── Apps ──
    case "apps":
      return { type: "macos_apps" }

    case "app": {
      const subcommand = filtered[2] || "activate"
      const appName = flagVal(filtered, "--app") || filtered[3]
      return {
        type: "macos_app",
        subcommand,
        app: appName,
        pid: flagInt(filtered, "--pid"),
        bundleId: subcommand === "launch" ? (filtered[3] || flagVal(filtered, "--bundle")) : undefined,
      }
    }

    case "frontmost":
      return { type: "macos_frontmost" }

    // ── Input ──
    case "click": {
      const target = filtered[2]
      if (!target) { console.error("error: interceptor macos click requires a ref or coordinates"); process.exit(1) }
      const isCoords = target.includes(",")
      return {
        type: "macos_click",
        ...(isCoords ? { coords: target } : { ref: target }),
        double: filtered.includes("--double"),
        right: filtered.includes("--right"),
      }
    }

    case "type": {
      const refOrText = filtered[2]
      if (!refOrText) { console.error("error: interceptor macos type requires text or ref + text"); process.exit(1) }
      if (/^e\d+$/.test(refOrText) && filtered[3]) {
        return { type: "macos_type", ref: refOrText, text: filtered[3] }
      }
      return { type: "macos_type", text: refOrText }
    }

    case "keys": {
      const combo = filtered[2]
      if (!combo) { console.error("error: interceptor macos keys requires a key combo"); process.exit(1) }
      return { type: "macos_keys", keys: combo }
    }

    case "scroll": {
      const direction = filtered[2] || "down"
      const amount = parseInt(filtered[3] || "300")
      return {
        type: "macos_scroll",
        direction,
        amount: isNaN(amount) ? 300 : amount,
        ref: flagVal(filtered, "--ref"),
      }
    }

    case "resize": {
      const ref = filtered[2]
      const width = flagInt(filtered, "--width") || parseInt(filtered[3]) || undefined
      const height = flagInt(filtered, "--height") || parseInt(filtered[4]) || undefined
      if (!ref) { console.error("error: interceptor macos resize requires a ref"); process.exit(1) }
      return { type: "macos_resize", ref, width, height }
    }

    case "move": {
      const ref = filtered[2]
      const x = flagInt(filtered, "--x") || parseInt(filtered[3]) || 0
      const y = flagInt(filtered, "--y") || parseInt(filtered[4]) || 0
      if (!ref) { console.error("error: interceptor macos move requires a ref"); process.exit(1) }
      return { type: "macos_move", ref, x, y }
    }

    case "drag": {
      const from = filtered[2]
      const to = filtered[3]
      if (!from || !to) { console.error("error: interceptor macos drag requires from and to refs or coords"); process.exit(1) }
      const fromIsCoords = from.includes(",")
      const toIsCoords = to.includes(",")
      if (fromIsCoords && toIsCoords) {
        return { type: "macos_drag", fromCoords: from, toCoords: to }
      }
      return { type: "macos_drag", from, to }
    }

    // ── Screenshot / Capture ──
    case "screenshot":
      return {
        type: "macos_screenshot",
        app: flagVal(filtered, "--app"),
        display: flagInt(filtered, "--display"),
        window: flagInt(filtered, "--window"),
        save: filtered.includes("--save"),
        format: flagVal(filtered, "--format") || "jpeg",
        quality: flagInt(filtered, "--quality") || 80,
        element: flagVal(filtered, "--element"),
      }

    case "capture": {
      const op = filtered[2] || "frame"
      return {
        type: "macos_capture",
        sub: op,
        app: flagVal(filtered, "--app"),
      }
    }

    // ── Speech ──
    case "listen": {
      const op = filtered[2] || "status"
      return {
        type: "macos_listen",
        sub: op,
        device: flagVal(filtered, "--device"),
      }
    }

    case "vad": {
      const op = filtered[2] || "status"
      return { type: "macos_vad", sub: op }
    }

    // ── Sound ──
    case "sounds": {
      const op = filtered[2] || "status"
      return {
        type: "macos_sounds",
        sub: op,
        filter: flagVal(filtered, "--filter"),
      }
    }

    // ── Vision ──
    case "vision": {
      const op = filtered[2] || "text"
      return {
        type: "macos_vision",
        sub: op,
        app: flagVal(filtered, "--app"),
      }
    }

    // ── NLP ──
    case "nlp": {
      const op = filtered[2]
      if (!op) { console.error("error: interceptor macos nlp requires a subcommand (entities, language, sentiment, tokens, similar, embed)"); process.exit(1) }
      const text = filtered[3]
      return {
        type: `macos_nlp`,
        sub: op,
        text,
        word1: op === "similar" ? filtered[3] : undefined,
        word2: op === "similar" ? filtered[4] : undefined,
      }
    }

    // ── Intelligence ──
    case "ai": {
      const op = filtered[2] || "status"
      const prompt = filtered[3]
      return {
        type: "macos_ai",
        sub: op,
        prompt,
      }
    }

    // ── Sensitive ──
    case "sensitive": {
      const op = filtered[2] || "check"
      return {
        type: "macos_sensitive",
        sub: op,
        app: flagVal(filtered, "--app"),
      }
    }

    // ── Health ──
    case "health": {
      const op = filtered[2] || "status"
      return { type: "macos_health", sub: op }
    }

    // ── Files ──
    case "files": {
      const op = filtered[2] || "recent"
      const path = filtered[3]
      return {
        type: "macos_files",
        sub: op,
        path,
        filter: flagVal(filtered, "--filter"),
        app: flagVal(filtered, "--app"),
        limit: flagInt(filtered, "--limit"),
      }
    }

    // ── Notifications ──
    case "notifications": {
      const op = filtered[2] || "tail"
      return {
        type: "macos_notifications",
        sub: op,
        app: flagVal(filtered, "--app"),
        limit: flagInt(filtered, "--limit"),
      }
    }

    // ── Clipboard ──
    case "clipboard": {
      const op = filtered[2] || "read"
      const text = op === "write" ? filtered[3] : undefined
      return {
        type: "macos_clipboard",
        sub: op,
        text,
        contentType: flagVal(filtered, "--type"),
        image: flagVal(filtered, "--image"),
        limit: flagInt(filtered, "--limit"),
      }
    }

    // ── Display ──
    case "display": {
      const op = filtered[2] || "list"
      const resolution = filtered[3]
      return {
        type: "macos_display",
        sub: op,
        resolution,
        id: flagVal(filtered, "--id") || filtered[3],
        hidpi: filtered.includes("--hidpi"),
        hz: flagInt(filtered, "--hz"),
      }
    }

    // ── Audio ──
    case "audio": {
      const channel = filtered[2] || "output"
      const op = filtered[3] || "start"
      return {
        type: "macos_audio",
        sub: channel,
        op,
        app: flagVal(filtered, "--app"),
        device: flagVal(filtered, "--device"),
        save: filtered.includes("--save"),
      }
    }

    // ── Stream ──
    case "stream": {
      const op = filtered[2] || "status"
      return {
        type: "macos_stream",
        op,
        sid: flagVal(filtered, "--sid") || filtered[3],
        app: flagVal(filtered, "--app"),
        display: flagInt(filtered, "--display"),
        virtual: flagVal(filtered, "--virtual"),
        format: flagVal(filtered, "--format"),
      }
    }

    // ── Monitor ──
    case "monitor": {
      const op = filtered[2] || "status"
      return {
        type: "macos_monitor",
        sub: op,
        sid: flagVal(filtered, "--sid") || (op === "export" ? filtered[3] : undefined),
        instruction: flagVal(filtered, "--instruction"),
        format: filtered.includes("--json") ? "json" : filtered.includes("--plan") ? "plan" : "timeline",
        raw: filtered.includes("--raw"),
        limit: flagInt(filtered, "--limit"),
      }
    }

    // ── Compound Commands ──
    case "open": {
      const appName = filtered[2] || flagVal(filtered, "--app")
      return {
        type: "macos_compound",
        sub: "open",
        app: appName,
        pid: flagInt(filtered, "--pid"),
        filter: flagVal(filtered, "--filter") || "interactive",
        depth: flagInt(filtered, "--depth") || 10,
      }
    }

    case "read": {
      return {
        type: "macos_compound",
        sub: "read",
        app: flagVal(filtered, "--app"),
        pid: flagInt(filtered, "--pid"),
        filter: flagVal(filtered, "--filter") || "interactive",
        depth: flagInt(filtered, "--depth") || 10,
      }
    }

    case "act": {
      const target = filtered[2]
      if (!target) { console.error("error: interceptor macos act requires a ref"); process.exit(1) }
      const text = filtered[3]
      return {
        type: "macos_compound",
        sub: "act",
        ref: target,
        text,
        app: flagVal(filtered, "--app"),
        pid: flagInt(filtered, "--pid"),
      }
    }

    case "inspect": {
      return {
        type: "macos_compound",
        sub: "inspect",
        app: flagVal(filtered, "--app"),
        pid: flagInt(filtered, "--pid"),
      }
    }

    default:
      console.error(`error: unknown macos subcommand '${sub}'. Run 'interceptor help' for usage.`)
      process.exit(1)
  }
}

// ── Flag helpers ──

function flagVal(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1 || !args[idx + 1]) return undefined
  return args[idx + 1]
}

function flagInt(args: string[], flag: string): number | undefined {
  const val = flagVal(args, flag)
  if (val === undefined) return undefined
  const n = parseInt(val)
  return isNaN(n) ? undefined : n
}
