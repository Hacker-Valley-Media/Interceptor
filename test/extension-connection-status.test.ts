import { afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { ConnectionSnapshot } from "../extension/src/background/transport"

try { GlobalRegistrator.register() } catch { /* shared test DOM already registered */ }

type RuntimeListener = (message: any, sender: any, sendResponse: (response: unknown) => void) => boolean | void

class FakePort {
  messageListeners: Array<(message: any) => void> = []
  disconnectListeners: Array<() => void> = []
  sent: unknown[] = []
  onMessage = { addListener: (listener: (message: any) => void) => this.messageListeners.push(listener) }
  onDisconnect = { addListener: (listener: () => void) => this.disconnectListeners.push(listener) }
  postMessage = (message: unknown) => { this.sent.push(message) }
  disconnect = () => { for (const listener of [...this.disconnectListeners]) listener() }
  receive(message: unknown): void { for (const listener of [...this.messageListeners]) listener(message) }
}

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
  constructor(readonly url: string) { FakeWebSocket.instances.push(this) }
  send(data: string): void { this.sent.push(data) }
  close(): void { this.readyState = FakeWebSocket.CLOSED; this.onclose?.() }
}

const originalChrome = (globalThis as { chrome?: unknown }).chrome

function installChrome(options: { port?: FakePort; safariReply?: unknown } = {}): { listeners: RuntimeListener[]; chrome: Record<string, any> } {
  const listeners: RuntimeListener[] = []
  const addListener = () => {}
  const runtime: Record<string, any> = {
    id: "gomcpnagjjlhehnkoobkjgnkbleiooed",
    getManifest: () => ({ version: "0.26.5" }),
    onMessage: { addListener: (listener: RuntimeListener) => listeners.push(listener) },
  }
  if (options.port) runtime.connectNative = () => options.port
  if (options.safariReply) {
    runtime.sendNativeMessage = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return options.safariReply
    }
  }
  const chrome = {
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    runtime,
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener },
    },
    scripting: { unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
    tabs: { onActivated: { addListener }, onCreated: { addListener }, onRemoved: { addListener } },
    webNavigation: { getFrame: async () => undefined, onCommitted: { addListener }, onCompleted: { addListener } },
  }
  ;(globalThis as { chrome: unknown }).chrome = chrome
  return { listeners, chrome }
}

async function transport() {
  return import("../extension/src/background/transport")
}

