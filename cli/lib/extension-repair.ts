/**
 * cli/lib/extension-repair.ts — `interceptor diagnose extension [--fix | --prompt] [--browser <key>] [--json]`
 *
 * Through 0.24.13 the unpacked extension carried the development key (ID
 * hkjb…). 1.0.1 moved the same installed folder to the Chrome Web Store key
 * (ID gomcp…), on macOS and Windows alike. A browser profile keeps one entry
 * per ID, and at every start Chromium re-reads each unpacked folder's
 * manifest. An entry whose folder now holds the other ID marks that folder
 * invalid, and Chromium then loads nothing from it
 * (chrome/browser/extensions/installed_loader.cc).
 *
 * What this module tells apart, per browser profile:
 *   both-ids     the old-ID entry and the current entry share one folder: the
 *                current copy works until the browser quits, then is gone.
 *   old-id-only  the old-ID entry is the profile's only Interceptor: nothing
 *                has loaded there since the update.
 *   session      the only entry is a --load-extension load (scripts/install.sh):
 *                Chromium never keeps those across a restart.
 *   two-copies   both IDs load persistently in one profile (for example after
 *                a manual fix that skipped the Remove step): every page gets
 *                Interceptor twice.
 * An old-ID entry next to a copy that works elsewhere (a store install) is
 * harmless and never reported.
 *
 * Fixes. both-ids in a browser that honors --load-extension (Brave, Vivaldi,
 * Chromium, Chrome for Testing) on macOS: quit the browser, start it once
 * hidden with --load-extension pointing at extension-legacy/ (the same
 * extension under the old key). Chromium moves the old entry there as a
 * command-line load, which it skips at every later start, so the shared folder
 * is valid again. Then reopen it with the windows and tabs it had. Everything
 * else (Google Chrome and Edge ignore the flag; old-id-only, session and
 * two-copies need a persistent change only the user can make) gets exact
 * manual steps; the dialog's Open button puts the folder on the clipboard and
 * opens a window for that profile (Chromium ignores chrome://extensions passed
 * on the command line, so the user types it; checked in a scratch browser).
 *
 * Mechanics each checked in Chromium source or a scratch browser:
 *   - the instance that owns a user-data dir is the pid in its SingletonLock;
 *   - SIGHUP runs the browser's normal quit and flushes Secure Preferences
 *     (chrome_browser_main_posix.cc); SIGTERM ends it without "Leave site?";
 *   - `open -n`: a plain `open -b` hands its --args to nobody when another
 *     instance of the same app (an automation profile) is already running;
 *   - a folder loaded for an ID whose service worker was registered earlier
 *     keeps running the cached script until the extension is reloaded, so
 *     manual steps for the old-ID copy end with a reload.
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"
import { homedir, hostname } from "node:os"
import { basename, dirname, join } from "node:path"
import { deriveChromiumExtensionId } from "../../scripts/installer/generate-native-host"
import { bridgeSocketPathForDetection } from "../../shared/bridge-paths"
import { LEGACY_DEVELOPMENT_EXTENSION_ID, STORE_EXTENSION_ID, STORE_LISTING_URL } from "../../shared/extension-identity"
import { brandDialog, type DialogView } from "./hvm-window"

type Platform = "darwin" | "win32" | "linux"

export type RepairBrowser = {
  key: string
  label: string
  /** User-data dir under ~/Library/Application Support (darwin), %LOCALAPPDATA% (win32) or ~/.config (linux). */
  dirs: Partial<Record<Platform, string>>
  /** macOS bundle id: the restart fix, and the dialog's Open button. */
  bundleId?: string
  /** win32: paths under Program Files / LOCALAPPDATA; linux: names on PATH. For the dialog's Open button. */
  exe?: Partial<Record<Platform, string[]>>
  /** Honors --load-extension. Google-branded Chrome and Edge ignore it. */
  loadExtension: boolean
  extensionsUrl: string
  /** Points the user-data dir at a fixture; tests also route the launch through it. */
  overrideEnv: string
}

export const REPAIR_BROWSERS: RepairBrowser[] = [
  { key: "chrome", label: "Google Chrome", dirs: { darwin: "Google/Chrome", win32: "Google\\Chrome\\User Data", linux: "google-chrome" }, bundleId: "com.google.Chrome", exe: { win32: ["Google\\Chrome\\Application\\chrome.exe"], linux: ["google-chrome", "google-chrome-stable"] }, loadExtension: false, extensionsUrl: "chrome://extensions", overrideEnv: "INTERCEPTOR_CHROME_USER_DATA" },
  { key: "brave", label: "Brave", dirs: { darwin: "BraveSoftware/Brave-Browser", win32: "BraveSoftware\\Brave-Browser\\User Data", linux: "BraveSoftware/Brave-Browser" }, bundleId: "com.brave.Browser", exe: { win32: ["BraveSoftware\\Brave-Browser\\Application\\brave.exe"], linux: ["brave-browser", "brave"] }, loadExtension: true, extensionsUrl: "brave://extensions", overrideEnv: "INTERCEPTOR_BRAVE_USER_DATA" },
  { key: "vivaldi", label: "Vivaldi", dirs: { darwin: "Vivaldi", win32: "Vivaldi\\User Data", linux: "vivaldi" }, bundleId: "com.vivaldi.Vivaldi", exe: { win32: ["Vivaldi\\Application\\vivaldi.exe"], linux: ["vivaldi", "vivaldi-stable"] }, loadExtension: true, extensionsUrl: "vivaldi://extensions", overrideEnv: "INTERCEPTOR_VIVALDI_USER_DATA" },
  { key: "edge", label: "Microsoft Edge", dirs: { darwin: "Microsoft Edge", win32: "Microsoft\\Edge\\User Data", linux: "microsoft-edge" }, bundleId: "com.microsoft.edgemac", exe: { win32: ["Microsoft\\Edge\\Application\\msedge.exe"], linux: ["microsoft-edge", "microsoft-edge-stable"] }, loadExtension: false, extensionsUrl: "edge://extensions", overrideEnv: "INTERCEPTOR_EDGE_USER_DATA" },
  { key: "chromium", label: "Chromium", dirs: { darwin: "Chromium", win32: "Chromium\\User Data", linux: "chromium" }, bundleId: "org.chromium.Chromium", exe: { win32: ["Chromium\\Application\\chrome.exe"], linux: ["chromium", "chromium-browser"] }, loadExtension: true, extensionsUrl: "chrome://extensions", overrideEnv: "INTERCEPTOR_CHROMIUM_USER_DATA" },
  // ponytail: Arc's handling of --load-extension is untested, so it gets the manual steps.
  { key: "arc", label: "Arc", dirs: { darwin: "Arc/User Data" }, bundleId: "company.thebrowser.Browser", loadExtension: false, extensionsUrl: "chrome://extensions", overrideEnv: "INTERCEPTOR_ARC_USER_DATA" },
  { key: "cft", label: "Google Chrome for Testing", dirs: { darwin: "Google/Chrome for Testing" }, bundleId: "com.google.chrome.for.testing", loadExtension: true, extensionsUrl: "chrome://extensions", overrideEnv: "INTERCEPTOR_CFT_USER_DATA" },
]

