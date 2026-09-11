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
 * Xcode signs each device-specific build with the user's configured developer
 * team. The actual bundle id must be persisted because every later install,
 * inventory, and launch step has to address that exact identity.
 *
 * Pure fs/JSON, no Bun/daemon imports beyond node:fs so it stays trivial to test.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type IosInstalled = {
  installedAt?: number
  bundleId?: string
  /** Runner signing expiry (epoch ms): ≤7 days free, ~1 year paid. Drives refresh. */
  expiresAt?: number
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
