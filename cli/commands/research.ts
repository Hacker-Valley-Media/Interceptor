/**
 * cli/commands/research.ts — interceptor research
 *
 * Local, no-daemon command (like `help`/`status`/`init`). Two jobs:
 *
 *   1. Print the deep-research playbook on demand — the moment an agent decides
 *      to go deep, it pulls the method straight into context:
 *        interceptor research            one-screen playbook + rubric
 *        interceptor research --full      extended playbook + verb cookbook
 *
 *   2. Manage an on-disk research ledger so the agent collects-before-synthesizing
 *      and can measure itself against the rubric (the satisfiable stopping rule):
 *        interceptor research init <slug> [--effort quick|standard|exhaustive]
 *        interceptor research add <url> [--note "..."] [--slug <s>] [--status <s>]
 *        interceptor research note "<insight>" [--slug <s>]
 *        interceptor research status [<slug>]
 *
 * Honors "the agent controls Interceptor": this command prints guidance and
 * writes a scaffold the agent asked for. It never crawls, never blocks another
 * command, and its `status` verdict is advisory text only.
 *
 * Ledger writes are confined to the base dir (default ./.interceptor-research,
 * override with --dir). No browser, no daemon, no network.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  RESEARCH_PLAYBOOK_ONE_SCREEN,
  RESEARCH_PLAYBOOK_FULL,
  RESEARCH_FLOORS,
  TRIANGULATION_MIN,
  type ResearchEffort,
} from "../../shared/research-playbook"

const DEFAULT_BASE = ".interceptor-research"

type Lead = { url: string; domain: string; status: string; note?: string; addedAt: string; sourceFile?: string }
type Ledger = { slug: string; effort: ResearchEffort; floor: number; createdAt: string; leads: Lead[] }

// ── helpers ────────────────────────────────────────────────────────────────

function flagValue(filtered: string[], flag: string): string | undefined {
  const i = filtered.indexOf(flag)
  return i !== -1 ? filtered[i + 1] : undefined
}

function resolveBase(filtered: string[]): string {
  return flagValue(filtered, "--dir") || DEFAULT_BASE
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    // Not a parseable URL — fall back to the raw token so leads are still tracked.
    return url.replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "")
  }
}

/** Slug dirs that currently exist under the base. */
function listSlugs(base: string): string[] {
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
}

// `.current` names the ledger the last `init` (or `use`) selected. Once a
// workspace held two ledgers, every `note`/`add`/`status` without --slug was
// refused (180 results, 2026-09-10 review); agents rarely pass the slug on
// every call, and the ledger they mean is the one they just opened.
const CURRENT_MARKER = ".current"

function readCurrentSlug(base: string): string | undefined {
  const p = join(base, CURRENT_MARKER)
  if (!existsSync(p)) return undefined
  const slug = readFileSync(p, "utf-8").trim()
  return slug.length > 0 ? slug : undefined
}

function writeCurrentSlug(base: string, slug: string): void {
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, CURRENT_MARKER), slug + "\n")
}

/** Resolve which slug a non-init subcommand operates on. */
function resolveSlug(base: string, explicit: string | undefined): string | { error: string } {
  if (explicit) return explicit
  const slugs = listSlugs(base)
  if (slugs.length === 1) return slugs[0]
  if (slugs.length === 0) return { error: `no research ledger found under ${base}/. Run 'interceptor research init <slug>' first.` }
  const current = readCurrentSlug(base)
  if (current && slugs.includes(current)) {
    console.error(`ledger: ${current} (last init/use; --slug <s> overrides, 'interceptor research use <slug>' switches)`)
    return current
  }
  return { error: `multiple ledgers under ${base}/ (${slugs.join(", ")}). Pass the slug, e.g. 'interceptor research status <slug>', or pick one with 'interceptor research use <slug>'.` }
}

function cmdUse(filtered: string[]): null {
  const slug = filtered[2]
  if (!slug || slug.startsWith("--")) {
    console.error("error: interceptor research use requires a slug. Usage: interceptor research use <slug>")
    process.exit(1)
  }
  const base = resolveBase(filtered)
  if (!existsSync(ledgerPath(base, slug))) {
    const slugs = listSlugs(base)
    console.error(`error: no ledger '${slug}' under ${base}/${slugs.length ? ` (have: ${slugs.join(", ")})` : ""}. Run 'interceptor research init ${slug}' to create it.`)
    process.exit(1)
  }
  writeCurrentSlug(base, slug)
  console.log(`current ledger: ${slug}`)
  return null
}