const OUR_IDS = [LEGACY_DEVELOPMENT_EXTENSION_ID, STORE_EXTENSION_ID]
const UNPACKED = 4     // ManifestLocation::kUnpacked
const COMMAND_LINE = 8 // ManifestLocation::kCommandLine: skipped at every start
const CHILD_ENV = "INTERCEPTOR_EXTENSION_REPAIR_CHILD"
/** Set on the copy the bridge runs, so it does not hand itself to the bridge again. */
const VIA_BRIDGE_ENV = "INTERCEPTOR_EXTENSION_REPAIR_VIA_BRIDGE"
const BRIDGE_APP = "/Applications/interceptor-bridge.app"
const PLATFORM = process.platform as Platform

/** The postinstall passes HOME for the console user; honor it (Bun's homedir() reads the passwd entry). */
const home = () => (PLATFORM !== "win32" && process.env.HOME) || homedir()
const readJson = (file: string): any => { try { return JSON.parse(readFileSync(file, "utf8")) } catch { return null } }
const norm = (p: string) => PLATFORM === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export function userDataDir(b: RepairBrowser): string | null {
  const override = process.env[b.overrideEnv]
  if (override) return override
  const dir = b.dirs[PLATFORM]
  if (!dir) return null
  if (PLATFORM === "darwin") return join(home(), "Library", "Application Support", dir)
  if (PLATFORM === "win32") return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, dir) : null
  return join(process.env.XDG_CONFIG_HOME || join(home(), ".config"), dir)
}

/** The old-key copy the installers leave next to the current one. macOS and
 *  Windows ship it (both released the old key in the same folder). ponytail:
 *  Linux releases began after the key change, so none ship it; a source checkout
 *  that needs one can stamp it with scripts/stamp-legacy-extension.ts. */
export function legacyExtensionDir(): string {
  if (process.env.INTERCEPTOR_LEGACY_EXTENSION_DIR) return process.env.INTERCEPTOR_LEGACY_EXTENSION_DIR
  if (PLATFORM === "darwin") return "/Library/Application Support/Interceptor/extension-legacy"
  const besideExe = join(dirname(process.execPath), PLATFORM === "win32" ? "extension-legacy" : "../extension-legacy")
  if (PLATFORM === "win32" && !existsSync(besideExe) && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "Programs", "Interceptor", "extension-legacy")
  return besideExe
}

/** The installed current copy (store key): the folder to load when a session load's own folder is gone. */
export function currentExtensionDir(): string {
  if (PLATFORM === "darwin") return "/Library/Application Support/Interceptor/extension"
  return join(dirname(legacyExtensionDir()), "extension")
}

/** The folder a by-hand fix should load for a session-only finding. */
function sessionFolder(f: { extensionId: string; path: string }): string {
  if (f.extensionId === LEGACY_DEVELOPMENT_EXTENSION_ID) return legacyExtensionDir()
  return existsSync(join(f.path, "manifest.json")) ? f.path : currentExtensionDir()
}

export type FindingKind = "both-ids" | "old-id-only" | "session" | "two-copies"

export type Finding = {
  kind: FindingKind
  browser: RepairBrowser
  profileDir: string
  profileName: string
  /** The entry the fix acts on. */
  extensionId: string
  path: string
  /** A restart (fixBrowser) repairs it. */
  autoFix: boolean
}

function manifestIdOf(cache: Map<string, string | null>, dir: string): string | null {
  const key = norm(dir)
  if (!cache.has(key)) {
    const k = readJson(join(dir, "manifest.json"))?.key
    let id: string | null = null
    try { id = typeof k === "string" ? deriveChromiumExtensionId(k) : null } catch {}
    cache.set(key, id)
  }
  return cache.get(key) ?? null
}

/** Pure classification of one profile's extension settings; exported for tests. */
export function classifyProfile(
  browser: RepairBrowser,
  profileDir: string,
  profileName: string,
  settings: Record<string, any>,
  opts: { idOf: (dir: string) => string | null; enhancedSafeBrowsing: boolean; legacyDir: string },
): Finding[] {
  const ours = OUR_IDS.flatMap(id => (settings[id] && typeof settings[id] === "object" ? [{ id, e: settings[id] }] : []))
  const isUnpacked = (e: any) => e.location === UNPACKED && typeof e.path === "string"
  const dead = ours.filter(({ id, e }) => isUnpacked(e) && id === LEGACY_DEVELOPMENT_EXTENSION_ID && (() => { const a = opts.idOf(e.path); return a !== null && a !== id })())
  const poisoned = new Set(dead.map(({ e }) => norm(e.path)))
  // A copy the profile keeps across starts (it may be switched off)...
  const installed = ours.filter(({ id, e }) =>
    e.location !== COMMAND_LINE && !(isUnpacked(e) && (opts.idOf(e.path) !== id || poisoned.has(norm(e.path)))))
  // ...and one that runs. Switched off only "for reload" (DISABLE_RELOAD, 4)
  // comes back on at the next start; switched off by the user or a policy does not.
  const running = installed.filter(({ e }) => !Array.isArray(e.disable_reasons) || e.disable_reasons.every((r: unknown) => r === 4))
  const make = (kind: FindingKind, id: string, path: string, autoFix = false): Finding =>
    ({ kind, browser, profileDir, profileName, extensionId: id, path, autoFix })

  const found: Finding[] = []
  for (const { id, e } of dead) {
    const sharesFolder = ours.some(o => o.id !== id && isUnpacked(o.e) && norm(o.e.path) === norm(e.path))
    if (sharesFolder) {
      const restartable = PLATFORM === "darwin" && !!browser.bundleId && browser.loadExtension && !opts.enhancedSafeBrowsing
      found.push(make("both-ids", id, e.path, restartable))
    } else if (installed.length === 0) {
      found.push(make("old-id-only", id, e.path))
    }
    // else: the profile keeps a copy elsewhere (the store install); this entry is harmless.
  }
  if (running.length > 1) {
    const old = running.find(w => w.id === LEGACY_DEVELOPMENT_EXTENSION_ID)!
    found.push(make("two-copies", old.id, old.e.path ?? ""))
  }
  if (installed.length === 0 && dead.length === 0) {
    // Our own one-time --load-extension start leaves inert command-line entries
    // on the legacy folder in every profile it opened; those are not a problem.
    const session = ours.find(({ e }) => e.location === COMMAND_LINE && typeof e.path === "string" && norm(e.path) !== norm(opts.legacyDir))
    if (session) found.push(make("session", session.id, session.e.path))
  }
  return found
}

