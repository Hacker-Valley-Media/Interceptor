/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

// Minimized-window preflight for the DOM-render screenshot path (issue #94).
//
// A minimized window has no live compositor frame to render, so the default
// DOM-render screenshot path used to inject screenshot-runner.js and then hang
// until the CLI WebSocket client timed out at 15s (cli/transport.ts). The fix
// adds a `chrome.windows.get(...).state === "minimized"` preflight in
// handleDomRenderScreenshot that returns the same fast, honest error shape the
// legacy --pixel path already returns.
//
// These tests stub chrome.tabs.get + chrome.windows.get and assert that:
//   (1) a minimized window short-circuits with the preflight error + data shape
//       and never touches the content-script / CORS / inject machinery, and
//   (2) a non-minimized window passes the preflight (proven here by the call
//       advancing past windows.get to the inject stage).

interface FakeTab { id: number; windowId: number }
interface FakeWindow { id: number; state: string }

let windowGetCalls: number[]
let scriptingInjectCalls: number
let originalChrome: unknown

function installFakeChrome(tab: FakeTab, win: FakeWindow) {
  windowGetCalls = []
  scriptingInjectCalls = 0
  originalChrome = (globalThis as { chrome?: unknown }).chrome
  ;(globalThis as { chrome: unknown }).chrome = {
    tabs: {
      get: async (tabId: number) => (tabId === tab.id ? tab : null),
    },
    windows: {
      get: async (windowId: number) => {
        windowGetCalls.push(windowId)
        return win.id === windowId ? win : null
      },
    },
    // If the preflight fails to short-circuit, the next thing the path does is
    // install a DNR CORS rule then inject the runner. Stub both so a leak is
    // observable (scriptingInjectCalls > 0) rather than throwing.
    declarativeNetRequest: {
      updateSessionRules: async () => undefined,
      getSessionRules: async () => [],
    },
    scripting: {
      executeScript: async () => { scriptingInjectCalls++; return [] },
    },
  }
}

function restoreChrome() {
  ;(globalThis as { chrome?: unknown }).chrome = originalChrome
}

afterEach(() => {
  restoreChrome()
})

describe("DOM-render screenshot — minimized-window preflight", () => {
  test("minimized window returns the preflight error and never injects the runner", async () => {
    installFakeChrome({ id: 200, windowId: 1 }, { id: 1, state: "minimized" })
    const { handleScreenshotActions } = await import("../extension/src/background/capabilities/screenshot")
    const result = await handleScreenshotActions({ type: "screenshot", save: true }, 200)

    expect(result.success).toBe(false)
    expect(result.error).toContain("window 1 is minimized")
    expect(result.error).toContain("DOM-render requires the window to be non-minimized")
    const data = result.data as { layer?: string; windowState?: string }
    expect(data.layer).toBe("preflight")
    expect(data.windowState).toBe("minimized")
    // Proves the fast-fail: the window state was checked and the runner was
    // never injected (no 15s hang path).
    expect(windowGetCalls).toEqual([1])
    expect(scriptingInjectCalls).toBe(0)
  })

  test("non-minimized window passes the preflight and proceeds toward injection", async () => {
    installFakeChrome({ id: 200, windowId: 1 }, { id: 1, state: "normal" })
    const { handleScreenshotActions } = await import("../extension/src/background/capabilities/screenshot")
    // We don't drive a full render here (no content script / OffscreenCanvas in
    // bun's env); we only assert the preflight did NOT short-circuit, i.e. the
    // path advanced past windows.get to the inject stage.
    await handleScreenshotActions({ type: "screenshot", save: true }, 200).catch(() => undefined)
    expect(windowGetCalls).toEqual([1])
    expect(scriptingInjectCalls).toBeGreaterThan(0)
  })
})
