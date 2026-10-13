import { describe, expect, test } from "bun:test"
import {
  CdpSubscriptions, CDP_EVENT_FRAME_PREFIX, encodeIpcFrame, isRawCdpAction, subscriptionEndedFrame,
} from "../daemon/cdp-tab-events"
import { parseTabCdpCommand } from "../cli/commands/tab-cdp"
import { classify } from "../cli/mcp/tiers"
import { needsTab } from "../extension/src/background/no-tab-actions"

// The daemon side of raw CDP event streaming, the CLI parse, and the gates
// that keep raw CDP on the IPC socket and behind the operator's MCP allowance.

describe("subscription registry", () => {
  const a = { name: "socket-a" }
  const b = { name: "socket-b" }

  test("an extension frame goes to each subscriber it names, as that subscriber's own frame", () => {
    const subs = new CdpSubscriptions<{ name: string }>()
    subs.add({ subscription: "s1", socket: a, contextId: "work", tabId: 7 })
    subs.add({ subscription: "s2", socket: b, contextId: "work", tabId: 7 })
    const routed = subs.route({
      type: "cdp_event", subscriptions: ["s1", "s2", "gone"], tabId: 7,
      method: "Page.screencastFrame", params: { data: "/9j/", sessionId: 3 },
    })
    expect(routed.map(r => r.subscriber.socket.name)).toEqual(["socket-a", "socket-b"])
    expect(routed[0].frame).toEqual({
      type: "cdp_event", subscription: "s1", tabId: 7,
      method: "Page.screencastFrame", params: { data: "/9j/", sessionId: 3 },
    })
    expect(routed[1].frame.subscription).toBe("s2")
  })

  test("a child session id is kept; a frame with no method goes nowhere", () => {
    const subs = new CdpSubscriptions()
    subs.add({ subscription: "s1", socket: a })
    expect(subs.route({ subscriptions: ["s1"], tabId: 1, method: "Runtime.consoleAPICalled", sessionId: "child" })[0].frame.sessionId).toBe("child")
    expect(subs.route({ subscriptions: ["s1"], tabId: 1 })).toEqual([])
    expect(subs.route({ subscriptions: "s1", method: "Page.enable" })).toEqual([])
  })

  test("a closed socket takes all of its subscriptions with it and no others", () => {
    const subs = new CdpSubscriptions()
    subs.add({ subscription: "s1", socket: a, contextId: "work" })
    subs.add({ subscription: "s2", socket: a, contextId: "personal" })
    subs.add({ subscription: "s3", socket: b, contextId: "work" })
    expect(subs.removeSocket(a).map(s => s.subscription)).toEqual(["s1", "s2"])
    expect(subs.size).toBe(1)
    expect(subs.route({ subscriptions: ["s1", "s3"], method: "Page.enable" }).map(r => r.subscriber.subscription)).toEqual(["s3"])
  })

  test("renewals group by extension context", () => {
    const subs = new CdpSubscriptions()
    subs.add({ subscription: "s1", socket: a, contextId: "work" })
    subs.add({ subscription: "s2", socket: b, contextId: "work" })
    subs.add({ subscription: "s3", socket: b })
    expect([...subs.byContext()]).toEqual([["work", ["s1", "s2"]], [undefined, ["s3"]]])
  })

  test("the ended notice has the event shape", () => {
    expect(subscriptionEndedFrame({ subscription: "s1", socket: a, tabId: 7 }, "extension_restarted")).toEqual({
      type: "cdp_event", subscription: "s1", tabId: 7,
      method: "Interceptor.subscriptionEnded", params: { reason: "extension_restarted" },
    })
  })

  test("frames are length-prefixed JSON, and extension frames open with the recognized prefix", () => {
    const frame = encodeIpcFrame({ type: "cdp_event", method: "Page.enable" })
    expect(frame.readUInt32LE(0)).toBe(frame.byteLength - 4)
    expect(JSON.parse(frame.subarray(4).toString("utf-8"))).toEqual({ type: "cdp_event", method: "Page.enable" })
    expect(JSON.stringify({ type: "cdp_event", subscriptions: [] }).startsWith(CDP_EVENT_FRAME_PREFIX)).toBe(true)
  })
})

