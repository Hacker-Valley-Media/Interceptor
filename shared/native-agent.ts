/**
 * shared/native-agent.ts — types, constants, and pure helpers for the
 * Runtime Agent surface: in-process introspection & control of
 * (AppKit/SwiftUI/C++/Rust) macOS apps via an in-process agent dylib.
 *
 * The agent registers with the daemon over the SAME WebSocket transport the
 * browser extension uses (`{type:"native", contextId:"runtime:<app>"}`), so verb
 * routing, `contexts`, and disambiguation reuse the existing extension paths.
 * The only net-new daemon behavior is the `delegate` frame (agent → bridge for
 * TCC-gated work) and a small per-agent metadata map for `macos runtime status`.
 *
 * Dependency-free (no Bun/daemon imports) so it can be unit tested and imported
 * from both cli and daemon. Mirrors shared/cdp-app.ts.
 */

export const NATIVE_CONTEXT_PREFIX = "runtime:"

/** WebSocket registration type used by the in-process agent. */
export const NATIVE_REGISTER_TYPE = "native"
/** Frame the agent emits to delegate a TCC-gated / OS-level op to the bridge. */
export const NATIVE_DELEGATE_TYPE = "delegate"

/** The way-in ladder. Ordered lightest → heaviest. */
export type NativeWayIn =
  | "own-build"        // rung 1 — the agent is linked into the user's own app
  | "runtime-channel"  // rung 2 — Electron/.NET/JVM/… runtime debug channel
  | "weak-entitlement" // rung 3 — DYLD_INSERT works without re-sign
  | "re-sign"          // rung 4 — hardened pure-native: local re-sign + agent load
  | "unsupported"      // rung 5 — system platform binary (public build unsupported)

export const NATIVE_WAY_IN_RUNG: Record<NativeWayIn, number> = {
  "own-build": 1,
  "runtime-channel": 2,
  "weak-entitlement": 3,
  "re-sign": 4,
  "unsupported": 5,
}

export type CodeSlice = "arm64" | "arm64e" | "x86_64" | "universal" | "unknown"

export type NativeRuntime =
  | "appkit" | "swiftui" | "catalyst"          // pure native (the target class for the agent)
  | "electron" | "chromium"                    // runtime-channel (CDP)
  | "dotnet" | "jvm" | "mono" | "python" | "qt"// runtime-channel (their own debug protocols)
  | "unknown"

/** Runtimes whose own debug channel is the right door (rung 2). */
export const RUNTIME_CHANNEL_RUNTIMES = new Set<NativeRuntime>([
  "electron", "chromium", "dotnet", "jvm", "mono", "python",
])

export type NativeAppDescriptor = {
  /** Stable, human-addressable context id, e.g. "runtime:myapp". */
  contextId: string
  /** Short app slug used in the context id. */
  appSlug: string
  appName: string
  bundleId?: string
  pid?: number
  /** Absolute path to the .app bundle. */
  path?: string
  slice: CodeSlice
  /** Hardened-runtime flag present in the CodeDirectory (flags 0x10000). */
  hardened: boolean
  /** Library validation enforced (no disable-library-validation entitlement). */
  libraryValidation: boolean
  /** System platform binary (SIP-protected; public runtime-agent builds do not load here). */
  platformBinary: boolean
  /** App Sandbox enabled. */
  sandboxed: boolean
  /** Relevant entitlement keys found via codesign. */
  entitlements: string[]
  runtime: NativeRuntime
  wayIn: NativeWayIn
}

export type NativeConnectionState = "connected" | "connecting" | "disconnected" | "error"

/** Daemon-side metadata for a connected agent (drives `macos runtime status`). */
export type NativeAgentState = {
  contextId: string
  appName: string
  pid?: number
  slice: CodeSlice
  wayIn?: NativeWayIn
  frameworks?: string[]
  registeredAt: number
  connection: NativeConnectionState
}

/** Action types the in-process agent understands (over the verb channel). */
export const NATIVE_VERB_TYPES = new Set<string>([
  "native_tree", "native_layers", "native_eval", "native_mutate", "native_intercept",
  "native_screenshot", "native_watch", "native_net", "native_net_log", "native_net_bodies", "native_ping", "native_ax", "native_file", "native_tcc", "native_draw", "native_js",
  // Runtime Hook Fabric
  "native_hook", "native_unhook", "native_hooks", "native_hook_log", "native_events",
  "native_trace", "native_untrace", "native_cintercept", "native_dom_watch", "native_domains",
  // Browser-verb aliases so `read`/`eval`/`screenshot --context runtime:` work.
  "get_state", "tree", "evaluate", "screenshot",
])

