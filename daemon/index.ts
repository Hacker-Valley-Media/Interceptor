import { unlinkSync, existsSync, appendFileSync, statSync, readFileSync, writeFileSync } from "node:fs"
import { execSync, spawn } from "node:child_process"
import { osClick, osKey, osType, osMove, generateBezierPath, translateCoords } from "./os-input-loader"
import { IS_WIN, SOCKET_PATH, IPC_PORT, PID_PATH, LOG_PATH, EVENTS_PATH, WS_PORT, EVENTS_MAX_SIZE, transportLabel } from "../shared/platform"

// ── Native Bridge (interceptor-bridge) connection ────────────────────────────────
const BRIDGE_SOCKET_PATH = "/tmp/interceptor-bridge.sock"
const BRIDGE_PID_PATH = "/tmp/interceptor-bridge.pid"
const BRIDGE_RECONNECT_MS = 2000
const BRIDGE_CONNECT_TIMEOUT_MS = 5000

let bridgeSocket: ReturnType<typeof Bun.connect> extends Promise<infer T> ? T | null : never = null as any
let bridgeBuffer = Buffer.alloc(0)
let bridgeConnecting = false
let bridgeSpawnAttempted = false
const bridgePending = new Map<string, {
  resolve: (response: string) => void
  timer: ReturnType<typeof setTimeout>
  cliSocket: { write: (data: Buffer | string) => number }
  startTime: number
  actionType: string
}>()

function isBridgeAlive(): boolean {
  try {
    const pid = parseInt(readFileSync(BRIDGE_PID_PATH, "utf-8").trim())
    if (isNaN(pid)) return false
    process.kill(pid, 0)
    return true
  } catch { return false }
}

function spawnBridge(): void {
  if (bridgeSpawnAttempted) return
  bridgeSpawnAttempted = true
  const bridgeBin = new URL("../interceptor-bridge/.build/debug/interceptor-bridge", import.meta.url).pathname
  const releaseBin = new URL("../interceptor-bridge/.build/release/interceptor-bridge", import.meta.url).pathname
  const distBin = new URL("../dist/interceptor-bridge", import.meta.url).pathname
  let bin = ""
  if (existsSync(distBin)) bin = distBin
  else if (existsSync(releaseBin)) bin = releaseBin
  else if (existsSync(bridgeBin)) bin = bridgeBin
  else {
    log("bridge binary not found — cannot auto-spawn")
    return
  }
  log(`spawning bridge: ${bin}`)
  const child = spawn(bin, [], { detached: true, stdio: "ignore" })
  child.unref()
  // Give it time to start
  setTimeout(() => { bridgeSpawnAttempted = false }, 10000)
}

async function connectBridge(): Promise<boolean> {
  if (bridgeConnecting) return false
  if (!existsSync(BRIDGE_SOCKET_PATH)) {
    if (!isBridgeAlive()) spawnBridge()
    return false
  }
  bridgeConnecting = true
  try {
    const sock = await Bun.connect({
      unix: BRIDGE_SOCKET_PATH,
      socket: {
        open(socket) {
          log("bridge connected")
          bridgeSocket = socket as any
          bridgeBuffer = Buffer.alloc(0)
          bridgeConnecting = false
        },
        data(_socket, raw) {
          bridgeBuffer = Buffer.concat([bridgeBuffer, Buffer.from(raw)])
          processBridgeBuffer()
        },
        close() {
          log("bridge disconnected")
          bridgeSocket = null as any
          bridgeConnecting = false
          // Schedule reconnect
          setTimeout(() => connectBridge(), BRIDGE_RECONNECT_MS)
        },
        error(_socket, err) {
          log(`bridge socket error: ${err.message}`)
          bridgeConnecting = false
        }
      }
    })
    bridgeSocket = sock as any
    return true
  } catch (err) {
    log(`bridge connect failed: ${(err as Error).message}`)
    bridgeConnecting = false
    if (!isBridgeAlive()) spawnBridge()
    return false
  }
}

