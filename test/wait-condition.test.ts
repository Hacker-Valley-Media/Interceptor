// Condition waits.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* shared test DOM already registered */ }

import { parseWaitCondition } from "../cli/commands/navigation"
import { waitCondition } from "../extension/src/background/content-bridge"
const { handleConditionCheck } = await import("../extension/src/content/actions/wait")

describe("wait parser", () => {
  test("plain wait <ms> is not a condition", () => {
    expect(parseWaitCondition(["wait", "500"])).toBeNull()
  })
  test("each kind maps to an action with a 10 s default timeout", () => {
    expect(parseWaitCondition(["wait", "--text", "Saved"])).toEqual({ type: "wait_condition", kind: "text", text: "Saved", timeout: 10_000 })
    expect(parseWaitCondition(["wait", "--gone", "Loading"])).toMatchObject({ kind: "gone", text: "Loading" })
    expect(parseWaitCondition(["wait", "--url", "/done", "--timeout", "3000"])).toMatchObject({ kind: "url", text: "/done", timeout: 3000 })
    expect(parseWaitCondition(["wait", "--selector", ".row", "--count", "10"])).toMatchObject({ kind: "selector", selector: ".row", count: 10 })
    expect(parseWaitCondition(["wait", "--gone-selector", "#spinner"])).toMatchObject({ kind: "gone_selector", selector: "#spinner" })
  })
  test("bad combinations are refused", () => {
    expect(() => parseWaitCondition(["wait", "--text", "a", "--url", "b"])).toThrow("one condition")
    expect(() => parseWaitCondition(["wait", "--count", "3"])).toThrow("--selector")
    expect(() => parseWaitCondition(["wait", "--text"])).toThrow("requires a value")
  })
})

describe("content condition check", () => {
  beforeEach(() => { document.body.innerHTML = "<p>Order Saved</p><div class='row'></div><div class='row'></div>" })
  test("text is case-insensitive; gone is its opposite", () => {
    expect((handleConditionCheck({ type: "condition_check", kind: "text", text: "order saved" }).data as { met: boolean }).met).toBe(true)
    expect((handleConditionCheck({ type: "condition_check", kind: "gone", text: "Order Saved" }).data as { met: boolean }).met).toBe(false)
  })
  test("selector counts", () => {
    expect((handleConditionCheck({ type: "condition_check", kind: "selector", selector: ".row", count: 2 }).data as { met: boolean }).met).toBe(true)
    expect((handleConditionCheck({ type: "condition_check", kind: "selector", selector: ".row", count: 3 }).data as { met: boolean }).met).toBe(false)
    expect((handleConditionCheck({ type: "condition_check", kind: "gone_selector", selector: "#nope" }).data as { met: boolean }).met).toBe(true)
  })
  test("an invalid selector is an error, not a timeout", () => {
    expect(handleConditionCheck({ type: "condition_check", kind: "selector", selector: "[[" }).success).toBe(false)
  })
})

describe("background wait loop", () => {
  let originalChrome: unknown
  let met = false
  let url = "http://x/start"
  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome
    met = false
    url = "http://x/start"
    ;(globalThis as { chrome: unknown }).chrome = {
      runtime: { lastError: undefined },
      tabs: {
        get: async () => ({ id: 1, url }),
        sendMessage: (_t: number, _m: unknown, _o: unknown, cb: (r: unknown) => void) => cb({ success: true, data: { met, observed: met ? "found" : "not yet" } }),
        onUpdated: { addListener() {}, removeListener() {} },
      },
    }
  })
  afterEach(() => { (globalThis as { chrome?: unknown }).chrome = originalChrome })

  test("returns once the page reports the condition", async () => {
    setTimeout(() => { met = true }, 120)
    const r = await waitCondition(1, { type: "wait_condition", kind: "text", text: "x", timeout: 2000 }, undefined, 20)
    expect(r.success).toBe(true)
    expect((r.data as { elapsed: number }).elapsed).toBeLessThan(1000)
  })
  test("times out with what it last saw", async () => {
    const r = await waitCondition(1, { type: "wait_condition", kind: "text", text: "x", timeout: 100 }, undefined, 20)
    expect(r.success).toBe(false)
    expect(r.error).toContain("timed out after 100 ms")
    expect(r.error).toContain("not yet")
  })
  test("url reads the tab, so it survives a navigation", async () => {
    setTimeout(() => { url = "http://x/done" }, 60)
    const r = await waitCondition(1, { type: "wait_condition", kind: "url", text: "/done", timeout: 2000 }, undefined, 20)
    expect(r.success).toBe(true)
  })
  test("timeout 0 checks once (verify)", async () => {
    const r = await waitCondition(1, { type: "wait_condition", kind: "text", text: "x", timeout: 0 }, undefined, 20)
    expect(r.success).toBe(false)
    expect(r.error).toContain("not met")
  })
})
