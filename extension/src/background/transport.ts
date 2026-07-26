import { handleDaemonMessage, drainMessageQueue, pendingRequests } from "./message-dispatch"
import { safeNativePortDisconnect, safeNativePortPing, safeNativePortPost, shouldSkipNativeKeepalive } from "./native-port-lifecycle"
import { recoverPendingRequestsAfterNativeDisconnect } from "./pending-request-recovery"
import { INITIAL_RECONNECT_DELAY_MS, delayWithJitter, nextReconnectDelay } from "./reconnect-lifecycle"
import { clearContextConflictBadge, registrationControlType, setContextConflictBadge } from "./context-registration"
import { SafariNativeRelayClient, type SafariNativeRelayRuntime } from "./safari-native-relay"

type ActiveTransport = "none" | "native" | "websocket" | "safari-native"
export type HostDeliveryResult = "sent" | "queued" | "failed"

export let nativePort: chrome.runtime.Port | null = null
export let activeTransport: ActiveTransport = "none"
let isConnecting = false
let nativeReconnectDelay = INITIAL_RECONNECT_DELAY_MS
let wsReconnectDelay = INITIAL_RECONNECT_DELAY_MS
let nativeReconnectTimer: ReturnType<typeof setTimeout> | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null

let wsChannel: WebSocket | null = null
let wsReady = false
// Half-open detection state: keepalives sent since the last inbound ws frame,
// and whether this connection's daemon has acked one (older daemons never do).
// All transitions go through the pure reducers below (wsStateOn*) so the
// stateful behavior — send increments, inbound resets, ack arms, open clears —
// is unit-testable without a live socket.
let wsKeepalive: WsKeepaliveState = { keepalivesSinceAck: 0, ackSupported: false }
let wsKeepAliveTimer: ReturnType<typeof setInterval> | null = null
let keepalivePongTimer: ReturnType<typeof setTimeout> | null = null
let pendingHandshakePort: chrome.runtime.Port | null = null
let lastNativeActivityAt = 0
const WS_URL = "ws://localhost:19222"
let configuredContextId: string | null = null
let forceWebSocketTransport = false
let safariNativeRelayEnabled = false
let safariNativeRelayClient: SafariNativeRelayClient | null = null
export const NATIVE_KEEPALIVE_PONG_TIMEOUT_MS = 15_000
export const RECENT_NATIVE_ACTIVITY_GRACE_MS = 10_000
// After this many consecutive keepalives sent with no inbound frame in reply
// (~40s at the 20s interval), treat the ws as half-open and force a reconnect.
export const WS_KEEPALIVE_MISS_LIMIT = 2
const OUTBOUND_RECOVERY_QUEUE_CAP = 50
const outboundRecoveryQueue: unknown[] = []

export type ExtensionTransportConfig = {
  contextId?: string
  forceWebSocket?: boolean
  safariNativeRelay?: boolean
}

/** Configure an entrypoint before it registers listeners or opens a channel. */
export function configureTransport(config: ExtensionTransportConfig): void {
  if (typeof config.contextId === "string" && config.contextId.trim().length > 0) {
    configuredContextId = config.contextId.trim()
  }
  forceWebSocketTransport = config.forceWebSocket === true
  safariNativeRelayEnabled = config.safariNativeRelay === true
}

function describeOutboundMessage(msg: unknown): string {
  const candidate = msg as { id?: unknown; result?: { error?: unknown } } | null
  if (candidate && typeof candidate.id === "string") {
    const error = typeof candidate.result?.error === "string" ? ` (${candidate.result.error})` : ""
    return `${candidate.id}${error}`
  }
  return JSON.stringify(msg).slice(0, 200)
}

export function emitEvent(event: string, data: Record<string, unknown> = {}) {
  sendToHost({ type: "event", event, ...data })
}

function clearNativeStateFor(port: chrome.runtime.Port | null): void {
  if (nativePort === port) nativePort = null
  if (pendingHandshakePort === port) pendingHandshakePort = null
  if (activeTransport === "native") activeTransport = "none"
}

