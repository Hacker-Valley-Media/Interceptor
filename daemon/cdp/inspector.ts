/**
 * daemon/cdp/inspector.ts — Path 0 bootstrap: load the Interceptor MV2 extension
 * into a RUNNING Electron app via its main-process Node/V8 inspector.
 *
 * Flow (verified against the Electron source):
 *   1. SIGUSR1 the main pid → starts the inspector at runtime, gated by the
 *      `nodeCliInspect` fuse, default ON (shell/common/node_bindings.cc:866-870;
 *      docs/tutorial/fuses.md:63-71). If the fuse is off, no inspector appears.
 *   2. Poll http://127.0.0.1:<inspectPort>/json for the webSocketDebuggerUrl.
 *   3. Connect; Runtime.evaluate, in the main-process context:
 *        session.defaultSession.extensions.loadExtension(path)
 *      (docs/api/session.md — ses.extensions.loadExtension; deprecated alias
 *      ses.loadExtension). Persistent session required; OTR is rejected.
 *   4. Disconnect. The inspector is never used again for this app.
 *
 * The one fragile element is obtaining `require` inside the inspector's global
 * eval context; several strategies are attempted and a precise error is returned
 * (triggering the Path A fallback) if none work. This is the element flagged as
 * needing live validation.
 */

import { captureSubprocessSync as spawnSync } from "../../shared/subprocess-sync"
import { captureSubprocess } from "../subprocess"
import { CdpConnection } from "./connection"
import { pollForEndpoint } from "./discovery"
import { DEFAULT_NODE_INSPECT_PORT } from "../../shared/cdp-app"

