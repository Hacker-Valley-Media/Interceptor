/**
 * daemon/ios/tools.ts — host toolchain orchestration for the iOS surface.
 *
 * Xcode launches the runner by default after setup because that path is covered
 * by Apple's supported testmanager stack. The optional pure-Bun path drives the
 * command-line tools via Bun.spawn:
 *   - xcrun devicectl   physical device list + iOS version + Developer-Mode state
 *   - xcrun simctl      simulator list/boot/launch
 *   - xcrun xcodebuild  build-for-testing + automatic signing (operator identity)
 *   - sips              VLM-budget screenshot resize (zero-dependency, native)
 * The WDA HTTP port is reached by daemon/ios/usbmux-forward.ts (pure Bun, talks
 * to macOS's own usbmuxd) — no go-ios / pymobiledevice3.
 *
 * No signing material is embedded here — signing is supplied by the operator or
 * user's local keychain. This keeps the surface capability-blind
 * (scripts/audit-capability-blind.sh).
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, cpSync, mkdirSync, statSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join, delimiter, dirname } from "node:path"
import { createHash } from "node:crypto"

/** Use the experimental userspace launcher only when an operator opts in. */
export function preferNoXcodeIosPath(): boolean {
  return process.env.INTERCEPTOR_NO_XCODE === "1" || process.env.INTERCEPTOR_IOS_USE_XCODE === "0"
}

/**
 * The daemon can be spawned by Chrome (native-messaging host), a LaunchAgent, or
 * the CLI — each with a different, often minimal PATH. The native iOS toolchain
 * is resolved by absolute path (`/usr/bin/xcrun`, `/usr/bin/sips`) or via `xcrun
 * --find`, so PATH barely matters now; we still append Homebrew/usr-local once at
 * module load for the odd edge case (e.g. a relocated `sips`/`plutil`).
 */
function augmentPathForToolDiscovery(): void {
  const candidates = ["/opt/homebrew/bin", "/usr/local/bin"]
  const current = (process.env.PATH || "").split(delimiter).filter(Boolean)
  const seen = new Set(current)
  for (const dir of candidates) {
    if (seen.has(dir)) continue
    try { if (existsSync(dir)) { current.push(dir); seen.add(dir) } } catch {}
  }
  process.env.PATH = current.join(delimiter)
}
augmentPathForToolDiscovery()

export type RunResult = { code: number; stdout: string; stderr: string; ok: boolean }

/** One-shot command via Bun.spawnSync. Never throws — returns a structured result. */
export function run(cmd: string, args: string[], opts: { timeoutMs?: number; input?: string } = {}): RunResult {
  const proc = Bun.spawnSync([cmd, ...args], {
    stdin: opts.input ? Buffer.from(opts.input) : undefined,
    timeout: opts.timeoutMs ?? 30_000,
  })
  const stdout = proc.stdout ? Buffer.from(proc.stdout).toString("utf-8") : ""
  const stderr = proc.stderr ? Buffer.from(proc.stderr).toString("utf-8") : ""
  const code = typeof proc.exitCode === "number" ? proc.exitCode : (proc.success ? 0 : -1)
  return { code, stdout, stderr, ok: proc.success }
}

/** Is a CLI tool resolvable on PATH? */
export function hasTool(name: string): boolean {
  const r = Bun.spawnSync(["/usr/bin/which", name])
  return r.success && Buffer.from(r.stdout ?? new Uint8Array()).toString("utf-8").trim().length > 0
}

/** Run and parse JSON stdout; returns undefined on failure or non-JSON. */
export function runJson<T = unknown>(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): T | undefined {
  const r = run(cmd, args, opts)
  if (!r.ok || !r.stdout.trim()) return undefined
  try { return JSON.parse(r.stdout) as T } catch { return undefined }
}

/**
 * Spawn a long-lived background process (port-forward helper, WDA runner) via
 * Bun.spawn. The caller tracks the handle and kills it on teardown. stdout/stderr
 * are ignored so the child never blocks on a full pipe buffer.
 */
export function spawnLongLived(
  cmd: string, args: string[], env?: Record<string, string>,
  opts: { stderr?: "ignore" | "pipe" } = {},
): Bun.Subprocess {
  return Bun.spawn([cmd, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    // "pipe" lets a launcher report WHY a child died (xcodebuild's signing error)
    // instead of surfacing the death as a later, unrelated timeout.
    stderr: opts.stderr ?? "ignore",
    env: env ? { ...process.env, ...env } : undefined,
  }) as Bun.Subprocess
}

