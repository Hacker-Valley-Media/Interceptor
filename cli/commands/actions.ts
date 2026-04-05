/**
 * cli/commands/actions.ts — click, type, select, hover, drag, dblclick, rightclick,
 *                           check, keys, focus, blur, click-at, what-at, regions
 */

import { parseElementTarget } from "../parse"

type Action = { type: string; [key: string]: unknown }

function parseAt(filtered: string[]): { x?: number; y?: number } {
  if (filtered.includes("--at")) {
    const parts = filtered[filtered.indexOf("--at") + 1].split(",").map(Number)
    return { x: parts[0], y: parts[1] }
  }
  return {}
}

export function parseActionsCommand(filtered: string[]): Action {
  const cmd = filtered[0]

  switch (cmd) {
    case "click": {
      const useOs = filtered.includes("--os")
      const target = parseElementTarget(filtered[1])
      const at = parseAt(filtered)
      if (useOs) {
        return { type: "os_click", ...target, ...at }
      } else if (target.semantic) {
        return { type: "find_and_click", name: target.semantic.name, role: target.semantic.role, ...at }
      } else {
        return { type: "click", ...target, ...at }
      }
    }

    case "type": {
      const append = filtered.includes("--append")
      const useOs = filtered.includes("--os")
      const target = parseElementTarget(filtered[1])
      const textArgs = filtered.slice(2).filter(a => a !== "--append" && a !== "--os")
      if (useOs) {
        return { type: "os_type", ...target, text: textArgs.join(" ") }
      } else if (target.semantic) {
        return { type: "find_and_type", name: target.semantic.name, role: target.semantic.role, inputText: textArgs.join(" "), clear: !append }
      } else {
        return { type: "input_text", ...target, text: textArgs.join(" "), clear: !append }
      }
    }

    case "select":
      return { type: "select_option", ...parseElementTarget(filtered[1]), value: filtered[2] }

    case "focus":
      if (!filtered[1]) {
        return { type: "get_focus" }
      } else {
        return { type: "focus", ...parseElementTarget(filtered[1]) }
      }

    case "blur":
      return { type: "blur" }

    case "hover": {
      const hoverAction: Record<string, unknown> = { type: "hover", ...parseElementTarget(filtered[1]) }
      if (filtered.includes("--from")) {
        const fromParts = filtered[filtered.indexOf("--from") + 1].split(",").map(Number)
        hoverAction.fromX = fromParts[0]
        hoverAction.fromY = fromParts[1]
      }
      if (filtered.includes("--steps")) {
        hoverAction.steps = parseInt(filtered[filtered.indexOf("--steps") + 1])
      }
      return hoverAction
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
      return dragAction
    }

    case "dblclick": {
      return { type: "dblclick", ...parseElementTarget(filtered[1]), ...parseAt(filtered) }
    }

    case "rightclick": {
      return { type: "rightclick", ...parseElementTarget(filtered[1]), ...parseAt(filtered) }
    }

    case "check":
      return { type: "check", ...parseElementTarget(filtered[1]), checked: filtered[2] !== "false" }

    case "keys": {
      if (filtered.includes("--os")) {
        const parts = filtered[1].split("+")
        const key = parts[parts.length - 1]
        const modifiers = parts.slice(0, -1)
        return { type: "os_key", key, modifiers }
      } else {
        return { type: "send_keys", keys: filtered[1] }
      }
    }

    case "click-at": {
      const coords = filtered[1]?.split(",").map(Number)
      if (!coords || coords.length !== 2 || coords.some(isNaN)) {
        console.error("error: click-at requires X,Y coordinates. Usage: slop click-at 500,300")
        process.exit(1)
      }
      return { type: "click_at", x: coords[0], y: coords[1] }
    }

    case "what-at": {
      const coords = filtered[1]?.split(",").map(Number)
      if (!coords || coords.length !== 2 || coords.some(isNaN)) {
        console.error("error: what-at requires X,Y coordinates. Usage: slop what-at 500,300")
        process.exit(1)
      }
      return { type: "what_at", x: coords[0], y: coords[1] }
    }

    case "regions":
      return { type: "regions" }

    default:
      console.error(`error: unknown actions command '${cmd}'`)
      process.exit(1)
  }
}
