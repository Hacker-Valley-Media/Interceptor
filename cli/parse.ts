/**
 * cli/parse.ts — argument parsing utilities shared across command modules
 */

import { createHash } from "node:crypto"

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

/** Derive an opaque, valid tab-group label without exposing the session id. */
export function deriveSessionGroupLabel(sessionId: string): string | undefined {
  if (sessionId.length === 0) return undefined
  return `s-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`
}

export type GroupScope = { label: string | undefined; soft: boolean }

const SESSION_ID_ENV_KEYS = [
  "INTERCEPTOR_SESSION_ID",
  "MAESTRO_COWORKING_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
] as const

/** Neutral public contract first, then verified host adapters. */
export function resolveSessionId(env: Record<string, string | undefined>): string | undefined {
  for (const key of SESSION_ID_ENV_KEYS) {
    const value = env[key]
    if (value?.trim()) return value
  }
  return undefined
}

/**
 * Group scope resolution, highest precedence first:
 *   1. --shared-group             explicit per-call opt-out (shared default group)
 *   2. --group <label>            explicit per-call choice
 *   3. $INTERCEPTOR_GROUP         explicit per-environment choice; SET-BUT-EMPTY
 *                                 means "the shared default group" (opts out of 4)
 *   4. $INTERCEPTOR_SESSION_ID or a verified host session variable gives agent
 *                                 shells a per-session group (`soft: true`)
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
 * `soft` rides the wire as `groupSoft` so the extension can treat an automatic
 * group as a preference (creation home, reuse, sweep unit) and
 * NOT as the hard isolation boundary an explicit --group asks for — the
 * caller never chose isolation, so empty-group resolution falls back to the
 * active tab and explicit --tab targets are not membership-gated against it.
 *
 * Parallel lanes commonly inherit the same host session id, so concurrent
 * lanes must pass a unique explicit `--group <label>` or set their own neutral
 * `INTERCEPTOR_SESSION_ID`.
 */
export function resolveGroupScope(args: string[], env: Record<string, string | undefined> = process.env): GroupScope {
  const optionTerminator = args.indexOf("--")
  const scopeArgs = optionTerminator === -1 ? args : args.slice(0, optionTerminator)
  const idx = scopeArgs.indexOf("--group")
  if (scopeArgs.includes("--shared-group")) {
    if (idx !== -1) {
      console.error("error: --shared-group conflicts with --group")
      process.exit(1)
    }
    return { label: undefined, soft: false }
  }
  let label: string | undefined
  let soft = false
  if (idx !== -1) {
    if (!scopeArgs[idx + 1] || scopeArgs[idx + 1].startsWith("--")) {
      console.error("error: --group requires a label")
      process.exit(1)
    }
    label = scopeArgs[idx + 1]
  } else if (env.INTERCEPTOR_GROUP !== undefined) {
    // Set-but-empty is a deliberate opt-out: target the default group.
    label = env.INTERCEPTOR_GROUP === "" ? undefined : env.INTERCEPTOR_GROUP
  } else {
    label = deriveSessionGroupLabel(resolveSessionId(env) ?? "")
    soft = label !== undefined
  }
  if (label !== undefined && !GROUP_LABEL_RE.test(label)) {
    console.error(`error: invalid group label '${label}' — must match [A-Za-z0-9_-]{1,32}`)
    process.exit(1)
  }
  return { label, soft }
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
