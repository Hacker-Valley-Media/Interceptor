/**
 * cli/commands/group-prune.ts — `interceptor group prune`.
 *
 *   interceptor group prune [--dry-run] [--app <name>] [--brand <title>] [--allow-frontmost]
 *
 * Deletes every CLOSED saved tab group that Interceptor left behind
 * (`<brand>` and `<brand>-<label>` chips on the bookmarks bar; issue #301).
 *
 * Chrome gives extensions no handle on a closed saved group: chrome.tabGroups
 * has get / query / update / move over OPEN groups and nothing else. The only
 * way to delete one is the browser's own UI, so this verb drives it through the
 * native desktop provider (Full install): open the chip's context menu, press
 * "Delete group", confirm the chip is gone. The calls are the same on macOS,
 * Windows and Linux; only the way the menu is opened differs, because the
 * Windows provider's `action` has no context-menu action. Saved groups sync, so
 * a prune on one computer clears every profile and device on that account.
 *
 * There is no age filter: the browser UI exposes no timestamp for a saved
 * group. Prune takes every closed managed group and nothing else.
 */

import { desktopAction } from "../../shared/desktop-contract"
import { GROUP_LABEL_RE } from "../parse"
import type { DaemonResponse, DaemonResult } from "../transport"
import { listExtensionContextIds } from "./group"
import { bridgePreflightFailure } from "./macos"

type Action = { type: string; [key: string]: unknown }

type SendFn = (action: Action, tabId?: number, contextId?: string) => Promise<DaemonResponse>

export type SavedGroupChip = { ref: string; title: string; state: "closed" | "open" }

export type GroupPruneOptions = {
  dryRun: boolean
  allowFrontmost: boolean
  app?: string
  brand?: string
}

export const DEFAULT_BRAND = "interceptor"

// Chromium browsers that draw the saved tab groups bar: by bundle id on macOS,
// by process or application name on Windows and Linux (no bundle id there).
const BROWSER_BUNDLES = new Set([
  "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
  "org.chromium.Chromium", "com.brave.Browser", "com.microsoft.edgemac",
])
const BROWSER_NAME_RE = /^(google[- ]chrome(?:[- ](?:beta|dev|canary|stable|unstable))?|chrome|chromium(?:[- ]browser)?|brave(?:[- ]browser)?|msedge|microsoft[- ]edge(?:[- ](?:beta|dev|stable))?)(\.exe)?$/i

// The provider operations a prune run calls.
const NEEDED_OPERATIONS = ["apps", "windows", "frontmost", "tree", "click", "action"]

// One tree line per chip: `[<ref>] button " <title> group - Closed"`. The tree
// text has one format on every host. The names are the browser's own
// accessibility strings, so this matches an English UI.
const REF = String.raw`\[([^\]\s]+)\]`
const CHIP_RE = new RegExp(String.raw`^\s*${REF} button " ?(.+) group - (Closed|Opened)"\s*$`)
const DELETE_ITEM_RE = new RegExp(String.raw`^\s*${REF} menuitem "Delete group"\s*$`)
const MENU_RE = new RegExp(String.raw`^\s*${REF} menu\s*$`)
const OPEN_ITEM_RE = new RegExp(String.raw`^\s*${REF} menuitem "Open group"\s*$`)
// The bar ends in a "Tab groups" button, which every host reports as a button.
const BAR_RE = new RegExp(String.raw`^\s*${REF} button "Tab groups"\s*$`)

const MENU_SETTLE_MS = 300
const MENU_POLLS = 3
const MAX_ATTEMPTS = 2
const DELETE_SETTLE_MS = 700

export function parseSavedGroupChips(tree: string): SavedGroupChip[] {
  const chips: SavedGroupChip[] = []
  for (const line of tree.split("\n")) {
    const m = CHIP_RE.exec(line)
    if (m) chips.push({ ref: m[1], title: m[2], state: m[3] === "Closed" ? "closed" : "open" })
  }
  return chips
}

