/**
 * cli/commands/diagnose.ts — interceptor diagnose
 *
 * Surfaces a concise debugging snapshot for agent diagnosis. Call this when
 * a command fails or when an agent needs to orient itself without issuing 4-5
 * follow-up commands to reconstruct system state.
 *
 * Works without a running daemon (reports what it can locally) and surfaces
 * progressively richer context when the daemon + extension are reachable.
 *
 * Context-aware: without --context, enumerates ALL connected browser contexts
 * and probes each one. In a dual-browser setup (Chrome + Brave) you see both
 * contexts side-by-side, making context mismatches immediately visible.
 *
 * Binary mismatch detection: compares the execPath recorded in the lock file
 * (which binary the socket daemon is actually running) against the path in
 * each browser's NMH manifest (which binary Chrome/Brave will spawn on
 * extension connect). A mismatch means the extension and CLI are talking to
 * different daemon processes — the root cause of "no extensions connected"
 * when Chrome appears open and the extension appears loaded.
 */

import { readFileSync } from "node:fs"
import { readStatusSnapshot, installedNmhManifests } from "../lib/status-renderer"
import { sendCommand } from "../transport"
import { listSessions } from "./monitor"
import { readLockFile, type LockFileData } from "../../daemon/lifecycle"
import { LOCK_PATH } from "../../shared/platform"
import { IOS_CONTEXT_PREFIX } from "../../shared/ios-device"
import { CDP_CONTEXT_PREFIX } from "../../shared/cdp-app"
import { VERSION } from "../version"
import {
  installTypeLabel,
  isPreStoreVersion,
  isStoreManaged,
  LEGACY_DEVELOPMENT_EXTENSION_ID,
  STORE_LISTING_URL,
} from "../../shared/extension-identity"

/** Where the installers leave the unpacked copy (the developer path). */
export const UNPACKED_EXTENSION_DIR = process.platform === "win32"
  ? "%LOCALAPPDATA%\\Programs\\Interceptor\\extension"
  : "/Library/Application Support/Interceptor/extension"

/** What the daemon knows about the extension behind a context. */
export type ContextIdentity = {
  version?: string
  extensionId?: string
  /** chrome.management installType: development = unpacked, normal = store. */
  installType?: string
  /** The native-messaging relay Chrome spawned belongs to this extension ID. */
  native?: boolean
}

type BinaryMismatch = {
  browser: string
  manifestPath: string
  runningPath: string
}

type ContextProbe = {
  contextId: string
  kind: "extension" | "ios" | "cdp"
  extension: { reachable: boolean; reason?: string } & ContextIdentity
  tab: { id: number; url: string; title: string } | null
  elements: number | null
}

/**
 * Issue #241: a pkg install replaces the extension on disk, but a running
 * browser keeps executing the OLD extension snapshot until it is reloaded. The
 * symptom is a CLI that reports one version while the extension behaves like
 * an older one (e.g. asking for a bundle file the build no longer ships). The
 * daemon now records the version each extension registered with; when it
 * differs from this CLI's, say so and name the fix.
 */
export function extensionVersionMismatchLine(
  contextId: string,
  extensionVersion: string | undefined,
  cliVersion: string,
  installType?: string,
): string | null {
  if (!extensionVersion || extensionVersion === cliVersion) return null
  if (isStoreManaged(installType)) {
    // A store copy has only what the Chrome Web Store published; reload asks the
    // store for an update (chrome.runtime.requestUpdateCheck) and cannot go past it.
    return `⚠ extension snapshot ${extensionVersion} ≠ CLI ${cliVersion} — this is the Chrome Web Store copy, so a reload alone cannot change its code; run 'interceptor reload --context ${contextId}' to ask the store for an update (Chrome installs it once the extension is idle), or click Update on chrome://extensions with Developer mode on. If the store has not published ${cliVersion} yet, load the unpacked copy from ${UNPACKED_EXTENSION_DIR} instead.`
  }
  const base = `⚠ extension snapshot ${extensionVersion} ≠ CLI ${cliVersion} — the browser is still running the old extension; run 'interceptor reload --context ${contextId}' and retry.`
  // A copy older than 0.25.0 cannot say which copy it is (that field is new).
  // If it is the unpacked one, the reload loads the store-keyed files: a new
  // extension ID to Chrome, so its storage (context name, tab-group label,
  // lifecycle) starts empty. Say so before the user loses the name.
  if (!installType && isPreStoreVersion(extensionVersion)) {
    return `${base} This copy predates the store identity: an unpacked copy comes back from the reload under the store extension ID with empty settings, so restore its name afterwards with 'interceptor contexts rename ${contextId} --context <new id>'; a Chrome Web Store copy updates when the store publishes ${cliVersion}.`
  }
  return base
}

