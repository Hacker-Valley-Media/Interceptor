import { describe, expect, test } from "bun:test"
import { DAEMON_HEALTH_SERVICE, LEGACY_HEALTH_BODY, decideDaemonRecovery, probeDaemonHealth } from "../shared/daemon-health"

// Fixtures speak raw HTTP over Bun.listen so they do not depend on the global
// Response class (happy-dom replaces it process-wide in the full suite).
function rawHttpServer(status: number, contentType: string, body: string) {
  const payload = Buffer.from(body, "utf-8")
  return Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {},
      data(socket, chunk) {
        if (!Buffer.from(chunk).toString("latin1").includes("\r\n\r\n")) return
        socket.write(`HTTP/1.1 ${status} X\r\nContent-Type: ${contentType}\r\nContent-Length: ${payload.byteLength}\r\nConnection: close\r\n\r\n`)
        socket.write(payload)
        socket.end()
      },
    },
  })
}

describe("probeDaemonHealth classifies whatever holds the singleton port", () => {
  test("nothing listening → free", async () => {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() {}, data() {} } })
    const port = probe.port
    probe.stop(true)
    expect(await probeDaemonHealth(port, 500)).toEqual({ state: "free" })
  })

  test("a self-healing daemon → interceptor with pid, version, healed", async () => {
    const server = rawHttpServer(200, "application/json;charset=utf-8", JSON.stringify({ service: DAEMON_HEALTH_SERVICE, pid: 4242, version: "9.9.9", wsPort: 1, healed: ["pid", 7, "socket"] }))
    try {
      expect(await probeDaemonHealth(server.port, 500)).toEqual({ state: "interceptor", pid: 4242, version: "9.9.9", healed: ["pid", "socket"] })
    } finally {
      server.stop(true)
    }
  })

  test("a pre-heal daemon answers every path with text → legacy", async () => {
    const server = rawHttpServer(200, "text/plain;charset=utf-8", LEGACY_HEALTH_BODY)
    try {
      expect(await probeDaemonHealth(server.port, 500)).toEqual({ state: "legacy" })
    } finally {
      server.stop(true)
    }
  })

  test("another HTTP service → foreign", async () => {
    const server = rawHttpServer(404, "text/html", "<html>nope</html>")
    try {
      expect(await probeDaemonHealth(server.port, 500)).toEqual({ state: "foreign", detail: "HTTP 404 <html>nope</html>" })
    } finally {
      server.stop(true)
    }
  })

  test("a listener that never answers → foreign on timeout", async () => {
    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() {}, data() {} } })
    try {
      expect(await probeDaemonHealth(silent.port, 200)).toEqual({ state: "foreign", detail: "no reply within 200ms" })
    } finally {
      silent.stop(true)
    }
  })

  test("a peer that closes without answering → foreign", async () => {
    const rude = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(socket) { socket.end() }, data() {} } })
    try {
      expect(await probeDaemonHealth(rude.port, 500)).toEqual({ state: "foreign", detail: "connection closed before an HTTP response" })
    } finally {
      rude.stop(true)
    }
  })
})

describe("decideDaemonRecovery never spawns or unlinks against a held port", () => {
  const log = "/tmp/x.log"
  test("ready after the probe → connect, regardless of probe state", () => {
    expect(decideDaemonRecovery({ state: "interceptor", pid: 1, version: "v", healed: ["pid"] }, true, 19222, log)).toEqual({ action: "connect" })
    expect(decideDaemonRecovery({ state: "free" }, true, 19222, log)).toEqual({ action: "connect" })
  })
  test("free port → spawn", () => {
    expect(decideDaemonRecovery({ state: "free" }, false, 19222, log)).toEqual({ action: "spawn" })
  })
  test("owner that could not heal → fail naming pid, version, log", () => {
    const r = decideDaemonRecovery({ state: "interceptor", pid: 77, version: "0.23.28", healed: [] }, false, 19222, log)
    expect(r.action).toBe("fail")
    expect((r as { message: string }).message).toContain("pid 77 (0.23.28)")
    expect((r as { message: string }).message).toContain(log)
  })
  test("legacy owner → fail with the kill recipe", () => {
    const r = decideDaemonRecovery({ state: "legacy" }, false, 19222, log)
    expect(r.action).toBe("fail")
    expect((r as { message: string }).message).toContain("lsof -t -nP -iTCP:19222")
  })
  test("foreign owner → fail naming the port override", () => {
    const r = decideDaemonRecovery({ state: "foreign", detail: "HTTP 404" }, false, 19222, log)
    expect(r.action).toBe("fail")
    expect((r as { message: string }).message).toContain("INTERCEPTOR_WS_PORT")
    expect((r as { message: string }).message).toContain("HTTP 404")
  })
})
