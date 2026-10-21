/**
 * daemon/ios/state.ts — small persisted state for the iOS surface so the user
 * never juggles env vars. Lives at
 * ~/.interceptor/ios/state.json:
 *
 *   - `aliases`     friendly name → udid (so `--on work` beats a raw udid).
 *   - `installed`   per-udid: when the agent was pushed, its actual bundle id,
 *                   and when its signing expires.
 *   - `appleId`     the Xcode team metadata used to build and sign the runner.
 *
 * Per-device runner secrets live next to it in runner-secrets.json (mode 0600).
 *
 * Xcode signs each device-specific build with the user's configured developer
 * team. The actual bundle id must be persisted because every later install,
 * inventory, and launch step has to address that exact identity.
 *
 * Pure fs/JSON, no Bun/daemon imports beyond node:fs so it stays trivial to test.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type IosInstalled = {
  installedAt?: number
  bundleId?: string
  /** Runner signing expiry (epoch ms): ≤7 days free, ~1 year paid. Drives refresh. */
  expiresAt?: number
  /** When a Mac launch last delivered the saved connection to a runner that keeps it (epoch ms). */
  deviceStartReadyAt?: number
}

/** The Xcode developer-team metadata used to sign the runner. */
export type IosAppleAccount = {
  /** Apple-ID team id the device auto-registered under (free personal team or paid). */
  teamId: string
  /** Free personal team (≤7-day certs, 3-app cap) vs. paid ($99, ~1-year certs). */
  kind: "free" | "paid"
  /** SHA-1/-256 of the development certificate currently in use (for refresh/rotate). */
  certSha?: string
  /** Path to the cached provisioning profile (.mobileprovision) on this Mac. */
  profilePath?: string
  /** Cert/profile expiry (epoch ms) — the refresh timer re-signs before this. */
  expiresAt?: number
}

export type IosState = {
  aliases: Record<string, string>          // alias -> udid (upper-case)
  installed: Record<string, IosInstalled>  // udid (upper-case) -> info
  // ponytail: one active Xcode team is enough until multi-team setup is requested.
  appleId?: IosAppleAccount
}

