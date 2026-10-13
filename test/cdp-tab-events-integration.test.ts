import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Raw CDP through the REAL daemon: a client on the IPC socket subscribes, a
// stand-in extension on the WebSocket answers and posts events, and the client
// reads them as frames on the socket it subscribed on. Covers what the pure
// helpers cannot: registration order, the close handler, and the WebSocket gate.

const REPO_ROOT = join(import.meta.dir, "..")
const WS_PORT = 19342

let workDir: string
let socketPath: string
let daemon: ReturnType<typeof Bun.spawn> | null = null

function frameMessage(value: unknown): Buffer {
  const encoded = Buffer.from(JSON.stringify(value), "utf-8")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(encoded.byteLength, 0)
  return Buffer.concat([header, encoded])
}

async function connectClient() {
  const messages: Array<Record<string, any>> = []
  let buffer = Buffer.alloc(0)
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_socket, chunk) {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)])
        while (buffer.length >= 4) {
          const len = buffer.readUInt32LE(0)
          if (buffer.length < 4 + len) break
          messages.push(JSON.parse(buffer.subarray(4, 4 + len).toString("utf-8")))
          buffer = buffer.subarray(4 + len)
        }
      },
    },
  })
  return { messages, send: (value: unknown) => socket.write(frameMessage(value)), close: () => socket.end() }
}

