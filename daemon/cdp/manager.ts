/**
 * daemon/cdp/manager.ts — owns CDP-app contexts and dispatches the cdp_ and app_
 * lifecycle actions. Path A (cdp:) connections live in cdpAppMap; Path 0 (app:) contexts
 * live in the daemon's extensionWsMap (the resident MV2 extension registers as a
 * normal extension), so this manager only bootstraps them and tracks status.
 */

import { spawn, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { CdpConnection } from "./connection"
import { discover, fetchTargets, pollForEndpoint } from "./discovery"
import { captureSubprocess } from "../subprocess"
import { executeCdpAction, mergeHeaderEntries, recordNetworkEvent, type ActionResult, type CdpExecContext, type CdpNetEntry, type HeaderOverrideRule } from "./translate"
import { bootstrapLoadExtension, inspectPortHolder } from "./inspector"
import { callDesktopProvider } from "../desktop-provider"
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

/** Frontmost app via lsappinfo (no TCC grant needed); empty off macOS or on failure. */
function frontmostApp(): { bundleId?: string; pid?: number } {
  if (process.platform !== "darwin") return {}
  const asn = spawnSync("lsappinfo", ["front"], { encoding: "utf-8" }).stdout?.trim()
  if (!asn) return {}
  const read = (key: string): string => spawnSync("lsappinfo", ["info", "-only", key, asn], { encoding: "utf-8" }).stdout ?? ""
  const pid = Number(read("pid").match(/"pid"\s*=\s*(\d+)/)?.[1])
  return { bundleId: read("bundleid").match(/"CFBundleIdentifier"="([^"]+)"/)?.[1], pid: Number.isFinite(pid) ? pid : undefined }
}

export {CDP_ACTION_TYPES} from "../../shared/cdp-app"

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
  executable?: string
  identity?: string
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
  dropExtensionContext: (contextId: string) => void
  mv2ExtensionDir: () => string
}

export class CdpManager {
  private contexts = new Map<string, CdpAppContext>()
  private appBindings = new Map<string, ElectronProcess>()
  private detachedApps = new Set<string>()
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

  acceptsAppRegistration(contextId: string): boolean {
    return !this.detachedApps.has(contextId)
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
    if (!ctx) return { success: false, code: "target_gone", error: `cdp context '${contextId}' not found (run 'interceptor macos cdp connect' or 'interceptor macos cdp status')` }
    if (!ctx.conn.isOpen) return { success: false, code: "target_gone", error: `cdp context '${contextId}' is disconnected` }
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
    try {
    switch (action.type) {
      case "cdp_connect": return await this.cdpConnect(action)
      case "cdp_targets": return await this.cdpTargets(action)
      case "cdp_attach": return await this.cdpAttach(action)
      case "cdp_detach": return await this.cdpDetach(action)
      case "cdp_status": return await this.cdpStatus()
      case "cdp_raw": return await this.cdpRaw(action)
      case "cdp_discover":
      case "app_discover": return await this.discoverApps()
      case "cdp_launch":
      case "app_launch": return await this.launchWithFlag(action)
      case "app_attach": return await this.appAttach(action)
      case "app_detach": return await this.appDetach(action)
      case "app_status": return await this.appStatus()
      default: return { success: false, error: `unknown cdp/app action: ${action.type}` }
    }
    } catch (error) { return { success: false, error: `CDP target identity or endpoint inspection failed (${error instanceof Error ? error.message.slice(0, 300) : "unknown"}); no fallback signal or replay was performed` } }
  }

  // ── Path A: direct CDP ──────────────────────────────────────────────────────

