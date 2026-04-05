/**
 * cli/commands/state.ts — state, tree, diff, find, text, html
 */

import { parseElementTarget } from "../parse"

type Action = { type: string; [key: string]: unknown }

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

    case "text":
      return filtered[1]
        ? { type: "extract_text", ...parseElementTarget(filtered[1]) }
        : { type: "extract_text" }

    case "html":
      return { type: "extract_html", ...parseElementTarget(filtered[1]) }

    default:
      console.error(`error: unknown state command '${cmd}'`)
      process.exit(1)
  }
}
