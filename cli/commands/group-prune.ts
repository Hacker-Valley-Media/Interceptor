/**
 * cli/commands/group-prune.ts — `interceptor group prune`.
 *
 *   interceptor group prune [label...] [--dry-run] [--app <name>] [--brand <title>] [--allow-frontmost]
 *
 * Deletes every CLOSED saved tab group that Interceptor left behind
 * (`<brand>` and `<brand>-<label>` chips on the bookmarks bar; issue #301).
 * With labels it deletes only `<brand>-<label>` for those labels: a delete
 * syncs to every profile on the account and cannot be undone.
 *
 * Chrome gives extensions no handle on a closed saved group: chrome.tabGroups
 * has get / query / update / move over OPEN groups and nothing else. The only
 * way to delete one is the browser's own UI, so this verb drives it through the
 * native desktop provider (Full install): open the chip's context menu, press
 * "Delete group", confirm the chip is gone. The calls are the same on macOS,
 * Windows and Linux; only the way the menu is opened differs, because the
 * Windows provider's `action` has no context-menu action. Every call goes to
 * the provider directly under its neutral `desktop_` name: on that path a
 * failed accessibility action is an error, where the macOS bridge's older
 * `macos_action` answers one with a real click at the element. Saved groups
 * sync, so a prune on one computer clears every profile and device on that account.
 *
 * There is no age filter: the browser UI exposes no timestamp for a saved
 * group. Prune takes every closed managed group and nothing else.
 */

import { callDesktopProvider } from "../../daemon/desktop-provider"
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
  /** Delete only `<brand>-<label>` for these labels. Absent: every closed managed group. */
  labels?: string[]
}

export const DEFAULT_BRAND = "interceptor"

