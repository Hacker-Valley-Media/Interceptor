import { describe, expect, test } from "bun:test"
import {
  WebRefRegistry, BoundedEventBuffer, CapabilityLedger, decideActionMode,
  renderWebTree, redactNetworkParams, extractRuntimeValue,
  WebSession, IosWebManager, type SerializedNode,
} from "../daemon/ios/web-manager"
import { blankCapabilities } from "../shared/ios-web"
import {
  encodeWirFrame, tryReadWirFrame, WIR_INCOMING, WIR_KEY, type DuplexBytes,
} from "../daemon/ios/webinspector-transport"
import { decodePlist } from "../daemon/ios/webinspector-plist"

// Locks the web-manager building blocks + a full WIR→WIP→verb round trip and
// device resolution, all device-free through fake byte channels.

describe("WebRefRegistry", () => {
  test("mints wN refs and invalidates on a new generation", () => {
    const r = new WebRefRegistry()
    r.newGeneration()
    const ref = r.mint({ kind: "runtime", selector: "#a" })
    expect(ref).toBe("w1")
    expect(r.resolve("w1")).toMatchObject({ selector: "#a" })
    r.newGeneration()
    expect(r.resolve("w1")).toEqual({ stale: true }) // document changed
  })
  test("rejects a non-web ref shape", () => {
    const r = new WebRefRegistry()
    expect(r.resolve("e5")).toBeUndefined()
  })
})

describe("BoundedEventBuffer", () => {
  test("caps by event count and counts drops", () => {
    const b = new BoundedEventBuffer<{ n: number }>({ maxEvents: 3, maxBytes: 1e9 })
    for (let i = 0; i < 5; i++) b.push({ n: i })
    const d = b.drain()
    expect(d.events).toHaveLength(3)
    expect(d.dropped).toBe(2)          // overflow surfaced, not hidden
    expect(d.events[0].n).toBe(2)
  })
})

describe("CapabilityLedger", () => {
  test("records observed + unavailable methods and derived flags", () => {
    const caps = blankCapabilities("web-page", "classic-page-id", "direct")
    const led = new CapabilityLedger(caps)
    led.markDomainEnabled("Console")
    led.observeMethod("Runtime.evaluate", true)
    led.observeMethod("DOM.getDocument", false)
    expect(caps.consoleEvents).toBe(true)
    expect(caps.runtimeEvaluate).toBe(true)
    expect(caps.domains.Runtime.methodsObserved).toContain("Runtime.evaluate")
    expect(caps.domains.DOM.unavailableMethods).toContain("DOM.getDocument")
  })
})

describe("decideActionMode", () => {
  test("dom is synthetic (trustedInput:false)", () => {
    const { report } = decideActionMode("dom", { nativeLaneAvailable: true, calibrated: true })
    expect(report.modeUsed).toBe("dom")
    expect(report.trustedInput).toBe(false)
  })
  test("native requires runner + calibration", () => {
    expect(decideActionMode("native", { nativeLaneAvailable: false, calibrated: false }).error?.data).toMatchObject({ code: "native_lane_unavailable" })
    expect(decideActionMode("native", { nativeLaneAvailable: true, calibrated: false }).error?.data).toMatchObject({ code: "native_mapping_unavailable" })
    const ok = decideActionMode("native", { nativeLaneAvailable: true, calibrated: true })
    expect(ok.report.modeUsed).toBe("native")
    expect(ok.report.trustedInput).toBe(true)
  })
  test("auto falls back to dom and discloses why", () => {
    const { report } = decideActionMode("auto", { nativeLaneAvailable: false, calibrated: false })
    expect(report.modeUsed).toBe("dom")
    expect(report.fallbackReason).toBe("native_runner_not_connected")
  })
})

describe("renderWebTree", () => {
  test("mints one ref per node and indents by depth", () => {
    const reg = new WebRefRegistry(); reg.newGeneration()
    const nodes: SerializedNode[] = [
      { tag: "div", depth: 0, selector: "div:nth-of-type(1)" },
      { tag: "a", href: "https://x/", text: "Link", depth: 1, selector: "a:nth-of-type(1)" },
    ]
    const tree = renderWebTree(nodes, reg)
    expect(tree).toContain("[w1] div")
    expect(tree).toContain("[w2] a")
    expect(tree).toContain("href=https://x/")
    expect(reg.resolve("w2")).toMatchObject({ selector: "a:nth-of-type(1)" })
  })
})

describe("redactNetworkParams", () => {
  test("redacts request/response headers and URL query secrets", () => {
    const out = redactNetworkParams({
      request: { url: "https://api.example.com/v1?access_token=SECRET&q=ok", headers: { Authorization: "Bearer X", Accept: "application/json" } },
    }) as any
    expect(out.request.headers.Authorization).toBe("«redacted»")
    expect(out.request.headers.Accept).toBe("application/json")
    expect(out.request.url).toContain("access_token=%C2%AB")   // redacted marker, url-encoded
    expect(out.request.url).toContain("q=ok")
  })
})

