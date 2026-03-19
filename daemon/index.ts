import { unlinkSync, existsSync, appendFileSync } from "node:fs"

const SOCKET_PATH = "/tmp/slop-browser.sock"
const PID_PATH = "/tmp/slop-browser.pid"
const LOG_PATH = "/tmp/slop-browser.log"

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(LOG_PATH, line) } catch {}
}

log("daemon starting")

try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH) } catch {}

const pendingRequests = new Map<string, {
  resolve: (v: string) => void
  timer: ReturnType<typeof setTimeout>
  socket: { write: (data: Buffer | string) => number; readonly remoteAddress: string }
  startTime: number
  actionType: string
}>()

const socketBuffers = new Map<object, Buffer>()
const socketWriteQueues = new Map<object, Buffer[]>()

function socketWriteFramed(socket: { write: (data: Buffer | string) => number }, json: string): boolean {
  try {
    const encoded = Buffer.from(json, "utf-8")
    const header = Buffer.alloc(4)
    header.writeUInt32LE(encoded.byteLength, 0)
    const frame = Buffer.concat([header, encoded])
    const wrote = socket.write(frame)
    if (wrote < frame.byteLength) {
      const remainder = frame.subarray(wrote)
      const queue = socketWriteQueues.get(socket) || []
      queue.push(Buffer.from(remainder))
      socketWriteQueues.set(socket, queue)
    }
    return true
  } catch (err) {
    log(`socket write error: ${(err as Error).message}`)
    return false
  }
}

function drainSocketQueue(socket: { write: (data: Buffer | string) => number }) {
  const queue = socketWriteQueues.get(socket)
  if (!queue || queue.length === 0) return
  while (queue.length > 0) {
    const chunk = queue[0]
    const wrote = socket.write(chunk)
    if (wrote < chunk.byteLength) {
      queue[0] = chunk.subarray(wrote)
      return
    }
    queue.shift()
  }
}

const timedOutRequests = new Set<string>()

let stdinBuffer = Buffer.alloc(0)

function processStdinBuffer() {
  while (stdinBuffer.length >= 4) {
    const msgLen = stdinBuffer.readUInt32LE(0)
    if (msgLen === 0 || msgLen > 10 * 1024 * 1024) {
      log(`invalid message length: ${msgLen}, discarding buffer`)
      stdinBuffer = Buffer.alloc(0)
      return
    }
    if (stdinBuffer.length < 4 + msgLen) return
    const jsonBuf = stdinBuffer.subarray(4, 4 + msgLen)
    stdinBuffer = stdinBuffer.subarray(4 + msgLen)
    try {
      const msg = JSON.parse(jsonBuf.toString("utf-8"))
      log(`received: ${JSON.stringify(msg).slice(0, 200)}`)
      handleNativeMessage(msg)
    } catch (err) {
      log(`json parse error: ${(err as Error).message}`)
    }
  }
}

function handleNativeMessage(msg: { id?: string; type?: string; [key: string]: unknown }) {
  if (msg.type === "ping") {
    log("received ping, sending pong")
    sendNativeMessage({ type: "pong" })
    return
  }

  if (msg.id) {
    const pending = pendingRequests.get(msg.id)
    if (pending) {
      clearTimeout(pending.timer)
      const duration = Date.now() - pending.startTime
      const success = (msg as { result?: { success?: boolean } }).result?.success ?? true
      log(`[${msg.id.slice(0, 8)}] resp ${success ? "ok" : "err"} ${pending.actionType} ${duration}ms`)
      pending.resolve(JSON.stringify(msg))
      pendingRequests.delete(msg.id)
    } else if (timedOutRequests.has(msg.id)) {
      log(`late response for timed-out request: ${msg.id}`)
      timedOutRequests.delete(msg.id)
    }
  }
}

function sendNativeMessage(msg: unknown): void {
  const json = JSON.stringify(msg)
  const encoded = Buffer.from(json, "utf-8")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(encoded.byteLength, 0)
  const combined = Buffer.concat([header, encoded])
  log(`sending: ${json.slice(0, 200)}`)
  process.stdout.write(combined)
}