// ── Pure helpers (unit tested) ────────────────────────────────────────────────

export function isNativeContextId(contextId: string | undefined): contextId is string {
  return typeof contextId === "string" && contextId.startsWith(NATIVE_CONTEXT_PREFIX)
}

/** Normalize an app name into a context-safe slug ("My App.app" -> "my-app"). */
export function nativeAppSlug(appName: string): string {
  return appName
    .trim()
    .toLowerCase()
    .replace(/\.app$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "app"
}

export function nativeContextId(appName: string): string {
  return NATIVE_CONTEXT_PREFIX + nativeAppSlug(appName)
}

/**
 * Deterministic way-in classifier. Pure so the
 * Swift bridge's discovery output and TS tests share one source of truth.
 */
export function classifyWayIn(input: {
  platformBinary?: boolean
  agentLinked?: boolean
  runtime?: NativeRuntime
  hardened?: boolean
  disableLibraryValidation?: boolean
  allowDyldEnvironmentVariables?: boolean
  getTaskAllow?: boolean
}): NativeWayIn {
  if (input.platformBinary) return "unsupported"
  if (input.agentLinked) return "own-build"
  if (input.runtime && RUNTIME_CHANNEL_RUNTIMES.has(input.runtime)) return "runtime-channel"
  const loadableWithoutResign =
    input.hardened === false ||
    (input.disableLibraryValidation === true && input.allowDyldEnvironmentVariables === true) ||
    input.getTaskAllow === true
  if (loadableWithoutResign) return "weak-entitlement"
  return "re-sign"
}

/** Detect the code slice from `lipo -archs` / `file` output. */
export function parseSlice(archsOutput: string): CodeSlice {
  const s = archsOutput.toLowerCase()
  const has = (a: string) => new RegExp(`\\b${a}\\b`).test(s)
  const arm64e = has("arm64e")
  const arm64 = has("arm64")
  const x86 = has("x86_64")
  if ((arm64 || arm64e) && x86) return "universal"
  if (arm64e) return "arm64e"
  if (arm64) return "arm64"
  if (x86) return "x86_64"
  return "unknown"
}

/** Does a `codesign -d -v` output show the hardened-runtime flag? */
export function parseHardenedRuntime(codesignVerbose: string): boolean {
  // CodeDirectory ... flags=0x10000(runtime)  — the runtime bit.
  return /flags=0x[0-9a-f]*\([^)]*\bruntime\b/i.test(codesignVerbose)
}

/** Detect the runtime from bundle frameworks / linked dylibs. */
export function classifyRuntime(input: {
  hasElectronFramework?: boolean
  chromiumHelpers?: boolean
  dylibs?: string[]            // names from otool -L / bundle scan
  hasSwiftUI?: boolean
}): NativeRuntime {
  if (input.hasElectronFramework) return "electron"
  if (input.chromiumHelpers) return "chromium"
  const d = (input.dylibs ?? []).join(" ").toLowerCase()
  if (/libcoreclr|libhostfxr|system\.private\.corelib/.test(d)) return "dotnet"
  if (/libjvm|libjli/.test(d)) return "jvm"
  if (/libmono/.test(d)) return "mono"
  if (/libpython|python\.framework/.test(d)) return "python"
  if (/qtcore/.test(d)) return "qt"
  if (input.hasSwiftUI || /swiftui/.test(d)) return "swiftui"
  return "appkit"
}

/** Human-readable one-liner for `macos runtime discover` plain-text output. */
export function describeWayIn(w: NativeWayIn): string {
  switch (w) {
    case "own-build": return "own build — link the agent, no re-sign"
    case "runtime-channel": return "runtime debug channel (Electron/.NET/JVM) — no re-sign"
    case "weak-entitlement": return "load with DYLD_INSERT_LIBRARIES — no re-sign"
    case "re-sign": return "local re-sign + resident agent load (SIP stays on; resets target TCC)"
    case "unsupported": return "system platform binary — public build unsupported"
  }
}
