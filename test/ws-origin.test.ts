import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Issue #274, against the REAL daemon: a web page can reach a loopback port,
// and the same-origin policy does not hold a WebSocket handshake back. The
// daemon answers by the Origin header: the extension and local programs are
// served, a web origin is refused before the upgrade.

const REPO_ROOT = join(import.meta.dir, "..")
// Ports distinct from the live daemon (19221/19222) and from the other
// scratch-daemon tests.
const IPC_PORT = 19361
const WS_PORT = 19362

let workDir: string
let daemon: ReturnType<typeof Bun.spawn> | null = null

const UPGRADE = "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"

type Reply = { status: number; body: string }

/**
 * One raw HTTP request on the WebSocket port. Raw sockets on purpose: another
 * test file's DOM globals replace fetch and WebSocket with versions that add
 * an Origin of their own. `afterUpgrade` is written once the daemon answers
 * 101, and the reply's body is then what the daemon sends back.
 */
function request(path: string, opts: { origin?: string; upgrade?: boolean; afterUpgrade?: Buffer } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0)
    let sentAfterUpgrade = false
    const timer = setTimeout(() => reject(new Error(`no reply for ${path}`)), 4000)
    const done = (socket: { end(): void }, reply: Reply) => { clearTimeout(timer); socket.end(); resolve(reply) }
    Bun.connect({
      hostname: "127.0.0.1",
      port: WS_PORT,
      socket: {
        open(socket) {
          socket.write(
            `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${WS_PORT}\r\n${opts.upgrade ? UPGRADE : "Connection: close\r\n"}`
            + `${opts.origin === undefined ? "" : `Origin: ${opts.origin}\r\n`}\r\n`,
          )
        },
        data(socket, chunk) {
          received = Buffer.concat([received, Buffer.from(chunk)])
          const headEnd = received.indexOf("\r\n\r\n")
          if (headEnd < 0) return
          const head = received.subarray(0, headEnd).toString("latin1")
          const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1])
          const body = received.subarray(headEnd + 4)
          if (status === 101 && opts.afterUpgrade) {
            if (!sentAfterUpgrade) { sentAfterUpgrade = true; socket.write(opts.afterUpgrade) }
            // An unmasked server text frame: 0x81, a length under 126, the payload.
            if (body.length >= 2 && body.length >= 2 + (body[1] & 0x7f)) done(socket, { status, body: body.subarray(2, 2 + (body[1] & 0x7f)).toString("utf-8") })
            return
          }
          const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0)
          if (status === 101 || body.length >= length) done(socket, { status, body: body.toString("utf-8") })
        },
        error(_socket, err) { clearTimeout(timer); reject(err) },
      },
    }).catch((err) => { clearTimeout(timer); reject(err) })
  })
}

const handshake = async (origin?: string): Promise<number> => (await request("/", { origin, upgrade: true })).status

/** A masked client text frame, as RFC 6455 requires from a client. */
function clientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf-8")
  const mask = Buffer.from([1, 2, 3, 4])
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]))])
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await Bun.sleep(50)
  }
  return predicate()
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "interceptor-ws-origin-test-"))
  const socketPath = join(workDir, "d.sock")
  daemon = Bun.spawn(["bun", "run", join(REPO_ROOT, "daemon", "index.ts"), "--standalone"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      INTERCEPTOR_TEMP: workDir,
      INTERCEPTOR_SOCKET_PATH: socketPath,
      INTERCEPTOR_IPC_PORT: String(IPC_PORT),
      INTERCEPTOR_WS_PORT: String(WS_PORT),
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  if (!await waitFor(() => existsSync(socketPath))) throw new Error("test daemon did not create its IPC socket")
  if (!await waitFor(() => request("/health").then(r => r.status === 200, () => false))) {
    throw new Error("test daemon did not open its WebSocket port")
  }
})

afterAll(() => {
  try { daemon?.kill() } catch {}
  try { rmSync(workDir, { recursive: true, force: true }) } catch {}
})

describe("the daemon's WebSocket port and the Origin header (daemon integration)", () => {
  test("a local program, which sends no Origin, is upgraded", async () => {
    expect(await handshake()).toBe(101)
  })

  test("the extension is upgraded", async () => {
    expect(await handshake("chrome-extension://gomcpnagjjlhehnkoobkjgnkbleiooed")).toBe(101)
    expect(await handshake("moz-extension://0b1f3c4e-9f6a-4d1b-8a52-3c2d1e0f9a8b")).toBe(101)
    expect(await handshake("safari-web-extension://A1B2C3D4-0000-1111-2222-333344445555")).toBe(101)
  })

  test("a web page is refused before the upgrade", async () => {
    for (const origin of ["https://evil.example", "http://localhost:3000", `http://127.0.0.1:${WS_PORT}`, "null", "file://"]) {
      expect(await handshake(origin)).toBe(403)
    }
  })

  test("/health follows the same rule", async () => {
    const local = await request("/health")
    expect(local.status).toBe(200)
    expect((JSON.parse(local.body) as { wsPort?: number }).wsPort).toBe(WS_PORT)
    expect((await request("/health", { origin: "https://evil.example" })).status).toBe(403)
  })

  test("an upgraded socket is served as before", async () => {
    const reply = await request("/", { upgrade: true, afterUpgrade: clientTextFrame(JSON.stringify({ type: "keepalive" })) })
    expect(reply.status).toBe(101)
    expect(JSON.parse(reply.body).type).toBe("keepalive_ack")
  })
})