/** Every Interceptor problem in a Chromium profile on this computer. macOS 27
 *  refuses to open Chrome, Brave and Edge data to a process without Full Disk
 *  Access (the installer's and Sparkle's included); such a browser goes in
 *  `blocked` so nobody reports it as clean. */
export function findProblems(only?: string, blocked: RepairBrowser[] = [], skipProtected = false): Finding[] {
  const idCache = new Map<string, string | null>()
  const legacyDir = legacyExtensionDir()
  const found: Finding[] = []
  eachProfile(only, blocked, skipProtected, (browser, profileDir, profileName, settings, prefs) => {
    found.push(...classifyProfile(browser, profileDir, profileName, settings, {
      idOf: dir => manifestIdOf(idCache, dir),
      enhancedSafeBrowsing: prefs?.safebrowsing?.enhanced === true,
      legacyDir,
    }))
  })
  return found
}

export type Copy = { browser: RepairBrowser; profileDir: string; profileName: string; extensionId: string; on: boolean }

/** The Interceptor copies profiles keep (store or unpacked), and whether each is
 *  switched on; the welcome window's "already added" check. */
export function findCopies(only?: string, blocked: RepairBrowser[] = [], skipProtected = false): Copy[] {
  const idCache = new Map<string, string | null>()
  const out: Copy[] = []
  eachProfile(only, blocked, skipProtected, (browser, profileDir, profileName, settings) => {
    for (const id of OUR_IDS) {
      const e = settings[id]
      if (!e || typeof e !== "object" || e.location === COMMAND_LINE) continue
      if (e.location === UNPACKED && (typeof e.path !== "string" || manifestIdOf(idCache, e.path) !== id)) continue
      const on = !Array.isArray(e.disable_reasons) || e.disable_reasons.every((r: unknown) => r === 4)
      out.push({ browser, profileDir, profileName, extensionId: id, on })
    }
  })
  return out
}

/** macOS 27 protects a browser's data folder (com.apple.macl) once the browser has
 *  run there. Being refused it posts "Data Access Blocked" to the user; listing
 *  the folder's attribute names is allowed and posts nothing (macOS 27.0.1). */
const isProtected = (dir: string) => PLATFORM === "darwin" && existsSync(dir) &&
  (spawnSync("/bin/ls", ["-ld@", dir], { encoding: "utf8" }).stdout ?? "").includes("com.apple.macl")

function eachProfile(only: string | undefined, blocked: RepairBrowser[], skipProtected: boolean, visit: (browser: RepairBrowser, profileDir: string, profileName: string, settings: Record<string, any>, prefs: any) => void): void {
  for (const browser of REPAIR_BROWSERS) {
    if (only && browser.key !== only) continue
    const root = userDataDir(browser)
    if (!root) continue
    if (skipProtected && isProtected(root)) { blocked.push(browser); continue }
    let dirs: string[]
    try { dirs = readdirSync(root).filter(d => d === "Default" || /^Profile \d+$/.test(d)) } catch (e: any) {
      if (e?.code === "EPERM" || e?.code === "EACCES") blocked.push(browser)
      continue
    }
    // Only the profiles the browser still lists: a deleted profile can leave its
    // folder behind, and opening it to repair it would bring it back.
    const cache = readJson(join(root, "Local State"))?.profile?.info_cache ?? {}
    if (Object.keys(cache).length > 0) dirs = dirs.filter(d => d in cache)
    for (const profileDir of dirs) {
      const secure = readJson(join(root, profileDir, "Secure Preferences"))
      const prefs = readJson(join(root, profileDir, "Preferences"))
      // Linux builds without a MAC seed can keep extension settings in Preferences.
      const settings = { ...(prefs?.extensions?.settings ?? {}), ...(secure?.extensions?.settings ?? {}) }
      visit(browser, profileDir, cache[profileDir]?.name || profileDir, settings, prefs)
    }
  }
}

// ── the restart fix (macOS) ─────────────────────────────────────────────────

/** How to start the browser; production uses LaunchServices, tests a headless binary. */
export type BrowserControl = {
  launch(args: string[], opts: { hidden: boolean }): void
  /** A second launch with --profile-directory hands that profile to the running instance. */
  openProfile(profileDir: string): void
}

const dataDirArgs = (b: RepairBrowser) => process.env[b.overrideEnv] ? [`--user-data-dir=${process.env[b.overrideEnv]}`] : []

/** One value from an app's Info.plist, XML or binary. */
const infoPlist = (app: string, key: string) =>
  (spawnSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", join(app, "Contents/Info.plist")], { encoding: "utf8" }).stdout ?? "").trim()

function macControl(b: RepairBrowser): BrowserControl {
  return {
    launch(args, { hidden }) {
      spawnSync("/usr/bin/open", ["-n", "-g", ...(hidden ? ["-j"] : []), "-b", b.bundleId!, "--args", ...dataDirArgs(b), ...args])
    },
    openProfile(profileDir) {
      const bundle = (spawnSync("/usr/bin/lsappinfo", ["info", "-only", "bundlepath", "-app", b.bundleId!], { encoding: "utf8" }).stdout ?? "").match(/bundle path="([^"]+)"/)?.[1]
      const exe = bundle && infoPlist(bundle, "CFBundleExecutable")
      if (exe) spawn(join(bundle!, "Contents/MacOS", exe), [...dataDirArgs(b), `--profile-directory=${profileDir}`], { detached: true, stdio: "ignore" }).unref()
    },
  }
}

