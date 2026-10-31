// A background trusted click says what the page received, moves a tab that is
// not showing into its own window, and comes home. The page's marker shim and
// the background-held wait_stable clock live here too.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { confirmDelivery, deliverInOwnWindow } from "../daemon/os-background"
import { installTrustShim } from "../extension/src/inject-trust"
import { formatActChanges } from "../cli/commands/compound"

const root = join(import.meta.dir, "..")
const read = (file: string) => readFileSync(join(root, file), "utf-8")
const delivered = { success: true, data: "delivered in the background, focus unchanged: ok", warning: "the page reports hidden" }
const target = { title: "t", error: "e", hint: "h", tabId: 7, watching: true }
const noWait = async () => {}
const receipts = (...answers: unknown[]) => {
  let i = 0
  return async () => ({ success: true, data: answers[Math.min(i++, answers.length - 1)] })
}

describe("confirmDelivery", () => {
  test("events reaching the page confirm it and drop the hidden warning", async () => {
    const result = await confirmDelivery(delivered, target, receipts({ events: ["mousedown"], hidden: true }), noWait)
    expect(result.success).toBe(true)
    expect(result.received).toBe(true)
    expect(result.warning).toBeUndefined()
    expect(result.data).toContain("delivered in the background, focus unchanged")
    expect(result.data).toContain("the page received it")
  })

  test("a slow page gets more than one read", async () => {
    const result = await confirmDelivery(delivered, target, receipts({ events: [] }, { events: [] }, { events: ["click"] }), noWait)
    expect(result.received).toBe(true)
  })

  test("silence fails, says to read the page, and never asks for a move", async () => {
    // Input can land in a document the receipt cannot hear, so a move and a
    // second send could deliver it twice.
    const result = await confirmDelivery(delivered, target, receipts({ events: [], hidden: true }), noWait)
    expect(result).toMatchObject({ success: false, received: false })
    expect(result.delivered).toBeUndefined()
    expect(result.error).toContain("the page reported none of it")
    expect(result.error).toContain("read the page before sending it again")
    expect((result.data as { hint: string }).hint).toContain("interceptor window new --tab 7")
    expect((result.data as Record<string, unknown>).moveTabId).toBeUndefined()
  })

  test("silence from a visible page points at the frontmost browser", async () => {
    const result = await confirmDelivery(delivered, target, receipts({ events: [], hidden: false }), noWait)
    expect(result.success).toBe(false)
    expect((result.data as { hint: string }).hint).toContain("frontmost app")
  })

  test("no answer keeps the old result: it claims nothing either way", async () => {
    // Navigated away: a new document was never armed, so it has no `events`.
    expect(await confirmDelivery(delivered, target, receipts({ hidden: false }), noWait)).toEqual(delivered)
    // An older extension does not know the action.
    expect(await confirmDelivery(delivered, target, async () => ({ success: false, error: "unknown" }), noWait)).toEqual(delivered)
    // Nothing armed (an iframe under the point, or a browser chord).
    expect(await confirmDelivery(delivered, { ...target, watching: false }, receipts({ events: [] }), noWait)).toEqual(delivered)
  })

  test("a failed delivery is not read at all", async () => {
    const failed = { success: false, error: "no window" }
    expect(await confirmDelivery(failed, target, async () => { throw new Error("read") }, noWait)).toEqual(failed)
  })
})

describe("deliverInOwnWindow", () => {
  const miss = { success: false, error: "miss" }

  test("moves, retries, moves home with what the move returned", async () => {
    const calls: Record<string, unknown>[] = []
    const home = { windowId: 1, index: 2 }
    const result = await deliverInOwnWindow(miss, async (a) => { calls.push(a); return { success: true, data: home } },
      async () => ({ success: true, data: "ok" }))
    expect(result).toEqual({ success: true, data: "ok" })
    expect(calls).toEqual([{ type: "os_detach" }, { type: "os_return", home }])
  })

  test("a tab that cannot move keeps the first answer and is not retried", async () => {
    const result = await deliverInOwnWindow(miss, async () => ({ success: false }), async () => { throw new Error("retried") })
    expect(result).toEqual(miss)
  })

  test("a tab that cannot go home says so", async () => {
    const result = await deliverInOwnWindow(miss,
      async (a) => a.type === "os_detach" ? { success: true, data: {} } : { success: false, error: "dragging" },
      async () => ({ success: true, data: "ok" }))
    expect(result).toMatchObject({ success: true, data: "ok", warning: "the tab stayed in its own window: dragging" })
  })

  test("the tab comes home even when the retry throws", async () => {
    const types: unknown[] = []
    const run = deliverInOwnWindow(miss, async (a) => { types.push(a.type); return { success: true, data: {} } },
      async () => { throw new Error("boom") })
    await expect(run).rejects.toThrow("boom")
    expect(types).toEqual(["os_detach", "os_return"])
  })
})