/** Kill a tracked child process best-effort. */
export function killChild(child: Bun.Subprocess | undefined): void {
  if (!child) return
  try { child.kill() } catch {}
}

// ── toolchain detection ────────────────────────────────────────────────────────

export type Toolchain = {
  devicectl: boolean
  simctl: boolean
  xcodebuild: boolean
  sips: boolean
}

export function detectToolchain(): Toolchain {
  return {
    devicectl: run("/usr/bin/xcrun", ["--find", "devicectl"]).ok,
    simctl: run("/usr/bin/xcrun", ["--find", "simctl"]).ok,
    xcodebuild: run("/usr/bin/xcrun", ["--find", "xcodebuild"]).ok,
    sips: true, // /usr/bin/sips ships with macOS
  }
}

// ── simulator discovery (xcrun simctl) ───────────────────────────────────────

export type RawSimDevice = { udid: string; name: string; state: string; isAvailable?: boolean; runtimeVersion?: string }

/**
 * List booted/available simulators via `xcrun simctl list devices --json`.
 * Returns flattened devices with their runtime version parsed from the key.
 */
export function listSimulators(): RawSimDevice[] {
  const json = runJson<{ devices: Record<string, Array<Omit<RawSimDevice, "runtimeVersion">>> }>(
    "/usr/bin/xcrun", ["simctl", "list", "devices", "--json"],
  )
  if (!json?.devices) return []
  const out: RawSimDevice[] = []
  for (const [runtime, devices] of Object.entries(json.devices)) {
    // runtime key looks like "com.apple.CoreSimulator.SimRuntime.iOS-17-4"
    const m = /iOS-(\d+)-(\d+)/.exec(runtime)
    const version = m ? `${m[1]}.${m[2]}` : undefined
    if (!/iOS/i.test(runtime)) continue
    for (const d of devices) {
      out.push({ ...d, runtimeVersion: version })
    }
  }
  return out
}

// ── physical device discovery (xcrun devicectl / CoreDevice) ──────────────────

export type RawPhysDevice = { udid: string; name: string; productVersion?: string; developerMode?: boolean; paired?: boolean; transport?: "usb" | "network" | "unknown" }

type DevicectlDevice = {
  hardwareProperties?: { udid?: string; platform?: string; deviceType?: string }
  deviceProperties?: { name?: string; osVersionNumber?: string; developerModeStatus?: string }
  connectionProperties?: { pairingState?: string; transportType?: string }
}

/**
 * List physical iOS-family devices via `xcrun devicectl list devices` (CoreDevice,
 * ships with Xcode 15+). It writes JSON to a file; we parse it, keep only the
 * iOS platform (drops watchOS/tvOS/macOS companions), carry Developer-Mode +
 * pairing state, and de-duplicate by udid (a device wired + on the network shows
 * twice — prefer the wired entry).
 */
export function listPhysicalDevices(): RawPhysDevice[] {
  const dir = mkdtempSync(join(tmpdir(), "interceptor-ios-dc-"))
  const out = join(dir, "devices.json")
  let raw = ""
  try {
    const r = run("/usr/bin/xcrun", ["devicectl", "list", "devices", "--json-output", out, "--quiet"], { timeoutMs: 20_000 })
    if (!r.ok && !existsSync(out)) return []
    raw = readFileSync(out, "utf-8")
  } catch { return [] }
  finally { try { rmSync(dir, { recursive: true, force: true }) } catch {} }

  let parsed: { result?: { devices?: DevicectlDevice[] } }
  try { parsed = JSON.parse(raw) } catch { return [] }

  const byUdid = new Map<string, RawPhysDevice & { _wired: boolean }>()
  for (const d of parsed.result?.devices ?? []) {
    if (d.hardwareProperties?.platform !== "iOS") continue // iPhone/iPad only
    const udid = d.hardwareProperties?.udid
    if (!udid) continue
    const transportRaw = d.connectionProperties?.transportType ?? ""
    const wired = /wired|usb/i.test(transportRaw)
    const transport: RawPhysDevice["transport"] = wired ? "usb" : /network|wifi/i.test(transportRaw) ? "network" : "unknown"
    const entry: RawPhysDevice & { _wired: boolean } = {
      udid,
      name: d.deviceProperties?.name || d.hardwareProperties?.deviceType || udid,
      productVersion: d.deviceProperties?.osVersionNumber,
      developerMode: /enabled/i.test(d.deviceProperties?.developerModeStatus ?? ""),
      paired: /paired/i.test(d.connectionProperties?.pairingState ?? ""),
      transport,
      _wired: wired,
    }
    const prior = byUdid.get(udid)
    if (!prior || (wired && !prior._wired)) byUdid.set(udid, entry)
  }
  return [...byUdid.values()].map(({ _wired, ...d }) => d)
}

