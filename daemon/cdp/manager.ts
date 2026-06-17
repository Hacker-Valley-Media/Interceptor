/**
 * daemon/cdp/manager.ts — owns CDP-app contexts and dispatches the cdp_ and app_
 * lifecycle actions. Path A (cdp:) connections live in cdpAppMap; Path 0 (app:) contexts
 * live in the daemon's extensionWsMap (the resident MV2 extension registers as a
 * normal extension), so this manager only bootstraps them and tracks status.
 */

import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CdpConnection } from "./connection"
import { discover, fetchTargets, pollForEndpoint } from "./discovery"
import { executeCdpAction, mergeHeaderEntries, recordNetworkEvent, type ActionResult, type CdpExecContext, type CdpNetEntry, type HeaderOverrideRule } from "./translate"
import { bootstrapLoadExtension } from "./inspector"
import {
  appContextId,
  appSlug,
  cdpContextId,
  DEFAULT_NODE_INSPECT_PORT,
  isElectronMainProcessArgs,
  parseDebugPortFromArgs,
  pickPageTarget,
  type CdpAppDescriptor,
  type CdpTarget,
} from "../../shared/cdp-app"

/**
 * Lifecycle action types handled by the CdpManager. Explicit set (not a prefix
 * match) so it never collides with the extension's `cdp_tree` meta action.
 */
export const CDP_ACTION_TYPES = new Set<string>([
  "cdp_connect", "cdp_targets", "cdp_attach", "cdp_detach", "cdp_status", "cdp_raw",
  "cdp_discover", "cdp_launch",
  "app_attach", "app_detach", "app_status", "app_discover", "app_launch",
])

type CdpAppContext = {
  descriptor: CdpAppDescriptor
  conn: CdpConnection
  targets: CdpTarget[]
  attachedTargetId?: string
  net: { enabled: boolean; entries: CdpNetEntry[] }
  exec: CdpExecContext
}

export type ElectronProcess = {
  pid: number
  appName: string
  command: string
  remoteDebuggingPort?: number
  inspectPort?: number
}

export function existingRemoteDebuggingPortFallback(proc: ElectronProcess, appName = proc.appName): ActionResult | undefined {
  const port = proc.remoteDebuggingPort
  if (typeof port !== "number" || !Number.isFinite(port)) return undefined
  const contextId = cdpContextId(appName)
  return {
    success: false,
    error: `${appName} already exposes a remote debugging port on 127.0.0.1:${port}; refusing Path 0 SIGUSR1 attach. Use direct CDP instead: interceptor macos cdp connect ${port} --app ${JSON.stringify(appName)}`,
    data: {
      fallback: "cdp",
      reason: "existing_remote_debugging_port",
      remoteDebuggingPort: port,
      contextId,
    },
  }
}

type ManagerDeps = {
  emit: (event: string, data?: Record<string, unknown>) => void
  hasExtensionContext: (contextId: string) => boolean
  mv2ExtensionDir: () => string
}

export class CdpManager {
  private contexts = new Map<string, CdpAppContext>()
  private deps: ManagerDeps

  constructor(deps: ManagerDeps) {
    this.deps = deps
  }

  /** Context ids backed by an outbound CDP connection (Path A). */
  contextIds(): string[] {
    return [...this.contexts.keys()]
  }

  hasContext(contextId: string): boolean {
    return this.contexts.has(contextId)
  }

  private prepareAppExtensionDir(sourceDir: string, contextId: string): string {
    const home = process.env.HOME
    if (!home) throw new Error("HOME is not set; cannot prepare Electron app extension")
    const safeName = contextId.replace(/[^a-zA-Z0-9._-]+/g, "-")
    const root = join(home, ".interceptor", "app-extensions")
    const dest = join(root, safeName)
    mkdirSync(root, { recursive: true })
    rmSync(dest, { recursive: true, force: true })
    cpSync(sourceDir, dest, { recursive: true })
    writeFileSync(
      join(dest, "electron-config.js"),
      `globalThis.INTERCEPTOR_APP_CONTEXT_ID = ${JSON.stringify(contextId)};\n`,
      "utf-8",
    )
    return dest
  }

