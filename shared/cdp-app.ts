/**
 * shared/cdp-app.ts — types, constants, and pure helpers for the
 * Electron / Chromium desktop-app control surface.
 *
 * Two transports back an "app context":
 *   - Path 0 (primary): an Interceptor MV2 extension is loaded into the running
 *     app via the main-process inspector; it registers with the daemon over the
 *     normal extension WebSocket as contextId "app:<name>". From the daemon's
 *     point of view this is just another extension context — no CDP.
 *   - Path A (fallback): the daemon opens an outbound CDP WebSocket to the app's
 *     own --remote-debugging-port target and drives it. Context id "cdp:<name>".
 *
 * This module is dependency-free (no Bun/daemon imports) so it can be unit
 * tested and imported from both cli and daemon.
 */

export const CDP_CONTEXT_PREFIX = "cdp:"
export const APP_CONTEXT_PREFIX = "app:"

/** Default Chromium renderer remote-debugging HTTP port (`--remote-debugging-port`). */
export const DEFAULT_REMOTE_DEBUG_PORT = 9222
/** Default Node/V8 main-process inspector port (`--inspect`, SIGUSR1). */
export const DEFAULT_NODE_INSPECT_PORT = 9229

export type CdpEndpointKind = "renderer" | "node-main"

/** A discovered debuggable target as returned by `GET /json` on the debug port. */
export type CdpTarget = {
  targetId: string
  type: "page" | "iframe" | "worker" | "shared_worker" | "service_worker" | "background_page" | "webview" | "other"
  title: string
  url: string
  webSocketDebuggerUrl: string
  /** Best-effort association to an OS window, by title, when known. */
  windowTitle?: string
}

export type CdpAppDescriptor = {
  /** Stable, human-addressable context id, e.g. "cdp:slack" or "app:code". */
  contextId: string
  /** Short app slug used in the context id ("slack", "code", "descript"). */
  appSlug: string
  appName: string
  bundleId?: string
  pid?: number
  host: string
  /** Renderer remote-debugging port (Path A) or inspector port (bootstrap). */
  port: number
  kind: CdpEndpointKind
  discoveredVia: "running-flag" | "relaunch" | "manual-port" | "inspector-bootstrap"
  /** Best-effort: the Node main-process inspector appeared blocked (fuse off). */
  fusesHardened?: boolean
}

export type CdpConnectionState = "connected" | "connecting" | "disconnected" | "error"

export type CdpContextState = {
  descriptor: CdpAppDescriptor
  targets: CdpTarget[]
  attachedTargetId?: string
  attachedAt?: number
  lastDiscoveryAt: number
  connection: CdpConnectionState
}

/** A raw `/json` target entry, before normalization. */
type RawJsonTarget = {
  id?: unknown
  type?: unknown
  title?: unknown
  url?: unknown
  webSocketDebuggerUrl?: unknown
  description?: unknown
}

const KNOWN_TARGET_TYPES = new Set<CdpTarget["type"]>([
  "page", "iframe", "worker", "shared_worker", "service_worker", "background_page", "webview", "other",
])

function normalizeTargetType(value: unknown): CdpTarget["type"] {
  const t = typeof value === "string" ? value : "other"
  return KNOWN_TARGET_TYPES.has(t as CdpTarget["type"]) ? (t as CdpTarget["type"]) : "other"
}

/**
 * Parse the JSON body of `GET /json` (or `/json/list`) into normalized targets.
 * Skips entries without a `webSocketDebuggerUrl` (e.g. already-attached targets
 * surfaced by DevTools, or service-worker stubs) since they cannot be driven.
 * Pure function — unit tested directly against fixture payloads.
 */
export function parseJsonTargets(body: unknown): CdpTarget[] {
  if (!Array.isArray(body)) return []
  const out: CdpTarget[] = []
  for (const raw of body as RawJsonTarget[]) {
    if (!raw || typeof raw !== "object") continue
    const ws = typeof raw.webSocketDebuggerUrl === "string" ? raw.webSocketDebuggerUrl : ""
    if (!ws) continue
    out.push({
      targetId: typeof raw.id === "string" ? raw.id : ws,
      type: normalizeTargetType(raw.type),
      title: typeof raw.title === "string" ? raw.title : "",
      url: typeof raw.url === "string" ? raw.url : "",
      webSocketDebuggerUrl: ws,
    })
  }
  return out
}

/**
 * Choose the most useful page target. Prefers `type:"page"` whose URL contains
 * `urlHint`, then any `page`, then the first target. Deterministic — model-free.
 */