/** The listener PID, undefined only when free. Unknown ownership refuses use. */
export async function inspectPortHolder(port: number): Promise<{ pid: number; name: string } | undefined> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("debug port must be an integer 1..65535")
  if (process.platform === "win32") {
    const r = await captureSubprocess(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference='Stop'; @(Get-NetTCPConnection -State Listen | Where-Object LocalPort -EQ ${port} | Select-Object -ExpandProperty OwningProcess -Unique) | ConvertTo-Json -Compress`],
      { timeoutMs: 20_000 })
    if (r.code !== 0) throw new Error("Windows debug-port ownership could not be established")
    const parsed = r.stdout.trim() ? JSON.parse(r.stdout) : []
    const pids = [...new Set(Array.isArray(parsed) ? parsed : [parsed])]
    if (!pids.length) return undefined
    if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] < 1) return { pid: 0, name: "unresolved port owner" }
    return { pid: pids[0], name: `pid-${pids[0]}` }
  }
  if (process.platform === "linux") {
    const r = spawnSync("ss", ["-H", "-ltnp", `sport = :${port}`], { encoding: "utf-8", timeout: 2000, maxBuffer: 65536 })
    if (r.error || r.status !== 0) throw new Error("Linux debug-port ownership requires a successful ss inspection")
    if (!r.stdout.trim()) return undefined
    const pids = [...new Set([...r.stdout.matchAll(/pid=(\d+)/g)].map(m => Number(m[1])))]
    return pids.length === 1 ? { pid: pids[0], name: `pid-${pids[0]}` } : { pid: 0, name: "unresolved port owner" }
  }
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf-8", timeout: 2000, maxBuffer: 65536 })
  if (r.error || (r.status !== 0 && r.status !== 1)) throw new Error("debug-port ownership could not be established")
  const pids = [...new Set(r.stdout.trim().split(/\s+/).filter(Boolean).map(Number))]
  if (r.status === 0 && !pids.length) throw new Error("debug-port ownership returned no identity; no signal may be sent")
  if (!pids.length) return undefined
  if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] < 1) return { pid: 0, name: "unresolved port owner" }
  const pid = pids[0]
  const name = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf-8", timeout: 2000, maxBuffer: 65536 }).stdout?.trim().split("/").pop() || "unknown"
  return { pid, name }
}

export type BootstrapResult = {
  success: boolean
  extensionId?: string
  extensionName?: string
  error?: string
  /** True when SIGUSR1 produced no inspector — almost always the fuse is off. */
  fuseLikelyOff?: boolean
  /** True when loadExtension was rejected for an off-the-record / temporary session. */
  otrSession?: boolean
  /** True when another process holds the inspector port; nothing was signaled. */
  portBusy?: boolean
}

function buildLoadExtensionExpression(extPath: string): string {
  const pathLit = JSON.stringify(extPath)
  // Runs in the Electron MAIN process. Tries multiple ways to obtain `require`
  // because the inspector's global eval context does not always expose the
  // module-scoped `require`.
  return `(async () => {
    function getRequire() {
      try { if (typeof require === 'function') return require } catch (e) {}
      try { if (typeof process !== 'undefined' && process.mainModule && typeof process.mainModule.require === 'function') return process.mainModule.require.bind(process.mainModule) } catch (e) {}
      try { if (typeof globalThis !== 'undefined' && typeof globalThis.require === 'function') return globalThis.require } catch (e) {}
      try { const Module = process.binding('module_wrap'); if (Module) {} } catch (e) {}
      try { return require('module').createRequire(process.execPath) } catch (e) {}
      return null;
    }
    try {
      const req = getRequire();
      if (!req) return { ok: false, error: 'no-require', detail: 'could not obtain require in main-process inspector context' };
      const electron = req('electron');
      if (!electron) return { ok: false, error: 'no-electron' };
      const ses = electron.session && electron.session.defaultSession;
      if (!ses) return { ok: false, error: 'no-default-session' };
      if (typeof ses.isPersistent === 'function' && ses.isPersistent() === false) {
        return { ok: false, error: 'otr-session' };
      }
      const loader = (ses.extensions && typeof ses.extensions.loadExtension === 'function') ? ses.extensions : ses;
      const ext = await loader.loadExtension(${pathLit}, { allowFileAccess: true });
      return { ok: true, id: ext && ext.id, name: ext && ext.name };
    } catch (e) {
      var msg = (e && e.message) ? e.message : String(e);
      if (/temporary session|off the record|cannot be loaded in a temporary/i.test(msg)) {
        return { ok: false, error: 'otr-session', detail: msg };
      }
      return { ok: false, error: 'load-failed', detail: msg };
    }
  })()`
}

/**
 * SIGUSR1 the pid and load the extension via the inspector. Does not require the
 * Swift bridge — the daemon sends the signal itself (process.kill) and dials the
 * inspector over loopback.
 */
export async function bootstrapLoadExtension(opts: {
  pid: number
  extPath: string
  host?: string
  inspectPort?: number
  signalTimeoutMs?: number
}): Promise<BootstrapResult> {
  const host = opts.host ?? "127.0.0.1"
  const inspectPort = opts.inspectPort ?? DEFAULT_NODE_INSPECT_PORT

  // 1. Send SIGUSR1 to start the inspector — unless another process already
  // holds the port: the app's inspector cannot bind it, and the poll below would
  // answer for that process (seen with a Chromium browser on 9229).
  const holder = await inspectPortHolder(inspectPort)
  if (holder && holder.pid !== opts.pid) {
    return {
      success: false,
      portBusy: true,
      error: `inspector port ${inspectPort} is held by ${holder.name} (pid ${holder.pid}), so the app's inspector cannot start there; SIGUSR1 was not sent. ` +
        `Relaunch the app with its inspector on a free port (open -g -a "<App>" --args --inspect=<port>) and pass --inspect-port <port>, or free port ${inspectPort}.`,
    }
  }
  if (!holder) {
    if (process.platform === "win32") {
      return { success: false, error: "Windows inspector attach requires the selected app to have been launched with --inspect; no signal was sent" }
    }
    try {
      process.kill(opts.pid, "SIGUSR1")
    } catch (err) {
      return { success: false, error: `failed to signal pid ${opts.pid}: ${(err as Error).message}` }
    }
  }

  // 2. Wait for the inspector endpoint.
  const endpoint = await pollForEndpoint(host, inspectPort, { timeoutMs: opts.signalTimeoutMs ?? 5000 })
  if (!endpoint) {
    return {
      success: false,
      fuseLikelyOff: true,
      error: `no inspector appeared on ${host}:${inspectPort} after SIGUSR1 — the app's nodeCliInspect fuse is likely disabled. Falling back to the CDP path.`,
    }
  }

  // 3. Connect and evaluate loadExtension.
  const conn = new CdpConnection(endpoint.wsUrl, { commandTimeoutMs: 15_000 })
  try {
    await conn.connect(5000)
    await conn.send("Runtime.enable").catch(() => {})
    // Require both OS ownership and the inspector's own PID before injection.
    try {
      if ((await inspectPortHolder(inspectPort))?.pid !== opts.pid) return { success: false, error: "inspector port ownership changed before extension load" }
      const probe = await conn.send("Runtime.evaluate", { expression: "process.pid", returnByValue: true })
      const inspectedPid = (probe.result as { value?: unknown } | undefined)?.value
      if (inspectedPid !== opts.pid) {
        return { success: false, error: `inspector on ${host}:${inspectPort} belongs to pid ${inspectedPid}, not target pid ${opts.pid} (port collision) — aborting before loadExtension` }
      }
    } catch { return { success: false, error: "inspector process identity could not be verified; no extension was loaded" } }
    const r = await conn.send("Runtime.evaluate", {
      expression: buildLoadExtensionExpression(opts.extPath),
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    })
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails as { exception?: { description?: string }; text?: string }
      return { success: false, error: `inspector eval threw: ${ex.exception?.description || ex.text || "unknown"}` }
    }
    const value = (r.result as { value?: { ok?: boolean; id?: string; name?: string; error?: string; detail?: string } } | undefined)?.value
    if (!value) return { success: false, error: "inspector eval returned no value" }
    if (value.ok) {
      return { success: true, extensionId: value.id, extensionName: value.name }
    }
    if (value.error === "otr-session") {
      return { success: false, otrSession: true, error: `app uses a non-persistent (off-the-record) session; Path 0 unavailable${value.detail ? ` (${value.detail})` : ""}` }
    }
    if (value.error === "no-require") {
      return { success: false, error: `could not reach the Electron module from the inspector context (${value.detail || "no require"}); falling back to the CDP path` }
    }
    return { success: false, error: `loadExtension failed: ${value.error}${value.detail ? ` — ${value.detail}` : ""}` }
  } catch (err) {
    return { success: false, error: `inspector bootstrap error: ${(err as Error).message}` }
  } finally {
    conn.close()
  }
}