describe("wiring", () => {
  const gate = read("extension/src/background/capabilities/os-input.ts")
  const dispatch = read("extension/src/background/message-dispatch.ts")
  const daemon = read("daemon/index.ts")

  test("only a daemon that can move a tab is told to, and never on Safari", () => {
    expect(gate).toContain("const moveTarget = backgroundOk && hasTabGroupApi() ? { moveTabId: tabId } : {}")
  })

  test("a browser chord is never read back: the browser keeps it from the page", () => {
    expect(gate).toContain("fg.background && !chord ? await armReceipt(tabId) : false")
  })

  test("only a refusal is ever sent again: nothing was delivered yet", () => {
    expect(read("daemon/os-background.ts")).not.toContain("moveTabId")
    expect(gate.match(/moveTarget/g)!.length).toBe(3)
  })

  test("the daemon's own calls never change the caller's stored target", () => {
    expect(daemon).toContain("anyTab: true, keepTarget: true")
    expect(dispatch).toContain("!softFallbackTab && action.keepTarget !== true) setActiveTabId(tabId, groupLabel)")
  })

  test("a page that cannot answer never holds up delivery", () => {
    expect(gate).toContain("setTimeout(() => resolve(null), ARM_TIMEOUT_MS)")
  })

  test("every spelling of the command key counts as a chord", () => {
    expect(gate).toContain("/^(cmd|command|meta|win|super|ctrl|control)$/i")
  })

  test("window new --tab cannot take another session's tab, and --any-tab never adopts one", () => {
    expect(dispatch).toContain('|| moveTabId !== undefined)) {')
    const windows = read("extension/src/background/capabilities/windows.ts")
    expect(windows).toContain("labelForGroupId(tab.groupId) === group")
    expect(windows).toContain("if (firstTab?.id && !action.incognito && adopts) {")
  })

  test("the move outlasts the window timeout, so a slow create is not abandoned", () => {
    expect(daemon).toContain("route.contextId, moveTabId, 10_000)")
    expect(read("extension/src/background/capabilities/windows.ts")).toMatch(/WINDOW_OP_TIMEOUT_MS = 8_?000\b/)
  })

  test("the retry runs once and carries a resolved secret", () => {
    expect(daemon).toContain("{ ...route, retried: true }")
    expect(daemon).toContain("if (!pending.osRoute || pending.osRoute.retried) return undefined")
    expect(daemon).toContain("sensitiveText: osRoute?.sensitiveText,")
  })

  test("window new --tab passes the managed-tab gate", () => {
    const gateAt = dispatch.indexOf("needsTab(action.type) || moveTabId !== undefined")
    expect(gateAt).toBeGreaterThan(dispatch.indexOf('action.type === "window_create" && typeof action.moveTabId === "number"'))
    expect(gateAt).toBeGreaterThan(0)
  })

  test("act prints a refusal's hint and treats a refusal as nothing sent", () => {
    const act = read("cli/commands/compound.ts")
    expect(act).toContain("data: actionResult!.data,")
    expect(gate.match(/delivered: false/g)!.length).toBe(3)
  })

  test("wait_stable keeps its clock in the background, and batch still reaches it", () => {
    expect(read("extension/src/background/router.ts")).toContain('action.type === "wait_stable"')
    expect(read("extension/src/content/actions/wait.ts")).toContain("performance.now()")
    // Sub-actions of `batch` run in the content script and never see the router.
    expect(read("extension/src/content.ts")).toContain('case "wait_stable":         return handleWaitStable(action)')
  })

  test("the page-world bundle does not name the extension in a stack trace", () => {
    expect(read("scripts/build.sh")).toContain("//# sourceURL=<anonymous>")
  })
})