/** A stand-in for the extension: registers a context and records what the daemon asks of it. */
async function connectExtension(contextId: string) {
  const requests: Array<Record<string, any>> = []
  const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`)
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("ws failed")) })
  let registered = false
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data))
    if (msg.type === "context_registered") { registered = true; return }
    if (!msg.id || !msg.action) return
    requests.push(msg)
    const type = msg.action.type
    if (type === "cdp_tab_subscribe") {
      ws.send(JSON.stringify({ id: msg.id, result: { success: true, tabId: msg.tabId, data: { subscription: msg.action.subscription, tabId: msg.tabId, attached: true } } }))
    } else if (type === "cdp_tab_send") {
      ws.send(JSON.stringify({ id: msg.id, result: { success: true, tabId: msg.tabId, data: { echoed: msg.action.method } } }))
    } else {
      ws.send(JSON.stringify({ id: msg.id, result: { success: true, data: { gone: [] } } }))
    }
  }
  ws.send(JSON.stringify({ type: "extension", contextId }))
  await waitFor(() => registered)
  return { ws, requests, post: (value: unknown) => ws.send(JSON.stringify(value)), close: () => ws.close() }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await Bun.sleep(20)
  }
  return predicate()
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "interceptor-cdp-events-test-"))
  socketPath = join(workDir, "d.sock")
  daemon = Bun.spawn(["bun", "run", join(REPO_ROOT, "daemon", "index.ts"), "--standalone"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      INTERCEPTOR_TEMP: workDir,
      INTERCEPTOR_SOCKET_PATH: socketPath,
      INTERCEPTOR_IPC_PORT: "19341",
      INTERCEPTOR_WS_PORT: String(WS_PORT),
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  if (!await waitFor(() => existsSync(socketPath), 8000)) throw new Error("test daemon did not create its IPC socket")
})

afterAll(() => {
  try { daemon?.kill() } catch {}
  try { rmSync(workDir, { recursive: true, force: true }) } catch {}
})

describe("raw CDP event stream (daemon integration)", () => {
  test("subscribe, receive events in order on the same socket, send on it, and release on close", async () => {
    const extension = await connectExtension("cdp-test")
    const client = await connectClient()

    client.send({ id: "sub-1", action: { type: "cdp_tab_events", filter: ["Page."] }, tabId: 41, contextId: "cdp-test" })
    expect(await waitFor(() => client.messages.length === 1)).toBe(true)
    const opened = client.messages[0]
    expect(opened.id).toBe("sub-1")
    expect(opened.result).toMatchObject({ success: true, data: { tabId: 41, attached: true } })
    const subscription = opened.result.data.subscription as string
    expect(subscription).toMatch(/^[0-9a-f-]{36}$/)

    // The extension was asked to subscribe that tab, with the client's filter.
    const asked = extension.requests.find(r => r.action.type === "cdp_tab_subscribe")!
    expect(asked.tabId).toBe(41)
    expect(asked.action).toMatchObject({ subscription, filter: ["Page."] })

    // A screencast-sized frame, then a small one: both arrive whole and in order.
    const jpeg = "A".repeat(300_000)
    extension.post({ type: "cdp_event", subscriptions: [subscription], tabId: 41, method: "Page.screencastFrame", params: { data: jpeg, sessionId: 1 } })
    extension.post({ type: "cdp_event", subscriptions: [subscription, "someone-else"], tabId: 41, method: "Page.frameNavigated", params: { frame: { url: "https://example.test/" } } })
    expect(await waitFor(() => client.messages.length === 3)).toBe(true)
    expect(client.messages[1]).toEqual({ type: "cdp_event", subscription, tabId: 41, method: "Page.screencastFrame", params: { data: jpeg, sessionId: 1 } })
    expect(client.messages[2]).toMatchObject({ type: "cdp_event", subscription, method: "Page.frameNavigated" })

    // The same socket carries commands; the answer is matched by id.
    client.send({ id: "ack-1", action: { type: "cdp_tab_send", method: "Page.screencastFrameAck", params: { sessionId: 1 } }, tabId: 41, contextId: "cdp-test" })
    expect(await waitFor(() => client.messages.some(m => m.id === "ack-1"))).toBe(true)
    expect(client.messages.find(m => m.id === "ack-1")!.result).toMatchObject({ success: true, data: { echoed: "Page.screencastFrameAck" } })

    // Closing the socket is the unsubscribe.
    client.close()
    expect(await waitFor(() => extension.requests.some(r => r.action.type === "cdp_tab_unsubscribe"))).toBe(true)
    expect(extension.requests.find(r => r.action.type === "cdp_tab_unsubscribe")!.action.subscription).toBe(subscription)

    // Frames never reach the daemon's events file.
    const eventsFile = join(workDir, "interceptor-events.jsonl")
    if (existsSync(eventsFile)) expect(readFileSync(eventsFile, "utf-8")).not.toContain("screencastFrame")
    extension.close()
  })

  test("an event for a subscription nobody holds is dropped", async () => {
    const extension = await connectExtension("cdp-test-2")
    const client = await connectClient()
    client.send({ id: "sub-2", action: { type: "cdp_tab_events" }, tabId: 5, contextId: "cdp-test-2" })
    expect(await waitFor(() => client.messages.length === 1)).toBe(true)
    extension.post({ type: "cdp_event", subscriptions: ["not-a-subscription"], tabId: 5, method: "Page.loadEventFired", params: {} })
    await Bun.sleep(150)
    expect(client.messages).toHaveLength(1)
    client.close()
    extension.close()
  })

  test("the WebSocket refuses every raw CDP action", async () => {
    const extension = await connectExtension("cdp-test-3")
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`)
    const answers: Array<Record<string, any>> = []
    await new Promise<void>((resolve) => { ws.onopen = () => resolve() })
    ws.onmessage = (event) => answers.push(JSON.parse(String(event.data)))
    for (const type of ["cdp_tab_send", "cdp_tab_attach", "cdp_tab_events", "cdp_tab_subscribe"]) {
      ws.send(JSON.stringify({ id: `ws-${type}`, action: { type, method: "Runtime.evaluate", params: { expression: "document.cookie" } }, tabId: 1, contextId: "cdp-test-3" }))
    }
    expect(await waitFor(() => answers.length === 4)).toBe(true)
    for (const answer of answers) {
      expect(answer.result).toEqual({ success: false, code: "permission_denied", error: "raw CDP requires local IPC" })
    }
    expect(extension.requests.filter(r => String(r.action.type).startsWith("cdp_tab_"))).toEqual([])

    // A socket that never registered as an extension cannot post events either.
    const client = await connectClient()
    client.send({ id: "sub-3", action: { type: "cdp_tab_events" }, tabId: 1, contextId: "cdp-test-3" })
    expect(await waitFor(() => client.messages.length === 1)).toBe(true)
    ws.send(JSON.stringify({ type: "cdp_event", subscriptions: [client.messages[0].result.data.subscription], tabId: 1, method: "Page.loadEventFired", params: {} }))
    await Bun.sleep(150)
    expect(client.messages).toHaveLength(1)
    ws.close()
    client.close()
    extension.close()
  })
})