function disconnectNativePort(port: chrome.runtime.Port | null): void {
  if (!port) return
  safeNativePortDisconnect(port)
  if (keepalivePongTimer) {
    clearTimeout(keepalivePongTimer)
    keepalivePongTimer = null
  }
  clearNativeStateFor(port)
}

function hasNativeMessaging(): boolean {
  // Some extension hosts expose connectNative with semantics that do not target
  // our Chromium native host. Entrypoints may explicitly select plain WebSocket;
  // Safari's selected native-relay path is handled before this predicate.
  if (forceWebSocketTransport) return false
  // Keep the generated MV2/Electron bootstrap global as a compatibility path.
  if ((globalThis as { INTERCEPTOR_FORCE_WS?: unknown }).INTERCEPTOR_FORCE_WS) return false
  return typeof chrome.runtime.connectNative === "function"
}

function postNative(msg: unknown, port = nativePort): boolean {
  if (!port) return false
  const res = safeNativePortPost(port, msg)
  if (res.posted) return true
  console.error("nativePort.postMessage threw (port disconnected before onDisconnect fired):", res.error)
  clearNativeStateFor(port)
  scheduleNativeReconnect()
  return false
}

function isWsOpen(): boolean {
  if (!wsReady || !wsChannel || wsChannel.readyState !== WebSocket.OPEN) return false
  return true
}

function markWsUnregistered(): void {
  wsReady = false
  if (activeTransport === "websocket") activeTransport = "none"
}

function markWsRegistered(): void {
  wsReady = true
  clearContextConflictBadge(chrome)
  if (activeTransport !== "native") {
    activeTransport = "websocket"
    wsReconnectDelay = INITIAL_RECONNECT_DELAY_MS
    isConnecting = false
    console.log("connection ready via ws channel")
    drainMessageQueue()
  }
  drainOutboundRecoveryQueue()
}

function sendWs(msg: unknown): boolean {
  const channel = wsChannel
  if (!wsReady || !channel || channel.readyState !== WebSocket.OPEN) return false
  try {
    channel.send(JSON.stringify(msg))
    return true
  } catch {
    return false
  }
}

function sendWsRegistration(ws: WebSocket, contextId: string): boolean {
  markWsUnregistered()
  try {
    ws.send(JSON.stringify({ type: "extension", contextId }))
    return true
  } catch (err) {
    console.error("ws context registration send error:", err)
    return false
  }
}

function closeWsForReconnect(ws: WebSocket): void {
  try { ws.close() } catch {}
  if (wsChannel !== ws) return
  stopWsKeepAlive()
  markWsUnregistered()
  wsChannel = null
  scheduleWsReconnect()
}

function enqueueOutboundRecovery(msg: unknown): HostDeliveryResult {
  if (outboundRecoveryQueue.length >= OUTBOUND_RECOVERY_QUEUE_CAP) {
    const dropped = outboundRecoveryQueue.shift()
    console.error("final delivery failure for queued outbound message:", describeOutboundMessage(dropped))
  }
  outboundRecoveryQueue.push(msg)
  return "queued"
}

function drainOutboundRecoveryQueue(): void {
  while (outboundRecoveryQueue.length > 0) {
    const msg = outboundRecoveryQueue[0]
    if (!sendWs(msg)) return
    outboundRecoveryQueue.shift()
  }
}