/**
 * List installed apps on a physical device via `xcrun devicectl device info apps`
 * (CoreDevice, native). Returns the parsed JSON or undefined.
 */
export function listDeviceApps(udid: string): unknown | undefined {
  const dir = mkdtempSync(join(tmpdir(), "interceptor-ios-apps-"))
  const out = join(dir, "apps.json")
  try {
    const r = run("/usr/bin/xcrun", ["devicectl", "device", "info", "apps", "--device", udid, "--json-output", out, "--quiet"], { timeoutMs: 30_000 })
    if (!r.ok && !existsSync(out)) return undefined
    const parsed = JSON.parse(readFileSync(out, "utf-8")) as { result?: { apps?: unknown } }
    return parsed.result?.apps ?? parsed.result ?? parsed
  } catch { return undefined }
  finally { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
}

// ── InterceptorRunner: push prebuilt agent + launch ─────────
//
// The pkg carries an unsigned build input. `ios setup` builds and signs a
// device-specific copy through Xcode using the user's configured team.

/** Bundle id of the on-device XCUITest runner app (the XCTRunner host). */
export const RUNNER_BUNDLE_ID = "com.interceptor.InterceptorRunner.xctrunner"

/** Stable team-scoped identity. Xcode adds `.xctrunner` to the generated host. */
export function runnerProductBundleId(teamId: string): string {
  const team = teamId.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-")
  if (!team) throw new Error("an Apple developer team id is required to derive the runner bundle id")
  return `com.interceptor.runner.${team}`
}

const SUPPORT_DIR = "/Library/Application Support/Interceptor"
const RUNNER_STAGE_DIR = join(homedir(), ".interceptor", "ios", "runner")
/** Present in the stage dir when `ios setup` built and signed its contents (kept across bundled-artifact changes). */
const SETUP_BUILT_MARKER = ".setup-built"
const RUNNER_XCODE_DERIVED_ROOT = join(homedir(), ".interceptor", "ios", "xcode-derived")
const RUNNER_SUPPORT_PROJECT = join(SUPPORT_DIR, "ios", "InterceptorRunner", "InterceptorRunner.xcodeproj")
const RUNNER_LOCAL_PROJECT = join(process.cwd(), "ios", "InterceptorRunner", "InterceptorRunner.xcodeproj")

/**
 * Locate the shipped prebuilt-runner artifact (the build-for-testing Products:
 * `…/Debug-iphoneos/InterceptorRunner-Runner.app` + a `.xctestrun`). It is shipped
 * as an opaque **tar** so it never trips macOS notarization on the iOS-signed
 * binaries inside; a plain dir is also accepted (dev). Resolution order:
 *   1. INTERCEPTOR_RUNNER_DIR — a Products dir (dev/override; user never sets this)
 *   2. /Library/Application Support/Interceptor/ios-runner — a Products dir
 *   3. INTERCEPTOR_RUNNER_TAR / /Library/.../ios-runner.tar — the bundled tar
 */
export function resolveRunnerArtifact(): { dir?: string; tar?: string } {
  const dirOverride = process.env.INTERCEPTOR_RUNNER_DIR
  if (dirOverride && existsSync(dirOverride)) return { dir: dirOverride }
  const shippedDir = join(SUPPORT_DIR, "ios-runner")
  if (existsSync(shippedDir)) return { dir: shippedDir }
  const tarOverride = process.env.INTERCEPTOR_RUNNER_TAR
  if (tarOverride && existsSync(tarOverride)) return { tar: tarOverride }
  const shippedTar = join(SUPPORT_DIR, "ios-runner.tar")
  if (existsSync(shippedTar)) return { tar: shippedTar }
  return {}
}

/** Find the `*-Runner.app` under a Products dir (top-level or Debug-iphoneos/). */
export function findRunnerApp(dir: string): string | undefined {
  const candidates = [dir, join(dir, "Debug-iphoneos")]
  for (const c of candidates) {
    try {
      const app = readdirSync(c).find((f) => f.endsWith("-Runner.app"))
      if (app) return join(c, app)
    } catch {}
  }
  return undefined
}

/** Find the launch `.xctestrun` in a Products dir (skip our injected copy). */
export function findXctestrun(dir: string): string | undefined {
  try {
    const xs = readdirSync(dir).filter((f) => f.endsWith(".xctestrun") && !f.includes("-interceptor"))
    if (xs.length) return join(dir, xs[0])
  } catch {}
  return undefined
}

function runnerArtifactFingerprint(art: { dir?: string; tar?: string }): string {
  const hash = createHash("sha256")
  const walk = (path: string, relative = "") => {
    const stat = statSync(path)
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name), join(relative, name))
    } else if (stat.isFile()) {
      hash.update(relative).update("\0").update(readFileSync(path))
    }
  }
  if (art.tar) walk(art.tar, "ios-runner.tar")
  else if (art.dir) walk(art.dir)
  return hash.digest("hex")
}