/** `<brand>` (the shared default group) or `<brand>-<label>` with a valid label. */
export function isManagedTitle(title: string, brands: Iterable<string>): boolean {
  for (const brand of brands) {
    if (title === brand) return true
    if (title.startsWith(`${brand}-`) && GROUP_LABEL_RE.test(title.slice(brand.length + 1))) return true
  }
  return false
}

/**
 * The chips prune may delete, one per title (a chip repeats in every window of
 * its profile). A title is left alone when it is not a managed group, and when
 * the group is open anywhere: as a chip that reads "Opened", or as a live group
 * in a connected profile. Deleting a saved group closes its open copy, in this
 * profile and in every synced one.
 */
export function selectPrunable(
  chips: SavedGroupChip[],
  brands: Iterable<string>,
  openTitles: ReadonlySet<string>
): SavedGroupChip[] {
  const brandList = [...brands]
  const openSomewhere = new Set(chips.filter((c) => c.state === "open").map((c) => c.title))
  const seen = new Set<string>()
  const out: SavedGroupChip[] = []
  for (const chip of chips) {
    if (chip.state !== "closed" || seen.has(chip.title)) continue
    if (!isManagedTitle(chip.title, brandList)) continue
    if (openSomewhere.has(chip.title) || openTitles.has(chip.title)) continue
    seen.add(chip.title)
    out.push(chip)
  }
  return out
}

/**
 * Browser windows that show no saved tab groups bar. The bar is part of the
 * bookmarks bar, so a profile that hides it has no chips to read: its closed
 * groups sit in the "Tab groups" menu only, where prune does not look.
 */
export function countWindowsWithoutBar(tree: string, windowCount: number): number {
  const bars = tree.split("\n").filter((line) => BAR_RE.test(line)).length
  return Math.max(0, windowCount - bars)
}

/** The open saved-group context menu, if the tree shows one. */
export function findSavedGroupMenu(tree: string): { menuRef?: string; deleteRef?: string } {
  const lines = tree.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const menu = MENU_RE.exec(lines[i])
    if (!menu || !OPEN_ITEM_RE.test(lines[i + 1] ?? "")) continue
    for (let j = i + 1; j < lines.length && /menuitem/.test(lines[j]); j++) {
      const del = DELETE_ITEM_RE.exec(lines[j])
      if (del) return { menuRef: menu[1], deleteRef: del[1] }
    }
    return { menuRef: menu[1] }
  }
  return {}
}

export type BrowserApp = { name: string; pid: number; hidden: boolean }

/**
 * The running Chromium browsers, one entry per process: two instances of one
 * browser (a second user-data-dir) share a name, so each is addressed by pid.
 * macOS answers `apps` with `[pid] Name * (hidden) — bundle.id` lines (`*`
 * marks the active app); Windows and Linux answer with `{ name, pid }` rows.
 */
export function parseRunningBrowsers(apps: unknown): BrowserApp[] {
  const browsers: BrowserApp[] = []
  if (typeof apps === "string") {
    for (const line of apps.split("\n")) {
      const m = /^\[(\d+)\] (.+?)( \*)?( \(hidden\))? — (\S+)\s*$/.exec(line)
      if (m && BROWSER_BUNDLES.has(m[5])) browsers.push({ name: m[2], pid: Number(m[1]), hidden: m[4] !== undefined })
    }
  } else if (Array.isArray(apps)) {
    for (const app of apps as Array<{ name?: unknown; pid?: unknown }>) {
      if (typeof app?.name === "string" && typeof app.pid === "number" && BROWSER_NAME_RE.test(app.name.trim())) {
        browsers.push({ name: app.name, pid: app.pid, hidden: false })
      }
    }
  }
  return browsers
}

export const PRUNE_PLATFORMS = ["darwin", "win32", "linux"]

export function unsupportedPlatformError(platform: string): string {
  return `group prune is not available on ${platform}: it deletes a closed saved tab group through the browser's own UI, `
    + "which needs Interceptor's native desktop provider (macOS, Windows, Linux). "
    + "Delete the groups by hand (right-click the chip, then Delete group)."
}