export function sendToHost(msg: unknown, forceWs?: boolean, allowQueue = false): HostDeliveryResult {
  if (safariNativeRelayEnabled) {
    connectSafariNativeRelayChannel()
    if (!safariNativeRelayClient) {
      return allowQueue ? enqueueOutboundRecovery(msg) : "failed"
    }
    safariNativeRelayClient.enqueue(msg)
    return "queued"
  }
  if (forceWs) {
    if (sendWs(msg)) return "sent"
    return allowQueue ? enqueueOutboundRecovery(msg) : "failed"
  }
  if (activeTransport === "native" && nativePort) {
    if (postNative(msg)) return "sent"
    // fall through to ws channel if native postMessage failed
  }
  if (activeTransport === "websocket" && wsReady && wsChannel) {
    if (sendWs(msg)) return "sent"
    return allowQueue ? enqueueOutboundRecovery(msg) : "failed"
  }
  if (nativePort) {
    if (postNative(msg)) return "sent"
    // fall through to ws channel if native postMessage failed
  }
  if (wsReady && wsChannel) {
    if (sendWs(msg)) return "sent"
  }
  return allowQueue ? enqueueOutboundRecovery(msg) : "failed"
}

function scheduleWsReconnect(): void {
  if (wsReconnectTimer) return
  if (wsChannel && (wsChannel.readyState === WebSocket.OPEN || wsChannel.readyState === WebSocket.CONNECTING)) return
  const delay = delayWithJitter(wsReconnectDelay)
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null
    connectWsChannel()
  }, delay)
  wsReconnectDelay = nextReconnectDelay(wsReconnectDelay)
}

function scheduleNativeReconnect(): void {
  if (nativeReconnectTimer) return
  if (nativePort || isConnecting) return
  const delay = delayWithJitter(nativeReconnectDelay)
  nativeReconnectTimer = setTimeout(() => {
    nativeReconnectTimer = null
    connectToHost()
  }, delay)
  nativeReconnectDelay = nextReconnectDelay(nativeReconnectDelay)
}

export function connectToHost(): void {
  if (safariNativeRelayEnabled) {
    connectSafariNativeRelayChannel()
    return
  }
  if (!hasNativeMessaging()) {
    if (isWsOpen()) activeTransport = "websocket"
    else connectWsChannel()
    return
  }
  if (nativePort || isConnecting) return
  isConnecting = true

  const port = chrome.runtime.connectNative("com.interceptor.host")

  const handshakeTimer = setTimeout(() => {
    console.error("native host handshake timeout (10s)")
    disconnectNativePort(port)
    scheduleNativeReconnect()
  }, 10000)

  port.onMessage.addListener((msg: {
    id?: string; type?: string
    action?: { type: string; [key: string]: unknown }
    tabId?: number
  }) => {
    if (msg.type === "pong") {
      lastNativeActivityAt = Date.now()
      if (pendingHandshakePort === port) {
        clearTimeout(handshakeTimer)
        pendingHandshakePort = null
        activeTransport = "native"
        nativeReconnectDelay = INITIAL_RECONNECT_DELAY_MS
        if (nativeReconnectTimer) {
          clearTimeout(nativeReconnectTimer)
          nativeReconnectTimer = null
        }
        isConnecting = false
        console.log("native host connected (pong received)")
        emitEvent("connection_established")
        drainMessageQueue()
      }
      if (keepalivePongTimer) {
        clearTimeout(keepalivePongTimer)
        keepalivePongTimer = null
      }
      return
    }
    lastNativeActivityAt = Date.now()
    handleDaemonMessage(msg)
  })

  port.onDisconnect.addListener(() => {
    const disconnectedPort = port
    isConnecting = false
    const lastError = chrome.runtime.lastError
    if (lastError) console.error("native host disconnected:", lastError.message)
    console.log("connection_lost", lastError?.message)
    clearNativeStateFor(disconnectedPort)
    if (isWsOpen()) {
      activeTransport = "websocket"
      console.log("native host down but ws channel active, switching to websocket")
      recoverPendingRequestsAfterNativeDisconnect(
        pendingRequests,
        (msg) => sendToHost(msg, true, true)
      )
      pendingRequests.clear()
      scheduleNativeReconnect()
      return
    }
    recoverPendingRequestsAfterNativeDisconnect(
      pendingRequests,
      (msg) => sendToHost(msg, true, true)
    )
    pendingRequests.clear()
    scheduleNativeReconnect()
  })

  nativePort = port
  pendingHandshakePort = port
  const ping = safeNativePortPing(port)
  if (!ping.posted) {
    clearTimeout(handshakeTimer)
    clearNativeStateFor(port)
    isConnecting = false
    scheduleNativeReconnect()
  }
}

