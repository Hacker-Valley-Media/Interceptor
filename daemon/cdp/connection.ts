/**
 * daemon/cdp/connection.ts — an outbound CDP WebSocket client to a single
 * debuggable target (Path A) or to a Node main-process inspector (bootstrap).
 *
 * CDP wire format (flat session model):
 *   command  -> { id, method, params, sessionId? }
 *   response <- { id, result } | { id, error }
 *   event    <- { method, params, sessionId? }
 *
 * No Origin header is sent: Bun's WebSocket client does not add one, so the
 * DevTools --remote-allow-origins check never rejects us.
 */

export type CdpEventHandler = (method: string, params: Record<string, unknown>, sessionId?: string) => void

type Pending = {
  resolve: (result: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class CdpConnection {
  readonly wsUrl: string
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private eventHandlers = new Set<CdpEventHandler>()
  private closeHandlers = new Set<(reason: string) => void>()
  private opened = false
  private closed = false
  private readonly commandTimeoutMs: number

  constructor(wsUrl: string, opts: { commandTimeoutMs?: number } = {}) {
    this.wsUrl = wsUrl
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 30_000
  }

  get isOpen(): boolean {
    return this.opened && !this.closed && this.ws?.readyState === WebSocket.OPEN
  }

  connect(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let ws: WebSocket
      try {
        ws = new WebSocket(this.wsUrl)
      } catch (err) {
        reject(new Error(`failed to open CDP websocket: ${(err as Error).message}`))
        return
      }
      this.ws = ws
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          try { ws.close() } catch {}
          reject(new Error(`CDP websocket connect timeout (${timeoutMs}ms) to ${this.wsUrl}`))
        }
      }, timeoutMs)

      ws.onopen = () => {
        this.opened = true
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve()
        }
      }
      ws.onmessage = (event) => this.onMessage(event)
      ws.onclose = () => {
        clearTimeout(timer)
        this.handleClosed("websocket closed")
        if (!settled) {
          settled = true
          // A close before open usually means a 403 (origin rejection) or the
          // target vanished. Surface an actionable hint.
          reject(new Error(`CDP websocket closed before open (${this.wsUrl}) — target gone or origin rejected (--remote-allow-origins)`))
        }
      }
      ws.onerror = () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          try { ws.close() } catch {}
          reject(new Error(`CDP websocket error connecting to ${this.wsUrl}`))
        }
      }
    })
  }

  private onMessage(event: MessageEvent): void {
    let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string }
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : "")
    } catch {
      return
    }
    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message || "CDP error"))
      else pending.resolve(msg.result ?? {})
      return
    }
    if (typeof msg.method === "string") {
      for (const handler of this.eventHandlers) {
        try { handler(msg.method, msg.params ?? {}, msg.sessionId) } catch {}
      }
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.isOpen || !this.ws) {
        reject(new Error("CDP connection is not open"))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command timeout: ${method}`))
      }, this.commandTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const payload: Record<string, unknown> = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`CDP send failed: ${(err as Error).message}`))
      }
    })
  }

  onEvent(handler: CdpEventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandlers.add(handler)
  }

  private handleClosed(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.opened = false
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`CDP connection closed: ${reason}`))
    }
    this.pending.clear()
    for (const handler of this.closeHandlers) {
      try { handler(reason) } catch {}
    }
  }

  close(): void {
    if (this.ws) {
      try { this.ws.close() } catch {}
    }
    this.handleClosed("closed by daemon")
  }
}
