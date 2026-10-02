import { describe, expect, test } from "bun:test"
import { BACKGROUND_OS_ACTIONS, bridgeActionFor, deliverInBackground } from "../daemon/os-background"

// The daemon hands a trusted browser action for an unfocused window to the
// macOS bridge. These pin the action it builds and what the caller gets back.

const BOUNDS = { left: 0, top: 30, width: 1728, height: 1011 }
const TARGET = {
  title: "Flow project",
  error: "window 5 is not the OS-focused window — trusted OS events are routed by the OS to whatever is frontmost, not to the target tab",
  hint: "trusted OS input needs the target tab visible in the OS-focused window.",
}

describe("background trusted input → bridge action", () => {
  test("os_click becomes a window-addressed bridge click at screen coordinates", () => {
    const action = bridgeActionFor({
      type: "os_click", background: TARGET, windowBounds: BOUNDS,
      pageX: 400, pageY: 300, chromeUiHeight: 81, button: "left", clickCount: 1,
    })
    expect(action).toEqual({
      type: "macos_bginput_click", coords: "400,411", right: false, double: false,
      windowTitle: "Flow project", windowBounds: BOUNDS,
    })
  })

  test("right and double clicks keep their kind; a missing UI height falls back to 88", () => {
    const right = bridgeActionFor({ type: "os_click", background: TARGET, windowBounds: BOUNDS, pageX: 10, pageY: 10, button: "right" })
    expect(right).toMatchObject({ right: true, double: false, coords: "10,128" })
    const double = bridgeActionFor({ type: "os_click", background: TARGET, windowBounds: BOUNDS, pageX: 10, pageY: 10, chromeUiHeight: 81, clickCount: 2 })
    expect(double).toMatchObject({ right: false, double: true })
  })

  test("os_type and os_key name the same window", () => {
    expect(bridgeActionFor({ type: "os_type", background: TARGET, windowBounds: BOUNDS, text: "hello" }))
      .toEqual({ type: "macos_bginput_type", text: "hello", windowTitle: "Flow project", windowBounds: BOUNDS })
    expect(bridgeActionFor({ type: "os_key", background: TARGET, windowBounds: BOUNDS, key: "a", modifiers: ["Meta", "Shift"] }))
      .toEqual({ type: "macos_bginput_keys", keys: "Meta+Shift+a", windowTitle: "Flow project", windowBounds: BOUNDS })
    expect(bridgeActionFor({ type: "os_key", background: TARGET, windowBounds: BOUNDS, key: "Enter" }))
      .toMatchObject({ keys: "Enter" })
  })

  test("nothing is built without a window frame, coordinates, or for os_move", () => {
    expect(bridgeActionFor({ type: "os_click", background: TARGET, pageX: 1, pageY: 1 })).toBeNull()
    expect(bridgeActionFor({ type: "os_click", background: TARGET, windowBounds: BOUNDS })).toBeNull()
    expect(bridgeActionFor({ type: "os_type", background: TARGET, windowBounds: BOUNDS, text: "" })).toBeNull()
    expect(bridgeActionFor({ type: "os_move", background: TARGET, windowBounds: BOUNDS, path: [] })).toBeNull()
    expect(BACKGROUND_OS_ACTIONS.has("os_move")).toBe(false)
  })
})

// macos_click / macos_type / macos_keys on a bridge from before
// window-addressed input ignore the window fields and post to the frontmost
// app. The browser path must never use them.
describe("background trusted input never uses a verb an older bridge would deliver to the frontmost app", () => {
  test("every bridge action goes to the bginput domain", () => {
    const actions = [
      bridgeActionFor({ type: "os_click", background: TARGET, windowBounds: BOUNDS, pageX: 1, pageY: 1 }),
      bridgeActionFor({ type: "os_type", background: TARGET, windowBounds: BOUNDS, text: "x" }),
      bridgeActionFor({ type: "os_key", background: TARGET, windowBounds: BOUNDS, key: "Enter" }),
    ]
    for (const a of actions) expect(String(a?.type)).toStartWith("macos_bginput_")
  })

  test("an older bridge has no such handler, so the caller gets the refusal and nothing is delivered", async () => {
    const type = { type: "os_type", background: TARGET, windowBounds: BOUNDS, text: "secret" }
    const result = await deliverInBackground(type, async () => ({ success: false, error: "no handler for domain: bginput" }))
    expect(result.success).toBe(false)
    expect(result.error).toContain("window 5 is not the OS-focused window")
    expect(result.error).toContain("no handler for domain: bginput")
  })
})

describe("background trusted input → result", () => {
  const click = { type: "os_click", background: TARGET, windowBounds: BOUNDS, pageX: 400, pageY: 300, chromeUiHeight: 81 }

  test("a bridge success says the delivery was in the background", async () => {
    const sent: Record<string, unknown>[] = []
    const result = await deliverInBackground(click, async (a) => { sent.push(a); return { success: true, data: "clicked at (400, 411) → pid=4321 window=7247" } })
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe("macos_bginput_click")
    expect(result).toEqual({ success: true, data: "delivered in the background, focus unchanged: clicked at (400, 411) → pid=4321 window=7247" })
  })

  test("a page the browser has paused adds a warning", async () => {
    const result = await deliverInBackground({ ...click, background: { ...TARGET, pageHidden: true } }, async () => ({ success: true, data: "clicked" }))
    expect(result.success).toBe(true)
    expect(result.warning).toContain("page reports hidden")
  })

  test("a bridge failure returns the gate's refusal and hint, with the reason", async () => {
    const result = await deliverInBackground(click, async () => ({ success: false, error: "no on-screen window matches the tab's window (nothing was delivered)" }))
    expect(result.success).toBe(false)
    expect(result.error).toContain("window 5 is not the OS-focused window")
    expect(result.error).toContain("no on-screen window matches")
    expect((result.data as { hint: string }).hint).toBe(TARGET.hint)
  })

  test("an action the bridge cannot take is refused without calling it", async () => {
    let called = false
    const result = await deliverInBackground({ type: "os_click", background: TARGET }, async () => { called = true; return { success: true } })
    expect(called).toBe(false)
    expect(result).toEqual({ success: false, error: TARGET.error, data: { hint: TARGET.hint } })
  })
})
