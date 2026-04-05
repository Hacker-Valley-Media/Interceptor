/**
 * cli/transport.ts — sendCommand (Unix socket / TCP) and sendCommandWs (WebSocket)
 */

import { connectOptions, WS_PORT } from "../shared/platform"

export const SLOP_TIMEOUT_MS = parseInt(process.env.SLOP_TIMEOUT || "15000")

export type Action = { type: string; [key: string]: unknown }
export type DaemonResponse = {
  id: string
  result: { success: boolean; error?: string; data?: unknown; tabId?: number }
}

export function sendCommand(action: Action, tabId?: number): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const shortId = id.slice(0, 8)
    process.stderr.write(`[${shortId}] → ${action.type}\n`)
    let buffer = Buffer.alloc(0)
    let resolved = false
    let socketRef: ReturnType<Awaited<ReturnType<typeof Bun.connect>>> | null = null

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        if (socketRef) try { socketRef.end() } catch {}
        reject(new Error("timeout: no response from daemon after " + (SLOP_TIMEOUT_MS / 1000) + "s. Ensure Chrome/Brave is open with the slop-browser extension loaded."))
      }
    }, SLOP_TIMEOUT_MS)

    Bun.connect(connectOptions({
      open(socket) {
        socketRef = socket
        const payload = JSON.stringify({ id, action, ...(tabId !== undefined && { tabId }) })
        const encoded = Buffer.from(payload, "utf-8")
        const header = Buffer.alloc(4)
        header.writeUInt32LE(encoded.byteLength, 0)
        socket.write(Buffer.concat([header, encoded]))
      },
      data(_socket, raw) {
        buffer = Buffer.concat([buffer, Buffer.from(raw)])
        if (buffer.length >= 4) {
          const msgLen = buffer.readUInt32LE(0)
          if (msgLen > 0 && msgLen <= 1024 * 1024 && buffer.length >= 4 + msgLen) {
            const json = buffer.subarray(4, 4 + msgLen).toString("utf-8")
            clearTimeout(timer)
            try {
              resolved = true
              resolve(JSON.parse(json))
            } catch {
              resolved = true
              reject(new Error("invalid response from daemon"))
            }
            _socket.end()
          }
        }
      },
      close() {
        clearTimeout(timer)
        if (!resolved) {
          reject(new Error("connection closed before response"))
        }
      },
      connectError(_socket, _err) {
        clearTimeout(timer)
        reject(new Error("daemon not running. Open Chrome with the slop-browser extension loaded."))
      },
      error(_socket, err) {
        clearTimeout(timer)
        reject(err)
      }
    }))
  })
}

export function sendCommandWs(action: Action, tabId?: number): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const shortId = id.slice(0, 8)
    process.stderr.write(`[${shortId}] →ws ${action.type}\n`)

    const timer = setTimeout(() => {
      reject(new Error("timeout: no response from daemon after " + (SLOP_TIMEOUT_MS / 1000) + "s via WebSocket."))
    }, SLOP_TIMEOUT_MS)

    const ws = new WebSocket(`ws://localhost:${WS_PORT}`)
    ws.onopen = () => {
      ws.send(JSON.stringify({ id, action, ...(tabId !== undefined && { tabId }) }))
    }
    ws.onmessage = (event) => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(typeof event.data === "string" ? event.data : ""))
      } catch {
        reject(new Error("invalid response from daemon via WebSocket"))
      }
      ws.close()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error("WebSocket connection failed to daemon"))
    }
    ws.onclose = () => {
      clearTimeout(timer)
    }
  })
}
