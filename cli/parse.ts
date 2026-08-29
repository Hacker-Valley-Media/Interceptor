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

/**
 * Derive the per-session group label: `s-` + 8 hex chars of FNV-1a over the
 * WHOLE session id. A hash, deliberately not a sanitized prefix — prefix
 * truncation collapses entropy on format-prefixed ids (`local_c1ec3b94-…`
 * would leave two discriminating characters and collide across concurrent
 * sessions; the hash is format-independent). Returns undefined for an empty id.
 */
export function deriveSessionGroupLabel(sessionId: string): string | undefined {
  if (sessionId.length === 0) return undefined
  let h = 0x811c9dc5
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `s-${h.toString(16).padStart(8, "0")}`
}

export type GroupScope = { label: string | undefined; derived: boolean }

/**
 * Group scope resolution, highest precedence first:
 *   1. --no-group                 explicit per-call opt-out (default group)
 *   2. --group <label>            explicit per-call choice
 *   3. $INTERCEPTOR_GROUP         explicit per-environment choice; SET-BUT-EMPTY
 *                                 means "the shared default group" (opts out of 4)
 *   4. derived from $CLAUDE_CODE_SESSION_ID — agent shells get a per-session
 *                                 group automatically (`derived: true`)
 *
 * Rationale for 4: the extension's tab-lifecycle policy reuse applies to NAMED
 * groups only (in the shared default group "most recent tab" can be a sibling
 * agent's), so a bare `open` from an agent used to create a fresh tab every
 * call — 200+ opens in one research session meant 200+ tabs, and the idle
 * sweep couldn't fire while the session kept the group active. Deriving a
 * per-session group restores one-tab-per-session reuse AND lets the sweep
 * close each session's group independently once that session goes quiet,
 * without weakening the sibling-isolation rule that keeps the default group
 * reuse-free. Interactive human shells (no session id) are unchanged.
 *
 * `derived` rides the wire as `groupDerived` so the extension can treat a
 * derived group as a soft preference (creation home, reuse, sweep unit) and
 * NOT as the hard isolation boundary an explicit --group asks for — the
 * caller never chose isolation, so empty-group resolution falls back to the
 * active tab and explicit --tab targets are not membership-gated against it.
 *
 * NOTE: parallel subagents inherit the parent's CLAUDE_CODE_SESSION_ID (no
 * per-agent env discriminator exists), so sibling lanes SHARE the derived
 * group and policy reuse can navigate a tab another lane is using. Lanes that
 * run Interceptor concurrently must pass an explicit `--group lane-<n>` each.
 */
export function resolveGroupScope(args: string[], env: Record<string, string | undefined> = process.env): GroupScope {
  const idx = args.indexOf("--group")
  if (args.includes("--no-group")) {
    if (idx !== -1) {
      console.error("error: --no-group conflicts with --group")
      process.exit(1)
    }
    return { label: undefined, derived: false }
  }
  let label: string | undefined
  let derived = false
  if (idx !== -1) {
    if (!args[idx + 1] || args[idx + 1].startsWith("--")) {
      console.error("error: --group requires a label")
      process.exit(1)
    }
    label = args[idx + 1]
  } else if (env.INTERCEPTOR_GROUP !== undefined) {
    // Set-but-empty is a deliberate opt-out: target the default group.
    label = env.INTERCEPTOR_GROUP === "" ? undefined : env.INTERCEPTOR_GROUP
  } else if (env.CLAUDE_CODE_SESSION_ID) {
    label = deriveSessionGroupLabel(env.CLAUDE_CODE_SESSION_ID)
    derived = label !== undefined
  }
  if (label !== undefined && !GROUP_LABEL_RE.test(label)) {
    console.error(`error: invalid group label '${label}' — must match [A-Za-z0-9_-]{1,32}`)
    process.exit(1)
  }
  return { label, derived }
}

/** Back-compat label-only view of resolveGroupScope. */
export function parseGroupFlag(args: string[], env: Record<string, string | undefined> = process.env): string | undefined {
  return resolveGroupScope(args, env).label
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