export type XcodeTeam = {
  teamId: string
  teamName?: string
  teamType?: string
  isFreeProvisioningTeam?: boolean
}

export function parseXcodeTeams(defaultsOutput: string): XcodeTeam[] {
  const teams = new Map<string, XcodeTeam>()
  for (const match of defaultsOutput.matchAll(/\{([^{}]*teamID[^{}]*)\}/g)) {
    const block = match[1] ?? ""
    const teamId = /teamID\s*=\s*"?([A-Z0-9]+)"?\s*;/.exec(block)?.[1]
    if (!teamId) continue
    const teamName = /teamName\s*=\s*"?([^";]+)"?\s*;/.exec(block)?.[1]
    const teamType = /teamType\s*=\s*"?([^";]+)"?\s*;/.exec(block)?.[1]
    const free = /isFreeProvisioningTeam\s*=\s*1\s*;/.test(block)
    teams.set(teamId, { teamId, teamName, teamType, isFreeProvisioningTeam: free })
  }
  return [...teams.values()]
}

export function listXcodeTeams(): XcodeTeam[] {
  const r = run("/usr/bin/defaults", ["read", "com.apple.dt.Xcode", "IDEProvisioningTeamByIdentifier"])
  if (!r.ok) return []
  return parseXcodeTeams(r.stdout)
}

export function chooseXcodeTeam(teams: XcodeTeam[], explicit?: string): { teamId?: string; error?: string } {
  if (explicit?.trim()) return { teamId: explicit.trim() }
  if (teams.length === 0) {
    return {
      error: "Xcode has no Apple Developer team configured. Open Xcode > Settings > Accounts, sign in, then re-run setup with --team <TEAM_ID> if needed.",
    }
  }
  if (teams.length === 1) return { teamId: teams[0]!.teamId }
  const paid = teams.filter((t) => !t.isFreeProvisioningTeam)
  if (paid.length === 1) return { teamId: paid[0]!.teamId }
  const summary = teams.map((t) => `${t.teamId}${t.teamName ? ` (${t.teamName})` : ""}`).join(", ")
  return { error: `multiple Xcode teams are configured; pass --team <TEAM_ID> or set INTERCEPTOR_IOS_TEAM. Available teams: ${summary}` }
}

function resolveRunnerProject(explicit?: string): string | undefined {
  const candidates = [
    explicit,
    process.env.INTERCEPTOR_RUNNER_PROJECT,
    RUNNER_SUPPORT_PROJECT,
    RUNNER_LOCAL_PROJECT,
  ].filter((p): p is string => typeof p === "string" && p.trim().length > 0)
  return candidates.find((p) => existsSync(p))
}

function safeUdidPath(udid: string): string {
  return udid.replace(/[^A-Za-z0-9._-]/g, "_")
}

export type MobileProvisionSummary = {
  teamIds: string[]
  applicationIdentifier?: string
  expiresAt?: number
  provisionedDevices: string[]
}

