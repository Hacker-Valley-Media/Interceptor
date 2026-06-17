/**
 * daemon/cdp/discovery.ts — HTTP discovery against a Chromium/Node debug port.
 *
 * `GET /json/version` and `GET /json` (a.k.a. /json/list) are served by the
 * remote-debugging HTTP server on 127.0.0.1:<port> when an Electron app is
 * launched with `--remote-debugging-port`, and by the Node/V8 inspector after
 * SIGUSR1. Each target entry carries a `webSocketDebuggerUrl`.
 *
 * Verified: ~/Downloads/chromium-main/content/browser/devtools/devtools_http_handler.cc
 *   :617-633 (/json/version), :645-655 (/json), :1055-1057 (webSocketDebuggerUrl).
 */

import { parseJsonTargets, type CdpTarget } from "../../shared/cdp-app"

export type CdpVersionInfo = {
  browser?: string
  protocolVersion?: string
  userAgent?: string
  webSocketDebuggerUrl?: string
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // No custom headers — crucially NO Origin header, so the DevTools
    // --remote-allow-origins check (devtools_http_handler.cc:819-832) never
    // rejects us. Bun's fetch does not add an Origin for same-process requests.
    const res = await fetch(url, { signal: controller.signal, redirect: "error" })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchVersion(host: string, port: number, timeoutMs = 2000): Promise<CdpVersionInfo> {
  const body = await getJson(`http://${host}:${port}/json/version`, timeoutMs) as Record<string, unknown>
  return {
    browser: typeof body.Browser === "string" ? body.Browser : undefined,
    protocolVersion: typeof body["Protocol-Version"] === "string" ? body["Protocol-Version"] : undefined,
    userAgent: typeof body["User-Agent"] === "string" ? body["User-Agent"] : undefined,
    webSocketDebuggerUrl: typeof body.webSocketDebuggerUrl === "string" ? body.webSocketDebuggerUrl : undefined,
  }
}

export async function fetchTargets(host: string, port: number, timeoutMs = 2000): Promise<CdpTarget[]> {
  // Prefer /json/list, fall back to /json (older endpoints serve one or the other).
  try {
    return parseJsonTargets(await getJson(`http://${host}:${port}/json/list`, timeoutMs))
  } catch {
    return parseJsonTargets(await getJson(`http://${host}:${port}/json`, timeoutMs))
  }
}

export type DiscoverResult = { version: CdpVersionInfo; targets: CdpTarget[] }

/** Probe a port: confirm it's a CDP/inspector endpoint and enumerate its targets. */
export async function discover(host: string, port: number, timeoutMs = 2000): Promise<DiscoverResult> {
  const version = await fetchVersion(host, port, timeoutMs)
  const targets = await fetchTargets(host, port, timeoutMs)
  return { version, targets }
}

/**
 * Poll for an inspector/debug endpoint to come up (used after SIGUSR1, which
 * starts the Node inspector asynchronously). Returns the browser-level
 * webSocketDebuggerUrl (Node inspector) or the first target's ws url.
 */
export async function pollForEndpoint(
  host: string,
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ wsUrl: string; version: CdpVersionInfo } | null> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const intervalMs = opts.intervalMs ?? 200
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const version = await fetchVersion(host, port, 1000)
      if (version.webSocketDebuggerUrl) return { wsUrl: version.webSocketDebuggerUrl, version }
      const targets = await fetchTargets(host, port, 1000)
      if (targets[0]?.webSocketDebuggerUrl) return { wsUrl: targets[0].webSocketDebuggerUrl, version }
    } catch {
      // not up yet
    }
    await Bun.sleep(intervalMs)
  }
  return null
}