  /** Run a normal verb (eval/read/screenshot/net/click/...) against a cdp: context. */
  async executeVerb(contextId: string, action: { type: string; [k: string]: unknown }): Promise<ActionResult> {
    const ctx = this.contexts.get(contextId)
    if (!ctx) return { success: false, error: `cdp context '${contextId}' not found (run 'interceptor macos cdp connect' or 'interceptor macos cdp status')` }
    if (!ctx.conn.isOpen) return { success: false, error: `cdp context '${contextId}' is disconnected` }
    return executeCdpAction(ctx.exec, action)
  }

  /** Build a per-connection exec context: net capture buffer + Fetch override. */
  private buildContext(conn: CdpConnection): { net: { enabled: boolean; entries: CdpNetEntry[] }; exec: CdpExecContext } {
    const net = { enabled: false, entries: [] as CdpNetEntry[] }
    const override = { rules: [] as HeaderOverrideRule[], enabled: false }
    const exec: CdpExecContext = {
      conn,
      net,
      ensureNetwork: async () => {
        if (!net.enabled) { await conn.send("Network.enable", {}); net.enabled = true }
      },
      setOverrides: async (rules) => {
        override.rules = rules
        if (!override.enabled) {
          await conn.send("Fetch.enable", { patterns: [{ requestStage: "Request" }] })
          override.enabled = true
        }
      },
      clearOverrides: async () => {
        override.rules = []
        if (override.enabled) { await conn.send("Fetch.disable", {}); override.enabled = false }
      },
    }
    conn.onEvent(async (method, params) => {
      recordNetworkEvent(net.entries, method, params)
      if (method === "Fetch.requestPaused") {
        const requestId = typeof params.requestId === "string" ? params.requestId : undefined
        if (!requestId) return
        const request = params.request as { url?: string; headers?: Record<string, string> } | undefined
        try {
          if (override.rules.length && request) {
            const headers = mergeHeaderEntries(request.headers, override.rules, request.url || "")
            await conn.send("Fetch.continueRequest", { requestId, headers })
          } else {
            await conn.send("Fetch.continueRequest", { requestId })
          }
        } catch {
          // A paused request MUST be answered exactly once or the page hangs.
          // Retry a bare continue; if that also fails, fail-open (disable Fetch)
          // so we never leave normal browsing wedged on our interception.
          try {
            await conn.send("Fetch.continueRequest", { requestId })
          } catch {
            try { await conn.send("Fetch.disable", {}) } catch {}
            override.enabled = false
            override.rules = []
          }
        }
      }
    })
    return { net, exec }
  }

  /** Dispatch a cdp_ or app_ lifecycle action. */
  async handle(action: { type: string; [k: string]: unknown }): Promise<ActionResult> {
    switch (action.type) {
      case "cdp_connect": return this.cdpConnect(action)
      case "cdp_targets": return this.cdpTargets(action)
      case "cdp_attach": return this.cdpAttach(action)
      case "cdp_detach": return this.cdpDetach(action)
      case "cdp_status": return this.cdpStatus()
      case "cdp_raw": return this.cdpRaw(action)
      case "cdp_discover":
      case "app_discover": return this.discoverApps()
      case "cdp_launch":
      case "app_launch": return this.launchWithFlag(action)
      case "app_attach": return this.appAttach(action)
      case "app_detach": return this.appDetach(action)
      case "app_status": return this.appStatus()
      default: return { success: false, error: `unknown cdp/app action: ${action.type}` }
    }
  }

  // ── Path A: direct CDP ──────────────────────────────────────────────────────