function handleControlPlaneMessage(
  rawMessage: unknown,
  transport: "websocket" | "safari-native",
): void {
  if (!rawMessage || typeof rawMessage !== "object") return
  const msg = rawMessage as {
    id?: string
    type?: string
    contextId?: string
    action?: { type: string; [key: string]: unknown }
    tabId?: number
    _viaWs?: boolean
  }
  const controlType = registrationControlType(msg)
  if (controlType === "context_conflict") {
    if (transport === "websocket") markWsUnregistered()
    else if (activeTransport === "safari-native") activeTransport = "none"
    console.error(`[interceptor] context name conflict: '${msg.contextId}' is already registered. Change the context ID in the extension popup.`)
    setContextConflictBadge(chrome)
    return
  }
  if (controlType === "context_registered") {
    if (transport === "websocket") {
      markWsRegistered()
    } else {
      activeTransport = "safari-native"
      clearContextConflictBadge(chrome)
      drainMessageQueue()
      while (outboundRecoveryQueue.length > 0) {
        safariNativeRelayClient?.enqueue(outboundRecoveryQueue.shift())
      }
    }
    return
  }
  if (msg.id && msg.action) {
    // The daemon-facing leg is still its WebSocket; responses must return over
    // the same connection even though JS reaches it through the native appex.
    msg._viaWs = true
    void handleDaemonMessage(msg)
  }
}

export function connectSafariNativeRelayChannel(): void {
  if (!safariNativeRelayEnabled) return
  if (safariNativeRelayClient) {
    safariNativeRelayClient.start()
    return
  }
  const contextId = configuredContextId
  if (!contextId) {
    console.error("Safari native relay requires an explicit context id")
    return
  }
  const runtime = (chrome as unknown as { runtime?: SafariNativeRelayRuntime }).runtime
  if (!runtime) {
    console.error("Safari native relay requires chrome.runtime")
    return
  }
  safariNativeRelayClient = new SafariNativeRelayClient({
    runtime,
    contextId,
    onMessage: (message) => handleControlPlaneMessage(message, "safari-native"),
    onConnectionChange: (connected) => {
      if (!connected && activeTransport === "safari-native") activeTransport = "none"
    },
    onError: (error) => console.error("Safari native relay:", error.message),
  })
  safariNativeRelayClient.start()
}

// Half-open detection state, threaded through pure reducers so every
// transition is testable without a live socket.
export type WsKeepaliveState = { keepalivesSinceAck: number; ackSupported: boolean }

// A fresh socket: no unacked keepalives, and `ackSupported` re-learned from
// THIS connection's first ack rather than inherited. Resetting ackSupported per
// connection is what keeps the gate honest — a daemon that acked on a prior
// socket but was replaced by a non-acking build won't leave the flag latched
// true and false-positive-reconnect a healthy but unacked connection.
export function wsStateOnOpen(): WsKeepaliveState {
  return { keepalivesSinceAck: 0, ackSupported: false }
}

// A keepalive just went out with no reply yet.
export function wsStateOnKeepaliveSent(state: WsKeepaliveState): WsKeepaliveState {
  return { ...state, keepalivesSinceAck: state.keepalivesSinceAck + 1 }
}

// Any inbound frame proves the read side is alive — clear the staleness count.
export function wsStateOnInboundFrame(state: WsKeepaliveState): WsKeepaliveState {
  return { ...state, keepalivesSinceAck: 0 }
}

// A keepalive_ack: this daemon supports acks, so arm half-open detection.
export function wsStateOnAck(state: WsKeepaliveState): WsKeepaliveState {
  return { ...state, ackSupported: true }
}