function ledgerPath(base: string, slug: string): string { return join(base, slug, "links.json") }
function insightsPath(base: string, slug: string): string { return join(base, slug, "insights.md") }
function sourcesDir(base: string, slug: string): string { return join(base, slug, "sources") }

function readLedger(base: string, slug: string): Ledger | { error: string } {
  const p = ledgerPath(base, slug)
  if (!existsSync(p)) return { error: `ledger not found: ${p}. Run 'interceptor research init ${slug}' first.` }
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Ledger
  } catch (err) {
    return { error: `could not parse ${p}: ${(err as Error).message}` }
  }
}

function countSavedSources(base: string, slug: string): number {
  const dir = sourcesDir(base, slug)
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter(f => f.endsWith(".md") || f.endsWith(".txt") || f.endsWith(".json")).length
}

// ── search-engine discovery hint (Layer C) ───────────────────────────────────

/** Recognized search/discovery surfaces where a depth nudge is worth one line. */
export function isSearchUrl(url: string): boolean {
  let host = "", path = "", search = ""
  try {
    const u = new URL(url)
    host = u.hostname.replace(/^www\./, "")
    path = u.pathname
    search = u.search
  } catch {
    return false
  }
  if (/(^|\.)google\.[a-z.]+$/.test(host) && path.startsWith("/search")) return true
  if (host === "scholar.google.com") return true
  if (host === "bing.com" && path.startsWith("/search")) return true
  if (host === "duckduckgo.com" && (path.startsWith("/html") || /[?&]q=/.test(search) || path === "/")) return /[?&]q=/.test(search) || path.startsWith("/html")
  if ((host === "reddit.com" || host === "old.reddit.com") && path.includes("/search")) return true
  if (host === "arxiv.org" && path.startsWith("/search")) return true
  if (host === "github.com" && path.startsWith("/search")) return true
  return false
}

/**
 * Pure predicate: should the hint be emitted at all? Excludes the rate-limit
 * (that's the only stateful part). Unit-tested directly.
 */
export function shouldEmitResearchHint(url: string, opts: { noFlag: boolean; envSet: boolean; ledgerActive: boolean }): boolean {
  if (opts.noFlag || opts.envSet || opts.ledgerActive) return false
  return isSearchUrl(url)
}

const HINT_WINDOW_MS = 6 * 60 * 60 * 1000 // rate-limit: at most one hint per 6h ("once per session", pragmatically)
const HINT_TEXT =
  "hint: deep-research mode available — run `interceptor research` for the depth playbook " +
  "(suppress with --no-research-hint or INTERCEPTOR_NO_RESEARCH_HINT=1)"

/**
 * Called from `runOpen`. Emits at most one rate-limited hint line to STDERR
 * (stdout stays clean — matches the existing `warning:`/`saved:` convention).
 * Changes no command behavior.
 */
export function maybeEmitResearchHint(url: string, filtered: string[], base = DEFAULT_BASE): void {
  const noFlag = filtered.includes("--no-research-hint")
  const envSet = !!process.env.INTERCEPTOR_NO_RESEARCH_HINT
  const ledgerActive = listSlugs(base).length > 0
  if (!shouldEmitResearchHint(url, { noFlag, envSet, ledgerActive })) return

  const flagFile = join(tmpdir(), "interceptor-research-hint.flag")
  try {
    if (existsSync(flagFile)) {
      const age = Date.now() - statSync(flagFile).mtimeMs
      if (age < HINT_WINDOW_MS) return
    }
    writeFileSync(flagFile, String(Date.now()))
  } catch {
    // If we can't track the flag, fail open (emit once) rather than spam — but a
    // write failure here is unusual; emitting is harmless.
  }
  process.stderr.write(HINT_TEXT + "\n")
}

// ── subcommands ──────────────────────────────────────────────────────────────

