// A navigation settles at DOMContentLoaded (after its own commit) or at complete.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { waitForTabLoad } from "../extension/src/background/content-bridge"

type Ev = { tabId: number; frameId: number }
function event() {
  const fns = new Set<(d: Ev) => void>()
  return { addListener: (f: (d: Ev) => void) => fns.add(f), removeListener: (f: (d: Ev) => void) => fns.delete(f), fire: (d: Ev) => [...fns].forEach(f => f(d)), size: () => fns.size }
}

let originalChrome: unknown
let updated: Set<(id: number, info: { status: string }) => void>
let probes = 0

beforeEach(() => {
  originalChrome = (globalThis as { chrome?: unknown }).chrome
  updated = new Set()
  probes = 0
  ;(globalThis as { chrome: unknown }).chrome = {
    runtime: { lastError: undefined },
    tabs: {
      get: async () => ({ id: 7, status: "loading" }),
      sendMessage: (_id: number, msg: { action?: { stop?: boolean }; stop?: boolean }, _o: unknown, cb: (r: unknown) => void) => { if (!(msg.action ?? msg).stop) probes++; cb({ success: true, data: { quietMs: 1000, mutations: 0 } }) },
      onUpdated: { addListener: (f: (id: number, info: { status: string }) => void) => updated.add(f), removeListener: (f: (id: number, info: { status: string }) => void) => updated.delete(f) },
    },
  }
})
afterEach(() => { (globalThis as { chrome?: unknown }).chrome = originalChrome })

test("DOMContentLoaded after this navigation's commit settles before complete", async () => {
  const committed = event(), dcl = event()
  const p = waitForTabLoad(7, 3000, { committed, domContentLoaded: dcl })
  committed.fire({ tabId: 7, frameId: 0 })
  dcl.fire({ tabId: 7, frameId: 0 })
  const r = await p
  expect(r.settledOn).toBe("dom")
  expect(r.ready).toBe(true)
  expect(probes).toBe(1)
  expect(committed.size() + dcl.size() + updated.size).toBe(0)
})

test("DOMContentLoaded without a commit seen here does not end the wait", async () => {
  const committed = event(), dcl = event()
  const p = waitForTabLoad(7, 3000, { committed, domContentLoaded: dcl })
  dcl.fire({ tabId: 7, frameId: 0 })        // an earlier navigation's event
  dcl.fire({ tabId: 8, frameId: 0 })        // another tab
  committed.fire({ tabId: 7, frameId: 3 })  // a subframe
  for (const f of updated) f(7, { status: "complete" })
  expect((await p).settledOn).toBe("complete")
})

test("a back/forward-cache restore (no DOMContentLoaded) settles on complete", async () => {
  const committed = event(), dcl = event()
  const p = waitForTabLoad(7, 3000, { committed, domContentLoaded: dcl })
  committed.fire({ tabId: 7, frameId: 0 })
  for (const f of updated) f(7, { status: "complete" })
  expect((await p).settledOn).toBe("complete")
})

test("no webNavigation (Safari, Electron) keeps the complete path", async () => {
  const p = waitForTabLoad(7, 3000, {})
  for (const f of updated) f(7, { status: "complete" })
  const r = await p
  expect(r.settledOn).toBe("complete")
  expect(probes).toBe(1)
})

test("a history step whose new URL is already complete settles from the caller's check, not the 10 s timer", async () => {
  let checks = 0
  const started = Date.now()
  const r = await waitForTabLoad(7, 15_000, {}, async () => ++checks >= 2)
  expect(r.settledOn).toBe("complete")
  expect(Date.now() - started).toBeLessThan(1000)
  expect(updated.size).toBe(0)
})