/** The pid that owns a user-data dir, from its SingletonLock ("<host>-<pid>"),
 *  when it runs on this computer and is that browser: a lock left by a crash
 *  can name a pid the system has since given to an unrelated process. */
export function instancePid(userData: string, b: RepairBrowser): number | null {
  let lock = ""
  try { lock = readlinkSync(join(userData, "SingletonLock")) } catch { return null }
  const cut = lock.lastIndexOf("-"), pid = Number(lock.slice(cut + 1))
  if (lock.slice(0, cut) !== hostname() || !(pid > 0)) return null
  try { process.kill(pid, 0) } catch { return null }
  // ponytail: only the macOS restart fix signals this pid, so only macOS checks the executable.
  if (PLATFORM !== "darwin") return pid
  // The browser's argv[0] is its executable inside the app bundle.
  const app = (spawnSync("/bin/ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).stdout ?? "").trim().match(/^(.+\.app)\/Contents\/MacOS\/[^/]+$/)?.[1]
  return app && infoPlist(app, "CFBundleIdentifier") === b.bundleId ? pid : null
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(400)) if (check()) return true
  return check()
}

/** SIGHUP is the normal quit, so a page with unsaved work may ask "Leave site?":
 *  give the user up to three minutes. `force` (our own hidden start) ends with
 *  SIGTERM, which skips those prompts. */
async function quit(userData: string, b: RepairBrowser, log: (l: string) => void, force: boolean): Promise<boolean> {
  const pid = instancePid(userData, b)
  if (!pid) return true
  try { process.kill(pid, "SIGHUP") } catch { return instancePid(userData, b) === null }
  if (await waitFor(() => instancePid(userData, b) === null, 15_000)) return true
  if (force) {
    try { process.kill(pid, "SIGTERM") } catch {}
    return waitFor(() => instancePid(userData, b) === null, 20_000)
  }
  log(`${b.label}: still open; a page may be asking whether to leave`)
  return waitFor(() => instancePid(userData, b) === null, 165_000)
}

function entryOf(userData: string, profileDir: string, id: string): any {
  return readJson(join(userData, profileDir, "Secure Preferences"))?.extensions?.settings?.[id]
}

export type FixResult = { browser: RepairBrowser; fixed: Finding[]; failed: Finding[]; reason?: string }

/** Quit the browser, start it once hidden with the old-key copy, quit, reopen. */
export async function fixBrowser(browser: RepairBrowser, findings: Finding[], log: (l: string) => void = () => {}, control?: BrowserControl): Promise<FixResult> {
  const userData = userDataDir(browser)!
  const ctl = control ?? macControl(browser)
  const legacy = legacyExtensionDir()
  const moved = (f: Finding) => { const e = entryOf(userData, f.profileDir, f.extensionId); return !e || e.location !== UNPACKED || norm(e.path) !== norm(f.path) }
  const result = (reason?: string): FixResult => ({ browser, fixed: findings.filter(moved), failed: findings.filter(f => !moved(f)), reason })

  const wasRunning = instancePid(userData, browser) !== null
  log(`${browser.label}: ${wasRunning ? "quitting" : "not running"}`)
  if (!await quit(userData, browser, log, false)) return result(`${browser.label} did not quit within 3 minutes; a page asked to stay open`)

  // Written at the quit above: the profiles --restore-last-session will reopen.
  const lastActive = new Set<string>(readJson(join(userData, "Local State"))?.profile?.last_active_profiles ?? [])
  log(`${browser.label}: starting once, hidden, with ${legacy}`)
  ctl.launch([`--load-extension=${legacy}`, "--restore-last-session"], { hidden: true })
  if (!await waitFor(() => instancePid(userData, browser) !== null, 20_000)) return result(`${browser.label} did not start`)
  // --load-extension applies to every profile this instance loads, so a profile
  // that was not open gets loaded by handing it to the running instance.
  await sleep(2_000)
  for (const f of findings) {
    if (!lastActive.has(f.profileDir) && !moved(f)) {
      log(`${browser.label}: opening profile ${f.profileName}, which was not open`)
      ctl.openProfile(f.profileDir)
    }
  }
  // Secure Preferences is written on a ~10 s timer; the quit below flushes it.
  await waitFor(() => findings.every(moved), 25_000)

  log(`${browser.label}: quitting the one-time start`)
  if (!await quit(userData, browser, log, true)) return result(`${browser.label} did not quit after the one-time start; quit it and open it again`)
  const done = result()
  if (wasRunning) {
    log(`${browser.label}: reopening with your windows and tabs`)
    ctl.launch(["--restore-last-session"], { hidden: false })
    // The summary comes after the browser's windows are back, or the browser covers it.
    await waitFor(() => instancePid(userData, browser) !== null, 20_000)
    await sleep(3000)
  }
  return done.failed.length ? { ...done, reason: "the profile did not load during the one-time start" } : done
}

// ── words ───────────────────────────────────────────────────────────────────

const STATE: Record<FindingKind, string> = {
  "both-ids": "lost at every browser start",
  "old-id-only": "not loading since the update",
  "session": "loaded for one session only",
  "two-copies": "running twice",
}

const where = (f: Finding) => `${f.browser.label}, profile "${f.profileName}"`

export function manualStep(f: Finding): string {
  const open = `type ${f.browser.extensionsUrl} in the address bar and turn on Developer mode`
  const legacy = legacyExtensionDir()
  switch (f.kind) {
    case "both-ids":
      return `${where(f)}: ${open}, click Load unpacked and choose ${legacy}. Then click Remove on the card named "Interceptor (old ID)" if it is there, and quit and reopen ${f.browser.label}.`
    case "old-id-only":
      return `${where(f)}: ${open}, click Load unpacked and choose ${legacy}, then click the reload arrow on the "Interceptor (old ID)" card. Keep that card: it is your Interceptor.`
    case "session":
      return `${where(f)}: ${open}, click Load unpacked and choose ${sessionFolder(f)}${f.extensionId === LEGACY_DEVELOPMENT_EXTENSION_ID ? ` and click the reload arrow on its card` : `, or install Interceptor from ${STORE_LISTING_URL}`}. Until then Interceptor lasts only until the browser quits.`
    case "two-copies":
      return `${where(f)}: type ${f.browser.extensionsUrl} in the address bar and click Remove on the Interceptor card with ID ${f.extensionId}${f.path === legacy ? ` (named "Interceptor (old ID)")` : ""}.`
  }
}

export function report(findings: Finding[], blocked: RepairBrowser[] = []): string {
  const howTo = existsSync(BRIDGE_APP)
    ? "In System Settings > Privacy & Security > Files & Folders, turn on each browser under interceptor-bridge (or give interceptor-bridge Full Disk Access), then run 'interceptor diagnose extension' again."
    : "Run 'interceptor diagnose extension' in a terminal that has Full Disk Access."
  const cannot = blocked.length ? [`  could not check ${blocked.map(b => b.label).join(", ")}: macOS needs your permission before another app reads ${blocked.length === 1 ? "its" : "their"} settings. ${howTo}`] : []
  if (findings.length === 0) return [blocked.length ? "extension: no problems in the browsers Interceptor could read" : "extension: Interceptor loads normally in every browser profile on this computer", ...cannot].join("\n")
  const lines = [`extension: ${findings.length} browser profile problem${findings.length === 1 ? "" : "s"} with Interceptor:`]
  for (const f of findings) lines.push(`  ${where(f)} (${f.profileDir}): ${STATE[f.kind]}  ${f.autoFix ? "fix: interceptor diagnose extension --fix" : "fix: by hand, below"}`)
  const manual = findings.filter(f => !f.autoFix)
  if (manual.length) lines.push(...manual.map(manualStep))
  return [...lines, ...cannot].join("\n")
}

// ── the installer warning ───────────────────────────────────────────────────

const stateDir = () => join(home(), ".interceptor")
const ACK_FILE = () => join(stateDir(), "extension-repair-acked.json")
const ackKey = (f: Finding) => `${f.browser.key}:${f.profileDir}:${f.kind}:${f.extensionId}`

function readAcked(): Set<string> {
  const v = readJson(ACK_FILE())
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
}

/** Manual-only findings are shown once, not at every install and update;
 *  `diagnose extension` and `--fix` always report them. */
function recordAcked(findings: Finding[]): void {
  addAcks(findings.map(ackKey))
}

function addAcks(keys: string[]): void {
  const acked = readAcked()
  for (const k of keys) acked.add(k)
  try { mkdirSync(stateDir(), { recursive: true }); writeFileSync(ACK_FILE(), JSON.stringify([...acked])) } catch {}
}

/** One dialog at a time: two installs in a row must not stack two prompts.
 *  A lock left by a process that died is taken over. Exported for tests. */
export function takeLock(): boolean {
  const lock = join(stateDir(), "extension-repair.lock")
  try { mkdirSync(stateDir(), { recursive: true }) } catch {}
  let holder = 0
  try { holder = Number(readFileSync(lock, "utf8").trim()) || 0 } catch {}
  if (holder && holder !== process.pid) { try { process.kill(holder, 0); return false } catch {} }
  try { writeFileSync(lock, String(process.pid)) } catch { return true }
  process.on("exit", () => { try { if (readFileSync(lock, "utf8").trim() === String(process.pid)) rmSync(lock) } catch {} })
  return true
}

/** Shows a dialog and returns the clicked button, or null when none was shown or
 *  it was closed. The first button is the default and, with two or more, also the
 *  cancel button: the dialog takes focus, so a Return or Escape meant for another
 *  app never picks an action. On macOS it is the branded window (hvm-window.ts);
 *  the system dialog is the fallback. */
export function dialog(message: string, buttons: string[], view?: DialogView): string | null {
  if (PLATFORM === "darwin") {
    const branded = brandDialog(view ?? { title: "Interceptor", text: message.split(/\n\n+/) }, buttons)
    if (branded !== undefined) return branded
    const script = [
      "on run argv",
      "activate",
      "set choices to items 2 thru -1 of argv",
      `display dialog (item 1 of argv) with title "Interceptor" buttons choices default button 1${buttons.length > 1 ? " cancel button 1" : ""} with icon caution`,
      "return button returned of result",
      "end run",
    ]
    const r = spawnSync("/usr/bin/osascript", [...script.flatMap(line => ["-e", line]), message, ...buttons], { encoding: "utf8" })
    // The cancel button ends the script with "User canceled. (-128)".
    return r.status === 0 ? r.stdout.trim() : (r.stderr ?? "").includes("(-128)") ? buttons[0] : null
  }
  if (PLATFORM === "win32") {
    // A message box has fixed buttons: Yes = the second choice, No (the default) = the first.
    const ps = "Add-Type -AssemblyName PresentationFramework; " +
      `[System.Windows.MessageBox]::Show($env:IX_MSG, 'Interceptor', '${buttons.length > 1 ? "YesNo" : "OK"}', 'Warning', '${buttons.length > 1 ? "No" : "OK"}').ToString()`
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", env: { ...process.env, IX_MSG: buttons.length > 1 ? `${message}\n\nYes: ${buttons[1]}.  No: ${buttons[0]}.` : message }, windowsHide: true })
    const out = (r.stdout ?? "").trim()
    return out === "Yes" ? buttons[1] : out ? buttons[0] : null
  }
  return null
}

export function copyToClipboard(text: string): void {
  if (PLATFORM === "darwin") spawnSync("/usr/bin/pbcopy", [], { input: text })
  else if (PLATFORM === "win32") spawnSync("powershell.exe", ["-NoProfile", "-Command", "Set-Clipboard -Value $env:IX_CLIP"], { env: { ...process.env, IX_CLIP: text }, windowsHide: true })
}

function winExe(b: RepairBrowser): string | null {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[]
  for (const rel of b.exe?.win32 ?? []) for (const root of roots) if (existsSync(join(root, rel))) return join(root, rel)
  return null
}

/** Puts the folder to choose on the clipboard and opens a window for each profile. */
function openForSteps(findings: Finding[]): void {
  const pick = findings.find(f => f.kind !== "two-copies")
  if (pick) copyToClipboard(pick.kind === "session" ? sessionFolder(pick) : legacyExtensionDir())
  const seen = new Set<string>()
  for (const f of findings) {
    const k = `${f.browser.key}:${f.profileDir}`
    if (seen.has(k)) continue
    seen.add(k)
    const args = [...dataDirArgs(f.browser), `--profile-directory=${f.profileDir}`]
    if (PLATFORM === "darwin" && f.browser.bundleId) spawnSync("/usr/bin/open", ["-n", "-b", f.browser.bundleId, "--args", ...args])
    else if (PLATFORM === "win32") { const exe = winExe(f.browser); if (exe) spawn(exe, args, { detached: true, stdio: "ignore" }).unref() }
  }
}

function detachSelf(only?: string, mode = "--prompt"): void {
  const self = basename(process.execPath).replace(/\.exe$/i, "") === "bun" ? [process.argv[1]] : []
  const logDir = PLATFORM === "darwin" ? join(home(), "Library", "Logs") : stateDir()
  try { mkdirSync(logDir, { recursive: true }) } catch {}
  const log = openSync(join(logDir, "interceptor-extension-repair.log"), "a")
  spawn(process.execPath, [...self, "diagnose", "extension", mode, ...(only ? ["--browser", only] : [])], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, [CHILD_ENV]: "1" },
  }).unref()
}