  private async cdpConnect(action: { [k: string]: unknown }): Promise<ActionResult> {
    const host = typeof action.host === "string" ? action.host : "127.0.0.1"
    const port = Number(action.port)
    if (typeof action.port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65535) return { success: false, error: "cdp connect requires an integer port 1..65535" }
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
    if (action.pid !== undefined && (typeof action.pid !== "number" || !Number.isSafeInteger(action.pid) || action.pid < 1 || action.pid > 0xffffffff)) {
      return { success: false, error: "app attach requires an integer pid1..4294967295" }
    }
    if (action.inspectPort !== undefined && (typeof action.inspectPort !== "number" || !Number.isSafeInteger(action.inspectPort) || action.inspectPort < 1 || action.inspectPort > 65535)) {
      return { success: false, error: "app attach requires an integer inspector port 1..65535" }
    }
    const procs = await listElectronProcesses()
    // NaN passes `typeof === "number"`, so guard with Number.isFinite.
    let pid = Number.isFinite(action.pid as number) ? (action.pid as number) : undefined
    let appName = typeof action.app === "string" ? action.app : undefined
    let matched: ElectronProcess | undefined

    if (pid === undefined) {
      if (!appName) return { success: false, error: "macos cdp app attach requires an app name or a numeric --pid" }
      const matches = electronAppMatches(procs, appName)
      if (matches.length > 1) return { success: false, error: "Electron app name is ambiguous; select an exact --pid" }
      matched = matches[0]
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
      if (appName && appName.toLowerCase() !== matched.appName.toLowerCase()) return { success: false, error: "app name does not match the selected process" }
      appName = matched.appName
    }
    if (!appName) appName = `pid-${pid}`

    const ctxId = appContextId(appName)

    const current = (await listElectronProcesses()).find(p => p.pid === pid)
    if (!current || current.command !== matched?.command || current.identity !== matched?.identity || current.executable !== matched?.executable) {
      return { success: false, error: "Electron process identity changed before attach; no signal or extension load was sent" }
    }
    const binding = this.appBindings.get(ctxId)
    if (binding && (binding.pid !== pid || binding.command !== current.command || binding.identity !== current.identity || binding.executable !== current.executable)) {
      return { success: false, error: `context '${ctxId}' belongs to another process identity; detach it before selecting a replacement` }
    }
    if (this.deps.hasExtensionContext(ctxId)) {
      if (!binding) return { success: false, error: `context '${ctxId}' has no verified process binding; detach it before attaching` }
      return { success: true, data: { contextId: ctxId, pid, alreadyLoaded: true } }
    }
    if (!binding && this.appBindings.size + this.detachedApps.size >= 128) return { success: false, error: "app context tracking exceeds 128 entries" }

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
    const beforeLoad = (await listElectronProcesses()).find(p => p.pid === pid)
    if (!beforeLoad || beforeLoad.command !== current.command || beforeLoad.identity !== current.identity || beforeLoad.executable !== current.executable) {
      return { success: false, error: "Electron process identity changed before attach; no signal or extension load was sent" }
    }
    this.appBindings.set(ctxId, current)
    this.detachedApps.delete(ctxId)
    const boot = await bootstrapLoadExtension({ pid: pid!, extPath, inspectPort })
    if (!boot.success) {
      this.appBindings.delete(ctxId)
      this.detachedApps.add(ctxId)
      this.deps.dropExtensionContext(ctxId)
      this.deps.emit("app_attach_failed", { app: appName, pid, error: boot.error, fuseLikelyOff: boot.fuseLikelyOff, otrSession: boot.otrSession, portBusy: boot.portBusy })
      return {
        success: false,
        error: boot.error,
        data: { fuseLikelyOff: boot.fuseLikelyOff === true, otrSession: boot.otrSession === true, portBusy: boot.portBusy === true, fallback: "cdp" },
      }
    }

    // Wait for the resident extension to connect back over WebSocket.
    const registered = await this.waitForExtensionContext(ctxId, 8000)
    this.deps.emit("app_attached", { app: appName, pid, contextId: ctxId, extensionId: boot.extensionId, registered })
    return {
      success: registered,
      error: registered ? undefined : "extension loaded but daemon registration was not observed; inspect before retrying",
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
    if (!contextId.startsWith("app:")) return { success: false, error: "app detach requires an app: context" }
    if (!this.detachedApps.has(contextId) && this.detachedApps.size + this.appBindings.size >= 128 && !this.appBindings.has(contextId)) return { success: false, error: "app context tracking exceeds 128 entries" }
    // The extension remains in the app, but routing and reconnects stay disabled
    // until an explicit attach reestablishes its process binding.
    this.detachedApps.add(contextId)
    this.appBindings.delete(contextId)
    this.deps.dropExtensionContext(contextId)
    this.deps.emit("app_detached", { contextId })
    return { success: true, data: { contextId, detached: true, note: "daemon routing is disabled; extension remains resident until the app restarts" } }
  }

  private async appStatus(): Promise<ActionResult> {
    const procs = await listElectronProcesses()
    const data = procs.map(p => {
      const ctxId = appContextId(p.appName)
      const binding = this.appBindings.get(ctxId)
      return {
        app: p.appName,
        pid: p.pid,
        contextId: ctxId,
        attached: this.deps.hasExtensionContext(ctxId) && binding?.pid === p.pid && binding.command === p.command && binding.identity === p.identity && binding.executable === p.executable,
        remoteDebuggingPort: p.remoteDebuggingPort,
        inspectPort: p.inspectPort,
      }
    })
    return { success: true, data }
  }

  // ── Discovery / launch ──────────────────────────────────────────────────────

  private async discoverApps(): Promise<ActionResult> {
    const procs = await listElectronProcesses()
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

  private async launchNativeWithFlag(action: { [k: string]: unknown }): Promise<ActionResult> {
    const app = typeof action.app === "string" ? action.app : ""
    const port = action.port === undefined ? 9222 : action.port
    const inspectPort = action.inspectPort
    if (!app || typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
        inspectPort !== undefined && (typeof inspectPort !== "number" || !Number.isSafeInteger(inspectPort) || inspectPort < 1 || inspectPort > 65535 || inspectPort === port)) {
      return { success: false, error: "launch requires an exact app name and distinct integer ports1..65535" }
    }
    const matches = (await listElectronProcesses()).filter(p => p.appName.toLowerCase() === app.toLowerCase())
    if (matches.length !== 1 || !matches[0].executable || !matches[0].identity) {
      return { success: false, error: "launch requires exactly one confirmed Electron app in the current native login" }
    }
    const target = matches[0]
    // Resolve and stat the file to relaunch before anything is quit: an AppImage's
    // executable lives on a /tmp/.mount_* path that vanishes when the app exits.
    const launchPath = relaunchPath(target)
    const executableBefore = statSync(launchPath)
    for (const value of [port, inspectPort].filter((p): p is number => typeof p === "number")) {
      const holder = await inspectPortHolder(value)
      if (holder && holder.pid !== target.pid) return { success: false, error: `debug port ${value} belongs to another or unresolved process; nothing was quit` }
    }
    const current = (await listElectronProcesses()).find(p => p.pid === target.pid)
    if (!current || current.identity !== target.identity || current.executable !== target.executable) {
      return { success: false, error: "Electron process identity changed before relaunch; nothing was quit" }
    }
    const before = await callDesktopProvider({ type: "desktop_frontmost" })
    const stopped = await callDesktopProvider({ type: "desktop_app", subcommand: "quit", pid: target.pid })
    if (!stopped.success) return stopped
    const deadline = Date.now() + 10_000
    let exited = false
    while (Date.now() < deadline) {
      try { process.kill(target.pid, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("app shutdown could not be verified; no replacement was launched")
        exited = true; break
      }
      await Bun.sleep(100)
    }
    if (!exited) return { success: false, error: "selected app has not exited; no replacement was launched or forced termination attempted" }
    for (const value of [port, inspectPort].filter((p): p is number => typeof p === "number")) {
      if (await inspectPortHolder(value)) return { success: false, error: "debug port was occupied during shutdown; the app was quit but no replacement was launched" }
    }
    const args = [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"]
    if (inspectPort !== undefined) args.push(`--inspect=127.0.0.1:${inspectPort}`)
    const executableNow = statSync(launchPath)
    if (["dev", "ino", "size", "mtimeMs"].some(key => executableBefore[key as keyof typeof executableBefore] !== executableNow[key as keyof typeof executableNow])) {
      return { success: false, error: "app executable changed during shutdown; no replacement was launched" }
    }
    const child = spawn(launchPath, args, { cwd: dirname(launchPath), detached: true, stdio: "ignore", windowsHide: true })
    const pid = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("spawn", () => resolve(child.pid!)) })
    child.unref()
    const endpoint = await pollForEndpoint("127.0.0.1", port, { timeoutMs: 15_000, intervalMs: 250 })
    if (!endpoint || (await inspectPortHolder(port))?.pid !== pid) {
      return { success: false, error: "replacement launched but its exact CDP port owner could not be verified; observe before retrying", data: { pid, app, port } }
    }
    const replacement = (await listElectronProcesses()).find(p => p.pid === pid)
    if (!replacement?.executable || relaunchPath(replacement) !== launchPath || !replacement.identity) {
      return { success: false, error: "replacement native-login identity could not be verified; observe before retrying", data: { pid, app, port } }
    }
    let restoredFrontmost = false
    const originalPid = before.success && before.data && typeof before.data === "object" ? (before.data as { pid?: number }).pid : undefined
    if (originalPid && originalPid !== target.pid) {
      for (let i = 0; i < 20; i++) {
        const now = await callDesktopProvider({ type: "desktop_frontmost" })
        if (now.success && now.data && typeof now.data === "object" && (now.data as { pid?: number }).pid === pid) {
          restoredFrontmost = (await callDesktopProvider({ type: "desktop_app", subcommand: "activate", pid: originalPid })).success
          break
        }
        await Bun.sleep(250)
      }
    }
    this.deps.emit("app_relaunched", { app, pid, port })
    return { success: true, data: { app, pid, port, inspectPort, restoredFrontmost, host: process.platform,
      note: "Native login and executable were verified; the app may raise its own window during launch." } }
  }

  private async launchWithFlag(action: { [k: string]: unknown }): Promise<ActionResult> {
    if (action.confirm !== true) return { success: false, error: "CDP relaunch requires explicit confirmation" }
    if (process.platform !== "darwin") {
      return this.launchNativeWithFlag(action)
    }
    const app = typeof action.app === "string" ? action.app : undefined
    if (!app) return { success: false, error: "launch requires an app name" }
    const port = typeof action.port === "number" ? action.port : 9222
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return { success: false, error: "debug port must be an integer 1..65535" }
    const inspectPort = action.inspectPort
    if (inspectPort !== undefined && (typeof inspectPort !== "number" || !Number.isSafeInteger(inspectPort) || inspectPort < 1 || inspectPort > 65535 || inspectPort === port)) {
      return { success: false, error: "inspector port requires a distinct integer 1..65535" }
    }
    if (inspectPort !== undefined) {
      const holder = await inspectPortHolder(inspectPort)
      const target = (await listElectronProcesses()).find(p => p.appName === app && p.pid === holder?.pid)
      if (holder && !target) return { success: false, error: "inspector port belongs to another or unresolved process; nothing was quit" }
    }
    // Quit, then WAIT for the app to fully exit before relaunching — otherwise
    // `open --args` reactivates the still-running instance and drops the flag.
    const appForAppleScript = app.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    const runningPids = (): number[] =>
      pidsRunningFromBundle(spawnSync("ps", ["-axww", "-o", "pid=,comm="], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 }).stdout ?? "", app)
    const waitForExit = async (attempts: number): Promise<number[]> => {
      let pids: number[] = []
      for (let i = 0; i < attempts; i++) {
        pids = runningPids()
        if (pids.length === 0) return []
        await Bun.sleep(250)
      }
      return pids
    }
    // Refuse when another process already serves CDP on the port: the poll
    // after the relaunch would answer for that process and report the app as
    // wired while it never bound the port (seen with two Electron apps from one
    // vendor that share the default port).
    if (await pollForEndpoint("127.0.0.1", port, { timeoutMs: 300, intervalMs: 150 })) {
      const holders = (await listElectronProcesses()).filter(p => p.remoteDebuggingPort === port)
      const other = holders.find(p => p.appName !== app)
      if (other || holders.length === 0) {
        return {
          success: false,
          error: `port ${port} already serves CDP${other ? ` for ${other.appName} (pid ${other.pid})` : ""}; pass --port <free port> to relaunch ${app}`,
        }
      }
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
    // -g: relaunch behind the user's windows; a CDP relaunch is plumbing, not a
    // request to look at the app (background-first contract). Electron
    // apps often activate themselves on ready regardless, so the app that was frontmost before is put back
    // once the endpoint is up. lsappinfo needs no TCC grant.
    const frontmostBefore = frontmostApp().bundleId
    const launchArgs = ["-g", "-a", app, "--args", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"]
    if (inspectPort !== undefined) launchArgs.push(`--inspect=127.0.0.1:${inspectPort}`)
    const res = spawnSync("open", launchArgs, { encoding: "utf-8" })
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
    // The debug endpoint is up before the app's window shows, and the
    // self-activation comes with the window (verified live: the check right
    // after the endpoint still saw the old frontmost, then the app took over).
    // Watch for up to 5 s and put the previous app back the moment the
    // relaunched app (one of its pids) is what took the front; a user switching
    // to some third app in that window is left alone.
    let restoredFrontmost = false
    if (frontmostBefore) {
      for (let i = 0; i < 20; i++) {
        const now = frontmostApp()
        if (now.bundleId && now.bundleId !== frontmostBefore && now.pid !== undefined && runningPids().includes(now.pid)) {
          spawnSync("open", ["-b", frontmostBefore], { stdio: "ignore" })
          restoredFrontmost = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    this.deps.emit("app_relaunched", { app, port })
    return {
      success: true,
      data: {
        app, port, inspectPort,
        frontmostBefore: frontmostBefore ?? null,
        restoredFrontmost,
        note: `relaunched with --remote-debugging-port=${port}; run 'interceptor macos cdp connect ${port}' to attach`
      }
    }
  }

  private requireCtx(action: { [k: string]: unknown }): CdpAppContext | { error: string; code: string; success: false } {
    const contextId = typeof action.contextId === "string" ? action.contextId : undefined
    if (!contextId) {
      const all = [...this.contexts.keys()]
      if (all.length === 1) return this.contexts.get(all[0])!
      return { success: false, code: all.length === 0 ? "target_gone" : "target_ambiguous", error: all.length === 0 ? "no cdp contexts connected" : `multiple cdp contexts, use --context (connected: ${all.join(", ")})` }
    }
    const ctx = this.contexts.get(contextId)
    if (!ctx) return { success: false, code: "target_gone", error: `cdp context '${contextId}' not found` }
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

/**
 * Pids whose EXECUTABLE lives in `<app>.app/Contents/MacOS/`, from `ps -o pid=,comm=`
 * output. Matching the full command line instead (pgrep -f) also hit every shell,
 * editor, or script that merely mentioned the path, and the relaunch then killed them.
 */
export function pidsRunningFromBundle(psOutput: string, app: string): number[] {
  const marker = `/${app}.app/Contents/MacOS/`
  const pids: number[] = []
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m && m[2].includes(marker)) pids.push(parseInt(m[1], 10))
  }
  return pids
}

/** A unique exact (case-insensitive) app name wins ("Notion" beside "Notion Calendar"); otherwise every substring match. */
export function electronAppMatches(procs: ElectronProcess[], name: string): ElectronProcess[] {
  const wanted = name.toLowerCase()
  const exact = procs.filter(p => p.appName.toLowerCase() === wanted)
  return exact.length === 1 ? exact : procs.filter(p => p.appName.toLowerCase().includes(wanted))
}

/**
 * The file that relaunches an Electron process: its executable, or on Linux the AppImage
 * that mounted it (APPIMAGE/APPDIR in the process environment), since the mount ends with the app.
 */
export function relaunchPath(proc: Pick<ElectronProcess, "pid" | "executable">, environ?: string): string {
  const executable = proc.executable!
  if (process.platform !== "linux" && environ === undefined) return executable
  let env: string
  try { env = environ ?? readFileSync(`/proc/${proc.pid}/environ`, "utf8") } catch { return executable }
  const value = (key: string) => env.split("\0").find(entry => entry.startsWith(key + "="))?.slice(key.length + 1)
  const image = value("APPIMAGE"), dir = value("APPDIR")
  return image && dir && image.startsWith("/") && executable.startsWith(dir.replace(/\/+$/, "") + "/") ? image : executable
}

/** Enumerate running Electron MAIN processes via `ps`, parsing their command lines. */
export async function listElectronProcesses(): Promise<ElectronProcess[]> {
  if (process.platform === "win32" || process.platform === "linux") {
    const approved = await callDesktopProvider({ type: "desktop_apps" })
    if (!approved.success || !Array.isArray(approved.data)) throw new Error("authenticated native app inventory is unavailable")
    const apps = new Map<number, string>()
    for (const row of approved.data as { pid?: number; name?: string }[]) {
      if (Number.isSafeInteger(row.pid) && row.pid! > 0 && typeof row.name === "string") apps.set(row.pid!, row.name)
    }
    if (apps.size > 1024) throw new Error("native app inventory exceeds 1024 processes")
    let windowsRows: { ProcessId?: number; ExecutablePath?: string; CommandLine?: string; Identity?: string }[] = []
    if (process.platform === "win32" && apps.size) {
      const r = await captureSubprocess(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter '${[...apps.keys()].map(pid => `ProcessId=${pid}`).join(" OR ")}' | Where-Object {$_.ExecutablePath -and $_.CommandLine} | Select-Object ProcessId,ExecutablePath,CommandLine,@{n='Identity';e={$_.CreationDate.ToUniversalTime().Ticks.ToString()}}) | ConvertTo-Json -Compress`],
        { timeoutMs: 20_000 }) // start plus CIM can pass 5 s on a busy host
      if (r.code !== 0) throw new Error(`Windows process metadata is unavailable (exit ${r.code}: ${r.stderr.trim().slice(0, 200)})`)
      const value: unknown = r.stdout.trim() ? JSON.parse(r.stdout) : []
      windowsRows = Array.isArray(value) ? value : [value as typeof windowsRows[number]]
    }
    const out: ElectronProcess[] = []
    for (const [pid, name] of apps) {
      try {
        let executable: string, command: string, identity: string
        if (process.platform === "win32") {
          const row = windowsRows.find(p => p.ProcessId === pid)
          if (!row?.ExecutablePath || !row.CommandLine || !row.Identity || /(?:^|\s)--type=/.test(row.CommandLine)) continue
          executable = row.ExecutablePath; command = row.CommandLine; identity = row.Identity
        } else {
          const proc = `/proc/${pid}`
          if (statSync(proc).uid !== process.getuid!()) continue
          const before = readFileSync(`${proc}/stat`, "utf8")
          executable = readlinkSync(`${proc}/exe`)
          const argv = readFileSync(`${proc}/cmdline`, "utf8").split("\0").filter(Boolean)
          if (argv.slice(1).some(arg => arg.startsWith("--type="))) continue
          command = argv.map(arg => JSON.stringify(arg)).join(" ")
          identity = before.slice(before.lastIndexOf(")") + 2).split(" ")[19]
          const after = readFileSync(`${proc}/stat`, "utf8")
          if (!identity || identity !== after.slice(after.lastIndexOf(")") + 2).split(" ")[19]) continue
        }
        const folder = dirname(executable)
        const resources = join(folder, "resources")
        // Packaged Electron supplies both Chromium data and its app archive or
        // unpacked package. A Chromium-looking argument alone never earns a signal.
        if (/^(?:chrome|chromium|msedge|brave|firefox|opera|vivaldi)(?:\.exe)?$/i.test(basename(executable)) ||
            !existsSync(join(folder, "icudtl.dat")) || !existsSync(join(folder, "chrome_100_percent.pak")) ||
            !["app.asar", "default_app.asar", "app/package.json"].some(file => existsSync(join(resources, file)))) continue
        out.push({ pid, appName: name, command, executable, identity,
          remoteDebuggingPort: parseDebugPortFromArgs(command, "remote-debugging-port"), inspectPort: parseDebugPortFromArgs(command, "inspect") })
      } catch { /* A disappearing or inaccessible candidate is not an attach target. */ }
    }
    const stillApproved = await callDesktopProvider({ type: "desktop_apps" })
    if (!stillApproved.success || !Array.isArray(stillApproved.data)) throw new Error("native login changed during process discovery")
    const pids = new Set((stillApproved.data as { pid?: number }[]).map(row => row.pid))
    return out.filter(row => pids.has(row.pid))
  }
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
