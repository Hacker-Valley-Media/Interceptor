/**
 * Runner-only WebSocket listeners.
 *
 * The daemon's main WebSocket server binds loopback (issue #274), so a phone
 * that dials ws://<LAN or Tailscale address>:<port> cannot reach it. For each
 * non-loopback address the daemon hands a runner (and for the Mac's Tailscale
 * address) it opens one of these on that exact address and the same port. It
 * serves only an InterceptorRunner: the first message must be a `{type:"ios"}`
 * registration (launch token or device proof, checked by the same code the main
 * server uses), and after that only that runner's own frames. Anything else, or
 * no registration within RUNNER_REGISTER_WINDOW_MS, closes the socket. There are
 * no HTTP routes.
 */
import type { ServerWebSocket } from "bun"
import { IOS_REGISTER_TYPE } from "../../shared/ios-device"

type Data = { timer?: ReturnType<typeof setTimeout> }
export type RunnerWs = ServerWebSocket<Data>
type Server = ReturnType<typeof Bun.serve>

export type RunnerListenerDeps = {
  port: number
  maxPayloadLength: number
  allowOrigin: (origin: string | null) => boolean
  /** A registered runner's frame (binary stream frame or parsed text reply). False when the socket is not a registered runner. */
  runnerFrame: (ws: RunnerWs, frame: Buffer | Record<string, unknown>) => boolean
  /** The main server's `{type:"ios"}` registration: sends the ack, returns whether it was accepted. */
  register: (ws: RunnerWs, msg: Record<string, unknown>) => boolean
  /** The main server's close handling. */
  close: (ws: RunnerWs, code: number, reason: string) => void
  log: (line: string) => void
  registerWindowMs?: number
}

/** How long a socket on a runner listener may stay open without registering. */
export const RUNNER_REGISTER_WINDOW_MS = 10_000

/** Returns `ensure(host)`: idempotent, one listener per host. A failed bind is logged once and retried on the next call. */
export function createRunnerListener(deps: RunnerListenerDeps): (host: string) => Server | undefined {
  const servers = new Map<string, Server>()
  const failed = new Set<string>()
  const windowMs = deps.registerWindowMs ?? RUNNER_REGISTER_WINDOW_MS
  const refuse = (ws: RunnerWs, why: string) => { try { ws.close(1008, why) } catch {} }

  return (host: string) => {
    const have = servers.get(host)
    if (have) return have
    let server: Server
    try {
      server = Bun.serve<Data>({
        hostname: host,
        port: deps.port,
        fetch(req, srv) {
          if (!deps.allowOrigin(req.headers.get("origin"))) return new Response("forbidden", { status: 403 })
          if (srv.upgrade(req, { data: {} })) return
          return new Response("not found", { status: 404 })
        },
        websocket: {
          maxPayloadLength: deps.maxPayloadLength,
          open(ws) {
            ws.data.timer = setTimeout(() => refuse(ws, "no runner registration"), windowMs)
          },
          message(ws, raw) {
            if (typeof raw !== "string") {
              if (!deps.runnerFrame(ws, Buffer.from(raw))) refuse(ws, "runner frames only")
              return
            }
            let msg: unknown
            try { msg = JSON.parse(raw) } catch { msg = undefined }
            const obj = msg && typeof msg === "object" ? msg as Record<string, unknown> : {}
            if (deps.runnerFrame(ws, obj)) return
            if (obj.type === IOS_REGISTER_TYPE && deps.register(ws, obj)) { clearTimeout(ws.data.timer); return }
            refuse(ws, "runner registration only")
          },
          close(ws, code, reason) {
            clearTimeout(ws.data.timer)
            deps.close(ws, code, reason)
          },
        },
      })
    } catch (err) {
      if (!failed.has(host)) {
        failed.add(host)
        deps.log(`ios runner listener not started on ${host}:${deps.port}: ${(err as Error).message}. If an older setup added \`tailscale serve --tcp=${deps.port}\` for this, remove it with \`tailscale serve --tcp=${deps.port} off\` (it forwards the whole daemon port).`)
      }
      return undefined
    }
    servers.set(host, server)
    failed.delete(host)
    deps.log(`ios runner listener on ${host}:${server.port}`)
    return server
  }
}