function noProviderError(reason: string): string {
  return "group prune deletes a closed saved tab group through the browser's own UI (the extension API lists open groups only), "
    + `so it needs the native desktop provider. ${reason.replace(/\s*\n+\s*/g, " ").trim()} `
    + "Without it, delete the groups by hand (right-click the chip, then Delete group); saved groups sync, so one computer is enough."
}

/** The parts of the host a prune run depends on; tests replace them. */
export type PruneHost = {
  platform: string
  /** Why the native provider cannot be used on this install, or null. */
  providerFailure: (send: SendFn) => Promise<string | null>
  sleep: (ms: number) => Promise<unknown>
}

async function call(send: SendFn, action: Action, contextId?: string): Promise<DaemonResult> {
  try {
    return (await send(action, undefined, contextId)).result
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

/**
 * One native call. Actions are written with their macOS names; on Windows and
 * Linux the same action goes to the desktop provider under its `desktop_` name.
 */
function native(send: SendFn, platform: string, action: Action): Promise<DaemonResult> {
  return call(send, platform === "darwin" ? action : desktopAction(action))
}

async function realProviderFailure(send: SendFn): Promise<string | null> {
  if (process.platform === "darwin") return bridgePreflightFailure()
  const hello = await call(send, { type: "desktop_hello" })
  if (!hello.success) return `${hello.error ?? "The desktop provider did not answer."} Run 'interceptor status': mode must be full.`
  const capabilities = (hello.data as { capabilities?: Array<{ operation: string; compiled: boolean; present: boolean }> } | undefined)?.capabilities ?? []
  const missing = NEEDED_OPERATIONS.filter((op) => !capabilities.some((c) => c.operation === op && c.compiled && c.present))
  return missing.length > 0 ? `This host's provider does not offer: ${missing.join(", ")} (see 'interceptor desktop capabilities').` : null
}

const REAL_HOST: PruneHost = {
  platform: process.platform,
  providerFailure: realProviderFailure,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}

type Native = (action: Action) => Promise<DaemonResult>

async function readTree(run: Native, pid: number, filter: "interactive" | "all"): Promise<{ tree?: string; error?: string }> {
  const r = await run({ type: "macos_tree", pid, filter, depth: 14, maxChars: 600_000, maxNodes: 12_000, maxMs: 8_000 })
  if (!r.success) return { error: r.error ?? "the browser's UI tree could not be read" }
  const data = r.data as unknown
  const tree = typeof data === "string" ? data : (data as { tree?: unknown } | undefined)?.tree
  return typeof tree === "string" ? { tree } : { error: "the browser's UI tree came back empty" }
}

/** Brand titles and open managed group titles, from every connected profile. Best effort. */
async function readExtensionGroups(send: SendFn): Promise<{ brands: Set<string>; openTitles: Set<string> }> {
  const brands = new Set<string>()
  const openTitles = new Set<string>()
  for (const contextId of await listExtensionContextIds(send)) {
    const r = await call(send, { type: "group_list" }, contextId)
    if (!r.success || !Array.isArray(r.data)) continue
    for (const g of r.data as Array<{ title?: unknown; label?: unknown; default?: unknown }>) {
      if (typeof g.title !== "string") continue
      if (g.default === true) { brands.add(g.title); openTitles.add(g.title) }
      if (typeof g.label === "string" && g.title.endsWith(`-${g.label}`)) {
        brands.add(g.title.slice(0, -(g.label.length + 1)))
        openTitles.add(g.title)
      }
    }
  }
  return { brands, openTitles }
}

type AppReport = {
  app: string
  pid: number
  found: string[]
  deleted: string[]
  failed: Array<{ title: string; reason: string }>
  skipped?: string
  partial?: true
  windowsWithoutBar?: number
}

async function pruneApp(
  run: Native, browser: BrowserApp, brands: Set<string>, openTitles: Set<string>, opts: GroupPruneOptions,
  frontmost: boolean, host: PruneHost
): Promise<AppReport> {
  const { name: app, pid } = browser
  const { sleep } = host
  const report: AppReport = { app, pid, found: [], deleted: [], failed: [] }
  const first = await readTree(run, pid, "interactive")
  if (first.tree === undefined) { report.skipped = `${app}: ${first.error}`; return report }
  if (first.tree.includes("(stopped:")) report.partial = true
  const windows = await run({ type: "macos_windows", pid })
  const noBar = Array.isArray(windows.data) ? countWindowsWithoutBar(first.tree, windows.data.length) : 0
  if (noBar > 0) report.windowsWithoutBar = noBar
  report.found = selectPrunable(parseSavedGroupChips(first.tree), brands, openTitles).map((c) => c.title)
  if (opts.dryRun || report.found.length === 0) return report
  if (browser.hidden) {
    // A menu opened in a hidden app is not on screen and can bring the app back.
    report.skipped = `${app} is hidden; run again when its windows are on screen`
    return report
  }
  if (frontmost && !opts.allowFrontmost) {
    // An open context menu takes the keyboard of the frontmost app, so a person
    // typing in the browser would be typing into the menu.
    report.skipped = `${app} is the frontmost app; run again when it is in the background, or pass --allow-frontmost`
    return report
  }

  // A menu the person dismisses (a click elsewhere, an app switch) costs one
  // attempt, so each group gets two.
  const attempts = new Map<string, number>()
  const lastProblem = new Map<string, string>()
  // Each delete re-reads the tree: refs are short-lived and the bar reflows.
  for (let round = 0; round < report.found.length * MAX_ATTEMPTS + 1; round++) {
    const before = await readTree(run, pid, "all")
    if (before.tree === undefined) break
    if (findSavedGroupMenu(before.tree).menuRef) {
      report.skipped = `a saved tab group menu is already open in ${app}; nothing more was deleted`
      break
    }
    const next = selectPrunable(parseSavedGroupChips(before.tree), brands, openTitles)
      .find((c) => (attempts.get(c.title) ?? 0) < MAX_ATTEMPTS)
    if (!next) break
    attempts.set(next.title, (attempts.get(next.title) ?? 0) + 1)

    // macOS has an accessibility action for the context menu. The Windows
    // provider's `action` has none, so Windows and Linux right-click the chip;
    // their provider delivers that to the window without activating it.
    const shown = host.platform === "darwin"
      ? await run({ type: "macos_action", ref: next.ref, action: "showMenu" })
      : await run({ type: "macos_click", ref: next.ref, right: true, double: false })
    if (!shown.success) { lastProblem.set(next.title, shown.error ?? "could not open the group's menu"); continue }
    let menu: ReturnType<typeof findSavedGroupMenu> = {}
    for (let poll = 0; poll < MENU_POLLS && !menu.menuRef; poll++) {
      await sleep(MENU_SETTLE_MS)
      menu = findSavedGroupMenu((await readTree(run, pid, "all")).tree ?? "")
    }
    if (!menu.deleteRef) {
      // Only macOS can close a menu by reference; elsewhere the next round
      // sees the open menu and stops the run.
      if (menu.menuRef && host.platform === "darwin") await run({ type: "macos_action", ref: menu.menuRef, action: "cancel" })
      lastProblem.set(next.title, menu.menuRef ? "the group's menu had no 'Delete group' item" : "the group's menu did not open")
      continue
    }
    const pressed = await run({ type: "macos_action", ref: menu.deleteRef, action: "press" })
    if (pressed.success) lastProblem.delete(next.title)
    else lastProblem.set(next.title, pressed.error ?? "could not press 'Delete group'")
    await sleep(DELETE_SETTLE_MS)
  }

  // The chip being gone is the only proof of a delete.
  const after = await readTree(run, pid, "interactive")
  const remaining = new Set(parseSavedGroupChips(after.tree ?? "").map((c) => c.title))
  for (const title of attempts.keys()) {
    if (after.tree === undefined) report.failed.push({ title, reason: "could not re-read the browser to confirm the delete" })
    else if (!remaining.has(title)) report.deleted.push(title)
    else report.failed.push({ title, reason: lastProblem.get(title) ?? "still on the bar after 'Delete group' (the browser may be asking for confirmation)" })
  }
  return report
}

export async function runGroupPrune(
  opts: GroupPruneOptions, send: SendFn, host: PruneHost = REAL_HOST
): Promise<DaemonResult & { warning?: string }> {
  if (!PRUNE_PLATFORMS.includes(host.platform)) return { success: false, error: unsupportedPlatformError(host.platform) }
  const noProvider = await host.providerFailure(send)
  if (noProvider !== null) return { success: false, error: noProviderError(noProvider) }
  const run: Native = (action) => native(send, host.platform, action)

  const { brands, openTitles } = await readExtensionGroups(send)
  brands.add(opts.brand ?? DEFAULT_BRAND)

  const listed = await run({ type: "macos_apps" })
  if (!listed.success) return { success: false, error: listed.error ?? "could not list running apps" }
  let apps = parseRunningBrowsers(listed.data)
  if (opts.app) {
    const wanted = opts.app.toLowerCase()
    apps = apps.filter((a) => a.name.toLowerCase() === wanted)
    if (apps.length === 0) return { success: false, error: `group prune: no running Chromium browser is named '${opts.app}'` }
  }
  if (apps.length === 0) return { success: true, data: { dryRun: opts.dryRun, deleted: 0, browsers: [] } }

  // One window on macOS and Windows; Linux can answer with a list.
  const front = (await run({ type: "macos_frontmost" })).data
  const frontPid = ((Array.isArray(front) ? front[0] : front) as { pid?: unknown } | null | undefined)?.pid

  const browsers: AppReport[] = []
  for (const app of apps) browsers.push(await pruneApp(run, app, brands, openTitles, opts, frontPid === app.pid, host))

  const deleted = browsers.reduce((n, b) => n + b.deleted.length, 0)
  const failures = browsers.flatMap((b) => b.failed.map((f) => `${f.title} not deleted: ${f.reason}`))
  const failed = failures.length
  const skipped = browsers.flatMap((b) => (b.skipped ? [b.skipped] : []))
  const notes = [
    ...(browsers.some((b) => b.partial) ? ["the browser's UI tree was cut short, so some groups may not have been seen; run again"] : []),
    ...browsers.filter((b) => b.windowsWithoutBar).map((b) =>
      `${b.windowsWithoutBar} ${b.app} window(s) show no bookmarks bar, so saved groups in those profiles were not checked (View > Always Show Bookmarks Bar, then run again)`),
  ]
  return {
    success: failed === 0 && skipped.length === 0,
    ...(failed > 0 || skipped.length > 0
      ? { error: `group prune did not finish (${deleted} deleted): ${[...failures, ...skipped].join("; ")}` }
      : {}),
    data: { dryRun: opts.dryRun, deleted, browsers },
    ...(notes.length > 0 ? { warning: notes.join("; ") } : {}),
  }
}

export function parseGroupPruneOptions(filtered: string[]): GroupPruneOptions | { error: string } {
  const opts: GroupPruneOptions = { dryRun: false, allowFrontmost: false }
  for (let i = 2; i < filtered.length; i++) {
    const arg = filtered[i]
    if (arg === "--dry-run") opts.dryRun = true
    else if (arg === "--allow-frontmost") opts.allowFrontmost = true
    else if ((arg === "--app" || arg === "--brand") && filtered[i + 1] && !filtered[i + 1].startsWith("--")) {
      if (arg === "--app") opts.app = filtered[++i]
      else opts.brand = filtered[++i]
    } else {
      return { error: "usage: interceptor group prune [--dry-run] [--app <name>] [--brand <title>] [--allow-frontmost]" }
    }
  }
  return opts
}
