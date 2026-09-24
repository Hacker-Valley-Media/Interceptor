/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { installRenderKeepalive } from "../extension/src/inject-keepalive"

try { GlobalRegistrator.register() } catch { /* already registered */ }

// Page-side render keep-alive. A hidden Chromium tab gets no
// compositor frames, so rAF never fires and the page reads hidden. These tests
// simulate that: the native rAF stub never fires and the visibility getters
// report hidden, then the keep-alive is switched on.

const KEY = Symbol.for("test-keepalive")

type Win = Window & typeof globalThis
let win: Win
let hiddenFlag: boolean
let nativeCallbacks: Map<number, FrameRequestCallback>
let nextId: number
let savedVis: PropertyDescriptor | undefined
let savedHidden: PropertyDescriptor | undefined
let savedRaf: typeof window.requestAnimationFrame
let savedCaf: typeof window.cancelAnimationFrame
let savedHasFocus: typeof Document.prototype.hasFocus

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// happy-dom may own these getters on a nearer prototype than Document; stub
// them where they live, which is also where the keep-alive installs.
function owner(name: string): object {
  let o: object | null = document
  while (o) {
    if (Object.getOwnPropertyDescriptor(o, name)) return o
    o = Object.getPrototypeOf(o)
  }
  throw new Error(`document has no ${name}`)
}
let visOwner: object
let hiddenOwner: object
let focusOwner: object

let savedWorker: unknown

beforeEach(() => {
  win = globalThis as unknown as Win
  // The existing cases pin the setTimeout fallback; the worker path has its own case below.
  savedWorker = (win as unknown as { Worker?: unknown }).Worker
  ;(win as unknown as { Worker?: unknown }).Worker = undefined
  hiddenFlag = true
  nativeCallbacks = new Map()
  nextId = 0
  visOwner = owner("visibilityState")
  hiddenOwner = owner("hidden")
  focusOwner = owner("hasFocus")
  savedVis = Object.getOwnPropertyDescriptor(visOwner, "visibilityState")
  savedHidden = Object.getOwnPropertyDescriptor(hiddenOwner, "hidden")
  savedRaf = win.requestAnimationFrame
  savedCaf = win.cancelAnimationFrame
  savedHasFocus = Object.getOwnPropertyDescriptor(focusOwner, "hasFocus")!.value
  Object.defineProperty(visOwner, "visibilityState", { configurable: true, get: () => (hiddenFlag ? "hidden" : "visible") })
  Object.defineProperty(hiddenOwner, "hidden", { configurable: true, get: () => hiddenFlag })
  // Native rAF for a hidden tab: accepted, never delivered.
  win.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = ++nextId
    nativeCallbacks.set(id, cb)
    return id
  }
  win.cancelAnimationFrame = (id: number): void => { nativeCallbacks.delete(id) }
})

afterEach(() => {
  const state = (win as unknown as Record<symbol, { set: (v: boolean) => boolean } | undefined>)[KEY]
  state?.set(false)
  ;(win as unknown as { Worker?: unknown }).Worker = savedWorker
  delete (win as unknown as Record<symbol, unknown>)[KEY]
  if (savedVis) Object.defineProperty(visOwner, "visibilityState", savedVis)
  if (savedHidden) Object.defineProperty(hiddenOwner, "hidden", savedHidden)
  win.requestAnimationFrame = savedRaf
  win.cancelAnimationFrame = savedCaf
  Object.defineProperty(focusOwner, "hasFocus", { configurable: true, writable: true, value: savedHasFocus })
})

