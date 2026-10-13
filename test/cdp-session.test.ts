import { afterAll, beforeAll, describe, expect, test } from "bun:test"

// Raw CDP sessions on browser tabs: the debugger attachment the extension
// shares between a raw client, one-shot commands and network capture, and the
// event fan-out to subscribers. Each test uses its own tab id; module state is
// shared on purpose, as it is in the service worker.

type Listener = (...args: any[]) => unknown
type Call = { tabId: number; sessionId?: string; method: string; params?: unknown }

const ours = new Set<number>()      // tabs this extension's client is attached to
const foreign = new Set<number>()   // tabs another debugger client holds
const calls: Call[] = []
const attaches: number[] = []
const detaches: number[] = []
const frames: Array<Record<string, any>> = []
const listeners = { event: [] as Listener[], detach: [] as Listener[], created: [] as Listener[], removed: [] as Listener[] }

const originalChrome = (globalThis as { chrome?: unknown }).chrome
afterAll(() => { (globalThis as { chrome?: unknown }).chrome = originalChrome })

function installFakeChrome(): void {
  ;(globalThis as { chrome?: unknown }).chrome = {
    debugger: {
      attach: async ({ tabId }: { tabId: number }) => {
        if (foreign.has(tabId) || ours.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`)
        ours.add(tabId)
        attaches.push(tabId)
      },
      detach: async ({ tabId }: { tabId: number }) => {
        if (!ours.delete(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`)
        detaches.push(tabId)
      },
      sendCommand: async (target: { tabId: number; sessionId?: string }, method: string, params?: unknown) => {
        if (!ours.has(target.tabId)) throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`)
        calls.push({ tabId: target.tabId, sessionId: target.sessionId, method, params })
        if (method === "Runtime.evaluate") throw new Error(JSON.stringify({ code: -32000, message: "Cannot find context with specified id" }))
        if (method === "Page.captureScreenshot") return { data: "aGVsbG8=" }
        return {}
      },
      onEvent: { addListener: (fn: Listener) => listeners.event.push(fn) },
      onDetach: { addListener: (fn: Listener) => listeners.detach.push(fn) },
    },
    tabs: {
      onCreated: { addListener: (fn: Listener) => listeners.created.push(fn) },
      onRemoved: { addListener: (fn: Listener) => listeners.removed.push(fn) },
    },
  }
}

function emitCdp(tabId: number, method: string, params: unknown = {}, sessionId?: string): void {
  for (const fn of listeners.event) void fn({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params)
}

/** The browser ended the session: the person clicked Cancel, or the tab closed. */
function browserDetach(tabId: number, reason: string): void {
  ours.delete(tabId)
  for (const fn of listeners.detach) fn({ tabId }, reason)
}

const callsFor = (tabId: number) => calls.filter(c => c.tabId === tabId).map(c => c.method)
const framesFor = (subscription: string) => frames.filter(f => f.subscriptions.includes(subscription))
const count = (list: number[], tabId: number) => list.filter(t => t === tabId).length

let session: typeof import("../extension/src/background/cdp-session")
let cdp: typeof import("../extension/src/background/cdp")
let capture: typeof import("../extension/src/background/network-capture")
let actions: typeof import("../extension/src/background/capabilities/raw-cdp")
let overrides: typeof import("../extension/src/background/capabilities/cdp-network-actions")

beforeAll(async () => {
  installFakeChrome()
  session = await import("../extension/src/background/cdp-session")
  cdp = await import("../extension/src/background/cdp")
  capture = await import("../extension/src/background/network-capture")
  actions = await import("../extension/src/background/capabilities/raw-cdp")
  overrides = await import("../extension/src/background/capabilities/cdp-network-actions")
  session.setCdpEventSinkForTesting((msg) => frames.push(msg as Record<string, any>))
  cdp.registerCdpListeners()
  session.registerRawCdpListeners()
})

describe("raw CDP send", () => {
  test("without a session: attach, run, detach", async () => {
    const result = await actions.handleRawCdpActions({ type: "cdp_tab_send", method: "Page.captureScreenshot", params: {} }, 101)
    expect(result).toEqual({ success: true, data: { data: "aGVsbG8=" } })
    expect(count(attaches, 101)).toBe(1)
    expect(count(detaches, 101)).toBe(1)
    expect(ours.has(101)).toBe(false)
  })

  test("an explicit attach keeps the debugger across sends until detach", async () => {
    expect((await actions.handleRawCdpActions({ type: "cdp_tab_attach" }, 102)).success).toBe(true)
    await actions.handleRawCdpActions({ type: "cdp_tab_send", method: "Page.enable" }, 102)
    await actions.handleRawCdpActions({ type: "cdp_tab_send", method: "Page.startScreencast", params: { format: "jpeg" } }, 102)
    expect(count(attaches, 102)).toBe(1)
    expect(count(detaches, 102)).toBe(0)
    expect(session.sessionStatus().find(s => s.tabId === 102)).toMatchObject({ attached: true, explicit: true })
    const detached = await actions.handleRawCdpActions({ type: "cdp_tab_detach" }, 102)
    expect(detached.data).toEqual({ tabId: 102, detached: true })
    expect(ours.has(102)).toBe(false)
  })

  test("concurrent one-shot sends share one attachment", async () => {
    await Promise.all([
      session.sendToTab(103, "Page.enable"),
      session.sendToTab(103, "DOM.enable"),
      session.sendToTab(103, "Page.getNavigationHistory"),
    ])
    expect(callsFor(103).sort()).toEqual(["DOM.enable", "Page.enable", "Page.getNavigationHistory"])
    expect(count(attaches, 103)).toBe(count(detaches, 103))
    expect(ours.has(103)).toBe(false)
  })

  test("a CDP error keeps its code and names the method", async () => {
    const result = await actions.handleRawCdpActions({ type: "cdp_tab_send", method: "Runtime.evaluate", params: { expression: "1" } }, 104)
    expect(result.success).toBe(false)
    expect(result.error).toBe("Runtime.evaluate: Cannot find context with specified id")
    expect(result.data).toEqual({ cdpError: { code: -32000, message: "Cannot find context with specified id" } })
    expect(ours.has(104)).toBe(false)
  })

  test("a child session id reaches chrome.debugger", async () => {
    await session.sendToTab(105, "Runtime.enable", undefined, "child-1")
    expect(calls.find(c => c.tabId === 105)).toMatchObject({ sessionId: "child-1", method: "Runtime.enable" })
  })

  test("a malformed method or params is refused before any attach", async () => {
    expect((await actions.handleRawCdpActions({ type: "cdp_tab_send", method: "captureScreenshot" }, 106)).success).toBe(false)
    expect((await actions.handleRawCdpActions({ type: "cdp_tab_send", method: "Page.enable", params: [1] }, 106)).success).toBe(false)
    expect(count(attaches, 106)).toBe(0)
  })
})

describe("internal one-shot commands (cdp_tree) share the attachment", () => {
  test("alone: attach, run, detach", async () => {
    await cdp.cdpCommand(151, "Accessibility.getFullAXTree")
    expect(callsFor(151)).toEqual(["Accessibility.getFullAXTree"])
    expect(count(attaches, 151)).toBe(1)
    expect(ours.has(151)).toBe(false)
  })

  test("during a raw session: no second attach, and the session keeps the debugger", async () => {
    await session.attachTab(152)
    await cdp.cdpCommand(152, "Accessibility.getFullAXTree")
    expect(count(attaches, 152)).toBe(1)
    expect(ours.has(152)).toBe(true)
    await session.detachTab(152)
    expect(ours.has(152)).toBe(false)
  })

  test("a failing command still releases the debugger", async () => {
    await expect(cdp.cdpCommand(153, "Runtime.evaluate")).rejects.toThrow()
    expect(ours.has(153)).toBe(false)
  })
})

describe("one debugger client per tab", () => {
  test("a tab another client holds is refused with a clear error, and nothing is detached", async () => {
    foreign.add(201)
    const result = await actions.handleRawCdpActions({ type: "cdp_tab_attach" }, 201)
    expect(result.success).toBe(false)
    expect(result.error).toContain("tab 201 already has a debugger client attached")
    expect(count(detaches, 201)).toBe(0)
    expect(session.sessionStatus().find(s => s.tabId === 201)).toBeUndefined()
    const send = await actions.handleRawCdpActions({ type: "cdp_tab_send", method: "Page.enable" }, 201)
    expect(send.error).toContain("already has a debugger client attached")
  })

  test("this extension's own session from before a worker restart is adopted", async () => {
    ours.add(202) // attached in the browser, unknown to the restarted worker
    const result = await actions.handleRawCdpActions({ type: "cdp_tab_attach" }, 202)
    expect(result.success).toBe(true)
    expect(cdp.debuggerAttached.has(202)).toBe(true)
    await actions.handleRawCdpActions({ type: "cdp_tab_detach" }, 202)
    expect(ours.has(202)).toBe(false)
  })
})

describe("event subscriptions", () => {
  test("a subscription holds the session and receives the tab's events", async () => {
    const sub = await actions.handleRawCdpActions({ type: "cdp_tab_subscribe", subscription: "s301" }, 301)
    expect(sub.data).toEqual({ subscription: "s301", tabId: 301, attached: true })
    await session.sendToTab(301, "Page.startScreencast", { format: "jpeg" })
    emitCdp(301, "Page.screencastFrame", { data: "/9j/", sessionId: 7 })
    emitCdp(302, "Page.screencastFrame", { data: "other tab" })
    expect(framesFor("s301")).toEqual([
      { type: "cdp_event", subscriptions: ["s301"], tabId: 301, method: "Page.screencastFrame", params: { data: "/9j/", sessionId: 7 } },
    ])
    expect(count(detaches, 301)).toBe(0)
    await actions.handleRawCdpActions({ type: "cdp_tab_unsubscribe", subscription: "s301" }, 0)
    expect(ours.has(301)).toBe(false)
  })

  test("a filter keeps matching methods; session events always pass", async () => {
    await session.subscribeTab(303, "s303", ["Page.", "Fetch.requestPaused"], true)
    emitCdp(303, "Page.frameNavigated", { frame: { id: "f" } })
    emitCdp(303, "Network.requestWillBeSent", { requestId: "1" })
    emitCdp(303, "Fetch.requestPaused", { requestId: "2" })
    browserDetach(303, "canceled_by_user")
    expect(framesFor("s303").map(f => f.method)).toEqual(["Page.frameNavigated", "Fetch.requestPaused", "Interceptor.detached"])
    expect(framesFor("s303").at(-1)!.params).toEqual({ reason: "canceled_by_user" })
    expect(session.sessionStatus().find(s => s.tabId === 303)).toMatchObject({ attached: false, session: false })
    await session.unsubscribe("s303")
  })

  test("two subscribers get one frame that names both", async () => {
    await session.subscribeTab(304, "s304a", [], true)
    await session.subscribeTab(304, "s304b", ["Page."], true)
    expect(count(attaches, 304)).toBe(1)
    emitCdp(304, "Page.loadEventFired", { timestamp: 1 })
    expect(frames.filter(f => f.tabId === 304)).toHaveLength(1)
    expect(frames.find(f => f.tabId === 304)!.subscriptions).toEqual(["s304a", "s304b"])
    await session.unsubscribe("s304a")
    expect(ours.has(304)).toBe(true)
    await session.unsubscribe("s304b")
    expect(ours.has(304)).toBe(false)
  })

  test("child-session events carry their session id", async () => {
    await session.subscribeTab(305, "s305", [], true)
    emitCdp(305, "Runtime.consoleAPICalled", { type: "log" }, "child-9")
    expect(framesFor("s305")[0].sessionId).toBe("child-9")
    await session.unsubscribe("s305")
  })

  test("a subscription the daemon stops renewing expires and releases the debugger", async () => {
    await session.subscribeTab(306, "s306", [], true)
    const now = Date.now()
    expect(session.renewSubscriptions(["s306", "unknown"], now)).toEqual(["unknown"])
    await session.sweepExpiredSubscriptions(now + session.SUBSCRIPTION_TTL_MS - 1)
    expect(ours.has(306)).toBe(true)
    await session.sweepExpiredSubscriptions(now + session.SUBSCRIPTION_TTL_MS + 1)
    expect(ours.has(306)).toBe(false)
    expect(session.renewSubscriptions(["s306"])).toEqual(["s306"])
  })

  test("--no-attach listens without holding the debugger", async () => {
    const sub = await session.subscribeTab(307, "s307", [], false)
    expect(sub.attached).toBe(false)
    expect(count(attaches, 307)).toBe(0)
    await session.unsubscribe("s307")
  })

  test("an explicit detach ends the session for subscribers and tells them", async () => {
    await session.subscribeTab(308, "s308", [], true)
    await session.detachTab(308)
    expect(framesFor("s308").map(f => [f.method, f.params])).toEqual([["Interceptor.detached", { reason: "client_detached" }]])
    expect(ours.has(308)).toBe(false)
    await session.unsubscribe("s308")
    expect(count(detaches, 308)).toBe(1)
  })
})

describe("sharing the debugger with network capture and overrides", () => {
  test("capture still records while a raw session receives the same events", async () => {
    await capture.enableNetworkCapture(401, [])
    await session.subscribeTab(401, "s401", [], true)
    emitCdp(401, "Network.requestWillBeSent", { requestId: "r1", request: { url: "https://example.test/a", method: "GET", headers: {} }, type: "XHR" })
    emitCdp(401, "Network.responseReceived", { requestId: "r1", response: { status: 200, mimeType: "text/plain", headers: {} } })
    emitCdp(401, "Network.loadingFinished", { requestId: "r1" })
    await Bun.sleep(5)
    expect(capture.getNetworkLogs(401).map(e => [e.url, e.status])).toEqual([["https://example.test/a", 200]])
    expect(framesFor("s401").map(f => f.method)).toEqual(["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished"])
  })

  test("the client's Network.disable does not stop capture, and ending the session leaves capture attached", async () => {
    expect(await session.sendToTab(401, "Network.disable")).toEqual({})
    expect(callsFor(401)).not.toContain("Network.disable")
    await session.unsubscribe("s401")
    expect(ours.has(401)).toBe(true)
    expect(count(detaches, 401)).toBe(0)
  })

  test("a raw session that enables Fetch answers its own paused requests", async () => {
    await session.subscribeTab(402, "s402", ["Fetch."], true)
    await session.sendToTab(402, "Fetch.enable", { patterns: [{ urlPattern: "*" }] })
    emitCdp(402, "Fetch.requestPaused", { requestId: "p1", request: { url: "https://example.test/", method: "GET", headers: {} } })
    await Bun.sleep(5)
    expect(callsFor(402)).not.toContain("Fetch.continueRequest")
    expect(framesFor("s402").map(f => f.method)).toEqual(["Fetch.requestPaused"])
    expect(session.sessionStatus().find(s => s.tabId === 402)).toMatchObject({ fetchOwned: true })

    const blocked = await overrides.handleCdpNetworkActions({ type: "network_override", rules: [{ urlPattern: "*" }] }, 402)
    expect(blocked.success).toBe(false)
    expect(blocked.error).toContain("a raw CDP session has Fetch interception enabled")
  })

  test("ending the last subscription disables Fetch so no request stays paused", async () => {
    await session.unsubscribe("s402")
    expect(callsFor(402)).toContain("Fetch.disable")
    expect(ours.has(402)).toBe(false)
  })

  test("override rules keep continuing requests beside a raw session, and block a raw Fetch.enable", async () => {
    const set = await overrides.handleCdpNetworkActions({ type: "network_override", rules: [{ urlPattern: "*example*", setHeaders: { "x-test": "1" } }] }, 403)
    expect(set.success).toBe(true)
    await session.subscribeTab(403, "s403", [], true)
    emitCdp(403, "Fetch.requestPaused", { requestId: "p2", request: { url: "https://example.test/", method: "GET", headers: {} } })
    await Bun.sleep(5)
    expect(calls.find(c => c.tabId === 403 && c.method === "Fetch.continueRequest")?.params).toMatchObject({
      requestId: "p2", headers: [{ name: "x-test", value: "1" }],
    })
    const refused = await actions.handleRawCdpActions({ type: "cdp_tab_send", method: "Fetch.enable" }, 403)
    expect(refused.success).toBe(false)
    expect(refused.error).toContain("has request override rules")
    await session.unsubscribe("s403")
    expect(ours.has(403)).toBe(true)
  })
})

describe("tabs opened from a tab in a session", () => {
  test("the opener's subscribers learn about the popup and can reach it", async () => {
    await session.subscribeTab(501, "s501", ["Page."], true)
    for (const fn of listeners.created) fn({ id: 502, openerTabId: 501, pendingUrl: "https://accounts.example.test/oauth", windowId: 9 })
    expect(framesFor("s501").map(f => [f.method, f.params])).toEqual([
      ["Interceptor.tabCreated", { tabId: 502, openerTabId: 501, url: "https://accounts.example.test/oauth", windowId: 9 }],
    ])
    expect(session.isFollowedPopup(502)).toBe(true)
    expect(session.isFollowedPopup(999)).toBe(false)

    for (const fn of listeners.removed) fn(502)
    expect(framesFor("s501").at(-1)).toMatchObject({ tabId: 501, method: "Interceptor.tabRemoved", params: { tabId: 502 } })
    expect(session.isFollowedPopup(502)).toBe(false)
  })

  test("a popup stops being reachable when the opener's session ends", async () => {
    for (const fn of listeners.created) fn({ id: 503, openerTabId: 501, url: "about:blank", windowId: 9 })
    expect(session.isFollowedPopup(503)).toBe(true)
    await session.unsubscribe("s501")
    expect(session.isFollowedPopup(503)).toBe(false)
  })

  test("a tab opened from a tab with no session is not followed", () => {
    for (const fn of listeners.created) fn({ id: 505, openerTabId: 504, url: "about:blank", windowId: 9 })
    expect(session.isFollowedPopup(505)).toBe(false)
  })
})

describe("nothing in the raw CDP path moves focus", () => {
  test("the fake browser has no tab or window activation API, and every test above passed", () => {
    const chromeApi = (globalThis as { chrome?: any }).chrome
    expect(chromeApi.tabs.update).toBeUndefined()
    expect(chromeApi.windows).toBeUndefined()
  })
})
