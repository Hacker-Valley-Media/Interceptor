import { unlinkSync, existsSync, appendFileSync, statSync, readFileSync, writeFileSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { osClick, osKey, osType, osMove, generateBezierPath, translateCoords } from "./os-input-loader"
import { IS_WIN, SOCKET_PATH, IPC_PORT, PID_PATH, LOG_PATH, EVENTS_PATH, WS_PORT, EVENTS_MAX_SIZE, transportLabel } from "../shared/platform"
import {
  MONITOR_EVENT_NAMES,
  appendSessionEvent,
  appendSessionNetArtifact,
  type MonitorAttachmentMeta,
  type MonitorEvent,
  type MonitorSessionMeta,
  updateSessionMeta,
} from "../shared/monitor-artifacts"
import { chooseOutboundTransport, validateContextRouting } from "./outbound-routing"
import { formatBridgeUnavailableError, getBridgeRecoveryActions, getBridgeRecoveryLayout } from "./bridge-recovery"
import { clearDaemonRuntimeFiles, decideDaemonStartupRole, defaultLifecycleDeps, readPidState, spawnDetachedStandaloneDaemon } from "./lifecycle"
import { CdpManager, CDP_ACTION_TYPES } from "./cdp/manager"
import { CDP_CONTEXT_PREFIX } from "../shared/cdp-app"
import {
  NATIVE_REGISTER_TYPE, NATIVE_DELEGATE_TYPE, NATIVE_CONTEXT_PREFIX,
  type NativeAgentState, type CodeSlice, type NativeWayIn,
} from "../shared/native-agent"

// ── Native Bridge (interceptor-bridge) connection ────────────────────────────────
const BRIDGE_SOCKET_PATH = "/tmp/interceptor-bridge.sock"
const BRIDGE_PID_PATH = "/tmp/interceptor-bridge.pid"
const BRIDGE_RECONNECT_MS = 2000
const BRIDGE_CONNECT_TIMEOUT_MS = 5000
const BRIDGE_RECOVERY_ACTION_TIMEOUT_MS = 1500

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

function readBridgeRecoveryLayout() {
  return getBridgeRecoveryLayout({
    exists: existsSync,
    home: process.env.HOME ?? "",
    importMetaUrl: import.meta.url,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
  })
}

// Probe whether the bridge LaunchAgent is actually bootstrapped into the
// user's GUI domain. A plist file existing on disk doesn't mean it's loaded —
// pkg postinstalls can (and do) fail the bootstrap call silently, leaving the
// agent unregistered. Distinguishes "user should kickstart" from "user must
// bootstrap first". Returns false on non-darwin or when the probe fails.
function isLaunchAgentBootstrapped(): boolean {
  if (process.platform !== "darwin") return false
  if (typeof process.getuid !== "function") return false
  try {
    const result = spawnSync("launchctl", ["print", `gui/${process.getuid()}/com.interceptor.bridge`], {
      encoding: "utf-8",
      stdio: ["ignore", "ignore", "ignore"],
    })
    return result.status === 0
  } catch {
    return false
  }
}

async function waitForBridgeSocket(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(BRIDGE_SOCKET_PATH)) return true
    await Bun.sleep(100)
  }
  return existsSync(BRIDGE_SOCKET_PATH)
}

async function spawnBridge(): Promise<boolean> {
  if (bridgeSpawnAttempted) return false
  bridgeSpawnAttempted = true
  try {
    const layout = readBridgeRecoveryLayout()
    const actions = getBridgeRecoveryActions(layout, existsSync)
    if (actions.length === 0) {
      log("bridge binary not found — cannot auto-spawn")
      return false
    }

    for (const action of actions) {
      try {
        log(`bridge recovery attempt: ${action.kind}`)
        const child = spawn(action.command, action.args, { detached: true, stdio: "ignore" })
        child.unref()
      } catch (err) {
        log(`bridge recovery launch failed (${action.kind}): ${(err as Error).message}`)
        continue
      }

      if (await waitForBridgeSocket(BRIDGE_RECOVERY_ACTION_TIMEOUT_MS)) return true
    }

    return existsSync(BRIDGE_SOCKET_PATH)
  } finally {
    setTimeout(() => { bridgeSpawnAttempted = false }, 10000)
  }
}

