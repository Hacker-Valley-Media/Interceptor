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
      `Tag names and bare CSS selectors are not positional targets — for selectors use 'interceptor click --selector "<css>"'. Use 'interceptor read --tree-only' to find refs.`,
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
      const firstFlag = filtered.findIndex((arg, index) => index > 0 && arg.startsWith("--"))
      const queryParts = filtered.slice(1, firstFlag === -1 ? filtered.length : firstFlag)
      const query = queryParts.join(" ").trim()
      if (!query) {
        console.error('error: interceptor find requires a non-empty query. Usage: interceptor find "<query>"')
        process.exit(1)
      }
      const textOnly = filtered.includes("--text-only")
      const elementsOnly = filtered.includes("--elements-only")
      if (textOnly && elementsOnly) {
        console.error("error: --text-only and --elements-only are mutually exclusive")
        process.exit(1)
      }
      if (textOnly && roleIdx !== -1) {
        console.error("error: --role selects element mode and cannot be combined with --text-only")
        process.exit(1)
      }
      const limit = limitIdx !== -1 ? parseInt(filtered[limitIdx + 1]) : 10
      if (!Number.isFinite(limit) || limit < 0) {
        console.error("error: --limit must be a non-negative integer")
        process.exit(1)
      }
      return {
        type: filtered.includes("--include-frames") ? "frames_find" : "find_element",
        query,
        role: roleIdx !== -1 ? filtered[roleIdx + 1] : undefined,
        mode: textOnly ? "text" : (elementsOnly || roleIdx !== -1) ? "elements" : "hybrid",
        limit
      }
    }

    case "text": {
      const markdown = filtered.includes("--markdown")
      const actionType: "extract_text" | "extract_markdown" = markdown ? "extract_markdown" : "extract_text"
      const refArg = filtered[1] && !filtered[1].startsWith("--") ? filtered[1] : undefined
      if (!refArg) return { type: actionType }
      const target = parseElementTarget(refArg)
      rejectIfBogusRef("text", refArg, target)
      return { type: actionType, ...target }
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
