// The WebSocket port is the daemon's one authoritative singleton token (the OS
// lets exactly one process bind it). The pid, lock, and socket files only
// *describe* the port owner, so anything that wants to know "is a daemon
// running?" asks the port, not the files. GET /health on that port is answered
// only by the owner, and answering it makes the owner restore any of its
// runtime files that went missing.

export type DaemonProbe =
  | { state: "free" }
  | { state: "interceptor"; pid: number; version: string; healed: string[] }
  | { state: "legacy" }
  | { state: "foreign"; detail: string }

export const DAEMON_HEALTH_SERVICE = "interceptor-daemon"
export const LEGACY_HEALTH_BODY = "interceptor daemon"

type RawHttpResult =
  | { kind: "refused" }
  | { kind: "timeout" }
  | { kind: "error"; message: string }
  | { kind: "response"; status: number; body: string }

// A raw loopback HTTP/1.1 GET over Bun.connect rather than fetch(): fetch()
// honors HTTP_PROXY/HTTPS_PROXY and would send this loopback probe to the
// proxy (verified: a proxy env turns a live daemon into "free", which is the
// deadlock again), and it is also replaceable process-wide (happy-dom). The
// daemon answers with Content-Length and honors Connection: close, so the
// reply is complete when the peer closes.
function loopbackHttpGet(port: number, path: string, timeoutMs: number): Promise<RawHttpResult> {
  return new Promise((resolve) => {
    let settled = false
    let peer: { end(): void } | null = null
    const chunks: Buffer[] = []
    const finish = (value: RawHttpResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { peer?.end() } catch {}
      resolve(value)
    }
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs)
    const refused = (err: Error & { code?: string }) =>
      finish(err.code === "ECONNREFUSED" || err.code === "ConnectionRefused" ? { kind: "refused" } : { kind: "error", message: err.message })
    const parse = () => {
      const raw = Buffer.concat(chunks)
      const text = raw.toString("latin1")
      const headerEnd = text.indexOf("\r\n\r\n")
      if (headerEnd < 0) return finish({ kind: "error", message: "connection closed before an HTTP response" })
      const status = parseInt(text.slice(0, text.indexOf("\r\n")).split(" ")[1] ?? "", 10)
      const headers = text.slice(0, headerEnd).toLowerCase()
      let body = raw.subarray(headerEnd + 4)
      const length = headers.match(/\r\ncontent-length:\s*(\d+)/)
      if (length) body = body.subarray(0, parseInt(length[1], 10))
      finish({ kind: "response", status: Number.isFinite(status) ? status : 0, body: body.toString("utf-8") })
    }
    Bun.connect<undefined>({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          peer = socket
          socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n`)
        },
        data(_socket, chunk) { chunks.push(Buffer.from(chunk)) },
        close() { parse() },
        connectError(_socket, err) { refused(err as Error & { code?: string }) },
        error(_socket, err) { finish({ kind: "error", message: err.message }) },
      },
    }).catch((err: Error & { code?: string }) => refused(err))
  })
}

export async function probeDaemonHealth(wsPort: number, timeoutMs = 1500): Promise<DaemonProbe> {
  const raw = await loopbackHttpGet(wsPort, "/health", timeoutMs)
  if (raw.kind === "refused") return { state: "free" }
  if (raw.kind === "timeout") return { state: "foreign", detail: `no reply within ${timeoutMs}ms` }
  if (raw.kind === "error") return { state: "foreign", detail: raw.message }
  const body = raw.body
  if (body.trim() === LEGACY_HEALTH_BODY) return { state: "legacy" }
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    if (data.service === DAEMON_HEALTH_SERVICE && Number.isSafeInteger(data.pid) && typeof data.version === "string") {
      return {
        state: "interceptor",
        pid: data.pid as number,
        version: data.version,
        healed: Array.isArray(data.healed) ? data.healed.filter((x): x is string => typeof x === "string") : [],
      }
    }
  } catch {}
  return { state: "foreign", detail: `HTTP ${raw.status} ${body.slice(0, 60).replace(/\s+/g, " ")}` }
}

export type DaemonRecovery =
  | { action: "connect" }
  | { action: "spawn" }
  | { action: "fail"; message: string }

// CLI side. `readyAfterProbe` is the runtime-file readiness re-read after the
// probe, because a successful probe is what heals the files.
export function decideDaemonRecovery(probe: DaemonProbe, readyAfterProbe: boolean, wsPort: number, logPath: string): DaemonRecovery {
  if (readyAfterProbe) return { action: "connect" }
  switch (probe.state) {
    case "free":
      return { action: "spawn" }
    case "interceptor":
      return {
        action: "fail",
        message: `daemon pid ${probe.pid} (${probe.version}) holds port ${wsPort} but could not restore its runtime files. Check ${logPath}, or run 'interceptor daemon stop' and retry.`,
      }
    case "legacy":
      return {
        action: "fail",
        message: `an older interceptor daemon holds port ${wsPort} but its runtime files are missing and that version cannot restore them. Stop it and retry (macOS: kill "$(lsof -t -nP -iTCP:${wsPort} -sTCP:LISTEN)").`,
      }
    case "foreign":
      return {
        action: "fail",
        message: `port ${wsPort} is held by a process that is not an interceptor daemon (${probe.detail}). Free the port or set INTERCEPTOR_WS_PORT for both the CLI and the daemon.`,
      }
  }
}