/** The pre-store development ID still connects (its origin stays allowed through
 *  0.25.x) but it is a second copy next to the store-ID one; name it. */
export function legacyDevelopmentCopyLine(contextId: string, extensionId: string | undefined): string | null {
  if (extensionId !== LEGACY_DEVELOPMENT_EXTENSION_ID) return null
  return `⚠ context ${contextId} is the pre-store development copy (id ${extensionId}); it keeps working through 0.25.x. Remove it on chrome://extensions, then load ${UNPACKED_EXTENSION_DIR} again or install ${STORE_LISTING_URL}, and restore its name with 'interceptor contexts rename ${contextId} --context <new id>'.`
}

/** Text for the CLI's "unknown action type" failure: the connected extension
 *  predates a verb this CLI sends. Copy-specific when the daemon knows the copy. */
export function staleExtensionHintLine(cliVersion: string, ctx?: ContextIdentity & { contextId?: string }): string {
  if (!ctx?.version && !ctx?.installType) {
    return `hint: the browser is running an Interceptor extension older than this CLI (${cliVersion}). Unpacked copy: run 'interceptor reload' (or reload it on chrome://extensions). Chrome Web Store copy: 'interceptor reload' asks the store for an update, which only helps once the store carries ${cliVersion}; until then load the unpacked copy from ${UNPACKED_EXTENSION_DIR}. 'interceptor diagnose' names the connected copy and its version.`
  }
  const label = installTypeLabel(ctx.installType)
  const version = ctx.version ?? "of unknown version"
  const target = ctx.contextId ? ` --context ${ctx.contextId}` : ""
  if (isStoreManaged(ctx.installType)) {
    return `hint: the ${label} extension ${version} is older than this CLI (${cliVersion}); a Chrome Web Store copy only changes when the store publishes a new version. Run 'interceptor reload${target}' to ask the store for an update, or load the unpacked copy from ${UNPACKED_EXTENSION_DIR}.`
  }
  return `hint: the ${label} extension ${version} is older than this CLI (${cliVersion}); run 'interceptor reload${target}' (or reload it on chrome://extensions) and retry.`
}

type ContextListEntry = { contextId: string } & ContextIdentity

async function listContextIdentities(): Promise<ContextListEntry[]> {
  // verbose: true → [{contextId, kind, version, …}] on a current daemon; an
  // older daemon ignores the flag and returns plain ids — accept both.
  const resp = await probeWithTimeout(() => sendCommand({ type: "contexts", verbose: true }))
  const raw = resp?.result.success && Array.isArray(resp.result.data)
    ? (resp.result.data as Array<string | ContextListEntry>)
    : []
  return raw.map(entry => typeof entry === "string" ? { contextId: entry } : entry)
}

/** Resolve the connected copy for the stale-extension hint; falls back to the
 *  generic text when the context cannot be determined. */
export async function staleExtensionHint(cliVersion: string, contextId?: string): Promise<string> {
  const exts = (await listContextIdentities()).filter(c => contextKind(c.contextId) === "extension")
  const ctx = contextId ? exts.find(c => c.contextId === contextId) : (exts.length === 1 ? exts[0] : undefined)
  return staleExtensionHintLine(cliVersion, ctx)
}