export function pickPageTarget(targets: CdpTarget[], urlHint?: string): CdpTarget | undefined {
  const pages = targets.filter(t => t.type === "page")
  if (urlHint) {
    const matched = pages.find(t => t.url.includes(urlHint))
    if (matched) return matched
  }
  if (pages.length > 0) return pages[0]
  return targets[0]
}

export function isCdpContextId(contextId: string | undefined): contextId is string {
  return typeof contextId === "string" && contextId.startsWith(CDP_CONTEXT_PREFIX)
}

export function isAppContextId(contextId: string | undefined): contextId is string {
  return typeof contextId === "string" && contextId.startsWith(APP_CONTEXT_PREFIX)
}

/** Normalize an app name into a context-safe slug ("Visual Studio Code" -> "visual-studio-code"). */
export function appSlug(appName: string): string {
  return appName
    .trim()
    .toLowerCase()
    .replace(/\.app$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "app"
}

export function cdpContextId(appName: string): string {
  return CDP_CONTEXT_PREFIX + appSlug(appName)
}

export function appContextId(appName: string): string {
  return APP_CONTEXT_PREFIX + appSlug(appName)
}

/** Extract a `--remote-debugging-port` / `--inspect[-port]` value from a process command line. */
export function parseDebugPortFromArgs(args: string, switchName: string): number | undefined {
  // matches --remote-debugging-port=9222 and --inspect=127.0.0.1:9229
  const re = new RegExp(`--${switchName}(?:=(?:[^\\s:=]+:)?(\\d+))?`)
  const m = re.exec(args)
  if (!m) return undefined
  if (m[1]) {
    const n = parseInt(m[1], 10)
    return Number.isNaN(n) ? undefined : n
  }
  return undefined
}

/**
 * Heuristic: does this process command line look like an Electron/Chromium app's
 * MAIN (browser) process? The main process is the one WITHOUT `--type=...`
 * (renderer/gpu/utility processes carry `--type=`). Electron apps embed
 * "Electron Framework" or pass Chromium switches.
 */
export function isElectronMainProcessArgs(args: string): boolean {
  if (/--type=/.test(args)) return false // child (renderer/gpu/utility) process
  // Exclude real browsers — they are Chromium but not Electron apps (no Node
  // main process, can't loadExtension, and they are the browser surface's job).
  const browserBundles = [
    "Google Chrome.app", "Google Chrome Canary.app", "Brave Browser.app",
    "Microsoft Edge.app", "Chromium.app", "Arc.app", "Vivaldi.app", "Opera.app",
  ]
  if (browserBundles.some(b => args.includes(b))) return false
  // A GUI app main is an executable inside `<App>.app/Contents/MacOS/`. Accept it
  // as a *candidate* even with minimal args (e.g. relaunched with only
  // --remote-debugging-port) — listElectronProcesses then confirms it is really
  // Electron via the bundle's Electron Framework.framework before using it.
  if (/\.app\/Contents\/MacOS\//.test(args)) return true
  // Fallback for Electron mains not launched from a .app bundle.
  const electronMarkers = [
    "Electron Framework.framework",
    "Electron.app",
    "--enable-features=",
    "--standard-schemes",
    "--user-data-dir",
  ]
  return electronMarkers.some(m => args.includes(m))
}

// ── Traffic redaction (mirrors the Descript research capture posture) ──────────

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token",
  "proxy-authorization", "x-csrf-token", "x-session-token",
])

export type HeaderMap = Record<string, string> | Array<{ name: string; value: string }>

/** Redact sensitive header values in place-safe copy. Accepts object or array shape. */
export function redactHeaders(headers: HeaderMap | undefined): HeaderMap | undefined {
  if (!headers) return headers
  if (Array.isArray(headers)) {
    return headers.map(h => SENSITIVE_HEADER_NAMES.has(h.name.toLowerCase())
      ? { name: h.name, value: "[redacted]" }
      : h)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_NAMES.has(k.toLowerCase()) ? "[redacted]" : v
  }
  return out
}

/** Replace a JSON body with a shape-only skeleton (keys preserved, scalars typed). */
export function jsonShape(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…"
  if (value === null) return null
  if (Array.isArray(value)) return value.length ? [jsonShape(value[0], depth + 1)] : []
  switch (typeof value) {
    case "string": return "<string>"
    case "number": return "<number>"
    case "boolean": return "<boolean>"
    case "object": {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = jsonShape(v, depth + 1)
      }
      return out
    }
    default: return `<${typeof value}>`
  }
}