process.stdin.on("data", (chunk: Buffer) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk])
  processStdinBuffer()
})

process.stdin.on("end", () => {
  log("stdin ended (native port disconnected)")
})

process.stdin.on("error", (err) => {
  log(`stdin error: ${err.message}`)
})

process.stdin.resume()

const REQUEST_TIMEOUT_MS = 30_000

let socketServer: ReturnType<typeof Bun.listen> | null = null

try {
  socketServer = Bun.listen({
    unix: SOCKET_PATH,
    socket: {
      open(socket) {
        socketBuffers.set(socket, Buffer.alloc(0))
        log("cli connected via socket")
      },
      data(socket, raw) {
        let buf = Buffer.concat([socketBuffers.get(socket) || Buffer.alloc(0), Buffer.from(raw)])

        while (buf.length >= 4) {
          const msgLen = buf.readUInt32LE(0)
          if (msgLen === 0 || msgLen > 1024 * 1024) {
            log(`invalid socket message length: ${msgLen}, discarding`)
            buf = Buffer.alloc(0)
            break
          }
          if (buf.length < 4 + msgLen) break

          const jsonBuf = buf.subarray(4, 4 + msgLen)
          buf = buf.subarray(4 + msgLen)

          let request: { id?: string; action?: unknown; tabId?: number }
          try {
            request = JSON.parse(jsonBuf.toString("utf-8"))
          } catch {
            socketWriteFramed(socket, JSON.stringify({ error: "invalid JSON" }))
            continue
          }

          const id = request.id ?? crypto.randomUUID()
          log(`cli request: ${id} ${JSON.stringify(request.action).slice(0, 100)}`)

          const timer = setTimeout(() => {
            pendingRequests.delete(id)
            timedOutRequests.add(id)
            setTimeout(() => timedOutRequests.delete(id), 60_000)
            log(`request timeout: ${id}`)
            socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: "timeout" } }))
          }, REQUEST_TIMEOUT_MS)

          const actionType = (request.action as { type?: string })?.type || "unknown"
          pendingRequests.set(id, {
            resolve: (response: string) => {
              clearTimeout(timer)
              socketWriteFramed(socket, response)
            },
            timer,
            socket,
            startTime: Date.now(),
            actionType
          })

          sendNativeMessage({ id, action: request.action, tabId: request.tabId })
        }

        socketBuffers.set(socket, buf)
      },
      drain(socket) {
        drainSocketQueue(socket)
      },
      close(socket) {
        socketBuffers.delete(socket)
        socketWriteQueues.delete(socket)
        log("cli disconnected")
      },
      error(_socket, err) {
        log(`socket error: ${err.message}`)
      }
    }
  })
  log(`socket listening on ${SOCKET_PATH}`)
} catch (err) {
  log(`socket listen failed: ${(err as Error).message}`)
  process.exit(1)
}

Bun.write(PID_PATH, `${process.pid}\n${SOCKET_PATH}\n`)
log(`pid file written: ${process.pid}`)

function gracefulShutdown(signal: string) {
  log(`${signal} received, draining ${pendingRequests.size} pending requests`)
  for (const [id, req] of pendingRequests) {
    clearTimeout(req.timer)
    socketWriteFramed(req.socket, JSON.stringify({ id, result: { success: false, error: "daemon shutting down" } }))
  }
  pendingRequests.clear()
  if (socketServer) {
    socketServer.stop(true)
    socketServer = null
  }
  try { unlinkSync(SOCKET_PATH) } catch {}
  try { unlinkSync(PID_PATH) } catch {}
  log("shutdown complete")
  process.exit(0)
}

process.on("exit", (code) => {
  log(`exiting with code ${code}`)
  try { unlinkSync(SOCKET_PATH) } catch {}
  try { unlinkSync(PID_PATH) } catch {}
})
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
process.on("SIGINT", () => gracefulShutdown("SIGINT"))
process.on("uncaughtException", (err) => {
  log(`uncaught exception: ${err.message}\n${err.stack}`)
})
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${reason}`)
})

log("daemon ready, waiting for native messages")