describe("render keep-alive (page side)", () => {
  test("installs inert: the page still reads its real visibility", () => {
    const state = installRenderKeepalive(win, KEY)
    expect(state).not.toBeNull()
    expect(state!.on).toBe(false)
    expect(document.visibilityState).toBe("hidden")
    expect(document.hidden).toBe(true)
  })

  test("installing twice returns the same state object", () => {
    const a = installRenderKeepalive(win, KEY)
    const b = installRenderKeepalive(win, KEY)
    expect(b).toBe(a)
  })

  test("set(true) reads visible, hasFocus, and fires visibilitychange once", () => {
    const state = installRenderKeepalive(win, KEY)!
    let changes = 0
    document.addEventListener("visibilitychange", () => { changes++ })
    state.set(true)
    expect(document.visibilityState).toBe("visible")
    expect(document.hidden).toBe(false)
    expect(document.hasFocus()).toBe(true)
    expect(changes).toBe(1)
    state.set(true) // no-op, no second event
    expect(changes).toBe(1)
  })

  test("rAF callbacks queued before and after set(true) run from the timer while hidden, once each", async () => {
    const state = installRenderKeepalive(win, KEY)!
    const runs: number[] = []
    const before = win.requestAnimationFrame(ts => { runs.push(ts) })
    expect(nativeCallbacks.size).toBe(1)
    await sleep(40)
    expect(runs.length).toBe(0) // inert: nothing drains a hidden tab
    state.set(true)
    win.requestAnimationFrame(ts => { runs.push(ts) })
    await sleep(60)
    expect(runs.length).toBe(2)
    expect(typeof runs[0]).toBe("number")
    // The drained callback's native request is cancelled, so Chromium holds no
    // stale entry to fire on the next paint.
    expect(nativeCallbacks.has(before)).toBe(false)
    expect(runs.length).toBe(2)
  })

  test("set(false) restores real visibility and stops draining", async () => {
    const state = installRenderKeepalive(win, KEY)!
    state.set(true)
    state.set(false)
    expect(document.visibilityState).toBe("hidden")
    expect(document.hidden).toBe(true)
    let ran = 0
    win.requestAnimationFrame(() => { ran++ })
    await sleep(60)
    expect(ran).toBe(0)
  })

  test("while really visible the native frame path delivers and the timer stays idle", async () => {
    const state = installRenderKeepalive(win, KEY)!
    hiddenFlag = false
    state.set(true)
    let ran = 0
    const id = win.requestAnimationFrame(() => { ran++ })
    await sleep(40)
    expect(ran).toBe(0) // no timer drain when the tab is visible
    nativeCallbacks.get(id)!(1)
    expect(ran).toBe(1)
    expect(document.visibilityState).toBe("visible")
  })

  test("cancelAnimationFrame drops the callback from both paths", async () => {
    const state = installRenderKeepalive(win, KEY)!
    state.set(true)
    let ran = 0
    const id = win.requestAnimationFrame(() => { ran++ })
    win.cancelAnimationFrame(id)
    await sleep(40)
    expect(ran).toBe(0)
    expect(nativeCallbacks.has(id)).toBe(false)
  })
})

describe("render keep-alive — self-requeuing loop", () => {
  test("a rAF loop runs at roughly frame rate while hidden and keeps running (no burst, no death)", async () => {
    const state = installRenderKeepalive(win, KEY)!
    state.set(true)
    let n = 0
    const loop = () => { n++; win.requestAnimationFrame(loop) }
    win.requestAnimationFrame(loop)
    await sleep(100)
    const first = n
    expect(first).toBeGreaterThanOrEqual(3)
    expect(first).toBeLessThanOrEqual(15)
    await sleep(100)
    expect(n).toBeGreaterThan(first)
    state.set(false)
    const stopped = n
    await sleep(60)
    expect(n).toBe(stopped)
  })
})

describe("render keep-alive — worker ticker", () => {
  test("ticks come from a Blob worker when one can be created; terminate on set(false)", async () => {
    let created = 0, terminated = 0
    class FakeWorker {
      onmessage: ((ev: { data: unknown }) => void) | null = null
      onerror: (() => void) | null = null
      private t: ReturnType<typeof setInterval>
      constructor(_url: string) { created++; this.t = setInterval(() => this.onmessage?.({ data: 0 }), 16) }
      terminate() { terminated++; clearInterval(this.t) }
    }
    ;(win as unknown as { Worker?: unknown }).Worker = FakeWorker
    const savedCreate = win.URL.createObjectURL
    win.URL.createObjectURL = () => "blob:fake"
    try {
      const state = installRenderKeepalive(win, KEY)!
      state.set(true)
      expect(created).toBe(1)
      let n = 0
      const loop = () => { n++; win.requestAnimationFrame(loop) }
      win.requestAnimationFrame(loop)
      await sleep(100)
      expect(n).toBeGreaterThanOrEqual(3)
      expect(n).toBeLessThanOrEqual(15)
      state.set(false)
      expect(terminated).toBe(1)
      const stopped = n
      await sleep(60)
      expect(n).toBe(stopped)
    } finally {
      win.URL.createObjectURL = savedCreate
    }
  })

  test("a worker that cannot be created falls back to timers and is not retried per frame", async () => {
    let attempts = 0
    class BlockedWorker { constructor(_url: string) { attempts++; throw new Error("blocked by CSP") } }
    ;(win as unknown as { Worker?: unknown }).Worker = BlockedWorker
    const savedCreate = win.URL.createObjectURL
    win.URL.createObjectURL = () => "blob:fake"
    try {
      const state = installRenderKeepalive(win, KEY)!
      state.set(true)
      let n = 0
      const loop = () => { n++; win.requestAnimationFrame(loop) }
      win.requestAnimationFrame(loop)
      await sleep(100)
      expect(n).toBeGreaterThanOrEqual(3)
      expect(attempts).toBe(1)
    } finally {
      win.URL.createObjectURL = savedCreate
    }
  })
})