export function readMobileProvisionSummary(profilePath: string): MobileProvisionSummary | undefined {
  if (!existsSync(profilePath)) return undefined
  const cms = run("/usr/bin/security", ["cms", "-D", "-i", profilePath], { timeoutMs: 15_000 })
  if (!cms.ok || !cms.stdout.trim()) return undefined
  const extract = (key: string, format: "json" | "raw") => run(
    "/usr/bin/plutil", ["-extract", key, format, "-o", "-", "-"], { input: cms.stdout, timeoutMs: 15_000 },
  )
  const teamIds = extract("TeamIdentifier", "json")
  const devices = extract("ProvisionedDevices", "json")
  const applicationIdentifier = extract("Entitlements.application-identifier", "raw")
  const expiration = extract("ExpirationDate", "raw")
  if (!teamIds.ok || !devices.ok || !applicationIdentifier.ok || !expiration.ok) return undefined
  try {
    const expiresAt = Date.parse(expiration.stdout.trim())
    return {
      teamIds: JSON.parse(teamIds.stdout) as string[],
      applicationIdentifier: applicationIdentifier.stdout.trim(),
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
      provisionedDevices: JSON.parse(devices.stdout) as string[],
    }
  } catch {
    return undefined
  }
}

export type XcodeRunnerBuildOptions = {
  teamId?: string
  projectPath?: string
  derivedDataPath?: string
  timeoutMs?: number
}

export type XcodeRunnerBuildResult = {
  dir: string
  appPath: string
  xctestrunPath: string
  teamId: string
  bundleId: string
  kind: "free" | "paid"
  profilePath?: string
  expiresAt?: number
}

export type RunnerIdentity = {
  bundleId: string
  teamId: string
  profilePath: string
  expiresAt?: number
}

function plistValue(path: string, key: string): string | undefined {
  const result = run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path])
  return result.ok && result.stdout.trim() ? result.stdout.trim() : undefined
}

function signedEntitlements(path: string): Record<string, unknown> | undefined {
  const displayed = run("/usr/bin/codesign", ["-d", "--entitlements", ":-", path])
  const output = `${displayed.stdout}\n${displayed.stderr}`
  const xmlStart = output.indexOf("<?xml")
  if (!displayed.ok || xmlStart < 0) return undefined
  const converted = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: output.slice(xmlStart) })
  if (!converted.ok) return undefined
  try { return JSON.parse(converted.stdout) as Record<string, unknown> } catch { return undefined }
}

/** Validate the complete Apple identity before any device installer is called. */
export function inspectRunnerIdentity(
  appPath: string,
  opts: { expectedBundleId?: string; expectedTeamId?: string; udid?: string } = {},
): RunnerIdentity {
  const setupHint = opts.udid ? `interceptor ios setup ${opts.udid}` : "interceptor ios setup"
  const fail = (detail: string): never => { throw new Error(`${detail}; run: ${setupHint}`) }
  const bundleId = plistValue(join(appPath, "Info.plist"), "CFBundleIdentifier")
  if (!bundleId) return fail("runner bundle identity is missing")
  if (opts.expectedBundleId && bundleId !== opts.expectedBundleId) {
    fail(`runner bundle id '${bundleId}' does not match expected '${opts.expectedBundleId}'`)
  }
  const verified = run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath])
  if (!verified.ok) return fail("runner is not fully code signed")
  const signature = run("/usr/bin/codesign", ["-dvvv", appPath])
  const teamId = /TeamIdentifier=([^\s]+)/.exec(`${signature.stdout}\n${signature.stderr}`)?.[1]
  if (!signature.ok || !teamId || teamId === "not set") return fail("runner signing team is missing")
  if (opts.expectedTeamId && teamId !== opts.expectedTeamId) {
    fail(`runner signing team '${teamId}' does not match selected team '${opts.expectedTeamId}'`)
  }
  const profilePath = join(appPath, "embedded.mobileprovision")
  const profile = readMobileProvisionSummary(profilePath)
  if (!profile) return fail("runner has no readable provisioning profile")
  if (typeof profile.expiresAt !== "number") return fail("runner provisioning profile has no valid expiration date")
  if (profile.expiresAt <= Date.now()) return fail("runner provisioning profile has expired")
  if (!profile.teamIds.includes(teamId)) fail("runner signature and provisioning team do not match")
  if (opts.udid && !profile.provisionedDevices.some((value) => value.toUpperCase() === opts.udid!.toUpperCase())) {
    fail(`runner provisioning profile does not include device '${opts.udid}'`)
  }
  const entitlements = signedEntitlements(appPath)
  const applicationIdentifier = entitlements?.["application-identifier"]
  const entitlementTeam = entitlements?.["com.apple.developer.team-identifier"]
  if (typeof applicationIdentifier !== "string" || applicationIdentifier !== `${teamId}.${bundleId}`) {
    return fail("runner signature application identifier does not match its team and bundle id")
  }
  const profileApplicationIdentifier = profile.applicationIdentifier
  const profileAllowsApplication = profileApplicationIdentifier === applicationIdentifier
    || (profileApplicationIdentifier?.endsWith(".*") === true && applicationIdentifier.startsWith(profileApplicationIdentifier.slice(0, -1)))
  if (!profileAllowsApplication) {
    fail("runner signature and provisioning application identifiers do not match")
  }
  if (entitlementTeam !== teamId) fail("runner entitlement and signing teams do not match")
  if (entitlements?.["get-task-allow"] !== true) fail("runner lacks the development get-task-allow entitlement")
  return { bundleId, teamId, profilePath, expiresAt: profile.expiresAt }
}

