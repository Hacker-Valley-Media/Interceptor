import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Integration regression for the keepalive pong-timeout reconnect loop:
// exercises the REAL daemon wiring (registration at the IPC socket, the
// close(socket) handler, and the pong-to-origin write) rather than the
// extracted helpers. Scenario that used to fail: relay A registers, relay B
// supersedes it, A's lingering process dies — the old close handler nulled
// the slot unconditionally, so B's next keepalive pong was silently queued
// for ws and the extension force-reconnected forever.

const REPO_ROOT = join(import.meta.dir, "..")

let workDir: string
let daemon: ReturnType<typeof Bun.spawn> | null = null
let socketPath: string

function frameMessage(json: string): Buffer {
  const encoded = Buffer.from(json, "utf-8")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(encoded.byteLength, 0)
  return Buffer.concat([header, encoded])
}

interface RelayConn {
  socket: Awaited<ReturnType<typeof Bun.connect>>
  messages: Array<Record<string, unknown>>
  close(): void
}

async function connectRelay(): Promise<RelayConn> {
  const messages: Array<Record<string, unknown>> = []
  let buffer = Buffer.alloc(0)
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_socket, chunk) {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)])
        while (buffer.length >= 4) {
          const len = buffer.readUInt32LE(0)
          if (buffer.length < 4 + len) break
          const body = buffer.subarray(4, 4 + len).toString("utf-8")
          buffer = buffer.subarray(4 + len)
          try { messages.push(JSON.parse(body)) } catch {}
        }
      },
    },
  })
  return {
    socket,
    messages,
    close() { socket.end() },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await Bun.sleep(25)
  }
  return predicate()
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "interceptor-clobber-test-"))
  socketPath = join(workDir, "d.sock")
  daemon = Bun.spawn(["bun", "run", join(REPO_ROOT, "daemon", "index.ts"), "--standalone"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      INTERCEPTOR_TEMP: workDir,
      INTERCEPTOR_SOCKET_PATH: socketPath,
      // Ports distinct from the live daemon (19221/19222) so the test never
      // loses the singleton gate to a real running instance.
      INTERCEPTOR_IPC_PORT: "19321",
      INTERCEPTOR_WS_PORT: "19322",
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  const up = await waitFor(() => existsSync(socketPath), 8000)
  if (!up) throw new Error("test daemon did not create its IPC socket")
})

afterAll(() => {
  try { daemon?.kill() } catch {}
  try { rmSync(workDir, { recursive: true, force: true }) } catch {}
})

describe("relay supersede wiring (daemon integration)", () => {
  test("stale relay close does not starve the live relay's keepalive pong", async () => {
    // Relay A registers.
    const relayA = await connectRelay()
    relayA.socket.write(frameMessage(JSON.stringify({ type: "native-relay" })))
    // A proves the link works: ping → pong on A.
    relayA.socket.write(frameMessage(JSON.stringify({ type: "ping" })))
    expect(await waitFor(() => relayA.messages.some(m => m.type === "pong"))).toBe(true)
    // The pong names the singleton's per-user WebSocket port (the test pins it via env).
    expect((relayA.messages.find(m => m.type === "pong") as { wsPort?: number }).wsPort).toBe(19322)

    // Relay B supersedes A (extension reconnect / second browser).
    const relayB = await connectRelay()
    relayB.socket.write(frameMessage(JSON.stringify({ type: "native-relay" })))

    // A's lingering process finally dies AFTER B registered.
    relayA.close()
    await Bun.sleep(150)

    // THE regression: B's keepalive must still be answered on B.
    relayB.socket.write(frameMessage(JSON.stringify({ type: "ping" })))
    const bGotPong = await waitFor(() => relayB.messages.some(m => m.type === "pong"))
    expect(bGotPong).toBe(true)

    relayB.close()
  })

  test("ping is answered on the originating socket even when it does not hold the slot", async () => {
    // C registers, then D supersedes — C stays connected (dual-browser case).
    const relayC = await connectRelay()
    relayC.socket.write(frameMessage(JSON.stringify({ type: "native-relay" })))
    const relayD = await connectRelay()
    relayD.socket.write(frameMessage(JSON.stringify({ type: "native-relay" })))
    await Bun.sleep(100)

    // C no longer holds the slot, but its keepalive must be answered on C —
    // liveness is a link property, not a routing-slot property.
    relayC.socket.write(frameMessage(JSON.stringify({ type: "ping" })))
    const cGotPong = await waitFor(() => relayC.messages.some(m => m.type === "pong"))
    expect(cGotPong).toBe(true)

    relayC.close()
    relayD.close()
  })
})
