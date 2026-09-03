/**
 * daemon/secrets.ts — the secret vault (issue #244).
 *
 * Secrets live in the macOS keychain, never in a file. The daemon is the only
 * process that ever holds a resolved value, and only for the length of one
 * delivery call. What lives on disk is metadata: names, targets, gate mode,
 * timestamps, release counts.
 *
 * Two backends satisfy `Vault`:
 *   - BunSecretsVault  login keychain via Bun.secrets (v1, works from the
 *                      compiled daemon with no entitlement).
 *   - a bridge-backed vault (daemon/index.ts) that stores in the data
 *     protection keychain owned by the signed bridge. When it reports
 *     unavailable, the daemon falls back to BunSecretsVault.
 *
 * Pure Node/Bun, no daemon imports, so every rule here is unit-testable.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type SecretGate = "none" | "touchid" | "biometry"

export type SecretMeta = {
  createdAt: number
  updatedAt?: number
  gate: SecretGate
  reuseSeconds: number
  targets: string[]
  lastReleasedAt?: number
  releases: number
}

export type SecretsFile = { version: 1; secrets: Record<string, SecretMeta> }

export type SecretTargetKind = "sudo" | "macos" | "browser" | "ios" | "any" | "reveal"
export type SecretTarget = { kind: SecretTargetKind; id?: string }

export interface Vault {
  readonly backend: string
  set(name: string, value: string): Promise<void>
  get(name: string): Promise<string | null>
  delete(name: string): Promise<boolean>
}

export const SECRET_SERVICE = process.env.INTERCEPTOR_SECRETS_SERVICE || "com.interceptor.secrets"
export const SECRET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const SECRET_GATES: ReadonlyArray<SecretGate> = ["none", "touchid", "biometry"]

export class SecretError extends Error {
  constructor(public code: "invalid_name" | "not_found" | "target_denied" | "gate_denied" | "vault_error" | "invalid_target" | "invalid_gate", message: string) {
    super(message)
  }
}

// ── metadata file ────────────────────────────────────────────────────────────

export function metadataPath(): string {
  return process.env.INTERCEPTOR_SECRETS_META || join(homedir(), ".interceptor", "secrets.json")
}

export function loadMeta(path = metadataPath()): SecretsFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SecretsFile>
    if (parsed && parsed.version === 1 && parsed.secrets && typeof parsed.secrets === "object") {
      return { version: 1, secrets: parsed.secrets }
    }
  } catch {}
  return { version: 1, secrets: {} }
}

export function saveMeta(file: SecretsFile, path = metadataPath()): void {
  try { mkdirSync(dirname(path), { recursive: true }) } catch {}
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 })
}

// ── validation ───────────────────────────────────────────────────────────────

export function assertName(name: unknown): string {
  if (typeof name !== "string" || !SECRET_NAME_RE.test(name)) {
    throw new SecretError("invalid_name", "secret name must be 1-64 characters: letters, digits, '.', '_' or '-' (starting with a letter or digit)")
  }
  return name
}

export function parseGate(raw: unknown): SecretGate {
  if (raw === undefined || raw === null || raw === "") return "none"
  if (typeof raw === "string" && (SECRET_GATES as ReadonlyArray<string>).includes(raw)) return raw as SecretGate
  throw new SecretError("invalid_gate", `unknown gate '${String(raw)}' (none | touchid | biometry)`)
}

/** Accepts `sudo`, `ios`, `any`, `macos:<bundleId>`, `browser:<host>`; comma lists are split. */
export function parseTargets(raw: unknown): string[] {
  const items: string[] = []
  const push = (s: string) => { for (const part of s.split(",")) { const t = part.trim(); if (t) items.push(t) } }
  if (Array.isArray(raw)) for (const r of raw) { if (typeof r === "string") push(r) }
  else if (typeof raw === "string") push(raw)
  if (items.length === 0) return ["any"]
  const out: string[] = []
  for (const t of items) {
    const lower = t.toLowerCase()
    if (lower === "sudo" || lower === "ios" || lower === "any") { out.push(lower); continue }
    if (lower.startsWith("macos:") && t.length > 6) { out.push("macos:" + t.slice(6)); continue }
    if (lower.startsWith("browser:") && t.length > 8) { out.push("browser:" + t.slice(8).toLowerCase()); continue }
    throw new SecretError("invalid_target", `unknown target '${t}' (sudo | macos:<bundleId> | browser:<host> | ios | any)`)
  }
  return [...new Set(out)]
}

export function parseDuration(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  if (typeof raw !== "string") throw new SecretError("invalid_target", "duration required (e.g. 30m, 2h, 90s)")
  const m = /^(\d+)\s*(s|m|h|d)?$/i.exec(raw.trim())
  if (!m) throw new SecretError("invalid_target", `bad duration '${raw}' (e.g. 30m, 2h, 90s)`)
  const n = parseInt(m[1], 10)
  const unit = (m[2] || "s").toLowerCase()
  const mult = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1
  return n * mult
}