export function buildRunnerWithXcode(udid: string, opts: XcodeRunnerBuildOptions = {}): XcodeRunnerBuildResult {
  if (!detectToolchain().xcodebuild) throw new Error("Xcode command-line tools are not available; install Xcode and run `sudo xcode-select -s /Applications/Xcode.app`.")
  const projectPath = resolveRunnerProject(opts.projectPath)
  if (!projectPath) {
    throw new Error(
      "InterceptorRunner.xcodeproj was not found. Reinstall Interceptor or pass --project /path/to/InterceptorRunner.xcodeproj.",
    )
  }
  const selected = chooseXcodeTeam(listXcodeTeams(), opts.teamId ?? process.env.INTERCEPTOR_IOS_TEAM ?? process.env.DEVELOPMENT_TEAM)
  if (!selected.teamId) throw new Error(selected.error ?? "could not choose an Xcode team")
  const productBundleId = runnerProductBundleId(selected.teamId)
  const expectedBundleId = `${productBundleId}.xctrunner`

  const derived = opts.derivedDataPath ?? join(RUNNER_XCODE_DERIVED_ROOT, safeUdidPath(udid))
  try {
    mkdirSync(dirname(derived), { recursive: true })
    rmSync(derived, { recursive: true, force: true })
  } catch {}

  const r = run("/usr/bin/xcrun", [
    "xcodebuild", "build-for-testing",
    "-project", projectPath,
    "-scheme", "InterceptorRunner",
    "-destination", `id=${udid}`,
    "-allowProvisioningUpdates",
    `DEVELOPMENT_TEAM=${selected.teamId}`,
    `PRODUCT_BUNDLE_IDENTIFIER=${productBundleId}`,
    "-derivedDataPath", derived,
  ], { timeoutMs: opts.timeoutMs ?? 10 * 60_000 })
  if (!r.ok) {
    const tail = `${r.stderr || r.stdout}`.slice(-2000).trim()
    throw new Error(`xcodebuild failed while provisioning InterceptorRunner: ${tail || "no output"}`)
  }

  const products = join(derived, "Build", "Products")
  const app = findRunnerApp(products)
  const xctestrun = findXctestrun(products)
  if (!app || !xctestrun) throw new Error("xcodebuild succeeded but did not produce InterceptorRunner-Runner.app and .xctestrun")

  try {
    rmSync(RUNNER_STAGE_DIR, { recursive: true, force: true })
    cpSync(products, RUNNER_STAGE_DIR, { recursive: true })
    // Record the bundled baseline, not the signed output's contents, and mark
    // the stage as setup-built so a later bundled-artifact change (a package
    // upgrade) does not restage the unsigned build over this signed one.
    writeFileSync(join(RUNNER_STAGE_DIR, ".source-sha256"), runnerArtifactFingerprint(resolveRunnerArtifact()) + "\n", { mode: 0o600 })
    writeFileSync(join(RUNNER_STAGE_DIR, SETUP_BUILT_MARKER), new Date().toISOString() + "\n", { mode: 0o600 })
  } catch (err) {
    throw new Error(`could not stage the Xcode-built runner: ${(err as Error).message}`)
  }

  const stagedApp = findRunnerApp(RUNNER_STAGE_DIR)
  const stagedXctestrun = findXctestrun(RUNNER_STAGE_DIR)
  if (!stagedApp || !stagedXctestrun) throw new Error("the staged Xcode-built runner is incomplete")

  const identity = inspectRunnerIdentity(stagedApp, {
    expectedBundleId,
    expectedTeamId: selected.teamId,
    udid,
  })
  const expiresAt = identity.expiresAt
  const lifetimeMs = typeof expiresAt === "number" ? expiresAt - Date.now() : undefined
  const kind: "free" | "paid" = typeof lifetimeMs === "number" && lifetimeMs < 30 * 24 * 60 * 60 * 1000 ? "free" : "paid"
  return {
    dir: RUNNER_STAGE_DIR,
    appPath: stagedApp,
    xctestrunPath: stagedXctestrun,
    teamId: identity.teamId,
    bundleId: identity.bundleId,
    kind,
    profilePath: identity.profilePath,
    expiresAt,
  }
}

