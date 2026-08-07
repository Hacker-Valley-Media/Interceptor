/**
 * cli/commands/tabs.ts — tabs, tab new/close/switch, window, frames, session
 *
 * Returns null for "session" subcommands (handled locally, no daemon needed).
 */

import { unlinkSync } from "node:fs"
import { writeFileSync } from "node:fs"
import { buildTabCreateAction } from "./compound"

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

export async function parseTabsCommand(filtered: string[]): Promise<Action | null> {
  const cmd = filtered[0]

  switch (cmd) {
    case "tabs":
      return { type: "tab_list" }

    case "tab":
      switch (filtered[1]) {
        case "new": {
          // Background-first by default; --activate is the opt-in. Shares the
          // open-verb parser so --reuse works here too (it was silently ignored
          // before), but never sets policyDefault: `tab new` is
          // the ⌘T verb and always creates unless --reuse is explicit.
          return buildTabCreateAction(filtered, filtered[2])
        }
        case "close": {
          // The id is the first non-flag argument (`tab close --json` is a
          // valid no-arg close). Strict digits beyond that: parseInt would
          // partial-parse '12abc' to 12 and turn a typo'd id into a close of
          // a different (or the active) tab.
          const closeId = filtered.slice(2).find(a => !a.startsWith("-"))
          if (closeId !== undefined && !/^\d+$/.test(closeId)) {
            console.error(`error: tab close requires a numeric tab ID, got '${closeId}'`)
            process.exit(1)
          }
          return closeId
            ? { type: "tab_close", tabId: parseInt(closeId) }
            : { type: "tab_close" }
        }
        case "switch": {
          const switchId = filtered.slice(2).find(a => !a.startsWith("-"))
          if (switchId === undefined || !/^\d+$/.test(switchId)) {
            console.error(`error: tab switch requires a numeric tab ID${switchId !== undefined ? `, got '${switchId}'` : ""}`)
            process.exit(1)
          }
          return { type: "tab_switch", tabId: parseInt(switchId) }
        }
        default:
          console.error("error: unknown tab subcommand. Use: new, close, switch")
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
