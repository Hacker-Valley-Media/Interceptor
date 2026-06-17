/**
 * shared/extensions.ts — Extension Fabric: manifest schema + the
 * capability-blind discovery resolver.
 *
 * The shipped product is a capability-blind host. It knows how to *discover* an
 * operator-placed extension bundle, validate its manifest *shape*, and surface
 * its declared verbs/agent/skill — but nothing about what any extension *does*.
 *
 * Discovery is filesystem-only. The core never network-fetches an extension
 * (enforced by the capability-blind audit + a unit test). Extensions live under
 * `~/.interceptor/extensions/<name>/` (the already-gitignored `.interceptor/`
 * private root). The bridge (Swift) has a parallel resolver in
 * `interceptor-bridge/Sources/ExtensionFabric.swift`; both MUST agree on the
 * root path and the precedence ordering — see DISCOVERY PRECEDENCE below.
 *
 * Dependency-free (no Bun/daemon imports) so it is importable from cli, daemon,
 * and tests, and usable *synchronously* in the CLI startup/parse path (C5 needs
 * the manifest-declared prefix set before `parseMacosCommand` dispatches).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"

// ── Manifest schema (neutral capability declaration) ──────────────────────────
// A manifest declares *what surface* an extension adds — a bridge-domain prefix,
// CLI verbs, agent dylib slices, a skill directory — never *how* anything works.

export type BridgeDomainDecl = {
  /** Single lowercase token, the `macos_<prefix>_<cmd>` routing key. */
  prefix: string
  /** Path (relative to the extension dir) of the DomainHandler dylib to dlopen. */
  dylib: string
  /** Exported C symbol the bridge calls to obtain the handler (e.g. itc_ext_handle). */
  entry: string
}

export type CliVerbDecl = {
  /** The subcommand verb, surfaced as `macos <actionPrefix> <verb>`. */
  verb: string
  /** Must match a bridgeDomains[].prefix — the routing domain the verb targets. */
  actionPrefix: string
}

export type AgentSlices = {
  arm64?: string
  arm64e?: string
  x86_64?: string
}

export type ExtensionManifest = {
  name: string
  version: string
  bridgeDomains?: BridgeDomainDecl[]
  cliVerbs?: CliVerbDecl[]
  agent?: AgentSlices
  /** Relative path to the extension's own SKILL.md directory. */
  skill?: string
  /**
   * Optional neutral, audit-centered capability tags. The core does not act on
   * these today (rung-4 delegation is guidance-only, see NativeDomain.swift);
   * reserved so a future capability router can match a handler without the core
   * knowing what the handler does.
   */
  capabilities?: string[]
}

export type DiscoveredExtension = {
  /** Directory name under the extensions root (the canonical extension id). */
  name: string
  /** Absolute path to the extension directory. */
  dir: string
  /** Absolute path to manifest.json. */
  manifestPath: string
  manifest: ExtensionManifest
}

/** A manifest that failed shape validation (surfaced, never silently dropped). */
export type RejectedExtension = {
  name: string
  dir: string
  manifestPath: string
  error: string
}

export type DiscoveryResult = {
  extensions: DiscoveredExtension[]
  rejected: RejectedExtension[]
}

// ── Paths ─────────────────────────────────────────────────────────────────────

/** Home dir, cross-platform, with an env override used by tests. */
function homeDir(): string {
  return (
    process.env.INTERCEPTOR_HOME_OVERRIDE ||
    process.env.HOME ||
    process.env.USERPROFILE ||
    ""
  )
}

/**
 * The extension discovery root. `INTERCEPTOR_EXTENSIONS_DIR` overrides it (used
 * by tests and by operators who keep extensions elsewhere). Mirrors the Swift
 * resolver's `extensionsRoot()`.
 */
export function extensionsRoot(): string {
  const override = process.env.INTERCEPTOR_EXTENSIONS_DIR
  if (override && override.length > 0) return override
  const home = homeDir()
  return home ? `${home}/.interceptor/extensions` : ".interceptor/extensions"
}

// ── Shape validation (validates shape, NOT behavior) ──────────────────────────