// `contexts` returns extension ids plus ios:/cdp: manager contexts. Browser
// probes (tab_list / get_a11y_tree) only make sense against extension
// contexts — an ios:/cdp: id appearing in the list is already proof the
// device/app is connected, and probing it with browser verbs would render a
// misleading "extension not responding".
function contextKind(contextId: string | undefined): ContextProbe["kind"] {
  if (contextId?.startsWith(IOS_CONTEXT_PREFIX)) return "ios"
  if (contextId?.startsWith(CDP_CONTEXT_PREFIX)) return "cdp"
  return "extension"
}

type DiagnoseSnapshot = {
  daemon: { running: boolean; pid: number | null; execPath?: string; version?: string; startedAt?: string }
  binaryMismatches: BinaryMismatch[]
  contexts: ContextProbe[]
  monitor: { active: number; total: number }
}

// Clear the timer in `finally` so it never keeps the process alive after
// fn() resolves — the original race left the timer running until it fired.
async function probeWithTimeout<T>(fn: () => Promise<T>, ms = 2000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timed out")), ms)
      }),
    ])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function readNmhManifestPath(manifestFile: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf-8")) as { path?: string }
    return manifest.path ?? null
  } catch {
    return null
  }
}

export function detectBinaryMismatches(lock: LockFileData | null): BinaryMismatch[] {
  if (!lock?.execPath) return []
  const mismatches: BinaryMismatch[] = []
  for (const { browser, manifestFile } of installedNmhManifests()) {
    const manifestPath = readNmhManifestPath(manifestFile)
    if (manifestPath && manifestPath !== lock.execPath) {
      mismatches.push({ browser, manifestPath, runningPath: lock.execPath })
    }
  }
  return mismatches
}

export async function probeContext(contextId: string | undefined, identity?: ContextIdentity): Promise<ContextProbe> {
  const label = contextId ?? "default"
  const kind = contextKind(contextId)

  if (kind !== "extension") {
    // Presence in the `contexts` list means the manager holds a live
    // registration for this device/app; report it without browser probes.
    return {
      contextId: label,
      kind,
      extension: { reachable: true },
      tab: null,
      elements: null,
    }
  }

  const [tabResp, treeResp] = await Promise.all([
    probeWithTimeout(() => sendCommand({ type: "tab_list" }, undefined, contextId)),
    probeWithTimeout(() =>
      sendCommand({ type: "get_a11y_tree", filter: "interactive", depth: 3, maxChars: 100_000 }, undefined, contextId)
    ),
  ])

  let extension: ContextProbe["extension"] = { reachable: false }
  let tab: ContextProbe["tab"] = null
  let elements: number | null = null

  if (tabResp?.result.success) {
    const tabs = tabResp.result.data as
      | Array<{ id: number; url: string; title: string; active: boolean }>
      | undefined
    if (Array.isArray(tabs) && tabs.length > 0) {
      const active = tabs.find(t => t.active) ?? tabs[0]
      tab = { id: active.id, url: active.url, title: active.title }
      extension = { reachable: true }
    } else {
      extension = { reachable: false, reason: "no tabs in interceptor group — run 'interceptor open <url>'" }
    }
  } else {
    extension = { reachable: false, reason: tabResp?.result.error || "extension not responding" }
  }

  if (treeResp?.result.success && typeof treeResp.result.data === "string") {
    elements = (treeResp.result.data.match(/\be\d+\b/g) ?? []).length
  }

  if (identity?.version) extension.version = identity.version
  if (identity?.extensionId) extension.extensionId = identity.extensionId
  if (identity?.installType) extension.installType = identity.installType
  if (identity?.native) extension.native = true
  return { contextId: label, kind, extension, tab, elements }
}