describe("listener shim", () => {
  class Target extends EventTarget {}
  // A prototype of our own, so the shim never touches the test runner's.
  const proto = Target.prototype as unknown as EventTarget
  Object.defineProperty(proto, "addEventListener", { writable: true, configurable: true, value: EventTarget.prototype.addEventListener })
  Object.defineProperty(proto, "removeEventListener", { writable: true, configurable: true, value: EventTarget.prototype.removeEventListener })
  installTrustShim(proto, () => true)

  const fire = (target: EventTarget, type = "click", tagged = true) => {
    const event = new Event(type, { cancelable: true }) as Event & { __interceptor_trust?: boolean }
    if (tagged) event.__interceptor_trust = true
    target.dispatchEvent(event)
    return event
  }

  test("a tagged event reads trusted, an untagged one reaches the listener unchanged", () => {
    const target = new Target()
    const seen: boolean[] = [], events: Event[] = []
    target.addEventListener("click", (e) => { seen.push(e.isTrusted); events.push(e) })
    const tagged = fire(target), plain = fire(target, "click", false)
    expect(seen[0]).toBe(true)
    expect(events[0]).not.toBe(tagged)
    expect(events[1]).toBe(plain)
    expect(seen[1]).not.toBe(true)
  })

  test("a listener that does not name isTrusted gets the real event, so brand checks hold", () => {
    const target = new Target()
    let got: Event | undefined
    target.addEventListener("click", (e) => { got = e })
    const event = fire(target)
    expect(got).toBe(event)
  })

  test("a function that is not of this realm reaches the native call unwrapped", () => {
    const added: unknown[] = []
    const fake = { addEventListener(_type: string, listener: unknown) { added.push(listener) }, removeEventListener() {} } as unknown as EventTarget
    installTrustShim(fake, () => true)
    const foreign = () => {}
    Object.setPrototypeOf(foreign, null)
    fake.addEventListener("click", foreign as EventListener)
    expect(added[0]).toBe(foreign)
  })

  test("removing a listener added before the shim, or by another path, still works", () => {
    const target = new Target()
    let calls = 0
    const fn = () => { calls++ }
    const nativeAdd = Object.getPrototypeOf(Object.getPrototypeOf(target)).addEventListener
      ?? EventTarget.prototype.addEventListener
    nativeAdd.call(target, "click", fn)
    fire(target)
    expect(calls).toBe(1)
    target.removeEventListener("click", fn)
    fire(target)
    expect(calls).toBe(1)
  })

  test("page globals cannot make addEventListener throw", () => {
    const added: unknown[] = []
    const fake = { addEventListener(_t: string, l: unknown) { added.push(l) }, removeEventListener() {} } as unknown as EventTarget
    installTrustShim(fake, () => { throw new TypeError("Right-hand side of 'instanceof' is not callable") })
    const fn = () => {}
    expect(() => fake.addEventListener("click", fn)).not.toThrow()
    expect(added[0]).toBe(fn)
    expect(() => fake.removeEventListener("click", fn)).not.toThrow()
  })

  test("targets other than nodes and windows are left alone", () => {
    class Other extends EventTarget {}
    const proto2 = Other.prototype as unknown as EventTarget
    Object.defineProperty(proto2, "addEventListener", { writable: true, configurable: true, value: EventTarget.prototype.addEventListener })
    Object.defineProperty(proto2, "removeEventListener", { writable: true, configurable: true, value: EventTarget.prototype.removeEventListener })
    installTrustShim(proto2, () => false)
    const target = new Other()
    let got: Event | undefined
    target.addEventListener("change", (e) => { got = e; void e.isTrusted })
    const event = fire(target, "change")
    expect(got).toBe(event)
  })

  test("event methods and setters work through the view", () => {
    const target = new Target()
    let type = ""
    target.addEventListener("click", (e) => {
      void e.isTrusted
      e.preventDefault()
      e.stopPropagation()
      ;(e as Event & { note?: string }).note = "kept"
      type = e.type
    })
    const event = fire(target) as Event & { note?: string }
    expect(type).toBe("click")
    expect(event.defaultPrevented).toBe(true)
    expect(event.note).toBe("kept")
  })

  test("every listener sees one view, and `instanceof` and `this` hold", () => {
    const target = new Target()
    const views: Event[] = []
    let self: unknown
    target.addEventListener("click", function (this: unknown, e) { void e.isTrusted; views.push(e); self = this })
    target.addEventListener("click", (e) => { void e.isTrusted; views.push(e) })
    fire(target)
    expect(views[0]).toBe(views[1])
    expect(views[0] instanceof Event).toBe(true)
    expect(views[0].constructor).toBe(Event)
    expect(self).toBe(target)
  })

  test("removeEventListener, duplicate adds, once, and handleEvent objects behave natively", () => {
    const target = new Target()
    let count = 0, once = 0
    const fn = () => { count++ }
    target.addEventListener("click", fn)
    target.addEventListener("click", fn)
    target.addEventListener("click", () => { once++ }, { once: true })
    fire(target)
    fire(target)
    expect(count).toBe(2)
    expect(once).toBe(1)
    target.removeEventListener("click", fn)
    fire(target)
    expect(count).toBe(2)

    const object = { trusted: false as boolean, handleEvent(e: Event) { this.trusted = e.isTrusted } }
    target.addEventListener("keydown", object)
    fire(target, "keydown")
    expect(object.trusted).toBe(true)
  })

  test("a null listener still passes to the native call", () => {
    expect(() => new Target().addEventListener("click", null)).not.toThrow()
  })

  test("a listener for anything but input stays the page's own function", () => {
    const target = new Target()
    let seen: Event | undefined
    let self: unknown
    target.addEventListener("message", function (this: unknown, e) { seen = e; self = this })
    const event = fire(target, "message")
    expect(seen).toBe(event)
    expect(self).toBe(target)
  })

  test("the page-visible override on Event.prototype is gone", () => {
    expect(read("extension/src/inject-net.ts")).not.toContain('Object.defineProperty(Event.prototype, "isTrusted"')
  })
})

describe("act after a navigation", () => {
  test("a page with no diff is what triggers the read", () => {
    expect(formatActChanges({ success: false })[0]).toContain("no earlier read")
    expect(formatActChanges({ success: true, data: "no snapshot" })[0]).toContain("no earlier read")
    expect(formatActChanges({ success: true, data: { changes: 0 } })).toEqual(["no visible changes"])
  })
})