function stateDir(): string {
  const dir = join(homedir(), ".interceptor", "ios")
  try { mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}
function statePath(): string {
  const override = process.env.INTERCEPTOR_IOS_STATE_PATH
  if (!override) return join(stateDir(), "state.json")
  try { mkdirSync(dirname(override), { recursive: true }) } catch {}
  return override
}

export function loadIosState(): IosState {
  try {
    const s = JSON.parse(readFileSync(statePath(), "utf-8")) as Partial<IosState>
    return { aliases: s.aliases ?? {}, installed: s.installed ?? {}, appleId: s.appleId }
  } catch {
    return { aliases: {}, installed: {} }
  }
}

export function saveIosState(s: IosState): void {
  try { writeFileSync(statePath(), JSON.stringify(s, null, 2)) } catch {}
}

// ── aliases ──────────────────────────────────────────────────────────────────
export function setAlias(alias: string, udid: string): void {
  const s = loadIosState()
  s.aliases[alias] = udid.toUpperCase()
  saveIosState(s)
}
export function aliasForUdid(udid: string): string | undefined {
  const s = loadIosState()
  const U = udid.toUpperCase()
  return Object.keys(s.aliases).find((a) => s.aliases[a] === U)
}
/** Resolve a user-typed device ref (alias | udid | ios:<udid>) to a udid. */
export function resolveUdid(ref: string): string | undefined {
  if (!ref) return undefined
  const s = loadIosState()
  if (s.aliases[ref]) return s.aliases[ref]
  const bare = ref.startsWith("ios:") ? ref.slice(4) : ref
  return bare ? bare.toUpperCase() : undefined
}

// ── installed cache ──────────────────────────────────────────────────────────
export function getInstalled(udid: string): IosInstalled | undefined {
  return loadIosState().installed[udid.toUpperCase()]
}
export function markInstalled(udid: string, expiresAt?: number, bundleId?: string): void {
  const s = loadIosState()
  const prev = s.installed[udid.toUpperCase()]
  s.installed[udid.toUpperCase()] = {
    installedAt: Date.now(),
    expiresAt: expiresAt ?? prev?.expiresAt,
    bundleId: bundleId ?? prev?.bundleId,
  }
  saveIosState(s)
}
/** The runner on this device saved its connection, so it can be opened on the device. */
export function markDeviceStartReady(udid: string): void {
  const s = loadIosState()
  const U = udid.toUpperCase()
  s.installed[U] = { ...s.installed[U], deviceStartReadyAt: Date.now() }
  saveIosState(s)
}
export function deviceStartReady(udid: string): boolean {
  return Boolean(loadIosState().installed[udid.toUpperCase()]?.deviceStartReadyAt)
}
export function knownInstalledUdids(): string[] {
  return Object.keys(loadIosState().installed)
}

// ── Apple-ID account ────────────────────────────────────────────────
export function getAppleAccount(): IosAppleAccount | undefined {
  return loadIosState().appleId
}
export function setAppleAccount(acct: IosAppleAccount): void {
  const s = loadIosState()
  s.appleId = acct
  saveIosState(s)
}
export function clearAppleAccount(): void {
  const s = loadIosState()
  delete s.appleId
  saveIosState(s)
}
/** udids whose signing expires within `withinMs` (default now) — the refresh set. */
export function installsExpiringBy(withinMs = 0, now = Date.now()): string[] {
  const s = loadIosState()
  return Object.entries(s.installed)
    .filter(([, info]) => typeof info.expiresAt === "number" && info.expiresAt - now <= withinMs)
    .map(([udid]) => udid)
}

// ── device-started runner secrets ──────────────────────────────────
// One random secret per device. A runner the device started itself (no pending
// launch) must present it to register. Kept apart from state.json so it can be
// owner-only; deleting the file revokes every device.
function secretsPath(): string {
  return process.env.INTERCEPTOR_IOS_SECRETS_PATH ?? join(dirname(statePath()), "runner-secrets.json")
}

function loadRunnerSecrets(): Record<string, string> {
  try { return JSON.parse(readFileSync(secretsPath(), "utf-8")) as Record<string, string> } catch { return {} }
}

/** The device's secret, created (32 random bytes, base64url) on first use. */
export function getOrCreateRunnerSecret(udid: string): string {
  const U = udid.toUpperCase()
  const all = loadRunnerSecrets()
  if (all[U]) return all[U]
  all[U] = randomBytes(32).toString("base64url")
  const path = secretsPath()
  writeFileSync(path, JSON.stringify(all, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600) // mode only applies when the file is created
  return all[U]
}

export function hasRunnerSecret(udid: string): boolean {
  return Boolean(loadRunnerSecrets()[udid.toUpperCase()])
}

/** True once any device got a secret, i.e. this Mac has launched a runner that can be opened on the device. */
export function anyRunnerSecret(): boolean {
  return Object.keys(loadRunnerSecrets()).length > 0
}

/** How far a runner proof's timestamp may be from this Mac's clock. */
export const RUNNER_PROOF_WINDOW_MS = 120_000
const seenNonces = new Map<string, number>()

/** HMAC-SHA256 over `<role>|<UDID>|<parts…>`, keyed by the device secret, base64url. */
function hmac(secret: string, role: string, udid: string, ...parts: Array<string | number>): string {
  return createHmac("sha256", secret).update([role, udid.toUpperCase(), ...parts].join("|")).digest("base64url")
}

/** The proof a device-started runner sends (exported for tests). */
export function runnerProof(secret: string, udid: string, ts: number, nonce: string): string {
  return hmac(secret, "runner", udid, ts, nonce)
}

/**
 * Check a device-started runner's proof of the device secret. The
 * secret itself never crosses the network. A proof is fresh (within
 * RUNNER_PROOF_WINDOW_MS) and single-use (its nonce is remembered).
 */
export function verifyRunnerProof(udid: string, p: { ts?: unknown; nonce?: unknown; proof?: unknown }, now = Date.now()): boolean {
  const { ts, nonce, proof } = p
  if (typeof ts !== "number" || !Number.isFinite(ts) || Math.abs(now - ts) > RUNNER_PROOF_WINDOW_MS) return false
  if (typeof nonce !== "string" || nonce.length < 16 || nonce.length > 128) return false
  if (typeof proof !== "string" || !proof) return false
  const secret = loadRunnerSecrets()[udid.toUpperCase()]
  if (!secret) return false
  const expected = Buffer.from(runnerProof(secret, udid, ts, nonce)), given = Buffer.from(proof)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false
  for (const [n, until] of seenNonces) if (until < now) seenNonces.delete(n)
  if (seenNonces.has(nonce)) return false
  seenNonces.set(nonce, now + 2 * RUNNER_PROOF_WINDOW_MS)
  return true
}

/** The daemon's answer to a verified proof, so the runner knows it reached this Mac. */
export function serverProof(udid: string, nonce: string): string | undefined {
  const secret = loadRunnerSecrets()[udid.toUpperCase()]
  return secret ? hmac(secret, "server", udid, nonce) : undefined
}
