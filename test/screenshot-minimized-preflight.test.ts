/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

// Minimized-window preflight for the DOM-render screenshot path (issue #94).
//
// A minimized window has no live compositor frame to render, so the default
// DOM-render screenshot path (which, before 0.18.3, injected a
// screenshot-runner.js bundle) hung until the CLI WebSocket client timed out
// at 15s (cli/transport.ts). The fix
// adds a `chrome.windows.get(...).state === "minimized"` preflight in
// handleDomRenderScreenshot that returns the same fast, honest error shape the
// legacy --pixel path already returns.
//
// These tests stub chrome.tabs.get + chrome.windows.get and assert that:
//   (1) a minimized window short-circuits with the preflight error + data shape
//       and never touches the content-script / CORS machinery, and
//   (2) a non-minimized window passes the preflight (proven here by the call
//       advancing past windows.get to the content-script dispatch stage).
//
// The DOM render is now native (content.ts), so the path no longer injects a
// screenshot-runner bundle — after the preflight it installs the DNR CORS rule
// and dispatches the dom_screenshot action to the content script via
// chrome.tabs.sendMessage.

interface FakeTab { id: number; windowId: number }
interface FakeWindow { id: number; state: string }

let windowGetCalls: number[]
let sendMessageCalls: number
let originalChrome: unknown

function installFakeChrome(tab: FakeTab, win: FakeWindow) {
  windowGetCalls = []
  sendMessageCalls = 0
  originalChrome = (globalThis as { chrome?: unknown }).chrome
  ;(globalThis as { chrome: unknown }).chrome = {
    tabs: {
      get: async (tabId: number) => (tabId === tab.id ? tab : null),
      // If the preflight fails to short-circuit, the path installs the DNR CORS
      // rule then dispatches dom_screenshot to the content script. Stub
      // sendMessage so the dispatch is observable (sendMessageCalls > 0) and
      // return a benign failure so handleDomRenderScreenshot returns early
      // without needing OffscreenCanvas/fetch.
      sendMessage: (_tabId: number, _msg: unknown, _opts: unknown, cb?: (r: unknown) => void) => {
        sendMessageCalls++
        if (typeof cb === "function") cb({ success: false, error: "test-stub" })
      },
    },
    windows: {
      get: async (windowId: number) => {
        windowGetCalls.push(windowId)
        return win.id === windowId ? win : null
      },
    },
    declarativeNetRequest: {
      updateSessionRules: async () => undefined,
      getSessionRules: async () => [],
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
    // Proves the fast-fail: the window state was checked and the content script
    // was never dispatched to (no 15s hang path).
    expect(windowGetCalls).toEqual([1])
    expect(sendMessageCalls).toBe(0)
  })

  test("non-minimized window passes the preflight and proceeds toward the content-script dispatch", async () => {
    installFakeChrome({ id: 200, windowId: 1 }, { id: 1, state: "normal" })
    const { handleScreenshotActions } = await import("../extension/src/background/capabilities/screenshot")
    // We don't drive a full native render here (no real content script in bun's
    // env); we only assert the preflight did NOT short-circuit, i.e. the path
    // advanced past windows.get to dispatching dom_screenshot to the content
    // script.
    await handleScreenshotActions({ type: "screenshot", save: true }, 200).catch(() => undefined)
    expect(windowGetCalls).toEqual([1])
    expect(sendMessageCalls).toBeGreaterThan(0)
  })
})