const stamp = () => `[${new Date().toISOString()}]`
const profiles = (fs: Finding[]) => [...new Set(fs.map(f => `"${f.profileName}"`))].join(", ")

function byBrowser(findings: Finding[]): Map<RepairBrowser, Finding[]> {
  const out = new Map<RepairBrowser, Finding[]>()
  for (const f of findings) out.set(f.browser, [...(out.get(f.browser) ?? []), f])
  return out
}

/** The warning the installers raise: explain, ask, restart what can be restarted, report. */
export async function promptAndFix(findings: Finding[], rescan: () => Finding[]): Promise<void> {
  const auto = byBrowser(findings.filter(f => f.autoFix))
  const manual = findings.filter(f => !f.autoFix)
  const labels = [...auto.keys()].map(b => b.label).join(" and ")
  const parts = ["Interceptor found browser profiles where it cannot load properly:"]
  for (const [b, fs] of byBrowser(findings)) parts.push(`${b.label}: ${fs.map(f => `"${f.profileName}" (${STATE[f.kind]})`).join(", ")}`)
  const restartText = `Restart ${labels} to fix it. Interceptor closes the browser, opens it hidden for a few seconds to move an old copy of the extension aside, then reopens it with your windows and tabs. If a page asks whether to leave, choose Leave. A browser that is closed now stays closed.`
  if (auto.size) parts.push(restartText)
  const openLabel = `Open ${[...byBrowser(manual).keys()].map(b => b.label).join(" and ")}`
  // With a restart to offer, the Open button is on the window after the restart.
  const manualText = `A restart can't fix ${manual.length === 1 ? "this one" : "these"}; it takes a minute by hand:\n${manual.map(manualStep).join("\n")}\n\n${auto.size ? `After the restart, ${openLabel} in the next window` : openLabel} copies the folder path and opens that profile.${PLATFORM === "darwin" ? " In the folder picker, press Command-Shift-G and paste it." : " In the folder picker, paste it into the address box."}`
  if (manual.length) parts.push(manualText)
  const buttons = auto.size ? ["Later", `Restart ${labels}`] : ["OK", openLabel]
  const choice = dialog(parts.join("\n\n"), buttons, {
    eyebrow: "Browser check", tone: "warn", title: "Interceptor needs a quick fix",
    text: ["Interceptor found browser profiles where it cannot load properly:"],
    items: findings.map(f => ({ name: f.browser.label, detail: `"${f.profileName}"`, chip: STATE[f.kind] })),
    after: [...(auto.size ? [restartText] : []), ...(manual.length ? manualText.split(/\n\n+/) : [])],
  })
  console.log(`${stamp()} dialog: ${choice ?? "not shown or closed"}`)
  // Shown once means a button was clicked; a dialog that never appeared comes back next time.
  if (manual.length && choice !== null) recordAcked(manual)
  if (choice === openLabel) return openForSteps(manual)
  if (!auto.size || choice !== buttons[1]) return

  // The dialog can sit for hours; fix what is still broken now.
  const results: FixResult[] = []
  for (const [b, fs] of byBrowser(rescan().filter(f => f.autoFix))) results.push(await fixBrowser(b, fs, line => console.log(`${stamp()} ${line}`)))
  const done = results.flatMap(r => r.fixed.length ? [`${r.browser.label}: ${profiles(r.fixed)}`] : [])
  const notDone = results.flatMap(r => r.failed.length ? [`${r.browser.label}: ${profiles(r.failed)} (${r.reason})`] : [])
  const summary = [
    done.length ? `Interceptor will load again in:\n${done.join("\n")}` : "",
    notDone.length ? `Not fixed:\n${notDone.join("\n")}\n\nRun 'interceptor diagnose extension --fix' to try again.` : "",
    manual.length ? `Still to do by hand:\n${manual.map(manualStep).join("\n")}` : "",
  ].filter(Boolean).join("\n\n")
  console.log(`${stamp()} ${summary.replace(/\n+/g, " | ")}`)
  const after = dialog(summary, manual.length ? ["OK", openLabel] : ["OK"], {
    eyebrow: "Browser check", tone: notDone.length ? "warn" : "ok",
    title: notDone.length ? (done.length ? "Partly fixed" : "Not fixed yet") : "Interceptor is back",
    items: [
      ...results.flatMap(r => r.fixed.map(f => ({ name: r.browser.label, detail: `"${f.profileName}"`, chip: "fixed", chipTone: "ok" as const }))),
      ...results.flatMap(r => r.failed.map(f => ({ name: r.browser.label, detail: `"${f.profileName}": ${r.reason}`, chip: "not fixed" }))),
    ],
    after: [
      ...(notDone.length ? ["Run 'interceptor diagnose extension --fix' to try again."] : []),
      ...(manual.length ? [`Still to do by hand:\n${manual.map(manualStep).join("\n")}`] : []),
    ],
  })
  console.log(`${stamp()} summary dialog: ${after ?? "dismissed"}`)
  if (after === openLabel) openForSteps(manual)
}

