import { describe, expect, test } from "bun:test"
import {
  cdpMethodForAction,
  executeCdpAction,
  mergeHeaderEntries,
  recordNetworkEvent,
  type CdpExecContext,
  type CdpNetEntry,
} from "../daemon/cdp/translate"
import type { CdpConnection } from "../daemon/cdp/connection"

function fakeConn(responder: (method: string, params: Record<string, unknown>) => Record<string, unknown>): CdpConnection {
  return {
    isOpen: true,
    send: async (method: string, params: Record<string, unknown> = {}) => responder(method, params),
  } as unknown as CdpConnection
}

function ctxWith(conn: CdpConnection): CdpExecContext {
  const net = { enabled: false, entries: [] as CdpNetEntry[] }
  return { conn, net, ensureNetwork: async () => { net.enabled = true } }
}

const responder = (method: string, params: Record<string, unknown>): Record<string, unknown> => {
  switch (method) {
    case "Runtime.evaluate": {
      const expr = String(params.expression ?? "")
      if (params.contextId === 7) return { result: { value: "isolated-result" } }
      if (expr === "1+1") return { result: { value: 2 } }
      if (expr.includes("__OBJ__")) return { result: { value: { a: 1, b: "x" } } }
      if (expr.includes("__THROW__")) return { exceptionDetails: { exception: { description: "Error: boom" } } }
      if (expr.includes("getBoundingClientRect")) return { result: { value: { x: 50, y: 60 } } }
      return { result: { value: "READVAL" } }
    }
    case "Page.getFrameTree": return { frameTree: { frame: { id: "FRAME1" } } }
    case "Page.createIsolatedWorld": return { executionContextId: 7 }
    case "Page.captureScreenshot": return { data: "QkFTRTY0" }
    case "Page.navigate": return { frameId: "FRAME1" }
    default: return {}
  }
}

describe("cdpMethodForAction (translation table)", () => {
  test("navigate → Page.navigate", () => {
    expect(cdpMethodForAction({ type: "navigate", url: "https://x" })).toEqual({ method: "Page.navigate", params: { url: "https://x" } })
  })
  test("screenshot → Page.captureScreenshot", () => {
    expect(cdpMethodForAction({ type: "screenshot" })?.method).toBe("Page.captureScreenshot")
  })
  test("type → Input.insertText", () => {
    expect(cdpMethodForAction({ type: "type", text: "hi" })).toEqual({ method: "Input.insertText", params: { text: "hi" } })
  })
  test("reload → Page.reload", () => {
    expect(cdpMethodForAction({ type: "reload" })?.method).toBe("Page.reload")
  })
  test("multi-step actions → null", () => {
    expect(cdpMethodForAction({ type: "evaluate", code: "x" })).toBeNull()
    expect(cdpMethodForAction({ type: "click" })).toBeNull()
  })
})

describe("executeCdpAction — eval envelope parity", () => {
  test("MAIN eval returns the value", async () => {
    expect(await executeCdpAction(ctxWith(fakeConn(responder)), { type: "evaluate", code: "1+1", world: "MAIN" }))
      .toEqual({ success: true, data: 2 })
  })
  test("object value preserved (JSON-cloned by CDP returnByValue)", async () => {
    const r = await executeCdpAction(ctxWith(fakeConn(responder)), { type: "evaluate", code: "__OBJ__", world: "MAIN" })
    expect(r.success).toBe(true)
    expect(r.data).toEqual({ a: 1, b: "x" })
  })
  test("exception → success:false with the message", async () => {
    const r = await executeCdpAction(ctxWith(fakeConn(responder)), { type: "evaluate", code: "__THROW__", world: "MAIN" })
    expect(r.success).toBe(false)
    expect(r.error).toContain("boom")
  })
  test("ISOLATED world routes through createIsolatedWorld", async () => {
    expect(await executeCdpAction(ctxWith(fakeConn(responder)), { type: "evaluate", code: "x", world: "ISOLATED" }))
      .toEqual({ success: true, data: "isolated-result" })
  })
})

describe("executeCdpAction — verbs", () => {
  test("screenshot returns a data URL", async () => {
    const r = await executeCdpAction(ctxWith(fakeConn(responder)), { type: "screenshot" })
    expect(r.success).toBe(true)
    expect((r.data as { dataUrl: string }).dataUrl).toBe("data:image/png;base64,QkFTRTY0")
  })
  test("type counts characters", async () => {
    const r = await executeCdpAction(ctxWith(fakeConn(responder)), { type: "type", text: "hello" })
    expect((r.data as { typed: number }).typed).toBe(5)
  })
  test("click with coords dispatches at x,y", async () => {
    const r = await executeCdpAction(ctxWith(fakeConn(responder)), { type: "click", x: 10, y: 20 })
    expect((r.data as { at: unknown }).at).toEqual({ x: 10, y: 20 })
  })
  test("click with selector resolves the element rect", async () => {
    const r = await executeCdpAction(ctxWith(fakeConn(responder)), { type: "click", selector: ".btn" })
    expect((r.data as { at: unknown }).at).toEqual({ x: 50, y: 60 })
  })
  test("unsupported action → success:false", async () => {
    expect((await executeCdpAction(ctxWith(fakeConn(responder)), { type: "frobnicate" })).success).toBe(false)
  })
})

