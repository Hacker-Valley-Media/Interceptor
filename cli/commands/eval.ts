/**
 * cli/commands/eval.ts — eval
 */

import { normalizeArgsSplit } from "../normalize"

type Action = { type: string; [key: string]: unknown }

export function parseEvalCommand(filtered: string[], positionalCount?: number): Action {
  const normalized = positionalCount === undefined ? normalizeArgsSplit(filtered) : { argv: filtered, positionalCount }
  const end = normalized.positionalCount + 1
  const flags = normalized.argv.slice(end)
  const world = flags.includes("--main") ? "MAIN" : "ISOLATED"
  const code = normalized.argv.slice(1, end).join(" ")
  if (!code.trim()) throw new Error("eval requires JavaScript code. Usage: interceptor eval <code> [--main] [--no-reload]")
  // --no-reload: MAIN-world eval on a strict-CSP page normally recovers by
  // stripping the CSP response header and RELOADING the tab. That is the right
  // trade for a static page and the wrong one for a stateful one — a reload
  // discards an open chat conversation, a half-filled form, or any in-memory
  // app state, and the caller finds out only from `cspBypassApplied: true` in a
  // result that arrives after the damage. This flag asks for the CSP error
  // instead, mirroring `screenshot --no-fallback`. The extension has honoured
  // `noCspReload` since the bypass core was factored out; only `monitor` set it.
  const action: Action = { type: "evaluate", code, world }
  if (flags.includes("--no-reload")) action.noCspReload = true
  return action
}

/**
 * An eval value the daemon had to cut is not a value (the
 * marker landed inside JSON and broke parsers). Detects the daemon's
 * `truncated` field and the bare marker older daemons append.
 */
export function evalCutMessage(result: { success: boolean; data?: unknown; truncated?: { shown?: number; total?: number } }): string | null {
  if (!result.success) return null
  const cut = result.truncated
    ?? (typeof result.data === "string" && result.data.length >= 50_000 && /\n\.\.\. \(truncated(?:: showed \d+ of \d+ chars)?\)$/.test(result.data) ? {} : undefined)
  if (!cut) return null
  const size = cut.total ? `${cut.total} characters, over the ${cut.shown} limit` : "too long"
  return `eval result is ${size}, so it was cut and is not printed; write it to a file instead: interceptor save --out <path> '<expression>'`
}