export async function runDiagnoseCommand(jsonMode: boolean, contextId?: string): Promise<void> {
  const status = readStatusSnapshot()
  const lock = readLockFile(LOCK_PATH)

  const snap: DiagnoseSnapshot = {
    daemon: {
      running: status.daemon,
      pid: status.pid,
      ...(lock ? { execPath: lock.execPath, version: lock.version, startedAt: lock.startedAt } : {}),
    },
    binaryMismatches: detectBinaryMismatches(lock),
    contexts: [],
    monitor: { active: 0, total: 0 },
  }

  if (status.daemon) {
    const contexts = await listContextIdentities()
    const identityOf = (id: string | undefined): ContextIdentity | undefined => {
      const c = contexts.find(entry => entry.contextId === id)
      return c ? { version: c.version, extensionId: c.extensionId, installType: c.installType, native: c.native } : undefined
    }

    if (contextId) {
      snap.contexts = [await probeContext(contextId, identityOf(contextId))]
    } else {
      snap.contexts = await Promise.all(
        contexts.length > 0
          ? contexts.map(c => probeContext(c.contextId, identityOf(c.contextId)))
          : [probeContext(undefined)]
      )
    }
  }

  try {
    const sessions = listSessions()
    snap.monitor = {
      active: sessions.filter(s => s.status === "active").length,
      total: sessions.length,
    }
  } catch {
    // monitor artifacts absent or unreadable; leave defaults
  }

  if (jsonMode) {
    console.log(JSON.stringify(snap, null, 2))
    return
  }

  const lines: string[] = []

  // Daemon block — include binary path when lock file is present
  if (status.daemon) {
    const daemonDetail = lock?.execPath
      ? `running  (pid ${status.pid}, ${lock.execPath})`
      : `running  (pid ${status.pid})`
    lines.push(`daemon:    ${daemonDetail}`)
  } else {
    lines.push("daemon:    not running  — open Chrome with the Interceptor extension, then run 'interceptor init'")
  }

  // Binary mismatch warning — the root cause of "no extensions connected" when
  // Chrome is open. Surface it immediately after the daemon line so it's impossible to miss.
  for (const m of snap.binaryMismatches) {
    lines.push(`⚠ binary mismatch (${m.browser}):`)
    lines.push(`    socket daemon: ${m.runningPath}`)
    lines.push(`    NMH manifest:  ${m.manifestPath}`)
    lines.push(`    Chrome will spawn the manifest binary; CLI talks to the socket binary.`)
    lines.push(`    Fix: run 'interceptor init' or update the NMH manifest to match.`)
  }

  if (status.daemon) {
    const multiCtx = snap.contexts.length > 1 || snap.contexts[0]?.contextId !== "default"

    for (const ctx of snap.contexts) {
      if (multiCtx) lines.push(`context ${ctx.contextId}:`)
      const indent = multiCtx ? "  " : ""

      if (ctx.kind !== "extension") {
        lines.push(`${indent}${ctx.kind === "ios" ? "ios device" : "cdp app"}: connected`)
        continue
      }

      const ext = ctx.extension
      // "(extension 0.24.2)" for a copy that did not say what it is; otherwise
      // "(store extension 0.25.0 via ws + native)" so the copy and its
      // transports are visible at a glance.
      const copy = ext.installType ? `${installTypeLabel(ext.installType)} extension` : "extension"
      const transport = ext.installType || ext.extensionId ? (ext.native ? " via ws + native" : " via ws") : ""
      lines.push(
        `${indent}extension: ${
          ext.reachable
            ? "connected"
            : `disconnected${ext.reason ? `  (${ext.reason})` : ""}`
        }${ext.version ? `  (${copy} ${ext.version}${transport})` : ""}`
      )
      const mismatch = extensionVersionMismatchLine(ctx.contextId, ext.version, VERSION, ext.installType)
      if (mismatch) lines.push(`${indent}${mismatch}`)
      const legacy = legacyDevelopmentCopyLine(ctx.contextId, ext.extensionId)
      if (legacy) lines.push(`${indent}${legacy}`)

      if (ctx.tab) {
        const { id, url, title } = ctx.tab
        lines.push(`${indent}tab ${id}:     ${url}  "${title}"`)
      } else {
        lines.push(`${indent}tab:       no active interceptor-group tab`)
      }

      if (ctx.elements !== null) {
        lines.push(`${indent}elements:  ${ctx.elements} interactive`)
      }
    }
  }

  lines.push(
    `monitor:   ${
      snap.monitor.active > 0
        ? `${snap.monitor.active} active  (${snap.monitor.total} total)`
        : snap.monitor.total > 0
        ? `none active  (${snap.monitor.total} stopped)`
        : "no sessions"
    }`
  )

  console.log(lines.join("\n"))
}
