/**
 * cli/commands/tabs.ts — tabs, tab new/close/switch/designate/self, window, frames, session
 *
 * Returns null for "session" subcommands (handled locally, no daemon needed).
 */

import { unlinkSync } from "node:fs"
import { writeFileSync } from "node:fs"
import { sendCommand } from "../transport"
import { loadDesignatedTab, saveDesignatedTab } from "./session-tab"

type Action = { type: string; [key: string]: unknown }

const WINDOW_RESIZE_NUMBER_FLAGS = new Set(["--left", "--top", "--width", "--height"])
const WINDOW_RESIZE_FLAGS = new Set([...WINDOW_RESIZE_NUMBER_FLAGS, "--state"])
const WINDOW_GEOMETRY_KEYS = ["left", "top", "width", "height"] as const
const WINDOW_STATES = new Set(["normal", "minimized", "maximized", "fullscreen", "locked-fullscreen"])
const WINDOW_STATES_WITHOUT_GEOMETRY = new Set(["minimized", "maximized", "fullscreen", "locked-fullscreen"])

function parseIntegerArg(label: string, raw: string | undefined): number {
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error(`${label} requires a value`)
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${label} must be an integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} is outside the safe integer range`)
  }
  return value
}

function parsePositiveIntegerArg(label: string, raw: string | undefined): number {
  const value = parseIntegerArg(label, raw)
  if (value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value
}

function windowResizeKeyForFlag(flag: string): "left" | "top" | "width" | "height" {
  return flag.slice(2) as "left" | "top" | "width" | "height"
}

function die(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

function parseWindowIdForCli(raw: string | undefined): number {
  try {
    return parsePositiveIntegerArg("window id", raw)
  } catch (err) {
    die((err as Error).message)
  }
}

export function buildWindowResizeAction(args: string[]): Action {
  const action: Action = { type: "window_resize" }
  let i = 0
  const positional: string[] = []

  if (args[0] && !args[0].startsWith("--")) {
    action.windowId = parsePositiveIntegerArg("window id", args[0])
    i = 1
  }

  for (; i < args.length; i++) {
    const token = args[i]
    if (token.startsWith("--")) {
      if (!WINDOW_RESIZE_FLAGS.has(token)) {
        throw new Error(`unknown window resize flag: ${token}`)
      }
      if (token === "--state") {
        const state = args[i + 1]
        if (!state || state.startsWith("--")) {
          throw new Error("--state requires a value")
        }
        if (!WINDOW_STATES.has(state)) {
          throw new Error(`invalid window state: ${state}`)
        }
        action.state = state
        i++
        continue
      }

      const key = windowResizeKeyForFlag(token)
      const label = token
      action[key] = key === "width" || key === "height"
        ? parsePositiveIntegerArg(label, args[i + 1])
        : parseIntegerArg(label, args[i + 1])
      i++
      continue
    }

    positional.push(token)
  }

  if (positional.length > 0) {
    if (action.windowId === undefined) {
      throw new Error("positional width/height require an explicit window id")
    }
    if (positional.length !== 2) {
      throw new Error("usage: interceptor window resize <window-id> <width> <height>")
    }
    if (action.width !== undefined || action.height !== undefined) {
      throw new Error("do not combine positional width/height with --width or --height")
    }
    action.width = parsePositiveIntegerArg("width", positional[0])
    action.height = parsePositiveIntegerArg("height", positional[1])
  }

  const state = action.state as string | undefined
  const hasGeometry = WINDOW_GEOMETRY_KEYS.some((key) => action[key] !== undefined)
  if (state && WINDOW_STATES_WITHOUT_GEOMETRY.has(state) && hasGeometry) {
    throw new Error(`${state} cannot be combined with left, top, width, or height`)
  }
  if (!state && !hasGeometry) {
    throw new Error("window resize requires --state or at least one geometry field")
  }

  return action
}

// `interceptor tab designate` with no id: pin the most recently opened
// interceptor-managed tab (highest tab id among the interceptor group,
// falling back to the highest id overall if none are managed).
async function resolveMostRecentTab(contextId?: string): Promise<number | undefined> {
  const resp = await sendCommand({ type: "tab_list" }, undefined, contextId)
  const result = resp.result
  if (!result.success) {
    throw new Error(result.error || "failed to list tabs")
  }
  const tabs = (result.data as Array<{ id?: number; managed?: boolean }>) || []
  const withIds = tabs.filter((t): t is { id: number; managed?: boolean } => typeof t.id === "number")
  const pool = withIds.some(t => t.managed) ? withIds.filter(t => t.managed) : withIds
  if (pool.length === 0) return undefined
  return pool.reduce((a, b) => (b.id > a.id ? b : a)).id
}

async function runTabDesignate(args: string[], jsonMode: boolean, contextId?: string): Promise<null> {
  let tabId: number

  if (args[0] && !args[0].startsWith("--")) {
    tabId = parseInt(args[0], 10)
    if (isNaN(tabId)) die(`invalid tab id: ${args[0]}`)
  } else {
    let resolved: number | undefined
    try {
      resolved = await resolveMostRecentTab(contextId)
    } catch (err) {
      die((err as Error).message)
    }
    if (resolved === undefined) {
      die("no tabs found to designate. Open one with 'interceptor open <url>' first.")
    }
    tabId = resolved
  }

  saveDesignatedTab(tabId)

  if (jsonMode) {
    console.log(JSON.stringify({ tab_id: tabId, designated: true }))
  } else {
    console.log(`Designated tab ${tabId} as working tab`)
  }
  return null
}

function runTabSelf(jsonMode: boolean): null {
  const tabId = loadDesignatedTab()
  if (tabId === undefined) {
    console.error("error: No tab designated. Run `interceptor tab designate [id]` first.")
    process.exit(1)
  }
  if (jsonMode) {
    console.log(JSON.stringify({ tab_id: tabId }))
  } else {
    console.log(String(tabId))
  }
  return null
}

export async function parseTabsCommand(filtered: string[], jsonMode = false, contextId?: string): Promise<Action | null> {
  const cmd = filtered[0]

  switch (cmd) {
    case "tabs":
      return { type: "tab_list" }

    case "tab":
      switch (filtered[1]) {
        case "new": {
          // Background-first by default; --activate is the opt-in.
          const action: Action = { type: "tab_create", url: filtered[2] }
          if (filtered.includes("--activate")) action.active = true
          return action
        }
        case "close":
          return filtered[2]
            ? { type: "tab_close", tabId: parseInt(filtered[2]) }
            : { type: "tab_close" }
        case "switch":
          return { type: "tab_switch", tabId: parseInt(filtered[2]) }
        case "designate":
          return runTabDesignate(filtered.slice(2), jsonMode, contextId)
        case "self":
          return runTabSelf(jsonMode)
        default:
          // Shorthand: `interceptor tab <id>` targets a specific tab by
          // switching focus to it (mirrors `tab switch <id>`).
          if (filtered[1] && /^\d+$/.test(filtered[1])) {
            return { type: "tab_switch", tabId: parseInt(filtered[1], 10) }
          }
          console.error("error: unknown tab subcommand. Use: new, close, switch, designate, self")
          process.exit(1)
      }
      break

    case "window":
      switch (filtered[1]) {
        case "new":
          return { type: "window_create", url: filtered[2], incognito: filtered.includes("--incognito") }
        case "close":
          return { type: "window_close", windowId: parseWindowIdForCli(filtered[2]) }
        case "focus":
          return { type: "window_focus", windowId: parseWindowIdForCli(filtered[2]) }
        case "resize": {
          try {
            return buildWindowResizeAction(filtered.slice(2))
          } catch (err) {
            die((err as Error).message)
          }
        }
        case "list":
        default:
          return { type: "window_list" }
      }

    case "frames":
      return { type: "frames_list" }

    case "session": {
      const sessionPath = "/tmp/interceptor-session.pid"
      if (filtered[1] === "start") {
        writeFileSync(sessionPath, `${process.pid}\n${Date.now()}`)
        console.log(`session started (pid: ${process.pid})`)
        console.log("session mode: batch commands recommended for best performance")
        return null
      }
      if (filtered[1] === "end") {
        try { unlinkSync(sessionPath) } catch {}
        console.log("session ended")
        return null
      }
      console.error("error: usage: interceptor session start|end")
      process.exit(1)
    }

    default:
      console.error(`error: unknown tabs command '${cmd}'`)
      process.exit(1)
  }
}