function processBridgeBuffer(): void {
  while (bridgeBuffer.length >= 4) {
    const msgLen = bridgeBuffer.readUInt32LE(0)
    if (msgLen === 0 || msgLen > 10 * 1024 * 1024) {
      log(`bridge: invalid message length: ${msgLen}`)
      bridgeBuffer = Buffer.alloc(0)
      return
    }
    if (bridgeBuffer.length < 4 + msgLen) return
    const jsonBuf = bridgeBuffer.subarray(4, 4 + msgLen)
    bridgeBuffer = bridgeBuffer.subarray(4 + msgLen)
    try {
      const msg = JSON.parse(jsonBuf.toString("utf-8")) as { id?: string; result?: unknown }
      if (msg.id) {
        const pending = bridgePending.get(msg.id)
        if (pending) {
          clearTimeout(pending.timer)
          const duration = Date.now() - pending.startTime
          const result = msg.result as { success?: boolean } | undefined
          log(`bridge resp [${msg.id.slice(0, 8)}] ${result?.success ? "ok" : "err"} ${pending.actionType} ${duration}ms`)
          emitEvent("request_complete", { requestId: msg.id, action: pending.actionType, duration, success: result?.success ?? false })
          pending.resolve(JSON.stringify(msg))
          bridgePending.delete(msg.id)
        }
      }
    } catch (err) {
      log(`bridge: json parse error: ${(err as Error).message}`)
    }
  }
}

function sendToBridge(id: string, action: Record<string, unknown>, cliSocket: { write: (data: Buffer | string) => number }, actionType: string): void {
  const payload = JSON.stringify({ id, action })
  const encoded = Buffer.from(payload, "utf-8")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(encoded.byteLength, 0)
  const frame = Buffer.concat([header, encoded])
  try {
    ;(bridgeSocket as any).write(frame)
  } catch (err) {
    log(`bridge write error: ${(err as Error).message}`)
    socketWriteFramed(cliSocket, JSON.stringify({ id, result: { success: false, error: "bridge connection lost" } }))
    return
  }
  const timer = setTimeout(() => {
    bridgePending.delete(id)
    log(`bridge request timeout: ${id}`)
    socketWriteFramed(cliSocket, JSON.stringify({ id, result: { success: false, error: "bridge timeout" } }))
  }, REQUEST_TIMEOUT_MS)
  bridgePending.set(id, {
    resolve: (response: string) => {
      clearTimeout(timer)
      socketWriteFramed(cliSocket, response)
    },
    timer,
    cliSocket: cliSocket,
    startTime: Date.now(),
    actionType
  })
}

// Start bridge connection on daemon startup
setTimeout(() => connectBridge(), 500)

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(LOG_PATH, line) } catch {}
}

function emitEvent(event: string, data: Record<string, unknown> = {}) {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), event, ...data })
  try {
    appendFileSync(EVENTS_PATH, entry + "\n")
    const stat = statSync(EVENTS_PATH)
    if (stat.size > EVENTS_MAX_SIZE) {
      const content = readFileSync(EVENTS_PATH, "utf-8")
      const lines = content.split("\n")
      const half = lines.slice(Math.floor(lines.length / 2)).join("\n")
      writeFileSync(EVENTS_PATH, half)
    }
  } catch {}
}

const STANDALONE = process.argv.includes("--standalone")

log(`daemon starting (mode: ${STANDALONE ? "standalone" : "native-messaging"})`)

// ── Native Relay ─────────────────────────────────────────────────────────────
// When Chrome spawns a new daemon (native-messaging mode) and a singleton is
// already running, the new process becomes a transparent stdio↔IPC bridge
// instead of exiting. This prevents the "native host disconnected" error cycle
// that occurs every ~30s due to MV3 service worker reconnects.
async function startNativeRelay(existingPid: number): Promise<never> {
  log(`relay mode: bridging native messaging to singleton (pid ${existingPid})`)

  const connectOpts = IS_WIN
    ? { hostname: "127.0.0.1", port: IPC_PORT }
    : { unix: SOCKET_PATH }

  let singletonSocket: Bun.Socket<undefined> | null = null

  try {
    singletonSocket = await Bun.connect<undefined>({
      ...connectOpts,
      socket: {
        open(socket: Bun.Socket<undefined>) {
          // Register as native relay — singleton routes traffic to handleNativeMessage
          const reg = JSON.stringify({ type: "native-relay" })
          const encoded = Buffer.from(reg, "utf-8")
          const header = Buffer.alloc(4)
          header.writeUInt32LE(encoded.byteLength, 0)
          socket.write(Buffer.concat([header, encoded]))
          log("relay: registered with singleton")
        },
        data(_socket: Bun.Socket<undefined>, raw: Buffer<ArrayBufferLike>) {
          // Singleton → stdout (Chrome)
          process.stdout.write(Buffer.from(raw))
        },
        close() {
          log("relay: singleton disconnected — exiting")
          process.exit(0)
        },
        error(_socket: Bun.Socket<undefined>, err: Error) {
          log(`relay: socket error — ${err.message}`)
          process.exit(1)
        }
      }
    })
  } catch (err) {
    log(`relay: failed to connect to singleton — exiting: ${(err as Error).message}`)
    process.exit(1)
  }

  // Chrome stdin → singleton IPC socket
  process.stdin.on("data", (chunk: Buffer) => {
    if (singletonSocket) singletonSocket.write(chunk)
  })
  process.stdin.on("end", () => {
    log("relay: stdin ended (Chrome disconnected) — exiting")
    process.exit(0)
  })
  process.stdin.resume()

  // Keep alive — Bun exits when event loop is empty
  while (true) await Bun.sleep(30_000)
}

