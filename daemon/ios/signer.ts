/**
 * daemon/ios/signer.ts — per-user re-sign of the bundled runner.
 *
 * The pkg ships the runner UNSIGNED (release.sh, decision 2). At `ios setup` we
 * re-sign it with the END USER's own Apple-ID identity so their device runs it
 * under their own team — no operator enrollment, no Xcode BUILD (we call
 * `/usr/bin/codesign`, base macOS, never `xcodebuild`).
 *
 * Two halves:
 *   1. REAL + offline-testable — the codesign machinery: build entitlements with
 *      `get-task-allow=true` (the debugger-attach entitlement testmanagerd needs),
 *      sign the inner `.xctest` then the outer `*-Runner.app`, embed the profile,
 *      and verify. Uses codesign's `-s <identity>` + `--entitlements` (NOT any
 *      xcodebuild build-setting), so it never trips audit-capability-blind check #4.
 *   2. ON-DEVICE / LIVE-CREDENTIAL-GATED — Apple GrandSlam auth (SRP-6a + 2FA +
 *      anisette), device registration, and dev cert + profile creation via
 *      developerservices2.apple.com. Anisette is generated LOCALLY on this Mac
 *      (the host's own ADI, as AltServer does) — which is why "no third party"
 *      (Part 7) holds only on macOS. These throw an actionable error until wired
 *      against real Apple-ID credentials; no silent fakes.
 *
 * Reference (read, do not vendor): AltSign (MIT). Not in the research ledger —
 * confirm its license before porting.
 */

import { captureSubprocessSync as spawnSync } from "../../shared/subprocess-sync"
import { writeFileSync, mkdtempSync, existsSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, basename } from "node:path"

/** Bundle id the profile must match (preserve it or the profile won't apply). */
export const RUNNER_BUNDLE_ID = "com.interceptor.InterceptorRunner.xctrunner"

// ── entitlements (REAL, offline-testable) ─────────────────────────────────────

export type SigningEntitlements = {
  /** Full application-identifier, e.g. "ABCDE12345.com.interceptor...". */
  applicationIdentifier: string
  teamId: string
}

/**
 * Build the XCUITest-runner entitlements plist. `get-task-allow=true` is the
 * load-bearing entitlement: without it testmanagerd cannot attach to the runner
 * (research REPORT.md §get-task-allow + src 01). Free personal-team dev profiles
 * carry it; distribution profiles strip it.
 */