// ── full WIR → WIP → verb round trip (no device) ──────────────────────────────

function fakeChannel() {
  let dataCb: ((b: Buffer) => void) | undefined
  let closeCb: (() => void) | undefined
  const writes: Buffer[] = []
  const chan: DuplexBytes = {
    write: (b) => writes.push(Buffer.from(b)),
    onData: (cb) => { dataCb = cb },
    onClose: (cb) => { closeCb = cb },
    close: () => { closeCb?.() },
  }
  return { chan, feed: (b: Buffer) => dataCb?.(b), fireClose: () => closeCb?.(), writes }
}

/** Extract the inner WIP request the session forwarded in its last socket-data frame. */
function lastInnerRequest(writes: Buffer[]): any {
  for (let i = writes.length - 1; i >= 0; i--) {
    const body = tryReadWirFrame(writes[i])!.body
    if (body.length === 0) continue // the empty-frame prompt that follows every message
    const decoded = decodePlist(body) as any
    const data = decoded.__argument?.[WIR_KEY.socketData]
    if (Buffer.isBuffer(data)) return JSON.parse(data.toString())
  }
  throw new Error("no forwarded socket data written")
}
function inboundWip(obj: unknown): Buffer {
  return encodeWirFrame({ __selector: WIR_INCOMING.applicationSentData, __argument: { [WIR_KEY.messageData]: Buffer.from(JSON.stringify(obj)) } })
}

function makeSession() {
  const io = fakeChannel()
  const session = new WebSession(io.chan as any, {
    sessionId: "iws_test", deviceContextId: "ios:u1", udid: "U1",
    applicationId: "PID:1", target: { targetId: "iwt_1", devicePageId: 1, type: "web-page", inspectable: true }, rawListingKey: "1",
    connectionId: "C1", senderKey: "S1", transportKind: "rsd-shim", setupVariant: "optional-page-id-no-chunks",
  }, "direct")
  return { session, io }
}

describe("WebSession round trip", () => {
  test("call → forwarded WIP request → response resolves", async () => {
    const { session, io } = makeSession()
    const p = session.call("Runtime.evaluate", { expression: "document.title" })
    const req = lastInnerRequest(io.writes)
    expect(req.method).toBe("Runtime.evaluate")
    io.feed(inboundWip({ id: req.id, result: { result: { type: "string", value: "Hello" } } }))
    const r = await p
    expect(extractRuntimeValue(r)).toBe("Hello")
    expect(session.capabilities.domains.Runtime.methodsObserved).toContain("Runtime.evaluate")
  })

  test("console events buffer only while started", async () => {
    const { session, io } = makeSession()
    io.feed(inboundWip({ method: "Console.messageAdded", params: { message: { text: "before" } } }))
    expect(session.console.size).toBe(0)          // not started yet
    session.setConsole(true)
    io.feed(inboundWip({ method: "Console.messageAdded", params: { message: { text: "after" } } }))
    expect(session.console.drain().events).toHaveLength(1)
  })

  test("detach rejects in-flight requests and marks closed", async () => {
    const { session, io } = makeSession()
    const p = session.call("Runtime.evaluate")
    lastInnerRequest(io.writes)
    session.detach("test")
    await expect(p).rejects.toBeDefined()
    expect(session.isClosed).toBe(true)
  })
})

// ── manager device resolution ─────────────────────────────────────────────────

describe("IosWebManager device resolution", () => {
  test("resolves the sole paired device for a lifecycle action", async () => {
    const mgr = new IosWebManager({ discover: async () => [{ udid: "U1", contextId: "ios:u1", paired: true, transport: "USB" }] })
    const res = await mgr.handle({ type: "ios_web_status" })
    expect(res.success).toBe(true)
    expect((res.data as any).deviceContextId).toBe("ios:u1")
    expect((res.data as any).session).toBeNull()
  })

  test("no paired device → device_not_found", async () => {
    const mgr = new IosWebManager({ discover: async () => [] })
    const res = await mgr.handle({ type: "ios_web_status" })
    expect(res.success).toBe(false)
    expect((res.data as any).code).toBe("device_not_found")
  })

  test("multiple devices → device_not_found with candidates", async () => {
    const mgr = new IosWebManager({ discover: async () => [
      { udid: "U1", contextId: "ios:u1", paired: true, transport: "USB" },
      { udid: "U2", contextId: "ios:u2", paired: true, transport: "USB" },
    ] })
    const res = await mgr.handle({ type: "ios_web_status" })
    expect((res.data as any).code).toBe("device_not_found")
    expect((res.data as any).candidates).toHaveLength(2)
  })

  test("a session action with no session → session_not_found (no runner touched)", async () => {
    const mgr = new IosWebManager({ discover: async () => [{ udid: "U1", contextId: "ios:u1", paired: true, transport: "USB" }] })
    const res = await mgr.handle({ type: "ios_web_eval", expression: "1" }, "ios:u1")
    expect(res.success).toBe(false)
    expect((res.data as any).code).toBe("session_not_found")
  })
})