/**
 * Stage the bundled (read-only) Products into a writable per-user dir so we can
 * inject per-session env into the xctestrun. Copies once; returns the staged dir.
 */
export function stageRunner(): { dir?: string; error?: string } {
  const dest = RUNNER_STAGE_DIR
  const art = resolveRunnerArtifact()
  try {
    const fingerprint = runnerArtifactFingerprint(art)
    let stagedFingerprint = ""
    try { stagedFingerprint = readFileSync(join(dest, ".source-sha256"), "utf-8").trim() } catch {}
    if (findXctestrun(dest) && findRunnerApp(dest)) {
      if (stagedFingerprint === fingerprint) return { dir: dest }
      // A runner that `ios setup` built and signed outlives changes to the
      // bundled (unsigned) artifact: restaging that build here replaced a
      // working signed runner with one iOS rejects, and every package upgrade
      // then needed a fresh `ios setup`. `ios refresh` rebuilds on demand.
      if (existsSync(join(dest, SETUP_BUILT_MARKER))) return { dir: dest }
    }
    if (!art.dir && !art.tar) {
      return { error: "the Interceptor iPhone agent is not bundled — reinstall Interceptor (the pkg ships it under /Library/Application Support/Interceptor)" }
    }
    try { rmSync(dest, { recursive: true, force: true }) } catch {}
    if (art.dir) {
      cpSync(art.dir, dest, { recursive: true })
    } else if (art.tar) {
      mkdirSync(dest, { recursive: true })
      const r = run("/usr/bin/tar", ["-xf", art.tar, "-C", dest])
      if (!r.ok) return { error: `could not unpack the agent: ${r.stderr.slice(-200)}` }
    }
    if (!findXctestrun(dest) || !findRunnerApp(dest)) return { error: "the bundled agent artifact is incomplete (missing .app or .xctestrun)" }
    writeFileSync(join(dest, ".source-sha256"), fingerprint + "\n", { mode: 0o600 })
    return { dir: dest }
  } catch (err) {
    return { error: `could not stage the agent: ${(err as Error).message}` }
  }
}

/**
 * Push the agent `.app` to a device. The supported Xcode setup route uses
 * devicectl so CoreDevice can reach network-paired phones; the pure-Bun
 * installation_proxy path remains available to the no-Xcode internals.
 *
 * ponytail: the no-Xcode discovery fallback (usbmux, async) is deferred — M0 is
 * iterated on a machine that HAS devicectl; the end-user no-Xcode discovery lands
 * with the M2 spike. Install routing is wired here now.
 */
export async function installRunnerApp(
  udid: string,
  expectedBundleId?: string,
  useDevicectl = false,
): Promise<{ ok: boolean; bundleId?: string; error?: string }> {
  const staged = stageRunner()
  if (staged.error || !staged.dir) return { ok: false, error: staged.error }
  const app = findRunnerApp(staged.dir)
  if (!app) return { ok: false, error: "bundled agent is missing its .app — the prebuilt artifact looks incomplete" }
  let identity: RunnerIdentity
  try { identity = inspectRunnerIdentity(app, { expectedBundleId, udid }) }
  catch (err) { return { ok: false, error: (err as Error).message } }
  if (!useDevicectl && preferNoXcodeIosPath()) {
    const installer = await import("./installer")
    try { await installer.installApp(udid, app, identity.bundleId); return { ok: true, bundleId: identity.bundleId } }
    catch (err) { return { ok: false, error: (err as Error).message } }
  }
  const r = run("/usr/bin/xcrun", ["devicectl", "device", "install", "app", "--device", udid, app], { timeoutMs: 180_000 })
  if (!r.ok) return { ok: false, error: `devicectl install failed: ${(r.stderr || r.stdout).slice(-400)}` }
  return { ok: true, bundleId: identity.bundleId }
}

