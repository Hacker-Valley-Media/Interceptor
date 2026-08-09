/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test"

// Foreground guard for trusted OS input (issue #166).
//
// os_click/os_move derived windowBounds from chrome.windows.getCurrent() —
// in an MV3 service worker that is the last-focused window, not the window
// owning the target tabId — and the daemon posts the resulting screen
// coordinates to the global HID tap, which routes by z-order. A trusted click
// aimed at a background tab therefore landed in whatever was frontmost, and
// reported success. os_type/os_key had the same shape for keystrokes.
//
// The fix resolves the owning window via chrome.tabs.get(tabId) →
// chrome.windows.get(tab.windowId) and refuses all four os_* verbs unless the
// target tab is the active tab of the OS-focused, non-minimized window.
//
// These tests stub chrome.tabs.get/chrome.windows.get and assert:
//   (1) refusal when the owning window is not focused,
//   (2) refusal when the tab is not active in its window,
//   (3) refusal when the owning window is minimized,
//   (4) the success path takes bounds from the OWNING window — getCurrent()
//       is never consulted (it is stubbed to a poisoned different window),
//   (5) the guard covers os_click, os_move, os_type, and os_key.

interface FakeTab { id: number; windowId: number; active: boolean }
interface FakeWindow {
  id: number; focused: boolean; state: string
  left: number; top: number; width: number; height: number
}

let getCurrentCalls: number
let originalChrome: unknown

const POISON_WINDOW = { id: 999, left: 7777, top: 8888, width: 1, height: 1, focused: true, state: "normal" }

function installFakeChrome(tab: FakeTab, win: FakeWindow) {
  getCurrentCalls = 0
  originalChrome = (globalThis as { chrome?: unknown }).chrome
  ;(globalThis as { chrome: unknown }).chrome = {
    tabs: {
      get: async (tabId: number) => {
        if (tabId !== tab.id) throw new Error(`no tab ${tabId}`)
        return tab
      },
    },
    windows: {
      get: async (windowId: number) => {
        if (windowId !== win.id) throw new Error(`no window ${windowId}`)
        return win
      },
      // Poisoned: if the implementation regresses to getCurrent(), the
      // returned bounds (7777/8888) make the assertion below fail loudly.
      getCurrent: async () => {
        getCurrentCalls++
        return POISON_WINDOW
      },
    },
  }
}

function restoreChrome() {
  ;(globalThis as { chrome?: unknown }).chrome = originalChrome
}

afterEach(restoreChrome)

const FOREGROUND_TAB: FakeTab = { id: 42, windowId: 5, active: true }
const FOCUSED_WINDOW: FakeWindow = { id: 5, focused: true, state: "normal", left: 100, top: 50, width: 1200, height: 800 }

async function osInput() {
  const mod = await import("../extension/src/background/capabilities/os-input")
  return mod.handleOsInputActions
}

describe("trusted OS input — foreground guard (issue #166)", () => {
  test("os_click refuses when the owning window is not focused", async () => {
    installFakeChrome(FOREGROUND_TAB, { ...FOCUSED_WINDOW, focused: false })
    const result = await (await osInput())({ type: "os_click", x: 10, y: 10 }, 42)
    expect(result.success).toBe(false)
    expect(result.error).toContain("window 5 is not the OS-focused window")
    const data = result.data as { hint?: string }
    expect(data.hint).toContain("tab switch")
  })

  test("os_click refuses when the tab is not active in its window", async () => {
    installFakeChrome({ ...FOREGROUND_TAB, active: false }, FOCUSED_WINDOW)
    const result = await (await osInput())({ type: "os_click", x: 10, y: 10 }, 42)
    expect(result.success).toBe(false)
    expect(result.error).toContain("tab 42 is not the active tab")
  })

  test("os_click refuses when the owning window is minimized", async () => {
    installFakeChrome(FOREGROUND_TAB, { ...FOCUSED_WINDOW, state: "minimized", focused: false })
    const result = await (await osInput())({ type: "os_click", x: 10, y: 10 }, 42)
    expect(result.success).toBe(false)
    expect(result.error).toContain("minimized")
  })

  test("os_click refuses when the tab does not exist", async () => {
    installFakeChrome(FOREGROUND_TAB, FOCUSED_WINDOW)
    const result = await (await osInput())({ type: "os_click", x: 10, y: 10 }, 777)
    expect(result.success).toBe(false)
    expect(result.error).toContain("tab 777 not found")
  })

  test("os_click success path uses the OWNING window's bounds, never getCurrent()", async () => {
    installFakeChrome(FOREGROUND_TAB, FOCUSED_WINDOW)
    const result = await (await osInput())({ type: "os_click", x: 10, y: 20 }, 42)
    expect(result.success).toBe(true)
    const data = result.data as {
      windowBounds: { left: number; top: number; width: number; height: number }
      screenTarget: { pageX: number; pageY: number }
    }
    expect(data.windowBounds).toEqual({ left: 100, top: 50, width: 1200, height: 800 })
    expect(data.screenTarget).toEqual({ pageX: 10, pageY: 20 })
    expect(getCurrentCalls).toBe(0)
  })

  test("os_move success path uses the owning window's bounds, never getCurrent()", async () => {
    installFakeChrome(FOREGROUND_TAB, FOCUSED_WINDOW)
    const result = await (await osInput())(
      { type: "os_move", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }, 42
    )
    expect(result.success).toBe(true)
    const data = result.data as { windowBounds: { left: number; top: number } }
    expect(data.windowBounds.left).toBe(100)
    expect(data.windowBounds.top).toBe(50)
    expect(getCurrentCalls).toBe(0)
  })

  test("os_move refuses when the owning window is not focused", async () => {
    installFakeChrome(FOREGROUND_TAB, { ...FOCUSED_WINDOW, focused: false })
    const result = await (await osInput())({ type: "os_move", path: [{ x: 1, y: 2 }] }, 42)
    expect(result.success).toBe(false)
    expect(result.error).toContain("not the OS-focused window")
  })

  test("os_type refuses when the owning window is not focused", async () => {
    installFakeChrome(FOREGROUND_TAB, { ...FOCUSED_WINDOW, focused: false })
    const result = await (await osInput())({ type: "os_type", text: "hello" }, 42)
    expect(result.success).toBe(false)
    expect(result.error).toContain("not the OS-focused window")
  })

  test("os_type passes when the tab is foreground (no ref → no content-script focus)", async () => {
    installFakeChrome(FOREGROUND_TAB, FOCUSED_WINDOW)
    const result = await (await osInput())({ type: "os_type", text: "hello" }, 42)
    expect(result.success).toBe(true)
    expect((result.data as { text?: string }).text).toBe("hello")
  })

  test("os_key refuses when the tab is not active in its window", async () => {
    installFakeChrome({ ...FOREGROUND_TAB, active: false }, FOCUSED_WINDOW)
    const result = await (await osInput())({ type: "os_key", key: "Enter" }, 42)
    expect(result.success).toBe(false)
    expect(result.error).toContain("not the active tab")
  })

  test("os_key passes when the tab is foreground", async () => {
    installFakeChrome(FOREGROUND_TAB, FOCUSED_WINDOW)
    const result = await (await osInput())({ type: "os_key", key: "Enter", modifiers: ["cmd"] }, 42)
    expect(result.success).toBe(true)
    expect((result.data as { key?: string }).key).toBe("Enter")
  })
})
