// Render keep-alive for hidden managed tabs.
//
// Chromium sends no compositor frames to a hidden tab, so requestAnimationFrame
// never fires there, and the page reads `document.hidden === true`. Apps that
// gate their rendering on either never draw, and agents used to `tab switch`
// the tab into view to make them. This installs, inert, on every page from the
// MAIN-world document_start script; `tab keepalive <id>` switches it on for one
// tab. While on and the tab is really hidden, the page reads visible and queued
// animation-frame callbacks run from a timer. Chromium still throttles
// background timers (one wake-up per second after 10 s hidden), and
// IntersectionObserver / ResizeObserver callbacks need a real lifecycle update,
// so those stay quiet; the CLI result says so.
//
// Symbol-keyed and non-enumerable like the other MAIN-world state (see
// inject-keys.ts): the page cannot list it, only a caller that knows the key.

export type KeepaliveState = {
  on: boolean
  set: (on: boolean) => boolean
}

const FRAME_MS = 16

type Found = { owner: object; desc: PropertyDescriptor }

// The override goes on the object that actually owns the getter (Document
// prototype in Chromium), not on a fixed prototype: a nearer definition on
// the chain would shadow it otherwise.
function inheritedDescriptor(obj: object, name: string): Found | undefined {
  let o: object | null = obj
  while (o) {
    const desc = Object.getOwnPropertyDescriptor(o, name)
    if (desc) return { owner: o, desc }
    o = Object.getPrototypeOf(o)
  }
  return undefined
}

export function installRenderKeepalive(win: Window & typeof globalThis, key: symbol): KeepaliveState | null {
  const slot = win as unknown as Record<symbol, KeepaliveState | undefined>
  if (slot[key]) return slot[key] as KeepaliveState

  const doc = win.document
  const vis = inheritedDescriptor(doc, "visibilityState")
  const hidden = inheritedDescriptor(doc, "hidden")
  const hasFocus = inheritedDescriptor(doc, "hasFocus")
  const nativeRaf = win.requestAnimationFrame
  const nativeCaf = win.cancelAnimationFrame
  if (!vis?.desc.get || !hidden?.desc.get || typeof hasFocus?.desc.value !== "function" ||
      typeof nativeRaf !== "function" || typeof nativeCaf !== "function") return null
  const origVis = vis.desc.get
  const origHidden = hidden.desc.get
  const origHasFocus = hasFocus.desc.value as (this: Document) => boolean

  const realHidden = (): boolean => {
    try { return !!origHidden.call(doc) } catch { return false }
  }

  // Every rAF callback is tracked until the native frame or the timer drain
  // runs it, whichever comes first; never both.
  const pending = new Map<number, FrameRequestCallback>()
  let timer: number | null = null

  const state: KeepaliveState = {
    on: false,
    set(on: boolean): boolean {
      if (state.on === on) return on
      state.on = on
      try { doc.dispatchEvent(new win.Event("visibilitychange")) } catch {}
      ensureDrain()
      return on
    }
  }

  // Tick source while really hidden. Chromium aligns a hidden page's own
  // timers to one wake-up per second (3 ticks in 2 s measured), so a
  // setTimeout-driven drain gives about one frame per second. A dedicated
  // worker's timer is not aligned (186 ticks in 2 s measured on the same tab),
  // so the ticks come from a Blob worker and setTimeout is only the fallback
  // for pages whose CSP forbids blob: workers. One drain per tick, only while
  // callbacks are pending; a re-queuing callback is picked up by the next tick,
  // never by a re-entrant drain (that burst until the stack overflowed).
  const drain = (): void => {
    if (!state.on || !realHidden() || pending.size === 0) return
    const batch = Array.from(pending.values())
    pending.clear()
    const now = win.performance.now()
    for (const cb of batch) {
      try { cb(now) } catch {}
    }
  }
  let worker: Worker | null = null
  let workerBlocked = false
  const startTicker = (): void => {
    if (worker || timer !== null) return
    if (workerBlocked) { scheduleFallback(); return }
    try {
      const src = "setInterval(function(){postMessage(0)}," + FRAME_MS + ")"
      worker = new win.Worker(win.URL.createObjectURL(new win.Blob([src], { type: "text/javascript" })))
      worker.onmessage = drain
      worker.onerror = () => { workerBlocked = true; stopTicker(); scheduleFallback() }
    } catch {
      workerBlocked = true
      scheduleFallback()
    }
  }
  const scheduleFallback = (): void => {
    if (timer !== null) return
    timer = win.setTimeout(() => { timer = null; drain(); if (state.on && realHidden() && pending.size > 0) scheduleFallback() }, FRAME_MS)
  }
  const stopTicker = (): void => {
    if (worker) { try { worker.terminate() } catch {} worker = null }
    if (timer !== null) { win.clearTimeout(timer); timer = null }
  }
  const ensureDrain = (): void => {
    if (state.on && realHidden()) startTicker()
    else stopTicker()
  }

  win.requestAnimationFrame = function (cb: FrameRequestCallback): number {
    const id: number = nativeRaf.call(win, (ts: number) => {
      if (!pending.has(id)) return
      pending.delete(id)
      cb(ts)
    })
    pending.set(id, cb)
    ensureDrain()
    return id
  }
  win.cancelAnimationFrame = function (id: number): void {
    pending.delete(id)
    nativeCaf.call(win, id)
  }

  Object.defineProperty(vis.owner, "visibilityState", {
    configurable: true,
    enumerable: vis.desc.enumerable === true,
    get(this: Document) { return state.on ? "visible" : origVis.call(this) }
  })
  Object.defineProperty(hidden.owner, "hidden", {
    configurable: true,
    enumerable: hidden.desc.enumerable === true,
    get(this: Document) { return state.on ? false : origHidden.call(this) }
  })
  Object.defineProperty(hasFocus.owner, "hasFocus", {
    configurable: true,
    enumerable: hasFocus.desc.enumerable === true,
    writable: true,
    value: function (this: Document): boolean { return state.on ? true : origHasFocus.call(this) }
  })

  // A tab that was visible and then hidden again needs the drain restarted.
  doc.addEventListener("visibilitychange", ensureDrain)

  Object.defineProperty(win, key, { value: state, configurable: true })
  return state
}