// ── target matching ──────────────────────────────────────────────────────────

function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "*") return true
  if (pattern === host) return true
  return host.endsWith("." + pattern)
}

/** `reveal` is never target-checked (it is always OS-gated instead). */
export function targetAllowed(targets: string[], target: SecretTarget): boolean {
  if (target.kind === "reveal") return true
  if (targets.includes("any")) return true
  switch (target.kind) {
    case "sudo": return targets.includes("sudo")
    case "ios": return targets.includes("ios")
    case "macos": {
      const id = (target.id || "").toLowerCase()
      return targets.some((t) => t.startsWith("macos:") && (t.slice(6) === "*" || t.slice(6).toLowerCase() === id))
    }
    case "browser": {
      const host = (target.id || "").toLowerCase()
      return targets.some((t) => t.startsWith("browser:") && hostMatches(t.slice(8), host))
    }
    default: return false
  }
}

export function describeTarget(target: SecretTarget): string {
  switch (target.kind) {
    case "sudo": return "sudo"
    case "macos": return `macOS app ${target.id || "(unknown)"}`
    case "browser": return `browser page on ${target.id || "(unknown host)"}`
    case "ios": return "iPhone"
    case "reveal": return "the terminal (reveal)"
    default: return "any target"
  }
}

// ── unlock windows (memory only, die with the daemon) ────────────────────────

const unlockUntil = new Map<string, number>()

export function openUnlock(name: string, seconds: number, now = Date.now()): number {
  const until = now + seconds * 1000
  unlockUntil.set(name, until)
  return until
}

export function isUnlocked(name: string, now = Date.now()): boolean {
  const until = unlockUntil.get(name)
  if (until === undefined) return false
  if (until <= now) { unlockUntil.delete(name); return false }
  return true
}

export function lock(name?: string): string[] {
  if (name) { const had = unlockUntil.delete(name); return had ? [name] : [] }
  const names = [...unlockUntil.keys()]
  unlockUntil.clear()
  return names
}

export function openUnlocks(now = Date.now()): Array<{ name: string; until: number }> {
  const out: Array<{ name: string; until: number }> = []
  for (const [name, until] of unlockUntil) {
    if (until > now) out.push({ name, until })
    else unlockUntil.delete(name)
  }
  return out
}

// ── Bun.secrets backend ──────────────────────────────────────────────────────

export class BunSecretsVault implements Vault {
  readonly backend = "login-keychain"
  constructor(private service = SECRET_SERVICE) {}
  async set(name: string, value: string): Promise<void> {
    await Bun.secrets.set({ service: this.service, name, value })
  }
  async get(name: string): Promise<string | null> {
    const v = await Bun.secrets.get({ service: this.service, name })
    return typeof v === "string" ? v : null
  }
  async delete(name: string): Promise<boolean> {
    try { return await Bun.secrets.delete({ service: this.service, name }) } catch { return false }
  }
}

// ── store operations ─────────────────────────────────────────────────────────

export type StoreOptions = { gate?: unknown; targets?: unknown; reuseSeconds?: unknown; metaPath?: string }

export async function storeSecret(vault: Vault, name: string, value: string, opts: StoreOptions = {}): Promise<SecretMeta> {
  assertName(name)
  if (typeof value !== "string" || value.length === 0) throw new SecretError("vault_error", "secret value is empty")
  const gate = parseGate(opts.gate)
  const targets = parseTargets(opts.targets)
  const reuse = typeof opts.reuseSeconds === "number" && opts.reuseSeconds > 0 ? Math.floor(opts.reuseSeconds) : 0
  await vault.set(name, value)
  const file = loadMeta(opts.metaPath)
  const prev = file.secrets[name]
  const now = Date.now()
  const meta: SecretMeta = {
    createdAt: prev?.createdAt ?? now,
    updatedAt: prev ? now : undefined,
    gate,
    reuseSeconds: reuse,
    targets,
    lastReleasedAt: prev?.lastReleasedAt,
    releases: prev?.releases ?? 0,
  }
  file.secrets[name] = meta
  saveMeta(file, opts.metaPath)
  return meta
}

export async function removeSecret(vault: Vault, name: string, metaPath?: string): Promise<boolean> {
  assertName(name)
  const deleted = await vault.delete(name)
  const file = loadMeta(metaPath)
  const had = name in file.secrets
  delete file.secrets[name]
  saveMeta(file, metaPath)
  lock(name)
  return deleted || had
}

export function listSecrets(metaPath?: string): Array<{ name: string } & SecretMeta & { unlocked: boolean }> {
  const file = loadMeta(metaPath)
  return Object.entries(file.secrets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, meta]) => ({ name, ...meta, unlocked: isUnlocked(name) }))
}