async function connectBridge(): Promise<boolean> {
  if (bridgeConnecting) return false
  if (!existsSync(BRIDGE_SOCKET_PATH)) {
    if (!isBridgeAlive()) {
      const recovered = await spawnBridge()
      if (!recovered || !existsSync(BRIDGE_SOCKET_PATH)) return false
    } else {
      return false
    }
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
    if (!isBridgeAlive()) {
      const recovered = await spawnBridge()
      if (recovered && existsSync(BRIDGE_SOCKET_PATH)) return connectBridge()
    }
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

// Runtime Agent surface: forward a `delegate` frame from an in-process
// agent to the Swift bridge (a macos_* action), then send the bridge's
// {id,result} back to the agent's WebSocket. This is how the injected agent
// piggybacks on the bridge's already-granted TCC (Accessibility / Screen
// Recording / Apple Events) instead of the re-signed target's reset grants.
function forwardDelegateToBridge(
  id: string,
  action: Record<string, unknown>,
  agentWs: { send: (data: string) => void },
  contextId: string,
): void {
  const actionType = (action?.type as string) || "unknown"
  emitEvent("native_delegate", { contextId, action: actionType, requestId: id })
  const fail = (error: string) => {
    try { agentWs.send(JSON.stringify({ id, result: { success: false, error } })) } catch {}
  }
  const dispatch = () => {
    const payload = JSON.stringify({ id, action })
    const encoded = Buffer.from(payload, "utf-8")
    const header = Buffer.alloc(4)
    header.writeUInt32LE(encoded.byteLength, 0)
    try {
      ;(bridgeSocket as any).write(Buffer.concat([header, encoded]))
    } catch {
      fail("bridge connection lost")
      return
    }
    const timer = setTimeout(() => {
      bridgePending.delete(id)
      fail("bridge timeout")
    }, REQUEST_TIMEOUT_MS)
    bridgePending.set(id, {
      resolve: (response: string) => { clearTimeout(timer); try { agentWs.send(response) } catch {} },
      timer,
      cliSocket: { write: () => 0 } as any,
      startTime: Date.now(),
      actionType,
    })
  }
  if (bridgeSocket) dispatch()
  else connectBridge().then((ok) => { (ok && bridgeSocket) ? dispatch() : fail("bridge unavailable for delegation") })
}

// Start bridge connection on daemon startup
setTimeout(() => connectBridge(), 500)

function log(msg: string) {
  const mode = process.argv.includes("--standalone") ? "standalone" : "native-messaging"
  const line = `[${new Date().toISOString()} pid:${process.pid} mode:${mode}] ${msg}\n`
  try { appendFileSync(LOG_PATH, line) } catch {}
}

function emitEvent(event: string, data: Record<string, unknown> = {}) {
  const eventObj = { timestamp: new Date().toISOString(), event, ...data }
  const entry = JSON.stringify(eventObj)
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

  const sid = typeof data.sid === "string" ? data.sid : undefined
  if (sid && MONITOR_EVENT_NAMES.has(event)) {
    try {
      appendSessionEvent(sid, eventObj as MonitorEvent)
      syncSessionMetaFromEvent(eventObj as MonitorEvent)
    } catch {}
  }
}

function attachmentFromEvent(ev: MonitorEvent): MonitorAttachmentMeta | null {
  const tabId = typeof ev.tid === "number" ? ev.tid : undefined
  if (tabId === undefined) return null
  const doc = typeof ev.doc === "string" ? ev.doc : undefined
  return {
    key: `${tabId}:${doc || "unknown"}`,
    tabId,
    documentId: doc,
    frameId: typeof ev.fid === "number" ? ev.fid : 0,
    url: typeof ev.u === "string" ? ev.u : undefined,
    openerTabId: typeof ev.openerTid === "number" ? ev.openerTid : undefined,
    attachedAt: typeof ev.t === "number" ? ev.t : Date.now(),
    detachedAt: undefined,
    lifecycle: typeof ev.lif === "string" ? ev.lif : undefined,
    reason: typeof ev.reason === "string" ? ev.reason : undefined
  }
}

function syncSessionMetaFromEvent(ev: MonitorEvent): void {
  if (!ev.sid) return

  updateSessionMeta(ev.sid, (current): MonitorSessionMeta => {
    const base: MonitorSessionMeta = current || {
      artifactVersion: 2,
      surface: "browser",
      sessionId: ev.sid!,
      taskId: typeof ev.taskId === "string" ? ev.taskId : undefined,
      startedAt: typeof ev.t === "number" ? ev.t : Date.now(),
      status: ev.event === "mon_stop" ? "stopped" : "active",
      paused: false,
      rootTabId: typeof ev.tid === "number" ? ev.tid : undefined,
      instruction: typeof ev.ins === "string" ? ev.ins : undefined,
      url: typeof ev.url === "string" ? ev.url : (typeof ev.u === "string" ? ev.u : undefined),
      activeAttachmentKey: undefined,
      counts: undefined,
      stopReason: undefined,
      attachments: []
    }

    if (ev.event === "mon_start") {
      base.surface = "browser"
      base.taskId = typeof ev.taskId === "string" ? ev.taskId : base.taskId
      base.startedAt = typeof ev.t === "number" ? ev.t : base.startedAt
      base.status = "active"
      base.paused = false
      base.rootTabId = typeof ev.tid === "number" ? ev.tid : base.rootTabId
      base.instruction = typeof ev.ins === "string" ? ev.ins : base.instruction
      base.url = typeof ev.url === "string" ? ev.url : base.url
    } else if (ev.event === "mon_pause") {
      base.paused = true
    } else if (ev.event === "mon_resume") {
      base.paused = false
    } else if (ev.event === "mon_stop") {
      base.status = "stopped"
      base.paused = false
      base.endedAt = typeof ev.t === "number" ? ev.t : base.endedAt
      base.stopReason = typeof ev.reason === "string" ? ev.reason : base.stopReason
      base.counts = {
        evt: typeof ev.evt === "number" ? ev.evt : base.counts?.evt || 0,
        mut: typeof ev.mut === "number" ? ev.mut : base.counts?.mut || 0,
        net: typeof ev.net === "number" ? ev.net : base.counts?.net || 0,
        nav: typeof ev.nav === "number" ? ev.nav : base.counts?.nav || 0,
      }
    } else if (ev.event === "mon_attach") {
      const attachment = attachmentFromEvent(ev)
      if (attachment) {
        const idx = base.attachments.findIndex((item) => item.key === attachment.key)
        if (idx === -1) base.attachments.push(attachment)
        else base.attachments[idx] = { ...base.attachments[idx], ...attachment }
        base.activeAttachmentKey = attachment.key
      }
    } else if (ev.event === "mon_detach") {
      const attachment = attachmentFromEvent(ev)
      if (attachment) {
        const idx = base.attachments.findIndex((item) => item.key === attachment.key)
        if (idx === -1) {
          base.attachments.push({ ...attachment, detachedAt: typeof ev.t === "number" ? ev.t : Date.now() })
        } else {
          base.attachments[idx] = {
            ...base.attachments[idx],
            detachedAt: typeof ev.t === "number" ? ev.t : Date.now(),
            reason: attachment.reason || base.attachments[idx].reason,
            lifecycle: attachment.lifecycle || base.attachments[idx].lifecycle,
            url: attachment.url || base.attachments[idx].url,
          }
        }
        if (base.activeAttachmentKey === attachment.key) base.activeAttachmentKey = undefined
      }
    }

    return base
  })
}

function persistNetArtifactFromEvent(ev: Record<string, unknown>): void {
  if (typeof ev.sid !== "string") return
  const event = typeof ev.event === "string" ? ev.event : ""
  let kind: "fetch" | "xhr" | "sse" | "ws" | "beacon" | "broadcast" | undefined
  if (event === "fetch" || event === "xhr" || event === "sse") kind = event
  else if (event.startsWith("ws_")) kind = "ws"
  else if (event === "beacon" || event === "beacon_error") kind = "beacon"
  else if (event.startsWith("broadcast_")) kind = "broadcast"
  if (!kind) return
  if ((kind === "fetch" || kind === "xhr" || kind === "sse") && (typeof ev.bp !== "string" || !ev.bp)) return

  appendSessionNetArtifact(ev.sid, {
    sid: ev.sid,
    seq: typeof ev.s === "number" ? ev.s : undefined,
    tid: typeof ev.tid === "number" ? ev.tid : undefined,
    doc: typeof ev.doc === "string" ? ev.doc : undefined,
    cause: typeof ev.cause === "number" ? ev.cause : undefined,
    kind,
    url: typeof ev.u === "string" ? ev.u : "",
    method: typeof ev.m === "string" ? ev.m : undefined,
    status: typeof ev.st === "number" ? ev.st : undefined,
    contentType: typeof ev.ct === "string" ? ev.ct : undefined,
    truncated: ev.trn === true,
    bodyBytes: typeof ev.bt === "number" ? ev.bt : undefined,
    bodyPreview: typeof ev.bp === "string" ? ev.bp : "",
    direction: typeof ev.dir === "string" ? ev.dir : undefined,
    payloadKind: typeof ev.pk === "string" ? ev.pk : undefined,
    payloadEncoding: typeof ev.enc === "string" ? ev.enc : undefined,
    socketId: typeof ev.skt === "string" ? ev.skt : undefined,
    channelId: typeof ev.ch === "string" ? ev.ch : undefined,
    channelName: typeof ev.cn === "string" ? ev.cn : undefined,
    returnValue: typeof ev.rv === "boolean" ? ev.rv : undefined
  })
}

const STANDALONE = process.argv.includes("--standalone")
const NATIVE_STANDALONE_BOOT_TIMEOUT_MS = 5_000

log(`daemon starting (mode: ${STANDALONE ? "standalone" : "native-messaging"})`)

// ── Native Relay ─────────────────────────────────────────────────────────────
// When Chrome spawns a new daemon (native-messaging mode) and a singleton is
// already running, the new process becomes a transparent stdio↔IPC bridge
// instead of exiting. This prevents the "native host disconnected" error cycle
// that occurs every ~30s due to MV3 service worker reconnects.
async function startNativeRelay(existingPid: number): Promise<never> {
  log(`relay mode: bridging native messaging to singleton (pid ${existingPid})`)

  let singletonSocket: Bun.Socket<undefined> | null = null

  try {
    const relaySocketHandlers: Bun.SocketHandler<undefined> = {
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

    singletonSocket = IS_WIN
      ? await Bun.connect<undefined>({
        hostname: "127.0.0.1",
        port: IPC_PORT,
        socket: relaySocketHandlers
      })
      : await Bun.connect<undefined>({
        unix: SOCKET_PATH,
        socket: relaySocketHandlers
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

function lifecycleDeps() {
  return {
    ...defaultLifecycleDeps({ pidPath: PID_PATH, socketPath: SOCKET_PATH, isWin: IS_WIN }),
    log,
  }
}

async function bootstrapDaemonRole(): Promise<void> {
  const deps = lifecycleDeps()
  const state = readPidState(deps)
  const decision = decideDaemonStartupRole(STANDALONE, state)

  if (decision.action === "exit") {
    log(`another daemon already running (pid ${decision.pid}) — exiting`)
    process.exit(0)
  }

  if (decision.action === "relay") {
    await startNativeRelay(decision.pid)
  }

  if (decision.action === "clear-and-continue" || decision.action === "clear-and-spawn") {
    clearDaemonRuntimeFiles(deps, decision.reason)
  }

  if (decision.action === "spawn" || decision.action === "clear-and-spawn") {
    const standalonePid = await spawnDetachedStandaloneDaemon(deps, NATIVE_STANDALONE_BOOT_TIMEOUT_MS)
    if (standalonePid) {
      await startNativeRelay(standalonePid)
    }
    log("native bootstrap failed to start detached singleton — falling back to in-process singleton")
  }
}

await bootstrapDaemonRole()

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
const NATIVE_HOST_TO_CHROME_MAX_BYTES = 1024 * 1024

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
    let wrote = 0
    try {
      wrote = socket.write(chunk)
    } catch (err) {
      log(`socket drain error: ${(err as Error).message}`)
      return
    }
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
    const eventName = msg.event as string || "extension_event"
    const eventPayload = { ...msg } as Record<string, unknown>
    if (typeof eventPayload.sid === "string") {
      try { persistNetArtifactFromEvent({ event: eventName, ...eventPayload }) } catch {}
      delete eventPayload.bp
      delete eventPayload.bt
      delete eventPayload.trn
      delete eventPayload.ct
    }
    emitEvent(eventName, eventPayload)
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

const extensionWsMap = new Map<string, { send: (data: string) => void }>()
// Runtime Agent surface: per-agent metadata for `macos runtime status`.
// The agent's ws is stored in extensionWsMap under its runtime:<app> contextId so the
// normal verb-routing / contexts / disambiguation paths work unchanged; this map
// only adds the descriptive metadata those paths don't carry.
const nativeAgentMeta = new Map<string, NativeAgentState>()
let nativeRelaySocket: Bun.Socket<undefined> | null = null
const wsOutboundQueues = new Map<string, string[]>()
const WS_QUEUE_CAP = 50

function resolveExtensionWs(contextId?: string): { send: (data: string) => void } | null {
  if (contextId) return extensionWsMap.get(contextId) ?? null
  if (extensionWsMap.size === 1) return [...extensionWsMap.values()][0]
  return null
}

// Resolve where the MV2 sibling extension (loaded into Electron apps) lives.
function resolveMv2ExtDir(): string {
  const env = process.env.INTERCEPTOR_MV2_EXT_DIR
  if (env) return env
  const candidates = [
    `${import.meta.dir}/../extension/dist-mv2`,
    `${process.env.HOME ?? ""}/.interceptor/extension-mv2`,
    "/Library/Application Support/Interceptor/extension-mv2",
  ]
  for (const c of candidates) {
    try { if (existsSync(c)) return c } catch {}
  }
  return candidates[0]
}

// CDP-app surface: direct CDP (cdp:) contexts live here; inspector
// bootstrap loads the MV2 extension which registers as an app: extension context.
const cdpManager = new CdpManager({
  emit: (event, data) => emitEvent(event, data || {}),
  hasExtensionContext: (ctxId: string) => extensionWsMap.has(ctxId),
  mv2ExtensionDir: resolveMv2ExtDir,
})

function drainWsOutboundQueue(ctxId: string): void {
  const ws = extensionWsMap.get(ctxId)
  if (!ws) return
  for (const key of [ctxId, "default"]) {
    const queue = wsOutboundQueues.get(key)
    if (!queue) continue
    while (queue.length > 0) {
      const msg = queue.shift()!
      log(`draining queued ws message [${key}]: ${msg.slice(0, 100)}`)
      try { ws.send(msg) } catch (err) { log(`ws drain error: ${(err as Error).message}`) }
    }
    wsOutboundQueues.delete(key)
  }
}

function sendNativeMessage(msg: unknown, contextId?: string): void {
  const json = JSON.stringify(msg)
  const resolvedWs = resolveExtensionWs(contextId)
  const preferred = chooseOutboundTransport(msg, {
    nativeRelayAvailable: !!nativeRelaySocket,
    extensionWsAvailable: !!resolvedWs,
    stdinAlive,
    standalone: STANDALONE
  })
  const byteLength = Buffer.byteLength(json, "utf-8")

  function failOversizedNativeMessage(transport: string): boolean {
    if (byteLength <= NATIVE_HOST_TO_CHROME_MAX_BYTES) return false
    const id = (msg as { id?: unknown } | null)?.id
    const error = `native message too large for ${transport}: ${byteLength} bytes exceeds ${NATIVE_HOST_TO_CHROME_MAX_BYTES}`
    log(error)
    if (typeof id === "string") {
      handleNativeMessage({ id, result: { success: false, error } })
    }
    return true
  }

  if (preferred === "ws" && resolvedWs) {
    log(`forwarding via ws: ${json.slice(0, 200)}`)
    try {
      resolvedWs.send(json)
      return
    } catch (err) {
      log(`ws send error: ${(err as Error).message}`)
    }
  }

  if (preferred === "relay" && nativeRelaySocket) {
    if (failOversizedNativeMessage("native relay")) return
    log(`forwarding via relay: ${json.slice(0, 200)}`)
    try {
      socketWriteFramed(nativeRelaySocket, json)
      return
    } catch (err) {
      log(`relay send error: ${(err as Error).message}`)
      nativeRelaySocket = null
    }
  }

  if (preferred === "native" && !STANDALONE && stdinAlive) {
    if (failOversizedNativeMessage("native stdio")) return
    log(`forwarding via runtime agent: ${json.slice(0, 200)}`)
    const encoded = Buffer.from(json, "utf-8")
    const header = Buffer.alloc(4)
    header.writeUInt32LE(encoded.byteLength, 0)
    const combined = Buffer.concat([header, encoded])
    process.stdout.write(combined)
    return
  }

  if (resolvedWs) {
    log(`fallback via ws: ${json.slice(0, 200)}`)
    try {
      resolvedWs.send(json)
      return
    } catch (err) {
      log(`fallback ws send error: ${(err as Error).message}`)
    }
  }

  if (nativeRelaySocket) {
    if (failOversizedNativeMessage("fallback native relay")) return
    log(`fallback via relay: ${json.slice(0, 200)}`)
    try {
      socketWriteFramed(nativeRelaySocket, json)
      return
    } catch (err) {
      log(`fallback relay send error: ${(err as Error).message}`)
      nativeRelaySocket = null
    }
  }

  if (!STANDALONE && stdinAlive) {
    if (failOversizedNativeMessage("fallback native stdio")) return
    log(`fallback via runtime agent: ${json.slice(0, 200)}`)
    const encoded = Buffer.from(json, "utf-8")
    const header = Buffer.alloc(4)
    header.writeUInt32LE(encoded.byteLength, 0)
    const combined = Buffer.concat([header, encoded])
    process.stdout.write(combined)
    return
  }

  const queueKey = contextId ?? "default"
  if (!wsOutboundQueues.has(queueKey)) wsOutboundQueues.set(queueKey, [])
  const queue = wsOutboundQueues.get(queueKey)!
  if (queue.length >= WS_QUEUE_CAP) queue.shift()
  queue.push(json)
  log(`queued for ws [${queueKey}] (${queue.length} pending): ${json.slice(0, 100)}`)
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

          let request: { id?: string; action?: unknown; tabId?: number; contextId?: string; type?: string }
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

          if (action?.type === "contexts") {
            const list = [...extensionWsMap.keys(), ...cdpManager.contextIds()]
            socketWriteFramed(socket, JSON.stringify({ id, result: { success: true, data: list } }))
            continue
          }

          // Runtime Agent surface: list connected in-process agents.
          if (action?.type === "native_status") {
            socketWriteFramed(socket, JSON.stringify({ id, result: { success: true, data: [...nativeAgentMeta.values()] } }))
            continue
          }

          // CDP-app surface: lifecycle actions → manager; verbs for
          // cdp: contexts → manager (app: contexts are extensions, handled below).
          if (action?.type && CDP_ACTION_TYPES.has(action.type)) {
            cdpManager.handle(action as { type: string; [k: string]: unknown })
              .then((result) => socketWriteFramed(socket, JSON.stringify({ id, result })))
              .catch((err) => socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: `cdp dispatch failed: ${(err as Error).message}` } })))
            continue
          }
          if (request.contextId && request.contextId.startsWith(CDP_CONTEXT_PREFIX)) {
            cdpManager.executeVerb(request.contextId, (action as { type: string; [k: string]: unknown }) ?? { type: "unknown" })
              .then((result) => socketWriteFramed(socket, JSON.stringify({ id, result })))
              .catch((err) => socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: `cdp verb failed: ${(err as Error).message}` } })))
            continue
          }

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
                  socketWriteFramed(socket, JSON.stringify({
                    id,
                    result: { success: false, error: formatBridgeUnavailableError(readBridgeRecoveryLayout(), { launchAgentLoaded: isLaunchAgentBootstrapped() }) },
                  }))
                }
              })
            }
            continue
          }

          const contextValidation = validateContextRouting({
            contextId: request.contextId,
            connectedContexts: [...extensionWsMap.keys()],
            nativeRelayAvailable: !!nativeRelaySocket,
            cdpContexts: cdpManager.contextIds(),
          })
          if (!contextValidation.ok) {
            socketWriteFramed(socket, JSON.stringify({ id, result: { success: false, error: contextValidation.error } }))
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

          sendNativeMessage({ id, action: request.action, tabId: request.tabId }, request.contextId)
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
        let request: { id?: string; action?: unknown; tabId?: number; contextId?: string; type?: string; result?: unknown }
        try {
          request = JSON.parse(rawStr)
        } catch {
          ws.send(JSON.stringify({ error: "invalid JSON" }))
          return
        }

        if (request.type === "extension") {
          const ctxId = request.contextId ?? "default"
          const oldCtxId = (ws as any).__contextId
          if (oldCtxId && oldCtxId !== ctxId && extensionWsMap.get(oldCtxId) === ws) {
            extensionWsMap.delete(oldCtxId)
          }
          ;(ws as any).__contextId = ctxId
          extensionWsMap.set(ctxId, ws)
          log(`ws extension registered [context: ${ctxId}]`)
          drainWsOutboundQueue(ctxId)
          return
        }

        // Runtime Agent surface: an in-process agent dylib registers
        // here. We store it in extensionWsMap under its runtime:<app> contextId
        // so verb routing / contexts / disambiguation all work unchanged, plus
        // nativeAgentMeta for `macos runtime status`.
        if (request.type === NATIVE_REGISTER_TYPE) {
          const r = request as { contextId?: string; pid?: number; slice?: string; appName?: string; frameworks?: string[]; wayIn?: string }
          const ctxId = r.contextId && r.contextId.startsWith(NATIVE_CONTEXT_PREFIX) ? r.contextId : NATIVE_CONTEXT_PREFIX + (r.contextId ?? "app")
          const oldCtxId = (ws as any).__contextId
          if (oldCtxId && oldCtxId !== ctxId && extensionWsMap.get(oldCtxId) === ws) {
            extensionWsMap.delete(oldCtxId)
            nativeAgentMeta.delete(oldCtxId)
          }
          ;(ws as any).__contextId = ctxId
          ;(ws as any).__native = true
          extensionWsMap.set(ctxId, ws)
          nativeAgentMeta.set(ctxId, {
            contextId: ctxId,
            appName: r.appName ?? ctxId.slice(NATIVE_CONTEXT_PREFIX.length),
            pid: typeof r.pid === "number" ? r.pid : undefined,
            slice: (r.slice as CodeSlice) ?? "unknown",
            wayIn: r.wayIn as NativeWayIn | undefined,
            frameworks: Array.isArray(r.frameworks) ? r.frameworks : undefined,
            registeredAt: Date.now(),
            connection: "connected",
          })
          log(`ws native agent registered [context: ${ctxId} pid: ${r.pid ?? "?"} slice: ${r.slice ?? "?"}]`)
          emitEvent("native_agent_registered", { contextId: ctxId, pid: r.pid, slice: r.slice, appName: r.appName })
          drainWsOutboundQueue(ctxId)
          return
        }

        // Runtime Agent surface: the agent delegates a TCC-gated /
        // OS-level op to the bridge. Routes the macos_* action to the bridge and
        // returns {id,result} back to the agent's ws.
        if (request.type === NATIVE_DELEGATE_TYPE) {
          const id = request.id ?? crypto.randomUUID()
          const action = (request.action as Record<string, unknown> | undefined) ?? { type: "unknown" }
          const ctxId = (ws as any).__contextId ?? "runtime:?"
          forwardDelegateToBridge(id, action, ws, ctxId)
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

        // CDP-app surface over the WebSocket transport (screenshot etc.).
        if (CDP_ACTION_TYPES.has(actionType)) {
          cdpManager.handle(request.action as { type: string; [k: string]: unknown })
            .then((result) => ws.send(JSON.stringify({ id, result })))
            .catch((err) => { try { ws.send(JSON.stringify({ id, result: { success: false, error: `cdp dispatch failed: ${(err as Error).message}` } })) } catch {} })
          return
        }
        if (request.contextId && request.contextId.startsWith(CDP_CONTEXT_PREFIX)) {
          cdpManager.executeVerb(request.contextId, (request.action as { type: string; [k: string]: unknown }) ?? { type: "unknown" })
            .then((result) => ws.send(JSON.stringify({ id, result })))
            .catch((err) => { try { ws.send(JSON.stringify({ id, result: { success: false, error: `cdp verb failed: ${(err as Error).message}` } })) } catch {} })
          return
        }

        const contextValidation = validateContextRouting({
          contextId: request.contextId,
          connectedContexts: [...extensionWsMap.keys()],
          nativeRelayAvailable: !!nativeRelaySocket,
          cdpContexts: cdpManager.contextIds(),
        })
        if (!contextValidation.ok) {
          ws.send(JSON.stringify({ id, result: { success: false, error: contextValidation.error } }))
          return
        }

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

        sendNativeMessage({ id, action: request.action, tabId: request.tabId }, request.contextId)
      },
      close(ws) {
        const ctxId = (ws as any).__contextId
        if (ctxId && extensionWsMap.get(ctxId) === ws) {
          extensionWsMap.delete(ctxId)
        }
        if (ctxId && nativeAgentMeta.has(ctxId)) {
          nativeAgentMeta.delete(ctxId)
          emitEvent("native_agent_disconnected", { contextId: ctxId })
        }
        log(`ws client disconnected [context: ${ctxId ?? "unknown"}]`)
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
  try { cdpManager.shutdown() } catch {} // close outbound CDP sockets + disable Fetch/Network on targets
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