/**
 * Decide, from inside the outbound keepalive timer, whether the ws is half-open
 * (OPEN at the OS layer but its read side is silently severed — the post-MV3-
 * hibernation failure mode). The outbound setInterval is the one callback that
 * keeps firing while ws.onmessage is wedged, so it must be the detector. Gated
 * on `ackSupported` (set only after this connection's first keepalive_ack)
 * so a daemon that never acks can't trip a permanent false-positive reconnect
 * loop. Pure so the gate is unit-testable.
 */
export function shouldForceWsReconnect(
  ackSupported: boolean,
  keepalivesSinceAck: number,
  missLimit: number,
): boolean {
  return ackSupported && keepalivesSinceAck >= missLimit
}

function startWsKeepAlive(): void {
  if (wsKeepAliveTimer) clearInterval(wsKeepAliveTimer)
  wsKeepAliveTimer = setInterval(() => {
    const channel = wsChannel
    if (!channel || channel.readyState !== WebSocket.OPEN) {
      if (wsKeepAliveTimer) clearInterval(wsKeepAliveTimer)
      wsKeepAliveTimer = null
      return
    }
    if (shouldForceWsReconnect(wsKeepalive.ackSupported, wsKeepalive.keepalivesSinceAck, WS_KEEPALIVE_MISS_LIMIT)) {
      console.error(`ws inbound stale (${wsKeepalive.keepalivesSinceAck} unacked keepalives) — forcing reconnect`)
      // Route through the shared teardown so onclose/backoff/reconnect run
      // exactly as they do for a clean close — no bespoke reconnect timer.
      closeWsForReconnect(channel)
      return
    }
    try {
      channel.send(JSON.stringify({ type: "keepalive", timestamp: Date.now() }))
      wsKeepalive = wsStateOnKeepaliveSent(wsKeepalive)
    } catch {}
  }, 20_000)
}

function stopWsKeepAlive(): void {
  if (wsKeepAliveTimer) clearInterval(wsKeepAliveTimer)
  wsKeepAliveTimer = null
}

async function getOrCreateContextId(): Promise<string> {
  const legacyConfigured = (globalThis as { INTERCEPTOR_APP_CONTEXT_ID?: unknown }).INTERCEPTOR_APP_CONTEXT_ID
  const configured = configuredContextId ?? legacyConfigured
  const storage = (chrome as unknown as {
    storage?: { local?: Pick<typeof chrome.storage.local, "get" | "set"> }
  }).storage?.local
  if (typeof configured === "string" && configured.length > 0) {
    // The fixed Safari identity is sufficient to register. Storage is only a
    // convenience here and must not become a control-plane dependency.
    try { await storage?.set({ contextId: configured }) } catch {}
    return configured
  }
  const stored = storage
    ? await storage.get("contextId") as { contextId?: string }
    : {}
  if (stored?.contextId) return stored.contextId
  const id = crypto.randomUUID()
  try { await storage?.set({ contextId: id }) } catch {}
  return id
}

