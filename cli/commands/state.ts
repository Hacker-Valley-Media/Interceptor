/**
 * cli/commands/state.ts — state, tree, diff, find, text, html
 */

import { parseElementTarget } from "../parse"

type Action = { type: string; [key: string]: unknown }

// parseElementTarget falls through unknown strings to { ref: <arg> }, which
// would then misroute to the content script as a bogus ref lookup and surface
// a misleading "stale element" error. Reject at the parser instead with a
// clear message about the supported argument shapes.
function rejectIfBogusRef(cmdName: string, raw: string, target: ReturnType<typeof parseElementTarget>): void {
  const isValidRef = !!target.ref && /^e\d+$/.test(target.ref)
  const isValidIndex = target.index !== undefined && !Number.isNaN(target.index)
  const isValidSemantic = !!target.semantic
  if (!isValidRef && !isValidIndex && !isValidSemantic) {
    console.error(
      `error: ${cmdName} got '${raw}' but requires an element ref (e.g. 'e2'), an index (e.g. '5'), or 'role:name' (e.g. 'button:Submit'). ` +
      `Tag names and CSS selectors are not supported. Use 'interceptor read --tree-only' to find refs.`,
    )
    process.exit(1)
  }
}

export function parseStateCommand(filtered: string[]): Action {
  const cmd = filtered[0]

  switch (cmd) {
    case "state":
      return { type: "get_state", full: filtered.includes("--full"), tabId: filtered.includes("--tab") ? parseInt(filtered[filtered.indexOf("--tab") + 1]) : undefined }

    case "tree": {
      if (filtered.includes("--native")) {
        const depthIdx = filtered.indexOf("--depth")
        return { type: "cdp_tree", depth: depthIdx !== -1 ? parseInt(filtered[depthIdx + 1]) : undefined }
      }
      const depthIdx = filtered.indexOf("--depth")
      const filterIdx = filtered.indexOf("--filter")
      const maxCharsIdx = filtered.indexOf("--max-chars")
      return {
        type: "get_a11y_tree",
        depth: depthIdx !== -1 ? parseInt(filtered[depthIdx + 1]) : 15,
        filter: filterIdx !== -1 ? filtered[filterIdx + 1] : "interactive",
        maxChars: maxCharsIdx !== -1 ? parseInt(filtered[maxCharsIdx + 1]) : 50000
      }
    }

    case "diff":
      return { type: "diff" }

    case "find": {
      const roleIdx = filtered.indexOf("--role")
      const limitIdx = filtered.indexOf("--limit")
      const queryParts = filtered.slice(1).filter(
        a =>
          a !== "--role" &&
          a !== "--limit" &&
          (roleIdx === -1 || a !== filtered[roleIdx + 1]) &&
          (limitIdx === -1 || a !== filtered[limitIdx + 1])
      )
      return {
        type: "find_element",
        query: queryParts.join(" "),
        role: roleIdx !== -1 ? filtered[roleIdx + 1] : undefined,
        limit: limitIdx !== -1 ? parseInt(filtered[limitIdx + 1]) : 10
      }
    }

    case "text": {
      if (!filtered[1]) return { type: "extract_text" }
      const target = parseElementTarget(filtered[1])
      rejectIfBogusRef("text", filtered[1], target)
      return { type: "extract_text", ...target }
    }

    case "html": {
      if (!filtered[1]) {
        console.error(`error: html requires an element ref (e.g. 'html e2'). Use 'interceptor read --tree-only' to find refs.`)
        process.exit(1)
      }
      const target = parseElementTarget(filtered[1])
      rejectIfBogusRef("html", filtered[1], target)
      return { type: "extract_html", ...target }
    }

    default:
      console.error(`error: unknown state command '${cmd}'`)
      process.exit(1)
  }
}