function cmdInit(filtered: string[]): null {
  const slug = filtered[2]
  if (!slug || slug.startsWith("--")) {
    console.error("error: interceptor research init requires a slug. Usage: interceptor research init <slug> [--effort quick|standard|exhaustive]")
    process.exit(1)
  }
  const base = resolveBase(filtered)
  const effortRaw = (flagValue(filtered, "--effort") || "standard") as ResearchEffort
  const effort: ResearchEffort = (effortRaw in RESEARCH_FLOORS) ? effortRaw : "standard"
  const floor = RESEARCH_FLOORS[effort]

  const dir = join(base, slug)
  if (existsSync(ledgerPath(base, slug))) {
    console.error(`error: ledger already exists at ${ledgerPath(base, slug)}. Use 'interceptor research status ${slug}' to inspect it.`)
    process.exit(1)
  }
  mkdirSync(sourcesDir(base, slug), { recursive: true })
  const ledger: Ledger = { slug, effort, floor, createdAt: new Date().toISOString(), leads: [] }
  writeFileSync(ledgerPath(base, slug), JSON.stringify(ledger, null, 2) + "\n")
  writeCurrentSlug(base, slug)
  writeFileSync(
    insightsPath(base, slug),
    `# Insights — ${slug}\n\n` +
    `> Running insight log. Collect to disk FIRST, synthesize LAST.\n` +
    `> Tag claims [HIGH]/[MED]/[LOW]/[CONFLICT]; unattributable -> [UNVERIFIED].\n` +
    `> Effort: ${effort} (floor ${floor} sources, triangulate >=${TRIANGULATION_MIN}x).\n\n`
  )

  console.log(`research ledger created: ${dir}/`)
  console.log(`  links.json     leads (add with: interceptor research add <url> --note "...")`)
  console.log(`  insights.md    running insights (append with: interceptor research note "...")`)
  console.log(`  sources/       save each opened page here as NN-${slug}.md`)
  console.log("")
  console.log(`effort: ${effort}  ->  floor ${floor} sources, every load-bearing claim triangulated >=${TRIANGULATION_MIN}x`)
  console.log(`check progress any time: interceptor research status ${slug}`)
  return null
}

function cmdAdd(filtered: string[], jsonMode: boolean): null {
  const url = filtered[2]
  if (!url || url.startsWith("--")) {
    console.error("error: interceptor research add requires a URL. Usage: interceptor research add <url> [--note \"...\"] [--slug <s>]")
    process.exit(1)
  }
  const base = resolveBase(filtered)
  const slugResolved = resolveSlug(base, flagValue(filtered, "--slug"))
  if (typeof slugResolved !== "string") { console.error(`error: ${slugResolved.error}`); process.exit(1) }
  const slug = slugResolved
  const led = readLedger(base, slug)
  if ("error" in led) { console.error(`error: ${led.error}`); process.exit(1) }

  const lead: Lead = {
    url,
    domain: domainOf(url),
    status: flagValue(filtered, "--status") || "new",
    note: flagValue(filtered, "--note"),
    addedAt: new Date().toISOString(),
  }
  if (!lead.note) delete lead.note

  // --capture / --stdin: save piped page text to sources/NN-<slug>.md as part of
  // adding the lead, so collect-before-synthesize is a single frictionless command:
  //   interceptor read --tab N --text-only --full | interceptor research add <url> --slug X --capture
  let savedMsg = ""
  if (filtered.includes("--capture") || filtered.includes("--stdin")) {
    let body = ""
    try { if (!process.stdin.isTTY) body = readFileSync(0, "utf-8") } catch {}
    if (body.trim()) {
      const idx = countSavedSources(base, slug) + 1
      const fname = `${String(idx).padStart(2, "0")}-${slug}.md`
      writeFileSync(join(sourcesDir(base, slug), fname), `# ${url}\n# saved ${new Date().toISOString()}\n\n${body}`)
      lead.sourceFile = `sources/${fname}`
      savedMsg = `, saved ${lead.sourceFile}`
    }
  }

  led.leads.push(lead)
  writeFileSync(ledgerPath(base, slug), JSON.stringify(led, null, 2) + "\n")

  const distinctDomains = new Set(led.leads.map(l => l.domain)).size
  if (jsonMode) {
    console.log(JSON.stringify({ success: true, data: { slug, leads: led.leads.length, distinctDomains, floor: led.floor, sourceFile: lead.sourceFile } }, null, 2))
  } else {
    console.log(`added: ${lead.domain}  (${led.leads.length} leads, ${distinctDomains} domains, floor ${led.floor})${savedMsg}`)
  }
  return null
}