  private async cdpConnect(action: { [k: string]: unknown }): Promise<ActionResult> {
    const host = typeof action.host === "string" ? action.host : "127.0.0.1"
    const port = Number(action.port)
    if (!Number.isFinite(port) || port <= 0) return { success: false, error: "macos cdp connect requires a numeric port" }
    let discovered
    try {
      discovered = await discover(host, port)
    } catch (err) {
      return { success: false, error: `no CDP endpoint on ${host}:${port}: ${(err as Error).message}` }
    }
    const urlHint = typeof action.urlHint === "string" ? action.urlHint : undefined
    const page = pickPageTarget(discovered.targets, urlHint)
    if (!page) return { success: false, error: `no debuggable page target on ${host}:${port}` }

    const name = typeof action.app === "string" && action.app
      ? action.app
      : deriveNameFromUrl(page.url) || `app-${port}`
    const contextId = cdpContextId(name)

    const conn = new CdpConnection(page.webSocketDebuggerUrl)
    try {
      await conn.connect()
    } catch (err) {
      return { success: false, error: `failed to open CDP target: ${(err as Error).message}` }
    }
    // New connection is live — only now retire any previous one for this context
    // (so a failed reconnect never leaves a zombie disconnected context).
    const existing = this.contexts.get(contextId)
    if (existing) existing.conn.close()
    const { net, exec } = this.buildContext(conn)
    conn.onClose((reason) => {
      this.deps.emit("cdp_disconnected", { contextId, reason })
    })

    const descriptor: CdpAppDescriptor = {
      contextId,
      appSlug: appSlug(name),
      appName: name,
      host,
      port,
      kind: "renderer",
      discoveredVia: action.viaRelaunch === true ? "relaunch" : "manual-port",
    }
    this.contexts.set(contextId, { descriptor, conn, targets: discovered.targets, attachedTargetId: page.targetId, net, exec })
    this.deps.emit("cdp_connected", { contextId, port, target: page.targetId })
    return { success: true, data: { contextId, attached: page.targetId, browser: discovered.version.browser, targets: summarizeTargets(discovered.targets) } }
  }

