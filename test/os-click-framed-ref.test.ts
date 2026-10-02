import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { handleOsInputActions } from "../extension/src/background/capabilities/os-input"

// A framed ref (`e<frame>_<n>`) names element n of an iframe. The trusted click
// used to ask the TOP frame for "e<n>", got a different element with the same
// number, and clicked it (a reCAPTCHA checkbox ref clicked the page's first
// text field). The rect now comes from the ref's own frame and each ancestor
// iframe's content origin is added; when a frame cannot be located nothing is
// clicked.

const g = globalThis as unknown as { chrome?: unknown }
let savedChrome: unknown
beforeEach(() => { savedChrome = g.chrome })
afterEach(() => { g.chrome = savedChrome })

type Sent = { frameId: number; action: Record<string, unknown> }
type Answer = { success: boolean; data?: Record<string, number | boolean>; error?: string }

function install(frames: { frameId: number; parentFrameId: number; url: string }[], answer: (s: Sent) => Answer) {
  const sent: Sent[] = []
  g.chrome = {
    runtime: {},
    tabs: {
      get: async () => ({ id: 42, windowId: 5, active: true, title: "ReCAPTCHA demo", url: "https://example.com/" }),
      getZoom: async () => 1,
      sendMessage: (_tab: number, msg: { action: Record<string, unknown> }, opts: { frameId: number }, cb: (r: Answer) => void) => {
        const s = { frameId: opts.frameId, action: msg.action }
        sent.push(s)
        cb(answer(s))
      },
    },
    windows: { get: async () => ({ id: 5, focused: false, state: "normal", left: 0, top: 52, width: 1728, height: 811 }) },
    webNavigation: { getAllFrames: async () => frames },
  }
  return sent
}

const TOP_PAGE = { viewportHeight: 730, pageHidden: false }
const click = (action: Record<string, unknown>) => handleOsInputActions({ type: "os_click", backgroundOk: true, ...action }, 42)
type ClickData = { screenTarget: { pageX: number; pageY: number }; chromeUiHeight: number; background?: { pageHidden?: boolean } }

describe("os_click on a ref inside an iframe", () => {
  test("the rect comes from the ref's frame, placed by the iframe's origin in the top page", async () => {
    const sent = install([{ frameId: 0, parentFrameId: -1, url: "https://example.com/" }, { frameId: 7, parentFrameId: 0, url: "https://captcha.example/anchor" }], s => {
      if (s.frameId === 7 && s.action.ref === "e1") return { success: true, data: { left: 12, top: 21, width: 28, height: 28, viewportHeight: 78 } }
      if (s.frameId === 0 && s.action.hostOfFrame === 7) return { success: true, data: { left: 33, top: 337, width: 304, height: 78, ...TOP_PAGE } }
      // The old behavior: the top frame's own e1, a different element.
      return { success: true, data: { left: 33, top: 78, width: 154, height: 29, ...TOP_PAGE } }
    })
    const result = await click({ ref: "e1", frameId: 7 })
    expect(result.success).toBe(true)
    const data = result.data as ClickData
    expect(data.screenTarget).toEqual({ pageX: 33 + 12 + 14, pageY: 337 + 21 + 14 })
    // Window math uses the top page's viewport, not the iframe's 78 px.
    expect(data.chromeUiHeight).toBe(811 - 730)
    expect(sent.some(s => s.frameId === 0 && s.action.ref === "e1")).toBe(false)
    expect(sent.find(s => s.action.hostOfFrame === 7)?.action.hostUrl).toBe("https://captcha.example/anchor")
  })

  test("nested iframes add every ancestor's origin", async () => {
    install([{ frameId: 0, parentFrameId: -1, url: "a" }, { frameId: 7, parentFrameId: 0, url: "b" }, { frameId: 9, parentFrameId: 7, url: "c" }], s => {
      if (s.frameId === 9) return { success: true, data: { left: 1, top: 2, width: 10, height: 10, viewportHeight: 50 } }
      if (s.frameId === 7) return { success: true, data: { left: 100, top: 200, width: 60, height: 60, viewportHeight: 300 } }
      return { success: true, data: { left: 1000, top: 2000, width: 400, height: 300, ...TOP_PAGE } }
    })
    const data = (await click({ ref: "e3", frameId: 9 })).data as ClickData
    expect(data.screenTarget).toEqual({ pageX: 1000 + 100 + 1 + 5, pageY: 2000 + 200 + 2 + 5 })
  })

  test("a point inside a frame is placed the same way (automatic escalation passes x,y)", async () => {
    install([{ frameId: 0, parentFrameId: -1, url: "a" }, { frameId: 7, parentFrameId: 0, url: "b" }],
      () => ({ success: true, data: { left: 33, top: 337, width: 304, height: 78, ...TOP_PAGE } }))
    const data = (await click({ x: 26, y: 35, frameId: 7 })).data as ClickData
    expect(data.screenTarget).toEqual({ pageX: 59, pageY: 372 })
  })

  test("an iframe that cannot be located refuses, and nothing is clicked", async () => {
    for (const frames of [
      [{ frameId: 0, parentFrameId: -1, url: "a" }, { frameId: 7, parentFrameId: 0, url: "b" }], // parent cannot find the iframe element
      [{ frameId: 0, parentFrameId: -1, url: "a" }],                                             // frame id is gone
    ]) {
      install(frames, s => s.action.hostOfFrame !== undefined ? { success: false, error: "iframe not found" } : { success: true, data: { left: 1, top: 1, width: 2, height: 2 } })
      const result = await click({ ref: "e1", frameId: 7 })
      expect(result.success).toBe(false)
      expect(result.error).toContain("could not locate iframe 7")
      expect(result.error).toContain("nothing was clicked")
    }
  })

  test("a top-frame ref is unchanged: one rect request, to frame 0", async () => {
    const sent = install([], () => ({ success: true, data: { left: 10, top: 20, width: 100, height: 40, ...TOP_PAGE } }))
    const data = (await click({ ref: "e5" })).data as ClickData
    expect(data.screenTarget).toEqual({ pageX: 60, pageY: 40 })
    expect(sent).toEqual([{ frameId: 0, action: { type: "rect", index: undefined, ref: "e5" } }])
  })
})