// ── macOS 27: the check runs inside the bridge ──────────────────────────────
// macOS 27 lets only an app with Full Disk Access read Chrome, Brave and Edge
// settings (the installer and Sparkle have none), and a program an app starts
// inherits its access. On a Full install that app is the bridge.

/** One request on the bridge socket, framed the way the daemon does it. Not via
 *  the daemon: the installer must not start one under its own identity. */
function bridgeRequest(action: Record<string, unknown>, timeoutMs: number): Promise<any> {
  return new Promise(resolve => {
    let buf = Buffer.alloc(0)
    const s = createConnection(bridgeSocketPathForDetection())
    const done = (v: any) => { clearTimeout(timer); s.destroy(); resolve(v) }
    const timer = setTimeout(() => done(null), timeoutMs)
    s.on("connect", () => {
      const body = Buffer.from(JSON.stringify({ id: `extension-repair-${process.pid}`, action }))
      const head = Buffer.alloc(4)
      head.writeUInt32LE(body.length)
      s.write(Buffer.concat([head, body]))
    })
    s.on("data", chunk => {
      buf = Buffer.concat([buf, Buffer.from(chunk)])
      if (buf.length < 4 || buf.length < 4 + buf.readUInt32LE(0)) return
      try { done(JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString()).result) } catch { done(null) }
    })
    s.on("error", () => done(null))
  })
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Runs this same command as a child of the bridge and relays its output.
 *  Returns its exit code, or null when there is no bridge to ask. */
