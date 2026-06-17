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

import { CdpConnection } from "./connection"
import { pollForEndpoint } from "./discovery"
import { DEFAULT_NODE_INSPECT_PORT } from "../../shared/cdp-app"

export type BootstrapResult = {
  success: boolean
  extensionId?: string
  extensionName?: string
  error?: string
  /** True when SIGUSR1 produced no inspector — almost always the fuse is off. */
  fuseLikelyOff?: boolean
  /** True when loadExtension was rejected for an off-the-record / temporary session. */
  otrSession?: boolean
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

  if (process.platform === "win32") {
    return { success: false, error: "SIGUSR1 inspector bootstrap is not available on Windows; use the CDP fallback (macos cdp connect)" }
  }

  // 1. Send SIGUSR1 to start the inspector.
  try {
    process.kill(opts.pid, "SIGUSR1")
  } catch (err) {
    return { success: false, error: `failed to signal pid ${opts.pid}: ${(err as Error).message}` }
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
    // Identity guard: the global inspect port (9229) may be held by a DIFFERENT
    // node/Electron process. Confirm we reached the pid we signaled before we
    // load anything into it.
    try {
      const probe = await conn.send("Runtime.evaluate", { expression: "process.pid", returnByValue: true })
      const inspectedPid = (probe.result as { value?: unknown } | undefined)?.value
      if (typeof inspectedPid === "number" && inspectedPid !== opts.pid) {
        return { success: false, error: `inspector on ${host}:${inspectPort} belongs to pid ${inspectedPid}, not target pid ${opts.pid} (port collision) — aborting before loadExtension` }
      }
    } catch { /* probe is best-effort; proceed if process.pid is unavailable */ }
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