/** Is the agent installed on the device? (devicectl app inventory.) */
export function isRunnerInstalled(udid: string, bundleId = RUNNER_BUNDLE_ID): boolean {
  const apps = listDeviceApps(udid) as { bundleIdentifier?: string }[] | { apps?: { bundleIdentifier?: string }[] } | undefined
  const list = Array.isArray(apps) ? apps : (apps as { apps?: unknown[] } | undefined)?.apps
  if (!Array.isArray(list)) return false
  return list.some((a) => (a as { bundleIdentifier?: string })?.bundleIdentifier === bundleId)
}

/**
 * Inject per-session connection env (INTERCEPTOR_WS_URL/TOKEN/UDID/CONTEXT_ID)
 * into a copy of the `.xctestrun` — the only point env reaches an on-device test
 * process. The copy is written NEXT TO the original so its `__TESTROOT__` bundle
 * paths still resolve. Handles both xctestrun format families (v1 top-level
 * targets, v2+ TestConfigurations/TestTargets). Returns the copy path, or
 * undefined if the plist could not be parsed.
 */
export function prepareXctestrunWithEnv(xctestrunPath: string, env: Record<string, string>, bundleId?: string): string | undefined {
  const asJson = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", xctestrunPath])
  if (!asJson.ok || !asJson.stdout.trim()) return undefined
  let doc: Record<string, unknown>
  try { doc = JSON.parse(asJson.stdout) } catch { return undefined }

  const applyToTarget = (t: Record<string, unknown>) => {
    t.EnvironmentVariables = { ...(t.EnvironmentVariables as object ?? {}), ...env }
    t.TestingEnvironmentVariables = { ...(t.TestingEnvironmentVariables as object ?? {}), ...env }
    if (bundleId) {
      t.TestHostBundleIdentifier = bundleId
      t.BundleIdentifiersForCrashReportEmphasis = [bundleId.replace(/\.xctrunner$/, "")]
    }
  }
  const cfgs = doc.TestConfigurations as Array<{ TestTargets?: Array<Record<string, unknown>> }> | undefined
  if (Array.isArray(cfgs)) {
    for (const cfg of cfgs) for (const t of cfg.TestTargets ?? []) applyToTarget(t)
  } else {
    for (const [k, v] of Object.entries(doc)) {
      if (k === "__xctestrun_metadata__") continue
      if (v && typeof v === "object" && !Array.isArray(v)) applyToTarget(v as Record<string, unknown>)
    }
  }

  const dir = dirname(xctestrunPath)
  const jsonTmp = join(dir, ".interceptor-xctestrun.json")
  const outPlist = join(dir, "InterceptorRunner-interceptor.xctestrun")
  try {
    writeFileSync(jsonTmp, JSON.stringify(doc))
    const conv = run("/usr/bin/plutil", ["-convert", "xml1", "-o", outPlist, jsonTmp])
    if (!conv.ok) return undefined
    return outPlist
  } catch { return undefined }
  finally { try { rmSync(jsonTmp, { force: true }) } catch {} }
}

// ── screenshot VLM-budget resize via sips (zero-dependency, native macOS) ──────

/**
 * Resize a base64 PNG so its long edge ≤ maxLongEdge, re-encoding to JPEG via
 * `sips`. Returns { dataUrl, format }. If maxLongEdge ≤ 0, returns the PNG
 * unchanged. Uses temp files (sips is file-based) and always cleans them up.
 */
export function resizePngToBudget(base64Png: string, maxLongEdge: number): { dataUrl: string; format: "png" | "jpeg" } {
  if (!maxLongEdge || maxLongEdge <= 0) {
    return { dataUrl: `data:image/png;base64,${base64Png}`, format: "png" }
  }
  const dir = mkdtempSync(join(tmpdir(), "interceptor-ios-shot-"))
  const inPath = join(dir, "in.png")
  const outPath = join(dir, "out.jpg")
  try {
    writeFileSync(inPath, Buffer.from(base64Png, "base64"))
    const r = run("/usr/bin/sips", ["-s", "format", "jpeg", "-Z", String(maxLongEdge), inPath, "--out", outPath])
    if (!r.ok) {
      // sips failed — fall back to the original PNG rather than erroring out.
      return { dataUrl: `data:image/png;base64,${base64Png}`, format: "png" }
    }
    const jpeg = readFileSync(outPath)
    return { dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`, format: "jpeg" }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}