// Chromium browsers that draw the saved tab groups bar: by bundle id where the
// host reports one (macOS), else by process or application name.
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
// Chrome can ask before it deletes a saved group: a window titled "Delete tab
// group?" holding "Delete group" and "Cancel" buttons (seen on Windows, Chrome 155).
// On a Mac the same dialog is a sheet in title case, "Delete Tab Group?" with
// "Delete Group" (Brave 155), hence the case-insensitive match.
const CONFIRM_RE = new RegExp(String.raw`^\s*${REF} (?:window|dialog|sheet|group) "Delete tab group\?"\s*$`, "i")
const CONFIRM_DELETE_RE = new RegExp(String.raw`^\s*${REF} button "Delete group"\s*$`, "i")
const CONFIRM_CANCEL_RE = new RegExp(String.raw`^\s*${REF} button "Cancel"\s*$`)
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
  openTitles: ReadonlySet<string>,
  labels?: readonly string[]
): SavedGroupChip[] {
  const brandList = [...brands]
  const openSomewhere = new Set(chips.filter((c) => c.state === "open").map((c) => c.title))
  const seen = new Set<string>()
  const out: SavedGroupChip[] = []
  for (const chip of chips) {
    if (chip.state !== "closed" || seen.has(chip.title)) continue
    if (!isManagedTitle(chip.title, brandList)) continue
    if (labels && !brandList.some((brand) => labels.some((label) => chip.title === `${brand}-${label}`))) continue
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

/**
 * Chrome's "Delete tab group?" confirmation, if the tree shows one: its two
 * buttons. Only lines nested under the dialog count; the tree text indents a
 * child deeper than its parent, so the scan stops where the dialog ends.
 */
export function findDeleteConfirmation(tree: string): { deleteRef?: string; cancelRef?: string } {
  const lines = tree.split("\n")
  const depth = (line: string) => line.length - line.trimStart().length
  for (let i = 0; i < lines.length; i++) {
    if (!CONFIRM_RE.test(lines[i])) continue
    const found: { deleteRef?: string; cancelRef?: string } = {}
    for (let j = i + 1; j < lines.length && depth(lines[j]) > depth(lines[i]); j++) {
      found.deleteRef ??= CONFIRM_DELETE_RE.exec(lines[j])?.[1]
      found.cancelRef ??= CONFIRM_CANCEL_RE.exec(lines[j])?.[1]
    }
    if (found.deleteRef || found.cancelRef) return found
  }
  return {}
}

export type BrowserApp = { name: string; pid: number; hidden: boolean }

/**
 * The running Chromium browsers, one entry per process: two instances of one
 * browser (a second user-data-dir) share a name, so each is addressed by pid.
 * Every host answers `apps` with rows. macOS rows carry `bundleId` and
 * `hidden`; Windows and Linux rows are `{ name, pid }`. A row with a bundle id
 * is judged by it alone, so an app that is merely named "Chrome" is not taken.
 */
export function parseRunningBrowsers(apps: unknown): BrowserApp[] {
  const browsers: BrowserApp[] = []
  if (!Array.isArray(apps)) return browsers
  for (const app of apps as Array<{ name?: unknown; pid?: unknown; bundleId?: unknown; hidden?: unknown }>) {
    if (typeof app?.name !== "string" || typeof app.pid !== "number") continue
    const isBrowser = typeof app.bundleId === "string" ? BROWSER_BUNDLES.has(app.bundleId) : BROWSER_NAME_RE.test(app.name.trim())
    if (isBrowser) browsers.push({ name: app.name, pid: app.pid, hidden: app.hidden === true })
  }
  return browsers
}

export const PRUNE_PLATFORMS = ["darwin", "win32", "linux"]

export const NO_VISIBLE_BROWSER = "the desktop provider lists no Chromium browser, so no closed groups were checked. "
  + "A browser that exposes no accessibility tree is invisible to it (Chromium under Wayland, for one); "
  + "delete its groups by hand (right-click the chip, then Delete group)"

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
  /** One call to the native provider, already under its `desktop_` name. */
  native: (send: SendFn, action: Action) => Promise<DaemonResult>
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
 * One native call. Actions are written with their macOS names and go to the
 * provider under the matching `desktop_` name on every host.
 */
async function native(send: SendFn, host: PruneHost, action: Action): Promise<DaemonResult> {
  try {
    return await host.native(send, desktopAction(action))
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
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
  // Straight to the provider, as `interceptor desktop` does: the daemon turns a
  // `desktop_` action back into the macOS bridge's `macos_` one.
  native: (_send, action) => callDesktopProvider(action),
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
  isFrontmost: () => Promise<boolean>, host: PruneHost
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
  report.found = selectPrunable(parseSavedGroupChips(first.tree), brands, openTitles, opts.labels).map((c) => c.title)
  if (opts.dryRun || report.found.length === 0) return report
  if (browser.hidden) {
    // A menu opened in a hidden app is not on screen and can bring the app back.
    report.skipped = `${app} is hidden; run again when its windows are on screen`
    return report
  }
  // An open context menu takes the keyboard of the frontmost app, so a person
  // typing in the browser would be typing into the menu.
  const frontmostSkip = `${app} is the frontmost app; run again when it is in the background, or pass --allow-frontmost`
  if (!opts.allowFrontmost && await isFrontmost()) {
    report.skipped = frontmostSkip
    return report
  }

  // A menu the person dismisses (a click elsewhere, an app switch) costs one
  // attempt, so each group gets two.
  const attempts = new Map<string, number>()
  const lastProblem = new Map<string, string>()
  // Each delete re-reads the tree: refs are short-lived and the bar reflows.
  let lastPressed: string | undefined
  // A confirmation takes a round of its own, hence the factor of two.
  for (let round = 0; round < report.found.length * MAX_ATTEMPTS * 2 + 1; round++) {
    const before = await readTree(run, pid, "all")
    if (before.tree === undefined) break
    // The run was asked to delete the group it just pressed, so it answers
    // Chrome's confirmation. One it cannot press is cancelled, so no dialog
    // is left over the person's window.
    const confirm = findDeleteConfirmation(before.tree)
    if ((confirm.deleteRef || confirm.cancelRef) && !lastPressed) {
      // Not this run's dialog: leave it to the person, as with an open menu.
      report.skipped = `a "Delete tab group?" dialog is already open in ${app}; nothing more was deleted`
      break
    }
    if (confirm.deleteRef || confirm.cancelRef) {
      const confirmed = confirm.deleteRef ? await run({ type: "macos_action", ref: confirm.deleteRef, action: "press" }) : undefined
      if (!confirmed?.success) {
        if (lastPressed) lastProblem.set(lastPressed, confirmed?.error ?? "the browser asked to confirm the delete and the confirmation could not be pressed")
        if (confirm.cancelRef) await run({ type: "macos_action", ref: confirm.cancelRef, action: "press" })
      }
      lastPressed = undefined
      await sleep(DELETE_SETTLE_MS)
      continue
    }
    if (findSavedGroupMenu(before.tree).menuRef) {
      report.skipped = `a saved tab group menu is already open in ${app}; nothing more was deleted`
      break
    }
    const next = selectPrunable(parseSavedGroupChips(before.tree), brands, openTitles, opts.labels)
      .find((c) => (attempts.get(c.title) ?? 0) < MAX_ATTEMPTS)
    if (!next) break
    // The person can switch to the browser while a run is under way.
    if (!opts.allowFrontmost && round > 0 && await isFrontmost()) {
      report.skipped = `${frontmostSkip}; nothing more was deleted`
      break
    }
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
    lastPressed = next.title
    await sleep(DELETE_SETTLE_MS)
  }

  // The chip being gone is the only proof of a delete.
  const after = await readTree(run, pid, "interactive")
  const remaining = new Set(parseSavedGroupChips(after.tree ?? "").map((c) => c.title))
  for (const title of attempts.keys()) {
    if (after.tree === undefined) report.failed.push({ title, reason: "could not re-read the browser to confirm the delete" })
    else if (!remaining.has(title)) report.deleted.push(title)
    else report.failed.push({ title, reason: lastProblem.get(title) ?? "still on the bar after 'Delete group'" })
  }
  return report
}

export async function runGroupPrune(
  opts: GroupPruneOptions, send: SendFn, host: PruneHost = REAL_HOST
): Promise<DaemonResult & { warning?: string }> {
  if (!PRUNE_PLATFORMS.includes(host.platform)) return { success: false, error: unsupportedPlatformError(host.platform) }
  const noProvider = await host.providerFailure(send)
  if (noProvider !== null) return { success: false, error: noProviderError(noProvider) }
  const run: Native = (action) => native(send, host, action)

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
  if (apps.length === 0) {
    // macOS lists every running app. The Windows and Linux providers list the
    // apps their accessibility layer can see, and Chromium under Wayland is not
    // one of them, so an empty list there is not proof that nothing was left.
    const unseen = host.platform === "darwin" ? {} : { warning: NO_VISIBLE_BROWSER }
    return { success: true, data: { dryRun: opts.dryRun, deleted: 0, browsers: [] }, ...unseen }
  }

  const isFrontmost = async (pid: number): Promise<boolean> => {
    // One window on macOS and Windows; Linux can answer with a list.
    const front = (await run({ type: "macos_frontmost" })).data
    return ((Array.isArray(front) ? front[0] : front) as { pid?: unknown } | null | undefined)?.pid === pid
  }

  const browsers: AppReport[] = []
  for (const app of apps) browsers.push(await pruneApp(run, app, brands, openTitles, opts, () => isFrontmost(app.pid), host))

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
    } else if (!arg.startsWith("--") && GROUP_LABEL_RE.test(arg)) {
      (opts.labels ??= []).push(arg)
    } else {
      return { error: "usage: interceptor group prune [label...] [--dry-run] [--app <name>] [--brand <title>] [--allow-frontmost]" }
    }
  }
  return opts
}
