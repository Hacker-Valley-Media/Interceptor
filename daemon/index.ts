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
}>()

let stdinBuffer = Buffer.alloc(0)

function processStdinBuffer() {
  while (stdinBuffer.length >= 4) {
    const msgLen = stdinBuffer.readUInt32LE(0)
    if (msgLen === 0 || msgLen > 1024 * 1024) {
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

function handleNativeMessage(msg: { id?: string; [key: string]: unknown }) {
  if (msg.id) {
    const pending = pendingRequests.get(msg.id)
    if (pending) {
      pending.resolve(JSON.stringify(msg))
      pendingRequests.delete(msg.id)
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

try {
  Bun.listen({
    unix: SOCKET_PATH,
    socket: {
      open(socket) {
        log("cli connected via socket")
      },
      data(socket, raw) {
        let request: { id?: string; action?: unknown; tabId?: number }
        try {
          request = JSON.parse(raw.toString())
        } catch {
          socket.write(JSON.stringify({ error: "invalid JSON" }) + "\n")
          return
        }

        const id = request.id ?? crypto.randomUUID()
        log(`cli request: ${id} ${JSON.stringify(request.action).slice(0, 100)}`)

        const timer = setTimeout(() => {
          pendingRequests.delete(id)
          socket.write(JSON.stringify({ id, result: { success: false, error: "timeout" } }) + "\n")
        }, REQUEST_TIMEOUT_MS)

        pendingRequests.set(id, {
          resolve: (response: string) => {
            clearTimeout(timer)
            socket.write(response + "\n")
          },
          timer
        })

        sendNativeMessage({ id, action: request.action, tabId: request.tabId })
      },
      close() {
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

process.on("exit", (code) => {
  log(`exiting with code ${code}`)
  try { unlinkSync(SOCKET_PATH) } catch {}
  try { unlinkSync(PID_PATH) } catch {}
})
process.on("SIGTERM", () => process.exit(0))
process.on("SIGINT", () => process.exit(0))
process.on("uncaughtException", (err) => {
  log(`uncaught exception: ${err.message}\n${err.stack}`)
})
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${reason}`)
})

log("daemon ready, waiting for native messages")
