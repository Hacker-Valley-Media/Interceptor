/// <reference lib="dom" />
// Issue #329: when captureVisibleTab threw, `--pixel` fell back to tabCapture
// and returned only tabCapture's activeTab error, so the real cause was lost.
// Chrome also refuses a third captureVisibleTab call inside one second, which
// is what a burst of --pixel calls hit.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { CAPTURE_VISIBLE_TAB_INTERVAL_MS, handleScreenshotActions, paceCaptureCall } from "../extension/src/background/capabilities/screenshot"

const QUOTA = "This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota."
const g = globalThis as unknown as { chrome?: unknown }
let saved: unknown
let captureErrors: Array<Error | null>
let streamIdError: Error | null
let captureCalls: number[]
let events: string[]
// windowId -> active tab id. By default each tab is the active tab of its own window.
let activeByWindow: Map<number, number>
let windowOf: (tabId: number) => number

beforeEach(() => {
  saved = g.chrome
  captureErrors = [new Error(QUOTA)]
  streamIdError = new Error("Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.")
  captureCalls = []
  events = []
  activeByWindow = new Map()
  windowOf = (tabId) => tabId
  g.chrome = {
    tabs: {
      get: async (id: number) => ({ id, windowId: windowOf(id), active: (activeByWindow.get(windowOf(id)) ?? id) === id }),
      query: async (q: { windowId?: number }) => {
        const windowId = q.windowId as number
        return [{ id: activeByWindow.get(windowId) ?? windowId, windowId, active: true }]
      },
      update: async (id: number) => { activeByWindow.set(windowOf(id), id); events.push(`activate ${id}`); return {} },
      captureVisibleTab: async () => {
        captureCalls.push(performance.now())
        events.push("capture")
        const err = captureErrors.length > 1 ? captureErrors.shift() : captureErrors[0]
        if (err) throw err
        return "data:image/jpeg;base64,AAAA"
      },
    },
    windows: { get: async (id: number) => ({ id, state: "normal" }) },
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
    scripting: {
      executeScript: async ({ target }: { target: { tabId: number } }) => {
        events.push("visibility")
        // The target reads "visible" only while it is its window's active tab.
        return [{ result: activeByWindow.get(windowOf(target.tabId)) === target.tabId ? "visible" : "hidden" }]
      },
    },
  }
})
afterEach(() => { g.chrome = saved })

describe("--pixel keeps the captureVisibleTab error (issue #329)", () => {
  test("both layers fail: the error leads with captureVisibleTab and names the fallback's error", async () => {
    captureErrors = [new Error("Failed to capture tab: image readback failed")]
    const result = await handleScreenshotActions({ type: "screenshot", pixel: true }, 7) as { success: boolean; error: string; data: Record<string, unknown> }
    expect(result.success).toBe(false)
    expect(result.error.startsWith("captureVisibleTab failed: Failed to capture tab: image readback failed")).toBe(true)
    expect(result.error).toContain("the tabCapture fallback also failed: Extension has not been invoked")
    expect(result.error).not.toContain("failed: tabCapture failed")
    expect(result.data).toMatchObject({ layer: "captureVisibleTab" })
    expect(String(result.data.hint)).toContain("may not be visible")
    expect(String(result.data.fallbackError)).toStartWith("Extension has not been invoked")
  })

  test("visibilityState is read while the target is still borrowed, before the user's tab is restored", async () => {
    // Window 1 shows the user's tab 100; the target 200 is a background tab there.
    windowOf = () => 1
    activeByWindow.set(1, 100)
    captureErrors = [new Error("Failed to capture tab: image readback failed")]
    const result = await handleScreenshotActions({ type: "screenshot", pixel: true }, 200) as { success: boolean; data: Record<string, unknown> }
    expect(result.success).toBe(false)
    expect(result.data.visibilityState).toBe("visible")
    expect(events.indexOf("visibility")).toBeLessThan(events.lastIndexOf("activate 100"))
    expect(activeByWindow.get(1)).toBe(100)
  })

  test("a working fallback still returns its image with the fallback note", async () => {
    captureErrors = [new Error("Failed to capture tab: image readback failed")]
    streamIdError = null
    const result = await handleScreenshotActions({ type: "screenshot", pixel: true }, 7) as { success: boolean; data: Record<string, unknown> }
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ method: "tabCapture", fallback: "tabCapture (captureVisibleTab failed)" })
  })

  test("a fallback image goes through the same format and save steps as a captureVisibleTab image", async () => {
    captureErrors = [new Error("Failed to capture tab: image readback failed")]
    streamIdError = null
    // The pixel transform re-encodes in the service worker; stub the two canvas APIs Bun lacks.
    const w = globalThis as unknown as Record<string, unknown>
    const savedBitmap = w.createImageBitmap, savedCanvas = w.OffscreenCanvas
    const encoded: string[] = []
    w.createImageBitmap = async () => ({ width: 40, height: 20, close() {} })
    w.OffscreenCanvas = class {
      constructor(public width: number, public height: number) {}
      getContext() { return { drawImage() {} } }
      async convertToBlob({ type }: { type: string }) { encoded.push(type); return new Blob([new Uint8Array([1, 2, 3])], { type }) }
    }
    try {
      const result = await handleScreenshotActions({ type: "screenshot", pixel: true, format: "webp", save: true }, 7) as { success: boolean; data: Record<string, unknown> }
      expect(result.success).toBe(true)
      expect(result.data).toMatchObject({ format: "webp", save: true, method: "tabCapture", fallback: "tabCapture (captureVisibleTab failed)" })
      expect(String(result.data.dataUrl)).toStartWith("data:image/webp;base64,")
      expect(encoded).toEqual(["image/webp"])
    } finally {
      w.createImageBitmap = savedBitmap
      w.OffscreenCanvas = savedCanvas
    }
  })

  test("a quota refusal gets one more paced turn instead of failing", async () => {
    captureErrors = [new Error(QUOTA), null]
    const result = await handleScreenshotActions({ type: "screenshot", pixel: true }, 9) as { success: boolean }
    expect(result.success).toBe(true)
    expect(captureCalls).toHaveLength(2)
    expect(captureCalls[1] - captureCalls[0]).toBeGreaterThanOrEqual(CAPTURE_VISIBLE_TAB_INTERVAL_MS - 5)
  })
})

describe("captureVisibleTab pacing (issue #329)", () => {
  test("concurrent calls start at least the quota interval apart", async () => {
    const started: number[] = []
    await Promise.all([1, 2, 3].map(async () => { await paceCaptureCall(); started.push(performance.now()) }))
    started.sort((a, b) => a - b)
    expect(started[1] - started[0]).toBeGreaterThanOrEqual(CAPTURE_VISIBLE_TAB_INTERVAL_MS - 5)
    expect(started[2] - started[1]).toBeGreaterThanOrEqual(CAPTURE_VISIBLE_TAB_INTERVAL_MS - 5)
    expect(CAPTURE_VISIBLE_TAB_INTERVAL_MS).toBeGreaterThan(500)
  })

  test("concurrent --pixel captures in different windows reach captureVisibleTab spaced to the quota", async () => {
    captureErrors = [new Error("stop after the capture call")]
    await Promise.all([7, 8].map(tab => handleScreenshotActions({ type: "screenshot", pixel: true }, tab)))
    expect(captureCalls).toHaveLength(2)
    expect(Math.abs(captureCalls[1] - captureCalls[0])).toBeGreaterThanOrEqual(CAPTURE_VISIBLE_TAB_INTERVAL_MS - 5)
  })
})