const NAME_RE = /^[a-z][a-z0-9-]*$/ // extension dir name / manifest name
const PREFIX_RE = /^[a-z][a-z0-9]*$/ // bridge-domain prefix: single lowercase token

/**
 * Built-in bridge domain prefixes the fabric must never let an extension
 * clobber. Mirrors the registrations in interceptor-bridge/Sources/main.swift.
 * The Swift loader reserves the live Router key set (authoritative); this list
 * lets the TS CLI reject a colliding prefix early with a clear message. Keep in
 * sync with main.swift — covered by a unit test.
 */
export const BUILTIN_BRIDGE_PREFIXES: ReadonlySet<string> = new Set([
  "tree", "find", "inspect", "value", "action", "focused", "windows", "resize",
  "move", "apps", "app", "frontmost", "click", "type", "keys", "scroll", "drag",
  "screenshot", "capture", "listen", "vad", "sounds", "vision", "nlp", "ai",
  "sensitive", "health", "files", "notifications", "clipboard", "display",
  "audio", "stream", "monitor", "trust", "tcc", "menu", "text", "compound",
  "overlay", "fs", "url", "log", "script", "intent", "container", "native",
  "vm", "pdf", "detect", "translate", "thumbnail", "auth", "calendar",
  "reminders", "contacts", "appintent", "photos", "maps", "location", "music",
  "share", "update",
])

/**
 * Validate a parsed manifest object's *shape*. Returns null if valid, else a
 * human-readable reason. Rejects bridge-domain prefixes that are not a single
 * lowercase token (an underscore would truncate the `macos_<prefix>_<cmd>`
 * routing key) or that collide with a built-in domain.
 */
export function validateManifestShape(obj: unknown): string | null {
  if (typeof obj !== "object" || obj === null) return "manifest is not an object"
  const m = obj as Record<string, unknown>
  if (typeof m.name !== "string" || !NAME_RE.test(m.name)) {
    return `manifest.name must match ${NAME_RE} (got ${JSON.stringify(m.name)})`
  }
  if (typeof m.version !== "string" || m.version.length === 0) {
    return "manifest.version must be a non-empty string"
  }
  if (m.bridgeDomains !== undefined) {
    if (!Array.isArray(m.bridgeDomains)) return "manifest.bridgeDomains must be an array"
    for (const d of m.bridgeDomains) {
      if (typeof d !== "object" || d === null) return "bridgeDomains[] entry is not an object"
      const dd = d as Record<string, unknown>
      if (typeof dd.prefix !== "string" || !PREFIX_RE.test(dd.prefix)) {
        return `bridgeDomains[].prefix must match ${PREFIX_RE} (got ${JSON.stringify(dd.prefix)})`
      }
      if (BUILTIN_BRIDGE_PREFIXES.has(dd.prefix)) {
        return `bridgeDomains[].prefix "${dd.prefix}" collides with a built-in domain`
      }
      if (typeof dd.dylib !== "string" || dd.dylib.length === 0) {
        return `bridgeDomains[].dylib must be a non-empty string (prefix ${dd.prefix})`
      }
      if (typeof dd.entry !== "string" || dd.entry.length === 0) {
        return `bridgeDomains[].entry must be a non-empty string (prefix ${dd.prefix})`
      }
    }
  }
  if (m.cliVerbs !== undefined) {
    if (!Array.isArray(m.cliVerbs)) return "manifest.cliVerbs must be an array"
    for (const v of m.cliVerbs) {
      if (typeof v !== "object" || v === null) return "cliVerbs[] entry is not an object"
      const vv = v as Record<string, unknown>
      if (typeof vv.verb !== "string" || vv.verb.length === 0) return "cliVerbs[].verb must be a non-empty string"
      if (typeof vv.actionPrefix !== "string" || !PREFIX_RE.test(vv.actionPrefix)) {
        return `cliVerbs[].actionPrefix must match ${PREFIX_RE} (got ${JSON.stringify(vv.actionPrefix)})`
      }
      if (BUILTIN_BRIDGE_PREFIXES.has(vv.actionPrefix)) {
        return `cliVerbs[].actionPrefix "${vv.actionPrefix}" collides with a built-in domain`
      }
    }
  }
  if (m.agent !== undefined) {
    if (typeof m.agent !== "object" || m.agent === null || Array.isArray(m.agent)) {
      return "manifest.agent must be an object of slice->path"
    }
  }
  if (m.skill !== undefined && typeof m.skill !== "string") return "manifest.skill must be a string"
  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities) || m.capabilities.some(c => typeof c !== "string")) {
      return "manifest.capabilities must be an array of strings"
    }
  }
  return null
}

