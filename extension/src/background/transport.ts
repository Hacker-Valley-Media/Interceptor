import { handleDaemonMessage, drainMessageQueue, pendingRequests } from "./message-dispatch"
import { ensureSlopGroup } from "./tab-group"

type ActiveTransport = "none" | "native" | "websocket"

export let nativePort: chrome.runtime.Port | null = null
export let activeTransport: ActiveTransport = "none"
let isConnecting = false
let reconnectDelay = 1000

let wsChannel: WebSocket | null = null
let wsReady = false
let wsKeepAliveTimer: ReturnType<typeof setInterval> | null = null
let keepalivePongTimer: ReturnType<typeof setTimeout> | null = null
const WS_URL = "ws://localhost:19222"

function emitEvent(event: string, data: Record<string, unknown> = {}) {
  sendToHost({ type: "event", event, ...data })
}

export function sendToHost(msg: unknown, forceWs?: boolean): void {
  if (forceWs && wsReady && wsChannel) {
    try { wsChannel.send(JSON.stringify(msg)) } catch {}
    return
  }
  if (activeTransport === "native" && nativePort) {
    nativePort.postMessage(msg)
    return
  }
  if (activeTransport === "websocket" && wsReady && wsChannel) {
    try { wsChannel.send(JSON.stringify(msg)) } catch {}
    return
  }
  if (nativePort) {
    nativePort.postMessage(msg)
    return
  }
  if (wsReady && wsChannel) {
    try { wsChannel.send(JSON.stringify(msg)) } catch {}
  }
}

export function connectToHost(): void {
  if (nativePort || isConnecting) return
  isConnecting = true

  const port = chrome.runtime.connectNative("com.slopbrowser.host")

  const handshakeTimer = setTimeout(() => {
    console.error("native host handshake timeout (10s)")
    port.disconnect()
  }, 10000)

  port.onMessage.addListener((msg: {
    id?: string; type?: string
    action?: { type: string; [key: string]: unknown }
    tabId?: number
  }) => {
    if (msg.type === "pong") {
      clearTimeout(handshakeTimer)
      activeTransport = "native"
      reconnectDelay = 1000
      isConnecting = false
      console.log("native host connected (pong received)")
      emitEvent("connection_established")
      drainMessageQueue()
      if (keepalivePongTimer) {
        clearTimeout(keepalivePongTimer)
        keepalivePongTimer = null
      }
      return
    }
    handleDaemonMessage(msg)
  })

  port.onDisconnect.addListener(() => {
    const dyingPort = nativePort
    isConnecting = false
    const lastError = chrome.runtime.lastError
    if (lastError) console.error("native host disconnected:", lastError.message)
    console.log("connection_lost", lastError?.message)
    nativePort = null
    if (wsReady && wsChannel) {
      activeTransport = "websocket"
      console.log("native host down but ws channel active, switching to websocket")
      return
    }
    if (activeTransport === "native") activeTransport = "none"
    for (const [id, req] of pendingRequests) {
      clearTimeout(req.timer)
      console.error(`orphaned request ${id} (${req.action}) — native port disconnected`)
      if (dyingPort) {
        try { dyingPort.postMessage({ id, result: { success: false, error: "native port disconnected" } }) } catch {}
      }
    }
    pendingRequests.clear()
    const jitter = Math.random() * reconnectDelay * 0.3
    setTimeout(connectToHost, reconnectDelay + jitter)
    reconnectDelay = Math.min(reconnectDelay * 2, 30000)
  })

  nativePort = port
  port.postMessage({ type: "ping" })
}

function startWsKeepAlive(): void {
  if (wsKeepAliveTimer) clearInterval(wsKeepAliveTimer)
  wsKeepAliveTimer = setInterval(() => {
    if (!wsChannel || wsChannel.readyState !== WebSocket.OPEN) {
      if (wsKeepAliveTimer) clearInterval(wsKeepAliveTimer)
      wsKeepAliveTimer = null
      return
    }
    try { wsChannel.send(JSON.stringify({ type: "keepalive", timestamp: Date.now() })) } catch {}
  }, 20_000)
}

function stopWsKeepAlive(): void {
  if (wsKeepAliveTimer) clearInterval(wsKeepAliveTimer)
  wsKeepAliveTimer = null
}

export function connectWsChannel(): void {
  if (wsChannel && (wsChannel.readyState === WebSocket.OPEN || wsChannel.readyState === WebSocket.CONNECTING)) return
  try {
    const ws = new WebSocket(WS_URL)
    ws.onopen = () => {
      wsChannel = ws
      wsReady = true
      ws.send(JSON.stringify({ type: "extension" }))
      startWsKeepAlive()
      console.log("ws channel connected")
      if (activeTransport !== "native") {
        activeTransport = "websocket"
        reconnectDelay = 1000
        isConnecting = false
        console.log("connection ready via ws channel")
        drainMessageQueue()
      }
    }
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : "")
        console.log("ws onmessage:", JSON.stringify(msg).slice(0, 200))
        if (msg.id && msg.action) {
          msg._viaWs = true
          handleDaemonMessage(msg)
        }
      } catch (err) {
        console.error("ws onmessage error:", err)
      }
    }
    ws.onclose = () => {
      stopWsKeepAlive()
      wsReady = false
      wsChannel = null
      if (activeTransport === "websocket") activeTransport = "none"
    }
    ws.onerror = () => {
      stopWsKeepAlive()
      wsReady = false
      wsChannel = null
      if (activeTransport === "websocket") activeTransport = "none"
    }
  } catch {}
}

export function registerAlarmListener(): void {
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 })
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "keepalive") return
    if (!nativePort) connectToHost()
    if (!wsChannel || wsChannel.readyState === WebSocket.CLOSED) connectWsChannel()
    if (activeTransport === "native" && nativePort) {
      nativePort.postMessage({ type: "ping" })
      keepalivePongTimer = setTimeout(() => {
        console.error("keepalive pong timeout (5s) — forcing reconnect")
        if (nativePort) nativePort.disconnect()
      }, 5000)
    }
  })
}
