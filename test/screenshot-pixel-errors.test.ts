/// <reference lib="dom" />
// Issue #329: when captureVisibleTab threw, `--pixel` fell back to tabCapture
// and returned only tabCapture's activeTab error, so the real cause was lost.
// Chrome also refuses a third captureVisibleTab call inside one second, which
// is what a burst of --pixel calls hit.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { CAPTURE_VISIBLE_TAB_INTERVAL_MS, handleScreenshotActions, waitForCaptureSlot } from "../extension/src/background/capabilities/screenshot"

const g = globalThis as unknown as { chrome?: unknown }
let saved: unknown
let captureError: Error | null
let streamIdError: Error | null
let captureCalls: number[]

beforeEach(() => {
  saved = g.chrome
  captureError = new Error("This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.")
  streamIdError = new Error("Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.")
  captureCalls = []
  g.chrome = {
    tabs: {
      // Each tab is the active tab of its own window, so concurrent captures are
      // in different windows: the per-window queue does not space them, pacing must.
      get: async (id: number) => ({ id, windowId: id, active: true }),
      query: async (q: { windowId?: number }) => [{ id: q.windowId, windowId: q.windowId, active: true }],
      update: async () => ({}),
      captureVisibleTab: async () => {
        captureCalls.push(Date.now())
        if (captureError) throw captureError
        return "data:image/jpeg;base64,AAAA"
      },
    },
    windows: { get: async () => ({ id: 1, state: "normal" }) },
    tabCapture: {
      getMediaStreamId: async () => {
        if (streamIdError) throw streamIdError
        return "stream-1"
      },
    },
    runtime: {
      getContexts: async () => [{}],
      sendMessage: (_message: unknown, reply?: (value: unknown) => void) => {
        reply?.({ success: true, data: "data:image/jpeg;base64,BBBB" })
        return Promise.resolve({ success: true, data: "data:image/jpeg;base64,BBBB" })
      },
    },
    scripting: { executeScript: async () => [{ result: "hidden" }] },
  }
})
afterEach(() => { g.chrome = saved })

describe("--pixel keeps the captureVisibleTab error (issue #329)", () => {
  test("both layers fail: the error leads with captureVisibleTab and names the fallback's error", async () => {
    const result = await handleScreenshotActions({ type: "screenshot", pixel: true }, 7) as { success: boolean; error: string; data: Record<string, unknown> }
    expect(result.success).toBe(false)
    expect(result.error.startsWith("captureVisibleTab failed: This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.")).toBe(true)
    expect(result.error).toContain("the tabCapture fallback also failed: Extension has not been invoked")
    expect(result.error).not.toContain("failed: tabCapture failed")
    expect(result.data).toMatchObject({ layer: "captureVisibleTab", visibilityState: "hidden" })
    expect(String(result.data.hint)).toContain("may not be visible")
    expect(String(result.data.fallbackError)).toStartWith("Extension has not been invoked")
  })

  test("a working fallback still returns its image with the fallback note", async () => {
    streamIdError = null
    const result = await handleScreenshotActions({ type: "screenshot", pixel: true }, 7) as { success: boolean; data: Record<string, unknown> }
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ method: "tabCapture", fallback: "tabCapture (captureVisibleTab failed)" })
  })
})

describe("captureVisibleTab pacing (issue #329)", () => {
  test("concurrent waiters start at least the quota interval apart", async () => {
    const started: number[] = []
    await Promise.all([1, 2, 3].map(async () => { await waitForCaptureSlot(); started.push(Date.now()) }))
    started.sort((a, b) => a - b)
    expect(started[1] - started[0]).toBeGreaterThanOrEqual(CAPTURE_VISIBLE_TAB_INTERVAL_MS - 5)
    expect(started[2] - started[1]).toBeGreaterThanOrEqual(CAPTURE_VISIBLE_TAB_INTERVAL_MS - 5)
    expect(CAPTURE_VISIBLE_TAB_INTERVAL_MS).toBeGreaterThan(500)
  })

  test("concurrent --pixel captures reach captureVisibleTab spaced to the quota", async () => {
    captureError = new Error("stop after the capture call")
    streamIdError = new Error("no grant")
    await Promise.all([7, 8].map(tab => handleScreenshotActions({ type: "screenshot", pixel: true }, tab)))
    expect(captureCalls).toHaveLength(2)
    expect(Math.abs(captureCalls[1] - captureCalls[0])).toBeGreaterThanOrEqual(CAPTURE_VISIBLE_TAB_INTERVAL_MS - 5)
  })
})