describe("raw CDP action gate", () => {
  test("every raw CDP action type is recognized; the app surface and other verbs are not", () => {
    for (const type of ["cdp_tab_send", "cdp_tab_attach", "cdp_tab_detach", "cdp_tab_events", "cdp_tab_subscribe", "cdp_tab_status"]) {
      expect(isRawCdpAction(type)).toBe(true)
    }
    for (const type of ["cdp_attach", "cdp_raw", "cdp_tree", "evaluate", undefined, 7]) expect(isRawCdpAction(type)).toBe(false)
  })

  test("the daemon refuses raw CDP on the WebSocket before any routing", async () => {
    const source = await Bun.file(new URL("../daemon/index.ts", import.meta.url)).text()
    const refusal = source.indexOf('error: "raw CDP requires local IPC"')
    expect(refusal).toBeGreaterThan(-1)
    // The refusal sits in the WebSocket handler, ahead of extension registration.
    expect(refusal).toBeGreaterThan(source.indexOf("websocket: {"))
    expect(refusal).toBeLessThan(source.indexOf('if (request.type === "extension")'))
  })

  test("the MCP gate treats the whole cdp family as arbitrary exec", () => {
    for (const args of [["cdp", "send", "Runtime.evaluate"], ["cdp", "events"], ["cdp", "attach"], ["cdp", "status"]]) {
      expect(classify("browser", "tab", args).tier).toBe("exec")
    }
    expect(classify("browser", "tab", ["new", "https://example.com"]).tier).toBe("mutate")
  })

  test("send/attach/detach need a tab; status and lease upkeep do not", () => {
    for (const type of ["cdp_tab_send", "cdp_tab_attach", "cdp_tab_detach", "cdp_tab_subscribe"]) expect(needsTab(type)).toBe(true)
    for (const type of ["cdp_tab_status", "cdp_tab_unsubscribe", "cdp_tab_renew"]) expect(needsTab(type)).toBe(false)
  })
})

describe("interceptor tab cdp — CLI parse", () => {
  test("send with JSON params", () => {
    expect(parseTabCdpCommand(["cdp", "send", "Page.captureScreenshot", '{"format":"jpeg","quality":60}'])).toEqual({
      type: "cdp_tab_send", method: "Page.captureScreenshot", params: { format: "jpeg", quality: 60 },
    })
  })

  test("send without params, and with a child session", () => {
    expect(parseTabCdpCommand(["cdp", "send", "Page.enable"])).toEqual({ type: "cdp_tab_send", method: "Page.enable" })
    expect(parseTabCdpCommand(["cdp", "send", "Runtime.enable", "--session", "abc"])).toEqual({
      type: "cdp_tab_send", method: "Runtime.enable", sessionId: "abc",
    })
  })

  test("bad params are an error, not a silent empty object", () => {
    expect(parseTabCdpCommand(["cdp", "send", "Page.enable", "{format:jpeg}"])).toHaveProperty("error")
    expect(parseTabCdpCommand(["cdp", "send", "Page.enable", "[1,2]"])).toHaveProperty("error")
    expect(parseTabCdpCommand(["cdp", "send"])).toHaveProperty("error")
  })

  test("attach, detach, status, unknown", () => {
    expect(parseTabCdpCommand(["cdp", "attach"])).toEqual({ type: "cdp_tab_attach" })
    expect(parseTabCdpCommand(["cdp", "detach"])).toEqual({ type: "cdp_tab_detach" })
    expect(parseTabCdpCommand(["cdp", "status"])).toEqual({ type: "cdp_tab_status" })
    expect(parseTabCdpCommand(["cdp", "raw"])).toHaveProperty("error")
  })
})
