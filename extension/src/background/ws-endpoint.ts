// The daemon's WebSocket port is per OS user (shared/platform.ts derivePorts:
// uid 501 keeps 19222). The native host runs as the browsing user and reports
// the port in its pong; until then, and on hosts without native messaging, the
// primary account's port is dialed. By IP, not `localhost`: the daemon binds
// 127.0.0.1 only.
export const DEFAULT_WS_PORT = 19222
let wsPort = DEFAULT_WS_PORT
const listeners = new Set<(port: number) => void>()

export function wsEndpoint(): string {
  return `ws://127.0.0.1:${wsPort}`
}

export function currentWsPort(): number {
  return wsPort
}

/** Adopt a port learned from the native host. Returns true when it changed. */
export function adoptWsPort(port: unknown): boolean {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535 || port === wsPort) return false
  wsPort = port
  try { void chrome.storage?.session?.set({ wsPort: port }) } catch {}
  for (const fn of listeners) fn(port)
  return true
}

export function onWsPortChange(fn: (port: number) => void): void {
  listeners.add(fn)
}

/** Service-worker restart: reuse the port the last pong reported. */
export function restoreWsPort(): void {
  try {
    void chrome.storage?.session?.get("wsPort").then((v) => adoptWsPort(v?.wsPort)).catch(() => {})
  } catch {}
}