async function runViaBridge(args: string[]): Promise<number | null> {
  if (!existsSync(BRIDGE_APP)) return null
  const self = basename(process.execPath) === "bun" ? [process.argv[1]] : []
  const log = join(stateDir(), `extension-repair-bridge-${process.pid}.log`)
  try { mkdirSync(stateDir(), { recursive: true }) } catch {}
  const command = [process.execPath, ...self, "diagnose", "extension", ...args].map(shq).join(" ")
  // In the background so the bridge's script deadline never cuts a repair short.
  const sh = `( /usr/bin/env ${VIA_BRIDGE_ENV}=1 ${command}; echo "__exit=$?" ) > ${shq(log)} 2>&1 & echo $!`
  let pid = 0
  // A bridge the installer just started needs a moment for its socket.
  for (let i = 0; i < 10 && !pid; i++) {
    if (i) await sleep(1000)
    const r = await bridgeRequest({ type: "macos_script_run", jsc: `JSON.stringify(host.shell("/bin/sh", ["-c", ${JSON.stringify(sh)}]))`, jscHost: "shell" }, 10_000)
    try { pid = Number(JSON.parse(r?.data?.result).stdout.trim()) || 0 } catch {}
  }
  if (!pid) return null
  let shown = 0
  const relay = () => {
    let lines: string[] = []
    try { lines = readFileSync(log, "utf8").split("\n").slice(0, -1) } catch {}
    for (const line of lines.slice(shown)) if (!line.startsWith("__exit=")) console.log(line)
    shown = lines.length
    return lines.find(l => l.startsWith("__exit="))
  }
  await waitFor(() => { try { process.kill(pid, 0); relay(); return false } catch { return true } }, 15 * 60_000)
  const exit = relay()
  try { rmSync(log) } catch {}
  return exit ? Number(exit.slice(7)) : 1
}

/** Only a Mac that installed a pre-1.0.1 Interceptor package can hold the old-ID
 *  entry, so only there is it worth asking for Full Disk Access. Exported for tests. */
export function hadOldInstall(history?: string): boolean {
  if (history === undefined) {
    try { history = readFileSync("/Library/Receipts/InstallHistory.plist", "utf8") } catch { return true }
  }
  for (const m of history.matchAll(/<key>displayName<\/key>\s*<string>Interceptor[^<]*<\/string>\s*<key>displayVersion<\/key>\s*<string>(\d+)\.(\d+)\.(\d+)/g)) {
    const [major, minor, patch] = m.slice(1).map(Number)
    if (major === 0 || (major === 1 && minor === 0 && patch === 0)) return true
  }
  return false
}

/** Asked once per browser, not once per version: an update must not ask again. */
const accessAck = (b: RepairBrowser) => `browser-data-access:${b.key}`

/** Asks for access to the browsers' data for the bridge, then runs the real check.
 *  A browser the bridge tried to read is listed under it in Files & Folders with
 *  one switch (macOS 27, no password). The window stays open while the user is in
 *  Settings (extension-welcome.ts); plain dialogs are the fallback. */
async function askForAccess(blocked: RepairBrowser[], only?: string): Promise<void> {
  addAcks(blocked.map(accessAck))
  const { runAccess } = await import("./extension-welcome")
  if (await runAccess(blocked, only) === "done") return
  const names = blocked.map(b => b.label).join(" and ")
  const text = [`Interceptor can't check ${names} for a problem that makes Interceptor disappear when the browser restarts. On this version of macOS, an app needs your permission to read another app's data.`,
    "Open Settings opens Files & Folders: under interceptor-bridge, turn on each browser listed. Interceptor checks as soon as one is on."]
  const choice = dialog(text.join("\n\n"), ["Later", "Open Settings"], { eyebrow: "Browser check", tone: "info", title: "Let Interceptor check your browsers", text })
  console.log(`${stamp()} access dialog: ${choice ?? "dismissed"}`)
  if (choice !== "Open Settings") return
  spawnSync("/usr/bin/open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"])
  const canRead = (b: RepairBrowser) => { try { readdirSync(userDataDir(b)!); return true } catch { return false } }
  if (!await waitFor(() => blocked.some(canRead), 15 * 60_000)) return console.log(`${stamp()} no browser data access was turned on within 15 minutes`)
  const checked = blocked.filter(canRead).map(b => b.label).join(" and ")
  console.log(`${stamp()} access is on for ${checked}; checking`)
  const stillBlocked: RepairBrowser[] = []
  const findings = findProblems(only, stillBlocked)
  if (findings.length) return promptAndFix(findings, () => findProblems(only))
  console.log(`${stamp()} ${report(findings, stillBlocked).replace(/\n/g, " | ")}`)
  dialog(`Interceptor checked ${checked}: nothing to fix.`, ["OK"], { eyebrow: "Browser check", tone: "ok", title: "All set", text: [`Interceptor checked ${checked}: nothing to fix.`] })
}

