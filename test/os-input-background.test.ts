/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test"

// Trusted OS input for a window that is not OS-focused.
//
// The foreground guard (issue #166) refuses a tab whose window is not focused,
// because the daemon's HID-tap events go to whatever is frontmost. The macOS
// bridge can address a window by id, so a daemon that has one sets
// `backgroundOk` on the action. Then the gate lets an ACTIVE tab in an
// unfocused, non-minimized window through and returns what the bridge needs
// to find the window (its frame and the tab title) plus the refusal to fall
// back on. Without the flag nothing changes, so an older daemon paired with a
// newer extension still gets the refusal.

interface FakeTab { id: number; windowId: number; active: boolean; title?: string }
interface FakeWindow {
  id: number; focused: boolean; state: string
  left: number; top: number; width: number; height: number
}

let originalChrome: unknown

function installFakeChrome(tab: FakeTab, win: FakeWindow) {
  originalChrome = (globalThis as { chrome?: unknown }).chrome
  ;(globalThis as { chrome: unknown }).chrome = {
    tabs: { get: async (tabId: number) => { if (tabId !== tab.id) throw new Error(`no tab ${tabId}`); return tab } },
    windows: { get: async (windowId: number) => { if (windowId !== win.id) throw new Error(`no window ${windowId}`); return win } },
  }
}

afterEach(() => { (globalThis as { chrome?: unknown }).chrome = originalChrome })

const TAB: FakeTab = { id: 42, windowId: 5, active: true, title: "Flow project" }
const UNFOCUSED: FakeWindow = { id: 5, focused: false, state: "normal", left: 0, top: 30, width: 1728, height: 1011 }

async function osInput() {
  return (await import("../extension/src/background/capabilities/os-input")).handleOsInputActions
}

type BackgroundData = {
  method: string
  windowBounds?: { left: number; top: number; width: number; height: number }
  background?: { title: string; error: string; hint: string; pageHidden?: boolean }
}

describe("trusted OS input — unfocused window with a bridge-capable daemon", () => {
  test("os_click is allowed and carries the window frame, tab title, and the fallback refusal", async () => {
    installFakeChrome(TAB, UNFOCUSED)
    const result = await (await osInput())({ type: "os_click", x: 10, y: 20, backgroundOk: true }, 42)
    expect(result.success).toBe(true)
    const data = result.data as BackgroundData & { screenTarget: { pageX: number; pageY: number }; chromeUiHeight: number }
    expect(data.method).toBe("os_event")
    expect(data.windowBounds).toEqual({ left: 0, top: 30, width: 1728, height: 1011 })
    expect(data.screenTarget).toEqual({ pageX: 10, pageY: 20 })
    // x,y clicks never ask the page for its viewport, so the fixed height stands.
    expect(data.chromeUiHeight).toBe(88)
    expect(data.background?.title).toBe("Flow project")
    expect(data.background?.error).toContain("window 5 is not the OS-focused window")
    expect(data.background?.hint).toMatch(/^trusted OS input reaches a tab only when it is the active tab/)
    expect(data.background?.pageHidden).toBe(false)
  })

  test("os_type and os_key carry the window frame the bridge matches on", async () => {
    installFakeChrome(TAB, UNFOCUSED)
    for (const action of [{ type: "os_type", text: "hello" }, { type: "os_key", key: "Enter" }]) {
      const result = await (await osInput())({ ...action, backgroundOk: true }, 42)
      expect(result.success).toBe(true)
      const data = result.data as BackgroundData
      expect(data.windowBounds).toEqual({ left: 0, top: 30, width: 1728, height: 1011 })
      expect(data.background?.title).toBe("Flow project")
    }
  })

  test("without backgroundOk the unfocused window is still refused, for every verb", async () => {
    installFakeChrome(TAB, UNFOCUSED)
    for (const action of [{ type: "os_click", x: 1, y: 1 }, { type: "os_type", text: "x" }, { type: "os_key", key: "a" }]) {
      const result = await (await osInput())(action, 42)
      expect(result.success).toBe(false)
      expect(result.error).toContain("not the OS-focused window")
      expect((result.data as { hint?: string }).hint).toContain("tab switch")
    }
  })

  test("os_move stays foreground-only", async () => {
    installFakeChrome(TAB, UNFOCUSED)
    const result = await (await osInput())({ type: "os_move", path: [{ x: 1, y: 2 }], backgroundOk: true }, 42)
    expect(result.success).toBe(false)
    expect(result.error).toContain("not the OS-focused window")
  })

  test("a minimized window and an inactive tab are refused even with backgroundOk", async () => {
    installFakeChrome(TAB, { ...UNFOCUSED, state: "minimized" })
    const minimized = await (await osInput())({ type: "os_click", x: 1, y: 1, backgroundOk: true }, 42)
    expect(minimized.success).toBe(false)
    expect(minimized.error).toContain("minimized")

    installFakeChrome({ ...TAB, active: false }, UNFOCUSED)
    const hiddenTab = await (await osInput())({ type: "os_click", x: 1, y: 1, backgroundOk: true }, 42)
    expect(hiddenTab.success).toBe(false)
    expect(hiddenTab.error).toContain("tab 42 is not the active tab")
  })

  test("a focused window takes the foreground path: no background target", async () => {
    installFakeChrome(TAB, { ...UNFOCUSED, focused: true })
    const result = await (await osInput())({ type: "os_click", x: 10, y: 20, backgroundOk: true }, 42)
    expect(result.success).toBe(true)
    expect((result.data as BackgroundData).background).toBeUndefined()
  })
})