// ── Discovery ─────────────────────────────────────────────────────────────────
//
// DISCOVERY PRECEDENCE (must match the Swift resolver):
//   1. Root: `INTERCEPTOR_EXTENSIONS_DIR` if set, else `~/.interceptor/extensions`.
//   2. Each immediate subdirectory holding a readable `manifest.json` is one
//      extension; the directory name is the canonical extension id.
//   3. Extensions are ordered by directory name (ascending) for deterministic,
//      machine-independent registration order. The FIRST extension to claim a
//      bridge prefix or CLI verb wins; later collisions are skipped + reported.
//   4. A manifest that fails shape validation is rejected (surfaced), not loaded.
//   5. No network fetch, ever — discovery only reads the local filesystem.

/** Synchronously discover all valid extensions under the root. Never throws. */
export function discoverExtensions(root: string = extensionsRoot()): DiscoveryResult {
  const out: DiscoveryResult = { extensions: [], rejected: [] }
  let entries: string[]
  try {
    if (!existsSync(root)) return out
    entries = readdirSync(root).sort()
  } catch {
    return out
  }
  for (const name of entries) {
    const dir = `${root}/${name}`
    const manifestPath = `${dir}/manifest.json`
    try {
      if (!statSync(dir).isDirectory()) continue
      if (!existsSync(manifestPath)) continue
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8"))
    } catch (err) {
      out.rejected.push({ name, dir, manifestPath, error: `invalid JSON: ${(err as Error).message}` })
      continue
    }
    const shapeError = validateManifestShape(parsed)
    if (shapeError) {
      out.rejected.push({ name, dir, manifestPath, error: shapeError })
      continue
    }
    const manifest = parsed as ExtensionManifest
    // The directory name is authoritative; a mismatched manifest.name is a soft
    // warning, not a rejection (the dir name is what the operator placed).
    out.extensions.push({ name, dir, manifestPath, manifest })
  }
  return out
}

/**
 * The set of `macos <prefix>` subcommand tokens contributed by installed
 * extensions — the union of bridge-domain prefixes and cliVerb actionPrefixes,
 * minus any that collide with a built-in (defensive; validation already rejects
 * those). C5 feeds this into `parseMacosCommand` so `macos <prefix> <cmd>` falls
 * through to the generic extension-verb builder instead of the hard `default`.
 */
export function extensionMacosPrefixes(result: DiscoveryResult = discoverExtensions()): Set<string> {
  const prefixes = new Set<string>()
  for (const ext of result.extensions) {
    for (const d of ext.manifest.bridgeDomains ?? []) {
      if (!BUILTIN_BRIDGE_PREFIXES.has(d.prefix)) prefixes.add(d.prefix)
    }
    for (const v of ext.manifest.cliVerbs ?? []) {
      if (!BUILTIN_BRIDGE_PREFIXES.has(v.actionPrefix)) prefixes.add(v.actionPrefix)
    }
  }
  return prefixes
}

/**
 * Normalize an extension subcommand into the `macos_<prefix>_<cmd>` action type,
 * mirroring the only existing dynamically-typed family (`vm`, macos.ts:996),
 * which normalizes hyphens to underscores in the type segment. `Router.route`
 * splits on `_` with maxSplits:2, so any embedded underscores from a normalized
 * hyphen are preserved as part of the command for the extension to parse.
 */
export function extensionActionType(prefix: string, cmd: string): string {
  return `macos_${prefix}_${cmd.replace(/-/g, "_")}`
}