describe("executeCdpAction — CLI verb aliases route correctly", () => {
  const ctx = () => ctxWith(fakeConn(responder))
  test("extract_text (no ref) → full page text", async () => {
    expect((await executeCdpAction(ctx(), { type: "extract_text" })).success).toBe(true)
  })
  test("extract_text WITH a ref → serializer-unsupported", async () => {
    const r = await executeCdpAction(ctx(), { type: "extract_text", ref: "e2" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/serializer|eval/i)
  })
  test("get_state → success (formatState-compatible shape via eval)", async () => {
    expect((await executeCdpAction(ctx(), { type: "get_state" })).success).toBe(true)
  })
  test("input_text → inserts into focused element", async () => {
    const r = await executeCdpAction(ctx(), { type: "input_text", text: "hi", ref: "e2" })
    expect(r.success).toBe(true)
    expect((r.data as { typed: number }).typed).toBe(2)
  })
  test("send_keys → dispatches a key", async () => {
    const r = await executeCdpAction(ctx(), { type: "send_keys", keys: "Enter" })
    expect(r.success).toBe(true)
    expect((r.data as { key: string }).key).toBe("Enter")
  })
  test("click_at → dispatches at coords", async () => {
    const r = await executeCdpAction(ctx(), { type: "click_at", x: 7, y: 9 })
    expect((r.data as { at: unknown }).at).toEqual({ x: 7, y: 9 })
  })
  test("scroll → succeeds", async () => {
    expect((await executeCdpAction(ctx(), { type: "scroll", direction: "down" })).success).toBe(true)
  })
  test("go_back → succeeds", async () => {
    expect((await executeCdpAction(ctx(), { type: "go_back" })).success).toBe(true)
  })
  test("ref-based interaction (find_element) → serializer-unsupported", async () => {
    const r = await executeCdpAction(ctx(), { type: "find_element", query: "x" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/serializer|eval/i)
  })
})

describe("mergeHeaderEntries", () => {
  test("override wins, case-insensitive, no duplicate", () => {
    const out = mergeHeaderEntries({ "User-Agent": "old", "X-Foo": "bar" }, [{ setHeaders: { "user-agent": "new" } }], "https://x")
    expect(out.find(h => h.name.toLowerCase() === "user-agent")?.value).toBe("new")
    expect(out.length).toBe(2)
  })
  test("urlPattern filters which requests get the override", () => {
    const out = mergeHeaderEntries({ A: "1" }, [{ urlPattern: "api.example", setHeaders: { B: "2" } }], "https://other.com")
    expect(out.find(h => h.name === "B")).toBeUndefined()
  })
})

describe("recordNetworkEvent (capture + redaction + requestId correlation)", () => {
  test("request then response, with sensitive headers redacted", () => {
    const buf: CdpNetEntry[] = []
    recordNetworkEvent(buf, "Network.requestWillBeSent", { requestId: "r1", request: { url: "http://x/api", method: "POST", headers: { authorization: "secret", "x-foo": "bar" } }, type: "XHR" })
    expect(buf.length).toBe(1)
    expect(buf[0].requestHeaders?.authorization).toBe("[redacted]")
    expect(buf[0].requestHeaders?.["x-foo"]).toBe("bar")
    recordNetworkEvent(buf, "Network.responseReceived", { requestId: "r1", response: { status: 200, headers: { "set-cookie": "sid=1" } } })
    expect(buf[0].status).toBe(200)
    expect(buf[0].responseHeaders?.["set-cookie"]).toBe("[redacted]")
  })

  test("concurrent same-URL requests correlate by requestId, not URL", () => {
    const buf: CdpNetEntry[] = []
    recordNetworkEvent(buf, "Network.requestWillBeSent", { requestId: "a", request: { url: "http://x/q", method: "GET" } })
    recordNetworkEvent(buf, "Network.requestWillBeSent", { requestId: "b", request: { url: "http://x/q", method: "GET" } })
    recordNetworkEvent(buf, "Network.responseReceived", { requestId: "b", response: { status: 500 } })
    recordNetworkEvent(buf, "Network.responseReceived", { requestId: "a", response: { status: 200 } })
    expect(buf.find(e => e.requestId === "a")?.status).toBe(200)
    expect(buf.find(e => e.requestId === "b")?.status).toBe(500)
  })

  test("redirect closes the prior hop's status (same requestId)", () => {
    const buf: CdpNetEntry[] = []
    recordNetworkEvent(buf, "Network.requestWillBeSent", { requestId: "r", request: { url: "http://x/1", method: "GET" } })
    recordNetworkEvent(buf, "Network.requestWillBeSent", { requestId: "r", request: { url: "http://x/2", method: "GET" }, redirectResponse: { status: 302 } })
    recordNetworkEvent(buf, "Network.responseReceived", { requestId: "r", response: { status: 200 } })
    const statuses = buf.filter(e => e.requestId === "r").map(e => e.status)
    expect(statuses).toEqual([302, 200]) // no permanent undefined orphan
  })
})