  private async cdpTargets(action: { [k: string]: unknown }): Promise<ActionResult> {
    const ctx = this.requireCtx(action)
    if ("error" in ctx) return ctx
    try {
      const targets = await fetchTargets(ctx.descriptor.host, ctx.descriptor.port)
      ctx.targets = targets
      return { success: true, data: summarizeTargets(targets) }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  private async cdpAttach(action: { [k: string]: unknown }): Promise<ActionResult> {
    const ctx = this.requireCtx(action)
    if ("error" in ctx) return ctx
    const targetId = typeof action.targetId === "string" ? action.targetId : undefined
    if (!targetId) return { success: false, error: "cdp attach requires a targetId" }
    const targets = await fetchTargets(ctx.descriptor.host, ctx.descriptor.port).catch(() => ctx.targets)
    const target = targets.find(t => t.targetId === targetId)
    if (!target) return { success: false, error: `target '${targetId}' not found` }
    const conn = new CdpConnection(target.webSocketDebuggerUrl)
    try {
      await conn.connect()
    } catch (err) {
      // Keep the previous live connection on failure — no zombie context.
      return { success: false, error: `failed to attach (kept previous target): ${(err as Error).message}` }
    }
    ctx.conn.close() // retire the old connection only after the new one is live
    const { net, exec } = this.buildContext(conn)
    conn.onClose((reason) => this.deps.emit("cdp_disconnected", { contextId: ctx.descriptor.contextId, reason }))
    ctx.conn = conn
    ctx.exec = exec
    ctx.net = net
    ctx.attachedTargetId = targetId
    ctx.targets = targets
    this.deps.emit("cdp_attached", { contextId: ctx.descriptor.contextId, target: targetId })
    return { success: true, data: { contextId: ctx.descriptor.contextId, attached: targetId } }
  }

  private cdpDetach(action: { [k: string]: unknown }): ActionResult {
    const ctx = this.requireCtx(action)
    if ("error" in ctx) return ctx
    ctx.conn.close()
    this.contexts.delete(ctx.descriptor.contextId)
    this.deps.emit("cdp_detached", { contextId: ctx.descriptor.contextId })
    return { success: true, data: { detached: ctx.descriptor.contextId } }
  }

  private cdpStatus(): ActionResult {
    const data = [...this.contexts.values()].map(ctx => ({
      contextId: ctx.descriptor.contextId,
      app: ctx.descriptor.appName,
      host: ctx.descriptor.host,
      port: ctx.descriptor.port,
      connection: ctx.conn.isOpen ? "connected" : "disconnected",
      attached: ctx.attachedTargetId,
      kind: ctx.descriptor.kind,
      via: ctx.descriptor.discoveredVia,
    }))
    return { success: true, data }
  }

  private async cdpRaw(action: { [k: string]: unknown }): Promise<ActionResult> {
    const ctx = this.requireCtx(action)
    if ("error" in ctx) return ctx
    const method = typeof action.method === "string" ? action.method : undefined
    if (!method) return { success: false, error: "cdp raw requires a method" }
    let params: Record<string, unknown> = {}
    if (typeof action.params === "string" && action.params.trim()) {
      try { params = JSON.parse(action.params) } catch { return { success: false, error: "cdp raw params must be valid JSON" } }
    } else if (action.params && typeof action.params === "object") {
      params = action.params as Record<string, unknown>
    }
    try {
      const result = await ctx.conn.send(method, params)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  // ── Path 0: inspector-bootstrap + extension control ─────────────────────────

  private async appAttach(action: { [k: string]: unknown }): Promise<ActionResult> {
    const procs = listElectronProcesses()
    // NaN passes `typeof === "number"`, so guard with Number.isFinite.
    let pid = Number.isFinite(action.pid as number) ? (action.pid as number) : undefined
    let appName = typeof action.app === "string" ? action.app : undefined
    let matched: ElectronProcess | undefined

    if (pid === undefined) {
      if (!appName) return { success: false, error: "macos cdp app attach requires an app name or a numeric --pid" }
      matched = procs.find(p => p.appName.toLowerCase().includes(appName!.toLowerCase()))
      if (!matched) {
        return { success: false, error: `no running Electron app matched '${appName}'. Run 'interceptor macos cdp app discover' to list candidates.` }
      }
      pid = matched.pid
      appName = matched.appName
    } else {
      // Only signal a pid we have confirmed is an Electron main process (listElectronProcesses
      // verifies the bundle ships Electron Framework.framework) — never SIGUSR1 a guess.
      matched = procs.find(p => p.pid === pid)
      if (!matched) {
        return { success: false, error: `pid ${pid} is not a confirmed Electron main process; refusing to signal it. Run 'interceptor macos cdp app discover'.` }
      }
      if (!appName) appName = matched.appName
    }
    if (!appName) appName = `pid-${pid}`

    const ctxId = appContextId(appName)

    // Already loaded? If the extension is already registered, short-circuit.
    if (this.deps.hasExtensionContext(ctxId)) {
      return { success: true, data: { contextId: ctxId, alreadyLoaded: true } }
    }

    if (matched && action.allowSigusr1 !== true) {
      const fallback = existingRemoteDebuggingPortFallback(matched, appName)
      if (fallback) return fallback
    }

    const sourceExtPath = typeof action.extPath === "string" && action.extPath ? action.extPath : this.deps.mv2ExtensionDir()
    // Prefer an inspector port already on the process's command line, then the
    // explicit flag, then the default — and never let NaN through.
    const inspectPort = Number.isFinite(action.inspectPort as number)
      ? (action.inspectPort as number)
      : (matched?.inspectPort ?? DEFAULT_NODE_INSPECT_PORT)

    if (!existsSync(sourceExtPath)) {
      this.deps.emit("app_attach_failed", { app: appName, pid, error: "mv2-extension-missing", extPath: sourceExtPath })
      return {
        success: false,
        error: `Path 0 extension not found at ${sourceExtPath}. This build ships the Path A (direct CDP) surface; use the fallback below.`,
        data: { mv2Missing: true, fallback: "cdp" },
      }
    }

    let extPath: string
    try {
      extPath = this.prepareAppExtensionDir(sourceExtPath, ctxId)
    } catch (err) {
      this.deps.emit("app_attach_failed", { app: appName, pid, error: "mv2-extension-prepare-failed", extPath: sourceExtPath })
      return {
        success: false,
        error: `failed to prepare Path 0 extension for ${ctxId}: ${(err as Error).message}`,
        data: { prepareFailed: true, fallback: "cdp" },
      }
    }

    this.deps.emit("app_attach_begin", { app: appName, pid, contextId: ctxId, extPath })
    const boot = await bootstrapLoadExtension({ pid: pid!, extPath, inspectPort })
    if (!boot.success) {
      this.deps.emit("app_attach_failed", { app: appName, pid, error: boot.error, fuseLikelyOff: boot.fuseLikelyOff, otrSession: boot.otrSession })
      return {
        success: false,
        error: boot.error,
        data: { fuseLikelyOff: boot.fuseLikelyOff === true, otrSession: boot.otrSession === true, fallback: "cdp" },
      }
    }

    // Wait for the resident extension to connect back over WebSocket.
    const registered = await this.waitForExtensionContext(ctxId, 8000)
    this.deps.emit("app_attached", { app: appName, pid, contextId: ctxId, extensionId: boot.extensionId, registered })
    return {
      success: true,
      data: {
        contextId: ctxId,
        extensionId: boot.extensionId,
        registered,
        note: registered ? undefined : "extension loaded but has not registered with the daemon yet; it may take a moment",
      },
    }
  }

  private async waitForExtensionContext(contextId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.deps.hasExtensionContext(contextId)) return true
      await Bun.sleep(200)
    }
    return this.deps.hasExtensionContext(contextId)
  }

  private appDetach(action: { [k: string]: unknown }): ActionResult {
    const contextId = typeof action.contextId === "string" ? action.contextId
      : typeof action.app === "string" ? appContextId(action.app) : undefined
    if (!contextId) return { success: false, error: "macos cdp app detach requires a context id or app name" }
    // The extension stays resident until the app restarts; we drop tracking and
    // emit an event. A future uninstall would re-enter the inspector.
    this.deps.emit("app_detached", { contextId })
    return { success: true, data: { contextId, note: "extension remains resident until the app restarts" } }
  }

  private appStatus(): ActionResult {
    const procs = listElectronProcesses()
    const data = procs.map(p => {
      const ctxId = appContextId(p.appName)
      return {
        app: p.appName,
        pid: p.pid,
        contextId: ctxId,
        attached: this.deps.hasExtensionContext(ctxId),
        remoteDebuggingPort: p.remoteDebuggingPort,
        inspectPort: p.inspectPort,
      }
    })
    return { success: true, data }
  }

  // ── Discovery / launch ──────────────────────────────────────────────────────

  private discoverApps(): ActionResult {
    const procs = listElectronProcesses()
    const data = procs.map(p => ({
      app: p.appName,
      pid: p.pid,
      remoteDebuggingPort: p.remoteDebuggingPort,
      inspectPort: p.inspectPort,
      cdpReady: p.remoteDebuggingPort !== undefined,
      appContext: appContextId(p.appName),
      cdpContext: cdpContextId(p.appName),
    }))
    return { success: true, data }
  }

  private async launchWithFlag(action: { [k: string]: unknown }): Promise<ActionResult> {
    if (process.platform !== "darwin") {
      return { success: false, error: "relaunch-with-flag is implemented for macOS only; on other platforms relaunch the app manually with --remote-debugging-port" }
    }
    const app = typeof action.app === "string" ? action.app : undefined
    if (!app) return { success: false, error: "launch requires an app name" }
    const port = typeof action.port === "number" ? action.port : 9222
    // Quit, then WAIT for the app to fully exit before relaunching — otherwise
    // `open --args` reactivates the still-running instance and drops the flag.
    const appForAppleScript = app.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    const appForRegex = app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const runningPids = (): number[] => {
      const check = spawnSync("pgrep", ["-f", `${appForRegex}.app/Contents/MacOS/`], { encoding: "utf-8" })
      if (check.status !== 0 || !(check.stdout || "").trim()) return []
      return check.stdout
        .split(/\s+/)
        .map(s => parseInt(s, 10))
        .filter(n => Number.isFinite(n))
    }
    const waitForExit = async (attempts: number): Promise<number[]> => {
      let pids: number[] = []
      for (let i = 0; i < attempts; i++) {
        pids = runningPids()
        if (pids.length === 0) return []
        await Bun.sleep(250)
      }
      return pids
    }
    spawnSync("osascript", ["-e", `quit app "${appForAppleScript}"`], { stdio: "ignore" })
    let stillRunning = await waitForExit(24)
    if (stillRunning.length > 0) {
      spawnSync("kill", ["-TERM", ...stillRunning.map(String)], { stdio: "ignore" })
      stillRunning = await waitForExit(16)
    }
    if (stillRunning.length > 0) {
      return {
        success: false,
        error: `failed to quit ${app} before relaunch; still running pid(s): ${stillRunning.join(", ")}`,
      }
    }
    const res = spawnSync("open", ["-a", app, "--args", `--remote-debugging-port=${port}`], { encoding: "utf-8" })
    if (res.status !== 0) {
      return { success: false, error: `failed to relaunch ${app}: ${res.stderr || "open failed"}` }
    }
    const endpoint = await pollForEndpoint("127.0.0.1", port, { timeoutMs: 15_000, intervalMs: 250 })
    if (!endpoint) {
      return {
        success: false,
        error: `relaunched ${app}, but no CDP endpoint appeared on 127.0.0.1:${port}; the app may have dropped or rejected --remote-debugging-port`,
      }
    }
    this.deps.emit("app_relaunched", { app, port })
    return { success: true, data: { app, port, note: `relaunched with --remote-debugging-port=${port}; run 'interceptor macos cdp connect ${port}' to attach` } }
  }

  private requireCtx(action: { [k: string]: unknown }): CdpAppContext | { error: string; success: false } {
    const contextId = typeof action.contextId === "string" ? action.contextId : undefined
    if (!contextId) {
      const all = [...this.contexts.keys()]
      if (all.length === 1) return this.contexts.get(all[0])!
      return { success: false, error: all.length === 0 ? "no cdp contexts connected" : `multiple cdp contexts, use --context (connected: ${all.join(", ")})` }
    }
    const ctx = this.contexts.get(contextId)
    if (!ctx) return { success: false, error: `cdp context '${contextId}' not found` }
    return ctx
  }

  shutdown(): void {
    for (const ctx of this.contexts.values()) ctx.conn.close()
    this.contexts.clear()
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function summarizeTargets(targets: CdpTarget[]): Array<{ targetId: string; type: string; title: string; url: string }> {
  return targets.map(t => ({ targetId: t.targetId, type: t.type, title: t.title, url: t.url }))
}

function deriveNameFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url)
    if (u.hostname) return u.hostname.replace(/^www\./, "")
  } catch {}
  return undefined
}

/** Enumerate running Electron MAIN processes via `ps`, parsing their command lines. */
export function listElectronProcesses(): ElectronProcess[] {
  if (process.platform === "win32") return []
  const res = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 })
  if (res.status !== 0 || !res.stdout) return []
  const out: ElectronProcess[] = []
  for (const line of res.stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = /^(\d+)\s+(.*)$/.exec(trimmed)
    if (!m) continue
    const pid = parseInt(m[1], 10)
    const command = m[2]
    if (!isElectronMainProcessArgs(command)) continue
    // Definitive confirmation: the bundle must ship Electron Framework.framework.
    // This is what gates SIGUSR1 in app_attach — a fuzzy Chromium-switch match
    // must never let us signal (and possibly terminate) a non-Electron browser.
    if (!bundleHasElectronFramework(command)) continue
    out.push({
      pid,
      appName: deriveAppNameFromCommand(command) || `pid-${pid}`,
      command,
      remoteDebuggingPort: parseDebugPortFromArgs(command, "remote-debugging-port"),
      inspectPort: parseDebugPortFromArgs(command, "inspect"),
    })
  }
  return out
}

function deriveAppNameFromCommand(command: string): string | undefined {
  const m = /\/([^/]+)\.app\//.exec(command)
  if (m) return m[1]
  const exe = command.split(/\s+/)[0]
  const base = exe.split("/").pop()
  return base || undefined
}

/** Definitive Electron check: the .app bundle ships "Electron Framework.framework". */
function bundleHasElectronFramework(command: string): boolean {
  const m = /(\/.*?\.app)\/Contents\/MacOS\//.exec(command)
  if (!m) return false
  return existsSync(`${m[1]}/Contents/Frameworks/Electron Framework.framework`)
}