export function buildEntitlementsPlist(e: SigningEntitlements): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>` +
    `<key>application-identifier</key><string>${e.applicationIdentifier}</string>` +
    `<key>com.apple.developer.team-identifier</key><string>${e.teamId}</string>` +
    `<key>get-task-allow</key><true/>` +
    `<key>keychain-access-groups</key><array><string>${e.applicationIdentifier}</string></array>` +
    `</dict></plist>`
  )
}

// ── codesign (REAL) ───────────────────────────────────────────────────────────

export function codesignAvailable(): boolean {
  return existsSync("/usr/bin/codesign")
}

/** Development signing identities in the keychain (name → sha1), via base-macOS security. */
export function developmentIdentities(): Array<{ sha1: string; name: string }> {
  const r = spawnSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf-8" })
  if (r.status !== 0) return []
  const out: Array<{ sha1: string; name: string }> = []
  for (const line of (r.stdout ?? "").split("\n")) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/.exec(line)
    if (m && /Apple Development|iPhone Developer/i.test(m[2])) out.push({ sha1: m[1], name: m[2] })
  }
  return out
}

export type ResignOpts = {
  /** codesign identity: a sha1 or the identity display name. */
  signingIdentity: string
  entitlements: SigningEntitlements
  /** Optional path to a .mobileprovision to embed as embedded.mobileprovision. */
  profilePath?: string
}

/**
 * Re-sign a `*-Runner.app` in place: embed the profile, sign the inner `.xctest`
 * first (inside-out is required), then the outer app, with the get-task-allow
 * entitlements. Returns nothing on success; throws with codesign's stderr on fail.
 */
export function resignRunnerApp(appPath: string, opts: ResignOpts): void {
  if (!codesignAvailable()) throw new Error("codesign not found (base macOS tool missing?)")
  if (!existsSync(appPath)) throw new Error(`runner app not found: ${appPath}`)

  const scratch = mkdtempSync(join(tmpdir(), "interceptor-sign-"))
  const entPath = join(scratch, "runner.entitlements.plist")
  writeFileSync(entPath, buildEntitlementsPlist(opts.entitlements))

  // Embed the provisioning profile so the device accepts the get-task-allow cert.
  if (opts.profilePath) {
    if (!existsSync(opts.profilePath)) throw new Error(`provisioning profile not found: ${opts.profilePath}`)
    copyFileSync(opts.profilePath, join(appPath, "embedded.mobileprovision"))
  }

  const xctest = findInnerXctest(appPath)
  const targets = xctest ? [xctest, appPath] : [appPath]  // inside-out
  for (const t of targets) {
    const r = spawnSync("/usr/bin/codesign", [
      "--force", "--sign", opts.signingIdentity,
      "--entitlements", entPath, "--generate-entitlement-der",
      "--timestamp=none", t,
    ], { encoding: "utf-8" })
    if (r.status !== 0) throw new Error(`codesign failed for ${basename(t)}: ${(r.stderr || r.stdout || "").trim()}`)
  }

  const v = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { encoding: "utf-8" })
  if (v.status !== 0) throw new Error(`codesign verify failed: ${(v.stderr || v.stdout || "").trim()}`)
}

/** Find the embedded `.xctest` bundle inside a `*-Runner.app` (PlugIns/). */
export function findInnerXctest(appPath: string): string | undefined {
  const plugins = join(appPath, "PlugIns")
  if (!existsSync(plugins)) return undefined
  const r = spawnSync("/bin/ls", [plugins], { encoding: "utf-8" })
  if (r.status !== 0) return undefined
  const name = (r.stdout ?? "").split("\n").find((n) => n.endsWith(".xctest"))
  return name ? join(plugins, name) : undefined
}

// ── Apple GrandSlam auth + provisioning (LIVE-CREDENTIAL-GATED) ────────────────

export type AppleSession = { token: string; teamId: string; kind: "free" | "paid" }

/**
 * Generate local anisette headers (X-Apple-I-MD / X-Apple-I-MD-M) from THIS Mac's
 * ADI, the way AltServer does. Present as a seam so the live auth (below) can call
 * it; gated until wired against the ADI framework in the M6 spike.
 */
export function localAnisette(): Record<string, string> {
  throw new Error(
    "signer: local anisette generation (macOS ADI) is implemented pending the M6 spike. " +
    "This is why the host must be macOS — no third-party anisette server.",
  )
}

/**
 * Authenticate to Apple developer-services with the user's Apple ID (SRP-6a + 2FA),
 * returning a session token (persisted to the Keychain by the caller, never here).
 * LIVE-CREDENTIAL-GATED: needs real Apple-ID credentials + the anisette seam.
 */
export async function appleLogin(_appleId: string, _password: string, _twoFactor?: string): Promise<AppleSession> {
  throw new Error(
    "signer: Apple-ID GrandSlam login (SRP-6a + 2FA + local anisette) is gated on the M6 spike. " +
    "AltSign is the reference. The Keychain token store, entitlements, and codesign re-sign are ready.",
  )
}

export type ProvisionResult = {
  teamId: string
  kind: "free" | "paid"
  signingIdentity: string   // sha1 of the dev cert now in the keychain
  profilePath: string       // cached .mobileprovision
  applicationIdentifier: string
  /** Cert/profile expiry (epoch ms): ≤7 days free, ~1 year paid. Drives refresh. */
  expiresAt: number
}

/**
 * With a valid Apple session: register the device UDID under the user's team,
 * create/reuse a development cert + a `get-task-allow` provisioning profile for
 * RUNNER_BUNDLE_ID, and import the cert into the keychain. Returns what
 * resignRunnerApp needs. LIVE-GATED (developerservices2 API + auth token).
 */
export async function provisionForDevice(_session: AppleSession, _udid: string): Promise<ProvisionResult> {
  throw new Error(
    "signer: device register + dev-cert/profile creation (developerservices2) is gated on the M6 spike. " +
    `Preserve bundle id ${RUNNER_BUNDLE_ID}.`,
  )
}