const USAGE = "interceptor diagnose extension [--fix | --prompt | --welcome] [--browser <key>] [--json]"

const toJson = (f: Finding) => ({ kind: f.kind, state: STATE[f.kind], browser: f.browser.key, profile: f.profileDir, profileName: f.profileName, extensionId: f.extensionId, path: f.path, autoFix: f.autoFix, ...(f.autoFix ? {} : { steps: manualStep(f) }) })

export async function runExtensionRepairCommand(args: string[], jsonMode: boolean): Promise<void> {
  const at = args.indexOf("--browser")
  const only = at === -1 ? undefined : args[at + 1]
  const unexpected = args.filter((a, i) => (a.startsWith("-") && !["--fix", "--prompt", "--welcome", "--browser"].includes(a)) || (!a.startsWith("-") && (at === -1 || i !== at + 1)))
  if (unexpected.length || (at !== -1 && !REPAIR_BROWSERS.some(b => b.key === only))) {
    console.error(`error: ${unexpected.length ? `unexpected '${unexpected[0]}'` : `--browser takes one of ${REPAIR_BROWSERS.map(b => b.key).join(", ")}`} for 'diagnose extension'. Usage: ${USAGE}`)
    process.exit(1)
  }
  const fix = args.includes("--fix")
  const prompt = args.includes("--prompt")
  // The first-install window (macOS): checks for a copy already in a browser,
  // repairs a broken one, else helps add one (store, unpacked or Safari).
  const welcome = args.includes("--welcome")
  // Installs and updates on a Mac that never had a pre-1.0.1 package cannot hold the
  // old-ID entry, so they leave protected folders alone rather than set off macOS's
  // "Data Access Blocked" notice; the welcome window watches for a connection instead.
  const quiet = (prompt || welcome) && PLATFORM === "darwin" && !hadOldInstall()
  // The installer's own read of a protected folder is refused, and macOS then lists
  // "interceptor" or "Installer" in Files & Folders, whose switches cannot help the
  // check (it runs inside interceptor-bridge). Only the bridge reads those folders.
  const skipDirect = (prompt || welcome) && PLATFORM === "darwin" && process.env[VIA_BRIDGE_ENV] !== "1"
  const blocked: RepairBrowser[] = []
  const findings = findProblems(only, blocked, quiet || skipDirect)
  if (PLATFORM === "darwin" && blocked.length && !quiet && process.env[VIA_BRIDGE_ENV] !== "1") {
    const exit = await runViaBridge([...args, ...(jsonMode ? ["--json"] : [])])
    if (exit !== null) { process.exitCode = exit; return }
  }
  const needsLegacy = findings.some(f => f.autoFix || f.kind === "both-ids" || f.kind === "old-id-only")
  if ((fix || prompt || welcome) && needsLegacy && !existsSync(join(legacyExtensionDir(), "manifest.json"))) {
    console.error(`error: ${legacyExtensionDir()} is missing; reinstall Interceptor to get the old-key copy the repair uses.`)
    process.exit(1)
  }

  if (welcome && PLATFORM === "darwin") {
    if (process.env[CHILD_ENV] !== "1") {
      console.log(`${stamp()} first install: opening the Interceptor welcome window`)
      return detachSelf(only, "--welcome")
    }
    if (!takeLock()) return console.log(`${stamp()} another Interceptor window is already open`)
    const { runWelcome } = await import("./extension-welcome")
    return runWelcome(only, findings, blocked, quiet)
  }

  if (prompt || welcome) {
    // The installers call this from root-owned postinstall work (macOS) or Setup
    // (Windows); a detached child shows the dialog so the install never waits.
    if (findings.length === 0) {
      // The bridge has no Full Disk Access yet: ask for it where the problem can exist.
      const acked = readAcked()
      const ask = process.env[VIA_BRIDGE_ENV] === "1" ? blocked.filter(b => !acked.has(accessAck(b))) : []
      if (!ask.length || !hadOldInstall()) return console.log(`${stamp()} ${report(findings, blocked)}`)
      if (process.env[CHILD_ENV] !== "1") {
        console.log(`${stamp()} cannot read ${ask.map(b => b.label).join(", ")}; asking the user for access to their data`)
        return detachSelf(only)
      }
      if (!takeLock()) return console.log(`${stamp()} another Interceptor repair dialog is already open`)
      return askForAccess(ask, only)
    }
    if (PLATFORM === "linux") return console.log(report(findings, blocked))
    const acked = readAcked()
    if (findings.every(f => !f.autoFix && acked.has(ackKey(f)))) {
      return console.log(`${stamp()} ${findings.length} finding(s) need steps by hand and were already shown; no dialog`)
    }
    if (process.env[CHILD_ENV] !== "1") {
      console.log(`${stamp()} ${report(findings, blocked).split("\n")[0].replace(/:$/, "")}; asking the user`)
      return detachSelf(only)
    }
    if (!takeLock()) return console.log(`${stamp()} another Interceptor repair dialog is already open`)
    return promptAndFix(findings, () => findProblems(only))
  }

  if (!fix) {
    if (jsonMode) return console.log(JSON.stringify({ problems: findings.map(toJson), blocked: blocked.map(b => b.key) }, null, 2))
    return console.log(report(findings, blocked))
  }

  const results: FixResult[] = []
  for (const [b, fs] of byBrowser(findings.filter(f => f.autoFix))) results.push(await fixBrowser(b, fs, line => { if (!jsonMode) console.log(line) }))
  const manual = findings.filter(f => !f.autoFix)
  if (jsonMode) {
    console.log(JSON.stringify({
      fixed: results.flatMap(r => r.fixed.map(toJson)),
      failed: results.flatMap(r => r.failed.map(f => ({ ...toJson(f), reason: r.reason }))),
      manual: manual.map(toJson),
    }, null, 2))
  } else {
    if (findings.length === 0) console.log(report(findings, blocked))
    for (const r of results) {
      if (r.fixed.length) console.log(`fixed: ${r.browser.label} ${profiles(r.fixed)}`)
      if (r.failed.length) console.log(`not fixed: ${r.browser.label} ${profiles(r.failed)} (${r.reason})`)
    }
    if (manual.length) console.log(manual.map(manualStep).join("\n"))
  }
  if (results.some(r => r.failed.length)) process.exit(1)
}