function cmdNote(filtered: string[]): null {
  const base = resolveBase(filtered)
  // text = everything after "note" that isn't a flag or flag-value
  const flagsWithValue = new Set(["--slug", "--dir"])
  const parts: string[] = []
  for (let i = 2; i < filtered.length; i++) {
    if (flagsWithValue.has(filtered[i])) { i++; continue }
    if (filtered[i].startsWith("--")) continue
    parts.push(filtered[i])
  }
  const text = parts.join(" ").trim()
  if (!text) {
    console.error('error: interceptor research note requires text. Usage: interceptor research note "<insight>" [--slug <s>]')
    process.exit(1)
  }
  const slugResolved = resolveSlug(base, flagValue(filtered, "--slug"))
  if (typeof slugResolved !== "string") { console.error(`error: ${slugResolved.error}`); process.exit(1) }
  const slug = slugResolved
  if (!existsSync(insightsPath(base, slug))) {
    console.error(`error: ${insightsPath(base, slug)} not found. Run 'interceptor research init ${slug}' first.`)
    process.exit(1)
  }
  appendFileSync(insightsPath(base, slug), `- ${text}\n`)
  console.log(`noted -> ${insightsPath(base, slug)}`)
  return null
}

/**
 * Saturation signals (deterministic, explainable). Two independent ways a branch
 * is genuinely "done" by breadth, plus an explicit agent override:
 *
 *  - domainSaturated: floor met AND the most recent round added no NEW domain
 *    (you're now revisiting the same sources — classic diminishing returns).
 *  - overCovered: you've gathered >= 2x the floor across many sources — a clearly
 *    wide net, even if each new source is a fresh domain. This fixes the original
 *    bug where a diverse-PRIMARY researcher (who never revisits a domain) could
 *    NEVER saturate, so good breadth was punished as "keep digging" forever.
 *
 * A third path — an explicit `[SATURATED-OVERRIDE] <reason>` insight note — lets
 * the agent declare a branch covered when it has triangulated every sub-question
 * but the heuristic can't see it. That keeps the agent in control (the override
 * must carry a justification) without forcing a longer, pointless dig.
 */
function computeSaturation(led: Ledger): { domainSaturated: boolean; overCovered: boolean; recentWindow: number; newDomainsInRecent: number } {
  const recentWindow = Math.max(3, Math.ceil(led.floor / 4))
  const n = led.leads.length
  const overCovered = n >= led.floor * 2
  if (n < recentWindow) return { domainSaturated: false, overCovered, recentWindow, newDomainsInRecent: -1 }
  const recent = led.leads.slice(n - recentWindow)
  const earlierDomains = new Set(led.leads.slice(0, n - recentWindow).map(l => l.domain))
  const newDomains = new Set(recent.map(l => l.domain).filter(d => !earlierDomains.has(d)))
  const domainSaturated = n >= led.floor && newDomains.size === 0
  return { domainSaturated, overCovered, recentWindow, newDomainsInRecent: newDomains.size }
}