// ── release ──────────────────────────────────────────────────────────────────

export type GateFn = (args: { reason: string; policy: "any" | "biometry"; reuseSeconds: number }) => Promise<{ ok: boolean; error?: string }>

export type ResolveOptions = {
  gate: GateFn
  session?: string
  metaPath?: string
  /** Force the OS prompt even for ungated secrets (used by reveal + unlock). */
  alwaysGate?: boolean
}

export function gateReason(name: string, target: SecretTarget, session?: string): string {
  const who = session ? ` (session ${session})` : ""
  return `Interceptor: release "${name}" to ${describeTarget(target)}${who}`
}

/**
 * The release gate (issue #244). Order matters: the caller has already
 * logged the action (name only); this checks metadata, then the target
 * allowlist, then the gate, and only then reads the keychain.
 */
export async function resolveSecret(vault: Vault, name: string, target: SecretTarget, opts: ResolveOptions): Promise<{ value: string; meta: SecretMeta; gated: boolean }> {
  assertName(name)
  const file = loadMeta(opts.metaPath)
  const meta = file.secrets[name]
  if (!meta) throw new SecretError("not_found", `no secret named '${name}' (interceptor macos secret list)`)
  if (!targetAllowed(meta.targets, target)) {
    throw new SecretError("target_denied", `secret '${name}' is not allowed for ${describeTarget(target)} (targets: ${meta.targets.join(", ")})`)
  }
  let gated = false
  const needsGate = opts.alwaysGate || (meta.gate !== "none" && !isUnlocked(name))
  if (needsGate) {
    const res = await opts.gate({
      reason: gateReason(name, target, opts.session),
      policy: meta.gate === "biometry" ? "biometry" : "any",
      reuseSeconds: meta.reuseSeconds,
    })
    if (!res.ok) throw new SecretError("gate_denied", res.error || `release of '${name}' was not approved`)
    gated = true
  }
  let value: string | null
  try { value = await vault.get(name) } catch (err) { throw new SecretError("vault_error", `keychain read failed for '${name}': ${(err as Error).message}`) }
  if (value === null) throw new SecretError("not_found", `secret '${name}' has metadata but no keychain item (re-register it)`)
  meta.lastReleasedAt = Date.now()
  meta.releases = (meta.releases ?? 0) + 1
  saveMeta(file, opts.metaPath)
  return { value, meta, gated }
}

// ── sudo delivery leg ────────────────────────────────────────────────────────

export type SudoResult = { success: boolean; error?: string; data?: { exitCode: number | null; stdout: string; stderr: string; keep: boolean } }

const SUDO_OUTPUT_CAP = 50_000

/**
 * `sudo -S` reads the password from stdin; `-k` ignores and does not refresh the
 * timestamp cache so every call authenticates with the vault value; `--keep`
 * drops `-k` so a burst of commands can ride sudo's own 5-minute cache.
 */
export async function runSudo(value: string, cmd: string[], opts: { keep?: boolean; timeoutMs?: number; sudoPath?: string } = {}): Promise<SudoResult> {
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((c) => typeof c !== "string")) {
    return { success: false, error: "macos sudo requires a command after --" }
  }
  const argv = [opts.sudoPath || "/usr/bin/sudo", "-S", ...(opts.keep ? [] : ["-k"]), "-p", "", "--", ...cmd]
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, SUDO_ASKPASS: "" } })
  } catch (err) {
    return { success: false, error: `could not start sudo: ${(err as Error).message}` }
  }
  const stdin = proc.stdin as unknown as { write: (s: string) => unknown; end: () => unknown }
  try { stdin.write(value + "\n"); stdin.end() } catch {}
  const timeoutMs = opts.timeoutMs ?? 600_000
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; try { proc.kill() } catch {} }, timeoutMs)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ])
  const exitCode = await proc.exited
  clearTimeout(timer)
  const out = stdout.length > SUDO_OUTPUT_CAP ? stdout.slice(0, SUDO_OUTPUT_CAP) + "\n... (truncated)" : stdout
  const err = stderr.length > SUDO_OUTPUT_CAP ? stderr.slice(0, SUDO_OUTPUT_CAP) + "\n... (truncated)" : stderr
  const data = { exitCode, stdout: out, stderr: err, keep: !!opts.keep }
  if (timedOut) return { success: false, error: `sudo command timed out after ${Math.round(timeoutMs / 1000)}s`, data }
  if (/incorrect password attempt|Sorry, try again/i.test(stderr)) {
    return { success: false, error: "sudo rejected the stored password (re-register the secret)", data }
  }
  if (exitCode !== 0) return { success: false, error: `command exited ${exitCode}`, data }
  return { success: true, data }
}