export function connectWsChannel(): void {
  if (safariNativeRelayEnabled) {
    connectSafariNativeRelayChannel()
    return
  }
  if (wsChannel && (wsChannel.readyState === WebSocket.OPEN || wsChannel.readyState === WebSocket.CONNECTING)) return
  try {
    const ws = new WebSocket(WS_URL)
    wsChannel = ws
    ws.onopen = async () => {
      if (wsChannel !== ws) {
        try { ws.close() } catch {}
        return
      }
      markWsUnregistered()
      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer)
        wsReconnectTimer = null
      }
      // Fresh socket: reset staleness AND re-learn ack support from this
      // connection's first ack (see wsStateOnOpen — don't inherit a prior
      // socket's capability flag).
      wsKeepalive = wsStateOnOpen()
      startWsKeepAlive()
      const contextId = await getOrCreateContextId()
      if (wsChannel !== ws) {
        try { ws.close() } catch {}
        return
      }
      if (ws.readyState !== WebSocket.OPEN) return
      if (!sendWsRegistration(ws, contextId)) {
        closeWsForReconnect(ws)
        return
      }
      console.log("ws channel connected; context registration requested")
    }
    ws.onmessage = (event) => {
      if (wsChannel !== ws) return
      // Any inbound frame proves the read side is alive — clear the half-open
      // counter regardless of the frame's kind.
      wsKeepalive = wsStateOnInboundFrame(wsKeepalive)
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : "")
        if (msg?.type === "keepalive_ack") {
          // First ack on this connection: arm half-open detection.
          wsKeepalive = wsStateOnAck(wsKeepalive)
          return
        }
        console.log("ws onmessage:", JSON.stringify(msg).slice(0, 200))
        handleControlPlaneMessage(msg, "websocket")
      } catch (err) {
        console.error("ws onmessage error:", err)
      }
    }
    ws.onclose = () => {
      if (wsChannel !== ws) return
      stopWsKeepAlive()
      markWsUnregistered()
      wsChannel = null
      scheduleWsReconnect()
    }
    ws.onerror = () => {
      if (wsChannel !== ws) return
      stopWsKeepAlive()
      markWsUnregistered()
      wsChannel = null
      scheduleWsReconnect()
    }
  } catch {
    markWsUnregistered()
    wsChannel = null
    scheduleWsReconnect()
  }
}

// --- SW Keepalive responder (content script heartbeat) ---
let lastSwKeepalive = 0

export function registerSwKeepaliveListener(): void {
  const onMessage = (chrome as unknown as {
    runtime?: { onMessage?: typeof chrome.runtime.onMessage }
  }).runtime?.onMessage
  if (!onMessage?.addListener) return
  onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== "sw_keepalive") return false
    const now = Date.now()
    if (now - lastSwKeepalive < 20_000) {
      sendResponse({ leader: false })
    } else {
      lastSwKeepalive = now
      sendResponse({ leader: true })
    }
    return false
  })
}

export function registerStorageContextListener(): void {
  const onChanged = (chrome as unknown as {
    storage?: { onChanged?: typeof chrome.storage.onChanged }
  }).storage?.onChanged
  if (!onChanged?.addListener) return
  onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.contextId) return
    const newId = changes.contextId.newValue
    if (typeof newId !== "string" || newId.length === 0) return
    if (!newId || !wsChannel || wsChannel.readyState !== WebSocket.OPEN) return
    const channel = wsChannel
    if (!sendWsRegistration(channel, newId)) {
      closeWsForReconnect(channel)
    }
  })
}

export function registerAlarmListener(): void {
  const alarms = (chrome as unknown as { alarms?: typeof chrome.alarms }).alarms
  if (typeof alarms?.create !== "function" || !alarms.onAlarm?.addListener) return
  const creation = alarms.create("keepalive", { periodInMinutes: 1 })
  if (creation && typeof (creation as Promise<void>).catch === "function") {
    ;(creation as Promise<void>).catch((err) => console.warn("keepalive alarm unavailable:", err))
  }
  alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "keepalive") return
    if (!nativePort) connectToHost()
    if (!wsChannel || wsChannel.readyState === WebSocket.CLOSED) connectWsChannel()
    if (activeTransport === "native" && nativePort) {
      if (shouldSkipNativeKeepalive(Date.now(), lastNativeActivityAt, RECENT_NATIVE_ACTIVITY_GRACE_MS)) return
      const port = nativePort
      const res = safeNativePortPing(port)
      if (!res.posted) {
        console.error("native keepalive ping failed:", res.error)
        clearNativeStateFor(port)
        return
      }
      keepalivePongTimer = setTimeout(() => {
        console.error(`keepalive pong timeout (${NATIVE_KEEPALIVE_PONG_TIMEOUT_MS / 1000}s) — forcing reconnect`)
        disconnectNativePort(port)
      }, NATIVE_KEEPALIVE_PONG_TIMEOUT_MS)
    }
  })
}