afterEach(async () => {
  ;(await transport()).resetTransportForTesting()
  FakeWebSocket.instances = []
  if (originalChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
  else (globalThis as { chrome?: unknown }).chrome = originalChrome
})

describe("extension connection snapshots", () => {
  test("reports initial native connection work as connecting", async () => {
    installChrome({ port: new FakePort() })
    const module = await transport()
    module.connectToHost()
    expect(module.connectionSnapshot()).toEqual({ state: "connecting" })
  })

  test("reports a native handshake as connected", async () => {
    const port = new FakePort()
    installChrome({ port })
    const module = await transport()
    module.connectToHost()
    port.receive({ type: "pong" })
    expect(module.connectionSnapshot()).toEqual({ state: "connected", transport: "native" })
  })

  test("reports a registered WebSocket as connected and clears native failure", async () => {
    const { chrome } = installChrome({ port: new FakePort() })
    const module = await transport()
    module.connectToHost()
    chrome.runtime.lastError = { message: "native host failed" }
    module.nativePort?.disconnect()
    module.configureTransport({ contextId: "main", forceWebSocket: true, webSocketImpl: FakeWebSocket as unknown as typeof WebSocket })
    module.connectWsChannel()
    const socket = FakeWebSocket.instances[0]
    socket.readyState = FakeWebSocket.OPEN
    await socket.onopen?.()
    socket.onmessage?.({ data: JSON.stringify({ type: "context_registered", contextId: "main" }) })
    expect(module.connectionSnapshot()).toEqual({ state: "connected", transport: "websocket" })
  })

  test("reports a registered Safari native relay as connected", async () => {
    installChrome({ safariReply: { connected: true, messages: [{ type: "context_registered", contextId: "safari" }] } })
    const module = await transport()
    module.configureTransport({ contextId: "safari", safariNativeRelay: true })
    module.connectSafariNativeRelayChannel()
    for (let i = 0; i < 20 && module.connectionSnapshot().state !== "connected"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(module.connectionSnapshot()).toEqual({ state: "connected", transport: "safari-native" })
  })

  test("reports a generic native disconnect", async () => {
    const port = new FakePort()
    const { chrome } = installChrome({ port })
    const module = await transport()
    module.connectToHost()
    port.receive({ type: "pong" })
    chrome.runtime.lastError = { message: "Native host exited." }
    port.disconnect()
    expect(module.connectionSnapshot()).toEqual({ state: "disconnected", nativeError: "Native host exited." })
  })

  test("retains the native-host-not-found result", async () => {
    const port = new FakePort()
    const { chrome } = installChrome({ port })
    const module = await transport()
    module.connectToHost()
    chrome.runtime.lastError = { message: "Specified native messaging host not found." }
    port.disconnect()
    expect(module.connectionSnapshot()).toEqual({
      state: "disconnected",
      nativeError: "Specified native messaging host not found.",
    })
  })

  test("answers the namespaced runtime status request", async () => {
    const port = new FakePort()
    const { listeners } = installChrome({ port })
    const module = await transport()
    module.registerSwKeepaliveListener()
    module.connectToHost()
    port.receive({ type: "pong" })
    let response: unknown
    listeners[0]({ type: "interceptor_connection_status" }, {}, (value) => { response = value })
    expect(response).toEqual({ state: "connected", transport: "native" })
  })
})

async function popupRenderer() {
  document.body.innerHTML = '<label for="contextId">Context ID</label><input id="contextId"><button id="save"></button><button id="reset"></button><div id="status"></div>'
  const { chrome } = installChrome()
  chrome.runtime.sendMessage = async () => ({ state: "connected", transport: "native" })
  chrome.storage.local.remove = async () => {}
  const module = await import("../extension/src/popup")
  await new Promise((resolve) => setTimeout(resolve, 0))
  const health = document.createElement("div")
  document.body.appendChild(health)
  return { health, render: module.renderConnectionHealth, terminal: module.terminalConnectionSnapshot }
}

async function render(snapshot: ConnectionSnapshot) {
  const popup = await popupRenderer()
  popup.render(popup.health, snapshot)
  return popup
}

describe("popup connection health", () => {
  test("ends 21 consecutive connecting snapshots as disconnected", async () => {
    const { terminal } = await popupRenderer()
    let snapshot: ConnectionSnapshot = { state: "connecting" }
    for (let attempt = 0; attempt <= 20; attempt += 1) {
      snapshot = terminal({ state: "connecting" }, attempt === 20)
    }
    expect(snapshot).toEqual({ state: "disconnected" })
  })

  test("renders the connecting state", async () => {
    const { health } = await render({ state: "connecting" })
    expect(health.textContent).toContain("Checking Interceptor daemon...")
  })

  test("renders the native-connected state", async () => {
    const { health } = await render({ state: "connected", transport: "native" })
    expect(health.textContent).toContain("Interceptor daemon is healthy")
    expect(health.textContent).toContain("Native messaging")
  })

  test("renders the WebSocket-connected state", async () => {
    const { health } = await render({ state: "connected", transport: "websocket" })
    expect(health.textContent).toContain("WebSocket")
    expect(health.querySelector("a")).toBeNull()
  })

  test("renders the Safari-native-connected state", async () => {
    const { health } = await render({ state: "connected", transport: "safari-native" })
    expect(health.textContent).toContain("Safari native")
    expect(health.querySelector("a")).toBeNull()
  })

  test("renders a generic disconnected warning without a reinstall link", async () => {
    const { health } = await render({ state: "disconnected", nativeError: "Native host exited." })
    expect(health.getAttribute("role")).toBe("alert")
    expect(health.textContent).toContain("Interceptor daemon is not healthy")
    expect(health.querySelector("a")).toBeNull()
  })

  test("renders the missing-or-repair warning for native-host-not-found", async () => {
    const { health } = await render({ state: "disconnected", nativeError: "Specified native messaging host not found." })
    expect(health.textContent).toContain("Interceptor may not be installed")
    expect(health.querySelector("a")?.textContent).toBe("Download latest Interceptor")
  })

  test("uses a keyboard-focusable Releases link", async () => {
    const { health } = await render({ state: "disconnected", nativeError: "Specified native messaging host not found." })
    const link = health.querySelector("a")
    expect(link?.href).toBe("https://github.com/Hacker-Valley-Media/Interceptor/releases/latest")
    expect(link?.tabIndex).toBe(0)
    expect(link?.target).toBe("_blank")
  })

  test("keeps the health block and existing settings in the static popup", () => {
    const popupHtml = Bun.file(new URL("../extension/popup.html", import.meta.url)).text()
    return popupHtml.then((html) => {
      expect(html).toContain('id="connectionHealth"')
      expect(html).toContain('id="contextId"')
      expect(html).toContain('id="save"')
      expect(html).toContain('id="reset"')
      expect(html).toContain("prefers-color-scheme: dark")
    })
  })

  test("builds popup.js as a classic IIFE script", async () => {
    const build = await Bun.file(new URL("../scripts/build.sh", import.meta.url)).text()
    expect(build).toMatch(/popup\.ts[^\n]*--format=iife/)
  })

  test("keeps settings and live health in the Electron MV2 popup", async () => {
    const html = await Bun.file(new URL("../extension/dist-mv2/popup.html", import.meta.url)).text()
    expect(html).toContain('id="connectionHealth"')
    expect(html).toContain('<script src="popup.js"></script>')
    expect(await Bun.file(new URL("../extension/dist-mv2/popup.js", import.meta.url)).exists()).toBe(true)
    expect(html).toContain('id="contextId"')
  })
})
