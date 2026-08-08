/**
 * cli/parse.ts — argument parsing utilities shared across command modules
 */

export function parseElementTarget(arg: string): { index?: number; ref?: string; frameId?: number; semantic?: { role: string; name: string } } {
  // Every caller that allows an absent target guards before calling (focus,
  // upload, text, html, read, act) — reaching here with no arg is always a
  // caller mistake, and without this gate it surfaced as a raw TypeError from
  // the compiled binary instead of usage.
  if (!arg) {
    console.error(
      "error: this command requires an element target — a ref (e.g. 'e2'), an index (e.g. '5'), or 'role:name' (e.g. 'button:Submit'). " +
      "Run 'interceptor read --tree-only' to find refs.",
    )
    process.exit(1)
  }
  const framed = /^e(\d+)_(\d+)$/.exec(arg)
  if (framed) {
    return { ref: `e${framed[2]}`, frameId: parseInt(framed[1], 10) }
  }
  if (/^e\d+$/.test(arg)) return { ref: arg }
  const n = parseInt(arg)
  if (!isNaN(n)) return { index: n }
  const colonIdx = arg.indexOf(":")
  if (colonIdx > 0) {
    return { semantic: { role: arg.slice(0, colonIdx), name: arg.slice(colonIdx + 1) } }
  }
  return { ref: arg }
}

export function parseTabFlag(args: string[]): number | undefined {
  const idx = args.indexOf("--tab")
  if (idx === -1) return undefined
  if (!args[idx + 1]) {
    console.error("error: --tab requires a numeric tab ID")
    process.exit(1)
  }
  const tabId = parseInt(args[idx + 1])
  if (isNaN(tabId)) {
    console.error(`error: --tab requires a numeric tab ID, got '${args[idx + 1]}'`)
    process.exit(1)
  }
  return tabId
}

export function parseContextFlag(args: string[]): string | undefined {
  const idx = args.indexOf("--context")
  if (idx === -1) return undefined
  if (!args[idx + 1] || args[idx + 1].startsWith("--")) {
    console.error("error: --context requires a context ID")
    process.exit(1)
  }
  return args[idx + 1]
}

// per-agent named tab groups. Labels become part of a tab-strip title.
export const GROUP_LABEL_RE = /^[A-Za-z0-9_-]{1,32}$/

/** --group <label>, falling back to $INTERCEPTOR_GROUP (flag wins). */
export function parseGroupFlag(args: string[], env: Record<string, string | undefined> = process.env): string | undefined {
  const idx = args.indexOf("--group")
  let label: string | undefined
  if (idx !== -1) {
    if (!args[idx + 1] || args[idx + 1].startsWith("--")) {
      console.error("error: --group requires a label")
      process.exit(1)
    }
    label = args[idx + 1]
  } else if (env.INTERCEPTOR_GROUP) {
    label = env.INTERCEPTOR_GROUP
  }
  if (label !== undefined && !GROUP_LABEL_RE.test(label)) {
    console.error(`error: invalid group label '${label}' — must match [A-Za-z0-9_-]{1,32}`)
    process.exit(1)
  }
  return label
}

const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]

/** --group-color <color>, validated against the closed Chrome tabGroups enum. */
export function parseGroupColorFlag(args: string[]): string | undefined {
  const idx = args.indexOf("--group-color")
  if (idx === -1) return undefined
  const color = args[idx + 1]
  if (!color || !GROUP_COLORS.includes(color)) {
    console.error(`error: invalid --group-color '${color ?? ""}' (must be one of: ${GROUP_COLORS.join(", ")})`)
    process.exit(1)
  }
  return color
}