if (existsSync(PID_PATH)) {
  try {
    const existingPid = parseInt(readFileSync(PID_PATH, "utf-8").trim().split("\n")[0])
    if (!isNaN(existingPid) && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0)
        if (STANDALONE) {
          log(`another daemon already running (pid ${existingPid}) — exiting`)
          process.exit(0)
        }
        // Native-messaging mode: become a relay instead of exiting
        await startNativeRelay(existingPid)
      } catch {
        log(`stale pid file for dead process ${existingPid} — taking over`)
      }
    }
  } catch {}
}

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

const LARGE_PAYLOAD_THRESHOLD = 16 * 1024
const MAX_RESPONSE_CHARS = 50000

function socketWriteFramed(socket: { write: (data: Buffer | string) => number }, json: string): boolean {
  try {
    let payload = json
    if (payload.length > MAX_RESPONSE_CHARS) {
      try {
        const parsed = JSON.parse(payload)
        if (parsed.result?.data && typeof parsed.result.data === "string" && parsed.result.data.length > MAX_RESPONSE_CHARS) {
          parsed.result.data = parsed.result.data.slice(0, MAX_RESPONSE_CHARS) + "\n... (truncated)"
          payload = JSON.stringify(parsed)
        }
      } catch {}
    }

    const encoded = Buffer.from(payload, "utf-8")

    if (encoded.byteLength > LARGE_PAYLOAD_THRESHOLD) {
      const sink = new Bun.ArrayBufferSink()
      sink.start({ asUint8Array: true, highWaterMark: 65536 })
      const header = new Uint8Array(4)
      new DataView(header.buffer).setUint32(0, encoded.byteLength, true)
      sink.write(header)
      sink.write(encoded)
      const frame = sink.end() as Uint8Array
      const wrote = socket.write(Buffer.from(frame))
      if (wrote < frame.byteLength) {
        const remainder = Buffer.from(frame.subarray(wrote))
        const queue = socketWriteQueues.get(socket) || []
        queue.push(remainder)
        socketWriteQueues.set(socket, queue)
      }
    } else {
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
    emitEvent("keepalive_ping")
    return
  }

  if (msg.type === "event") {
    emitEvent(msg.event as string || "extension_event", msg as Record<string, unknown>)
    return
  }

  if (msg.id) {
    const pending = pendingRequests.get(msg.id)
    if (pending) {
      const requestId = msg.id
      clearTimeout(pending.timer)
      const duration = Date.now() - pending.startTime
      const result = (msg as { result?: { success?: boolean; data?: Record<string, unknown> } }).result
      const success = result?.success ?? true

      if (success && pending.actionType.startsWith("os_") && result?.data) {
        const data = result.data as Record<string, unknown>
        if (data.method === "os_event") {
          const enrichedAction: Record<string, unknown> = { type: pending.actionType }
          if (data.windowBounds) {
            Object.assign(enrichedAction, data.screenTarget as Record<string, unknown> || {})
            enrichedAction.windowBounds = data.windowBounds
            enrichedAction.chromeUiHeight = data.chromeUiHeight
          }
          if (pending.actionType === "os_click") {
            enrichedAction.button = data.button || "left"
            enrichedAction.clickCount = data.clickCount || 1
          }
          if (pending.actionType === "os_key") {
            enrichedAction.key = data.key
            enrichedAction.modifiers = data.modifiers
          }
          if (pending.actionType === "os_type") {
            enrichedAction.text = data.text
          }
          if (pending.actionType === "os_move") {
            enrichedAction.path = data.path
            enrichedAction.duration = data.duration
          }
          log(`[${requestId.slice(0, 8)}] posting OS event for ${pending.actionType}`)
          handleOsAction(requestId, enrichedAction).then((osResult) => {
            const finalResult = osResult || { success: false, error: "os action failed" }
            emitEvent("request_complete", { requestId, action: pending.actionType, duration: Date.now() - pending.startTime, success: finalResult.success })
            pending.resolve(JSON.stringify({ id: requestId, result: finalResult }))
            pendingRequests.delete(requestId)
          })
          return
        }
      }

      log(`[${msg.id.slice(0, 8)}] resp ${success ? "ok" : "err"} ${pending.actionType} ${duration}ms`)
      emitEvent("request_complete", { requestId: msg.id, action: pending.actionType, duration, success })
      pending.resolve(JSON.stringify(msg))
      pendingRequests.delete(msg.id)
    } else if (timedOutRequests.has(msg.id)) {
      log(`late response for timed-out request: ${msg.id}`)
      timedOutRequests.delete(msg.id)
    }
  }
}

let extensionWs: { send: (data: string) => void } | null = null
let nativeRelaySocket: Bun.Socket<undefined> | null = null
const wsOutboundQueue: string[] = []
const WS_QUEUE_CAP = 50

function drainWsOutboundQueue(): void {
  if (!extensionWs) return
  while (wsOutboundQueue.length > 0) {
    const msg = wsOutboundQueue.shift()!
    log(`draining queued ws message: ${msg.slice(0, 100)}`)
    try { extensionWs.send(msg) } catch (err) { log(`ws drain error: ${(err as Error).message}`) }
  }
}

function sendNativeMessage(msg: unknown): void {
  const json = JSON.stringify(msg)
  // Prefer native relay — ensures pong reaches Chrome via native messaging path
  // (extensionWs drops pong because its handler only processes msg.id && msg.action)
  if (nativeRelaySocket) {
    log(`forwarding via relay: ${json.slice(0, 200)}`)
    try {
      socketWriteFramed(nativeRelaySocket, json)
      return
    } catch (err) {
      log(`relay send error: ${(err as Error).message}`)
      nativeRelaySocket = null
    }
  }
  if (extensionWs) {
    log(`forwarding via ws: ${json.slice(0, 200)}`)
    try {
      extensionWs.send(json)
      return
    } catch (err) {
      log(`ws send error: ${(err as Error).message}`)
    }
  }
  if (STANDALONE || !stdinAlive) {
    if (wsOutboundQueue.length >= WS_QUEUE_CAP) wsOutboundQueue.shift()
    wsOutboundQueue.push(json)
    log(`queued for ws (${wsOutboundQueue.length} pending): ${json.slice(0, 100)}`)
    return
  }
  log(`forwarding via native: ${json.slice(0, 200)}`)
  const encoded = Buffer.from(json, "utf-8")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(encoded.byteLength, 0)
  const combined = Buffer.concat([header, encoded])
  process.stdout.write(combined)
}

let stdinAlive = !STANDALONE

if (!STANDALONE) {
  process.stdin.on("data", (chunk: Buffer) => {
    stdinBuffer = Buffer.concat([stdinBuffer, chunk])
    processStdinBuffer()
  })

  process.stdin.on("end", () => {
    stdinAlive = false
    log("stdin ended (native port disconnected) — daemon continues in standalone mode")
  })

  process.stdin.on("error", (err) => {
    log(`stdin error: ${err.message}`)
  })

  process.stdin.resume()
} else {
  log("standalone mode — no native messaging stdin")
}

const REQUEST_TIMEOUT_MS = 180_000

async function handleOsAction(
  id: string,
  action: { type?: string; [key: string]: unknown } | undefined
): Promise<{ success: boolean; error?: string; data?: unknown } | null> {
  if (!action) return null
  const startTime = Date.now()

  switch (action.type) {
    case "os_click": {
      const windowBounds = action.windowBounds as { left: number; top: number; width: number; height: number } | undefined
      const pageX = action.pageX as number | undefined
      const pageY = action.pageY as number | undefined
      if (!windowBounds || pageX === undefined || pageY === undefined) {
        return { success: false, error: "os_click requires windowBounds, pageX, pageY" }
      }
      const chromeUiHeight = (action.chromeUiHeight as number) || 88
      const { screenX, screenY } = translateCoords(pageX, pageY, windowBounds, chromeUiHeight)
      const button = (action.button as "left" | "right") || "left"
      const clickCount = (action.clickCount as number) || 1
      log(`[${id.slice(0, 8)}] os_click screen(${screenX},${screenY}) button=${button} clicks=${clickCount}`)
      const result = await osClick(screenX, screenY, button, clickCount)
      emitEvent("os_action", { requestId: id, action: "os_click", duration: Date.now() - startTime, success: result.success })
      return result
    }

    case "os_key": {
      const key = action.key as string
      const modifiers = (action.modifiers as string[]) || []
      if (!key) return { success: false, error: "os_key requires key" }
      log(`[${id.slice(0, 8)}] os_key ${modifiers.join("+")}${modifiers.length ? "+" : ""}${key}`)
      const result = await osKey(key, modifiers)
      emitEvent("os_action", { requestId: id, action: "os_key", duration: Date.now() - startTime, success: result.success })
      return result
    }

    case "os_type": {
      const text = action.text as string
      if (!text) return { success: false, error: "os_type requires text" }
      log(`[${id.slice(0, 8)}] os_type "${text.slice(0, 50)}"`)
      const result = await osType(text)
      emitEvent("os_action", { requestId: id, action: "os_type", duration: Date.now() - startTime, success: result.success })
      return result
    }

    case "os_move": {
      const path = action.path as Array<{ x: number; y: number }> | undefined
      const windowBounds = action.windowBounds as { left: number; top: number; width: number; height: number } | undefined
      if (!path || !windowBounds) return { success: false, error: "os_move requires path and windowBounds" }
      const chromeUiHeight = (action.chromeUiHeight as number) || 88
      const screenPath = path.map(p => translateCoords(p.x, p.y, windowBounds, chromeUiHeight))
        .map(p => ({ x: p.screenX, y: p.screenY }))
      const duration = (action.duration as number) || 100
      log(`[${id.slice(0, 8)}] os_move ${screenPath.length} points`)
      const result = await osMove(screenPath, duration)
      emitEvent("os_action", { requestId: id, action: "os_move", duration: Date.now() - startTime, success: result.success })
      return result
    }

    default:
      return null
  }
}

let socketServer: Bun.TCPSocketListener<undefined> | Bun.UnixSocketListener<undefined> | null = null

try {
  const socketHandlers: Bun.SocketHandler<undefined> = {
      open(socket: Bun.Socket<undefined>) {
        socketBuffers.set(socket, Buffer.alloc(0))
        log("cli connected via socket")
      },
      data(socket: Bun.Socket<undefined>, raw: Buffer<ArrayBufferLike>) {
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

          let request: { id?: string; action?: unknown; tabId?: number; type?: string }
          try {
            request = JSON.parse(jsonBuf.toString("utf-8"))
          } catch {
            socketWriteFramed(socket, JSON.stringify({ error: "invalid JSON" }))
            continue
          }

          // Native relay registration — relay process identifies itself
          if (request.type === "native-relay") {
            ;(socket as any).__nativeRelay = true
            nativeRelaySocket = socket
            log("native relay registered via IPC socket")
            continue
          }

          // Native relay message forwarding — route to extension protocol handler
          if ((socket as any).__nativeRelay) {
            handleNativeMessage(request as any)
            continue
          }

          const id = request.id ?? crypto.randomUUID()
          const action = request.action as { type?: string; [key: string]: unknown } | undefined
          const actionType = action?.type || "unknown"
          log(`cli request: ${id} ${JSON.stringify(request.action).slice(0, 100)}`)
          emitEvent("request_received", { requestId: id, action: actionType })

          if (action?.type?.startsWith("os_") && action.windowBounds && action.pageX !== undefined) {
            handleOsAction(id, action).then((osResult) => {
              if (osResult) {
                socketWriteFramed(socket, JSON.stringify({ id, result: osResult }))
              } else {
                socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: "unhandled os action" } }))
              }
            })
            continue
          }

          // Route macos_ actions to the native bridge
          if (action?.type?.startsWith("macos_")) {
            if (bridgeSocket) {
              sendToBridge(id, action, socket, actionType)
            } else {
              // Try to connect (async), respond when done
              connectBridge().then((connected) => {
                if (connected && bridgeSocket) {
                  sendToBridge(id, action, socket, actionType)
                } else {
                  socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: "interceptor-bridge not running. Start it with: interceptor-bridge or grant Accessibility permission." } }))
                }
              })
            }
            continue
          }

          const timer = setTimeout(() => {
            pendingRequests.delete(id)
            timedOutRequests.add(id)
            setTimeout(() => timedOutRequests.delete(id), 60_000)
            log(`request timeout: ${id}`)
            emitEvent("request_timeout", { requestId: id, action: actionType })
            socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: "timeout" } }))
          }, REQUEST_TIMEOUT_MS)
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
      drain(socket: Bun.Socket<undefined>) {
        drainSocketQueue(socket)
      },
      close(socket: Bun.Socket<undefined>) {
        if ((socket as any).__nativeRelay) {
          nativeRelaySocket = null
          log("native relay disconnected")
        }
        socketBuffers.delete(socket)
        socketWriteQueues.delete(socket)
        log("cli disconnected")
      },
      error(_socket: Bun.Socket<undefined>, err: Error) {
        log(`socket error: ${err.message}`)
      }
    }
  if (IS_WIN) {
    socketServer = Bun.listen({ hostname: "127.0.0.1", port: IPC_PORT, socket: socketHandlers })
  } else {
    socketServer = Bun.listen({ unix: SOCKET_PATH, socket: socketHandlers })
  }
  log(`socket listening on ${transportLabel()}`)
} catch (err) {
  log(`socket listen failed: ${(err as Error).message}`)
  process.exit(1)
}

