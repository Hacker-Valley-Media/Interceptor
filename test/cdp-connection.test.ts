import { describe, expect, test } from "bun:test"
import { CdpConnection } from "../daemon/cdp/connection"

describe("CdpConnection", () => {
  test("sends a command and resolves the matching response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, s) { if (s.upgrade(req)) return undefined; return new Response("x") },
      websocket: {
        message(ws, raw) {
          const m = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString()) as { id: number; method: string }
          ws.send(JSON.stringify({ id: m.id, result: { echoed: m.method } }))
        },
      },
    })
    const conn = new CdpConnection(`ws://localhost:${server.port}/devtools/page/X`)
    await conn.connect()
    const r = await conn.send("Test.ping", {})
    expect(r.echoed).toBe("Test.ping")
    expect(conn.isOpen).toBe(true)
    conn.close()
    server.stop(true)
  })

  test("rejects pending commands and fires onClose when the socket closes (reconnect signal)", async () => {
    let closedReason = ""
    const server = Bun.serve({
      port: 0,
      fetch(req, s) { if (s.upgrade(req)) return undefined; return new Response("x") },
      websocket: { message() { /* never responds */ } },
    })
    const conn = new CdpConnection(`ws://localhost:${server.port}/devtools/page/Y`, { commandTimeoutMs: 8000 })
    conn.onClose((reason) => { closedReason = reason })
    await conn.connect()
    const pending = conn.send("Test.never", {})
    server.stop(true) // force-close the connection
    await expect(pending).rejects.toThrow()
    expect(closedReason.length).toBeGreaterThan(0)
    expect(conn.isOpen).toBe(false)
  })

  test("connect rejects on a dead port", async () => {
    const conn = new CdpConnection("ws://127.0.0.1:1/devtools/page/Z")
    await expect(conn.connect(1000)).rejects.toThrow()
  })
})
