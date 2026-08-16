/**
 * cli/normalize.ts — order-independent argument normalization
 *
 * Rewrites a command's argv so positionals keep their relative order and come
 * first, followed by flags (each with its value). Existing command parsers
 * read positionals at fixed indices (filtered[1], filtered[2]) and locate
 * flags via indexOf/includes — both patterns work on the normalized shape, so
 * every browser-surface command gains flag-order independence at this single
 * choke point instead of 27 per-module rewrites. Fixes the class of bug where
 * `interceptor open --text-only <url>` created a tab whose URL was literally
 * "--text-only".
 *
 * Also gained for free on normalized commands:
 *   --flag=value   split into `--flag value` (indexOf parsers understand it)
 *   --             option terminator: everything after is positional verbatim
 *
 * The macos/ios surfaces are NOT normalized: they parse nested verbs with
 * per-subverb flag semantics (e.g. --activate is a boolean for `macos open`
 * but takes a value for `macos native tcc`, --on is a boolean for overlays
 * but names a device for ios). ponytail: verb-first grammars there keep
 * order-dependence livable; per-subverb specs are a later phase.
 *
 * CORRECTNESS CONTRACT: every flag that consumes a following value token in a
 * command module MUST be listed for that command family below. A value flag
 * missing from the map would have its value classified as a positional and
 * reordered ahead of the flags, breaking `indexOf(flag) + 1` reads for
 * invocations that work today. The sets below were harvested from every
 * indexOf("--x")/flagValue(...)/VALUE_FLAGS site in cli/commands/*.ts.
 */

// Flags whose value token is optional (consume the next token only when it
// does not look like another flag). Mirrors monitor.ts's own parsing.
const OPTIONAL_VALUE_FLAGS = new Set(["--persist-bodies"])

// buildFilteredArgs strips --tab/--context/--group/--group-color (+values)
// before normalization, but --frame keeps its value in filtered args.
const GLOBAL_VALUE_FLAGS = ["--frame"]

const COMPOUND = ["--filter", "--keys", "--limit", "--timeout", "--tree-format"]
const STATE = ["--depth", "--filter", "--limit", "--max-chars", "--role"]
// --selector/--nth take VALUES. Without them declared here the normalizer
// treats them as booleans and strips their operands, so
// `click --selector button --nth 4` arrives with selector === "--nth".
const ACTIONS = ["--at", "--duration", "--from", "--nth", "--selector", "--steps", "--to"]
const NAV = ["--amount", "--ms", "--timeout"]
const NET = ["--filter", "--format", "--limit", "--out", "--since", "--pattern", "--patterns", "--type"]
const SCREENSHOT = ["--clip", "--element", "--filter", "--format", "--kind", "--limit", "--quality", "--ref", "--region", "--scale", "--selector", "--target-max-long-edge", "--threshold"]
const DATA = ["--since"]
const META = ["--css", "--frame-ids", "--since"]
const SAVE = ["--out", "--chunk-size"]
const BATCH = ["--timeout"]
const MONITOR = ["--capture", "--format", "--guard-policy", "--instruction", "--mode", "--out", "--retention-policy", "--session", "--task", "--verifier-policy", "--persist-bodies"]
const SCENE = ["--profile", "--slide", "--type"]
const SSE = ["--filter", "--limit", "--timeout"]
const RESEARCH = ["--dir", "--effort", "--note", "--slug", "--status"]
const SKILLS = ["--into", "--owned-root"]
const DAEMON = ["--reason", "--timeout"]

const VALUE_FLAGS_BY_CMD: Record<string, string[]> = {
  // compound
  open: COMPOUND, read: COMPOUND, act: COMPOUND, inspect: COMPOUND,
  websearch: COMPOUND, search: COMPOUND,
  // state
  state: STATE, tree: STATE, diff: STATE, find: STATE, text: STATE, html: STATE,
  // actions
  click: ACTIONS, type: ACTIONS, select: ACTIONS, focus: ACTIONS, blur: ACTIONS,
  hover: ACTIONS, drag: ACTIONS, dblclick: ACTIONS, rightclick: ACTIONS,
  check: ACTIONS, keys: ACTIONS, "click-at": ACTIONS, "what-at": ACTIONS, regions: ACTIONS,
  // navigation
  navigate: NAV, back: NAV, forward: NAV, scroll: NAV, wait: NAV, "wait-stable": NAV, wait_for: NAV,
  // tabs (booleans only)
  tabs: [], tab: [], window: [], frames: [], session: [],
  // network
  network: NET, net: NET, headers: NET,
  // screenshot
  screenshot: SCREENSHOT, canvas: SCREENSHOT, capture: SCREENSHOT, ocr: SCREENSHOT,
  // data
  cookies: DATA, storage: DATA, history: DATA, bookmarks: DATA, downloads: DATA, clear: DATA, clipboard: DATA,
  // meta
  status: META, reload: META, meta: META, links: META, images: META, forms: META,
  info: META, page_info: META, query: META, exists: META, count: META, table: META,
  attr: META, style: META, events: META, notify: META, sessions: META,
  capabilities: META, modals: META, panels: META,
  // singles
  eval: [], save: SAVE, brand: [], group: [], batch: BATCH, raw: BATCH,
  monitor: MONITOR, scene: SCENE, sse: SSE, override: [],
  upgrade: [], init: [], research: RESEARCH, extensions: [], contexts: [],
  skills: SKILLS, daemon: DAEMON, manifest: [],
}

/**
 * Normalize `[cmd, ...rest]` to `[cmd, ...positionals, ...flags]`.
 * Commands without a value-flag map (macos, ios) are returned untouched.
 */
export function normalizeArgs(filtered: string[]): string[] {
  const cmd = filtered[0]
  const familyFlags = VALUE_FLAGS_BY_CMD[cmd]
  if (!familyFlags) return filtered
  const vf = new Set([...familyFlags, ...GLOBAL_VALUE_FLAGS])

  const positionals: string[] = []
  const flags: string[] = []
  let terminated = false

  for (let i = 1; i < filtered.length; i++) {
    const tok = filtered[i]
    if (terminated) { positionals.push(tok); continue }
    if (tok === "--") { terminated = true; continue }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=")
      if (eq > 2) {
        const name = tok.slice(0, eq)
        if (vf.has(name)) { flags.push(name, tok.slice(eq + 1)); continue }
        flags.push(tok)
        continue
      }
      flags.push(tok)
      if (vf.has(tok) && i + 1 < filtered.length) {
        const next = filtered[i + 1]
        if (OPTIONAL_VALUE_FLAGS.has(tok) && next.startsWith("-")) continue
        flags.push(next)
        i++
      }
      continue
    }
    // includes single-dash tokens ("-100", "-h" is handled upstream) — they
    // are values/positionals in this grammar, never short-option groups
    positionals.push(tok)
  }

  return [cmd, ...positionals, ...flags]
}