Bun.write(PID_PATH, `${process.pid}\n${transportLabel()}\n`)
log(`pid file written: ${process.pid}`)

let wsServer: ReturnType<typeof Bun.serve> | null = null
try {
  wsServer = Bun.serve<undefined>({
    port: WS_PORT,
    fetch(req, server) {
      if (server.upgrade(req, {})) return
      return new Response("interceptor daemon", { status: 200 })
    },
    websocket: {
      open(ws) {
        log(`ws client connected`)
      },
      message(ws, raw) {
        const rawStr = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8")
        log(`ws recv: ${rawStr.slice(0, 300)}`)
        let request: { id?: string; action?: unknown; tabId?: number; type?: string; result?: unknown }
        try {
          request = JSON.parse(rawStr)
        } catch {
          ws.send(JSON.stringify({ error: "invalid JSON" }))
          return
        }

        if (request.type === "extension") {
          (ws as any).__isExtension = true
          extensionWs = ws
          log("ws extension channel registered")
          drainWsOutboundQueue()
          return
        }

        if (request.type === "keepalive") {
          log("ws keepalive")
          return
        }

        if (request.type === "event") {
          // Extension-originated event stream (monitor, keepalive_ping, etc.)
          handleNativeMessage(request as any)
          return
        }

        if ((request as any).id && (request as any).result !== undefined) {
          handleNativeMessage(request as any)
          return
        }

        const id = request.id ?? crypto.randomUUID()
        log(`ws request: ${id} ${JSON.stringify(request.action).slice(0, 100)}`)

        const actionType = (request.action as { type?: string })?.type || "unknown"
        const timer = setTimeout(() => {
          pendingRequests.delete(id)
          timedOutRequests.add(id)
          setTimeout(() => timedOutRequests.delete(id), 60_000)
          log(`ws request timeout: ${id}`)
          ws.send(JSON.stringify({ id, result: { success: false, error: "timeout" } }))
        }, REQUEST_TIMEOUT_MS)

        pendingRequests.set(id, {
          resolve: (response: string) => {
            clearTimeout(timer)
            ws.send(response)
          },
          timer,
          socket: { write: () => 0, remoteAddress: "ws" } as any,
          startTime: Date.now(),
          actionType
        })

        sendNativeMessage({ id, action: request.action, tabId: request.tabId })
      },
      close(ws) {
        if ((ws as any).__isExtension) extensionWs = null
        log("ws client disconnected")
      }
    }
  })
  log(`ws server listening on port ${WS_PORT}`)
} catch (err) {
  log(`ws server failed (port ${WS_PORT} in use?) — continuing without WebSocket: ${(err as Error).message}`)
}

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
  if (wsServer) wsServer.stop(true)
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

// Global keepalive — prevent Bun from exiting when stdin closes.
// Bun compiled binaries exit when the event loop is empty.
// An infinite async loop guarantees the process stays alive.
async function keepAliveForever() {
  while (true) {
    await Bun.sleep(10_000)
  }
}
keepAliveForever()

log("daemon ready, waiting for native messages")
