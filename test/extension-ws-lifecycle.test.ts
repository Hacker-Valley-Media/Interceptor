import { afterEach, describe, expect, test } from "bun:test"

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void | Promise<void>) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }
}

const hadOriginalChrome = Object.prototype.hasOwnProperty.call(globalThis, "chrome")
const originalChrome = (globalThis as { chrome?: unknown }).chrome

function installFakeChrome(): void {
  const addListener = () => {}
  ;(globalThis as { chrome: unknown }).chrome = {
    action: {
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
    },
    runtime: {
      onMessage: { addListener },
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => { throw new Error("Safari storage unavailable during bootstrap") },
      },
    },
    scripting: {
      unregisterContentScripts: async () => {},
      registerContentScripts: async () => {},
    },
    tabs: {
      onActivated: { addListener },
      onCreated: { addListener },
      onRemoved: { addListener },
    },
    webNavigation: {
      getFrame: async () => undefined,
      onCommitted: { addListener },
      onCompleted: { addListener },
    },
  }
}

afterEach(async () => {
  const { resetTransportForTesting } = await import("../extension/src/background/transport")
  resetTransportForTesting()
  if (hadOriginalChrome) {
    ;(globalThis as { chrome?: unknown }).chrome = originalChrome
  } else {
    delete (globalThis as { chrome?: unknown }).chrome
  }
  FakeWebSocket.instances = []
})

describe("extension websocket lifecycle", () => {
  test("Safari-shaped startup registers the explicit context once without storage", async () => {
    installFakeChrome()

    const { configureTransport, connectWsChannel } = await import("../extension/src/background/transport")
    const { initializeActionRouter } = await import("../extension/src/background/router")

    expect(() => initializeActionRouter()).not.toThrow()
    configureTransport({
      contextId: "safari",
      forceWebSocket: true,
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })

    connectWsChannel()
    connectWsChannel()

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].url).toBe("ws://localhost:19222")
    expect(FakeWebSocket.instances[0].sent).toEqual([])

    FakeWebSocket.instances[0].readyState = FakeWebSocket.OPEN
    await FakeWebSocket.instances[0].onopen?.()

    expect(FakeWebSocket.instances[0].sent).toEqual([
      JSON.stringify({ type: "extension", contextId: "safari" }),
    ])
  })

  test("registration carries version, extension id, and install type when the host exposes them", async () => {
    installFakeChrome()
    const c = (globalThis as { chrome: Record<string, any> }).chrome
    c.runtime.id = "gomcpnagjjlhehnkoobkjgnkbleiooed"
    c.runtime.getManifest = () => ({ version: "0.25.0" })
    c.management = { getSelf: async () => ({ installType: "normal" }) }

    const { configureTransport, connectWsChannel } = await import("../extension/src/background/transport")
    configureTransport({ contextId: "main", forceWebSocket: true, webSocketImpl: FakeWebSocket as unknown as typeof WebSocket })
    connectWsChannel()
    FakeWebSocket.instances[0].readyState = FakeWebSocket.OPEN
    await FakeWebSocket.instances[0].onopen?.()

    expect(FakeWebSocket.instances[0].sent).toHaveLength(1)
    expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toEqual({
      type: "extension",
      contextId: "main",
      version: "0.25.0",
      extensionId: "gomcpnagjjlhehnkoobkjgnkbleiooed",
      installType: "normal",
    })
  })

  test("a registration overtaken during the identity lookup does not send its stale context", async () => {
    installFakeChrome()
    const c = (globalThis as { chrome: Record<string, any> }).chrome
    c.runtime.id = "gomcpnagjjlhehnkoobkjgnkbleiooed"
    c.runtime.getManifest = () => ({ version: "0.25.0" })
    const resolvers: Array<(info: { installType: string }) => void> = []
    c.management = { getSelf: () => new Promise((resolve) => { resolvers.push(resolve) }) }
    let onStorageChanged: ((changes: Record<string, { newValue?: unknown }>, area: string) => void) | undefined
    c.storage.onChanged = { addListener: (fn: typeof onStorageChanged) => { onStorageChanged = fn } }

    const { configureTransport, connectWsChannel, registerStorageContextListener } = await import("../extension/src/background/transport")
    configureTransport({ contextId: "main", forceWebSocket: true, webSocketImpl: FakeWebSocket as unknown as typeof WebSocket })
    registerStorageContextListener()
    connectWsChannel()
    const ws = FakeWebSocket.instances[0]
    ws.readyState = FakeWebSocket.OPEN
    const first = ws.onopen?.()
    while (resolvers.length < 1) await new Promise((r) => setTimeout(r, 0))

    // Rename lands while the first registration still waits on getSelf().
    onStorageChanged?.({ contextId: { newValue: "renamed" } }, "local")
    while (resolvers.length < 2) await new Promise((r) => setTimeout(r, 0))
    resolvers[1]({ installType: "development" })
    await new Promise((r) => setTimeout(r, 0))
    resolvers[0]({ installType: "development" })
    await first
    await new Promise((r) => setTimeout(r, 0))

    expect(ws.sent.map((m) => JSON.parse(m).contextId)).toEqual(["renamed"])
  })
})