function cmdStatus(filtered: string[], jsonMode: boolean): null {
  const base = resolveBase(filtered)
  const explicit = filtered[2] && !filtered[2].startsWith("--") ? filtered[2] : flagValue(filtered, "--slug")
  const slugResolved = resolveSlug(base, explicit)
  if (typeof slugResolved !== "string") { console.error(`error: ${slugResolved.error}`); process.exit(1) }
  const slug = slugResolved
  const led = readLedger(base, slug)
  if ("error" in led) { console.error(`error: ${led.error}`); process.exit(1) }

  const leadsCount = led.leads.length
  const distinctDomains = new Set(led.leads.map(l => l.domain)).size
  const sourcesSaved = countSavedSources(base, slug)
  // Breadth proxy: saved source files are the honest count; if none saved yet,
  // fall back to leads tracked so an agent that hasn't filed yet still gets signal.
  const collected = sourcesSaved > 0 ? sourcesSaved : leadsCount

  let needsCorroboration = 0
  let hasOverride = false
  const insightsFile = insightsPath(base, slug)
  if (existsSync(insightsFile)) {
    // Count tags only in appended insight entries (lines starting with "- "),
    // never the header guidance that lists the tags as examples.
    const entries = readFileSync(insightsFile, "utf-8")
      .split("\n")
      .filter(l => l.trimStart().startsWith("- "))
      .join("\n")
    const matches = entries.match(/\[(UNVERIFIED|LOW|CONFLICT)\]/gi)
    needsCorroboration = matches ? matches.length : 0
    hasOverride = /\[SATURATED-OVERRIDE\]/i.test(entries)
  }

  const sat = computeSaturation(led)
  const saturated = sat.domainSaturated || sat.overCovered || hasOverride
  const satReason = sat.domainSaturated ? "no new domains in last round"
    : sat.overCovered ? `>=2x floor (${leadsCount}/${led.floor})`
    : hasOverride ? "agent override" : ""

  let verdict: string
  if (collected < led.floor) {
    verdict = `KEEP DIGGING — breadth floor not met (${led.floor - collected} more to reach ${led.floor})`
  } else if (!saturated) {
    const why = sat.newDomainsInRecent === -1
      ? `too few leads to judge saturation (need >=${sat.recentWindow} in a round)`
      : `last round added ${sat.newDomainsInRecent} new domain${sat.newDomainsInRecent === 1 ? "" : "s"}`
    verdict = `KEEP DIGGING — branch not saturated (${why}). Dig until READY, or if every sub-question is covered, record: interceptor research note '[SATURATED-OVERRIDE] <why>'`
  } else if (needsCorroboration > 0) {
    verdict = `VERIFY — ${needsCorroboration} claim${needsCorroboration === 1 ? "" : "s"} tagged [UNVERIFIED]/[LOW]/[CONFLICT] still need corroboration`
  } else {
    verdict = `READY — breadth floor met, branch saturated (${satReason}), claims attributed. Write the report.`
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      success: true,
      data: { slug, effort: led.effort, floor: led.floor, leadsCount, distinctDomains, sourcesSaved, collected, needsCorroboration, saturated, satReason, overridden: hasOverride, verdict },
    }, null, 2))
    return null
  }

  const lines = [
    `research: ${slug}  (effort: ${led.effort})`,
    `  sources collected : ${collected} / ${led.floor} floor${collected < led.floor ? `   (${led.floor - collected} to go)` : ""}`,
    `  leads tracked     : ${leadsCount}   (${sourcesSaved} saved to sources/)`,
    `  domains           : ${distinctDomains} distinct`,
    `  needs corroboration: ${needsCorroboration} claim${needsCorroboration === 1 ? "" : "s"} tagged [UNVERIFIED]/[LOW]/[CONFLICT]`,
    `  saturation        : ${saturated ? `SATURATED (${satReason})` : "NOT saturated"}${!saturated && sat.newDomainsInRecent >= 0 ? ` — last round of ${sat.recentWindow}: ${sat.newDomainsInRecent} new domain${sat.newDomainsInRecent === 1 ? "" : "s"}` : ""}`,
    `  triangulation     : every load-bearing claim should be corroborated >=${TRIANGULATION_MIN}x`,
    `  verdict           : ${verdict}`,
  ]
  console.log(lines.join("\n"))
  return null
}

// ── entry ────────────────────────────────────────────────────────────────────

export async function runResearchCommand(filtered: string[], jsonMode = false): Promise<null> {
  const sub = filtered[1]

  // No subcommand (or --full): print the playbook. Pure stdout, no side effects.
  if (!sub || sub === "--full" || sub.startsWith("--")) {
    const full = filtered.includes("--full")
    console.log(full ? RESEARCH_PLAYBOOK_FULL : RESEARCH_PLAYBOOK_ONE_SCREEN)
    return null
  }

  switch (sub) {
    case "init":   return cmdInit(filtered)
    case "use":    return cmdUse(filtered)
    case "add":    return cmdAdd(filtered, jsonMode)
    case "note":   return cmdNote(filtered)
    case "status": return cmdStatus(filtered, jsonMode)
    default:
      console.error(`error: unknown research subcommand '${sub}'. Use: (none) | --full | init | use | add | note | status`)
      process.exit(1)
  }
}
