import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runTabLifecycleSweep } from "../extension/src/background/tab-lifecycle"
import { namedGroups } from "../extension/src/background/tab-group"

// Sweep-level tests for `closeGroupWhenDone`. The guard math is covered pure in
// tab-lifecycle.test.ts; what these pin down is the wiring the pure functions
// cannot see: that purge mode reaches chrome.tabs.remove with the WHOLE group
// (no dirty-state veto, no guard veto), that it mints a survivor tab only when
// the group is the entire profile, and that it drops the group's idle stamp.

const GROUP_ID = 7
const LABEL = "lane1"
const NOW = 1_700_000_000_000

type Calls = {
  removed: number[][]
  created: number
  sessionRemoved: string[]
  sessionSet: Record<string, unknown>[]
  scripted: number
}

function installChrome(opts: { policy: Record<string, unknown>; groupTabs: unknown[]; profileTabs: number }) {
  const calls: Calls = { removed: [], created: 0, sessionRemoved: [], sessionSet: [], scripted: 0 }
  const session: Record<string, unknown> = { [`groupLastSeen:${LABEL}`]: NOW - 5 * 60_000 }
  const pick = (store: Record<string, unknown>, key: unknown): Record<string, unknown> => {
    if (typeof key !== "string") return { ...store }
    return key in store ? { [key]: store[key] } : {}
  }
  const allTabs = () =>
    Array.from({ length: opts.profileTabs }, (_, i) => ({ id: 1000 + i, windowId: 1 }))

  ;(globalThis as { chrome: unknown }).chrome = {
    tabGroups: {
      query: async () => [],
      get: async (id: number) => (id === GROUP_ID ? { id, windowId: 1 } : Promise.reject(new Error("no group"))),
    },
    tabs: {
      query: async (q: { groupId?: number } = {}) => (q.groupId === GROUP_ID ? opts.groupTabs : allTabs()),
      remove: async (ids: number[]) => { calls.removed.push(ids) },
      create: async () => { calls.created += 1; return { id: 9999 } },
    },
    windows: { getLastFocused: async () => ({ id: 1, focused: true }) },
    scripting: {
      executeScript: async () => { calls.scripted += 1; return [{ result: true }] },
    },
    storage: {
      managed: { get: async () => ({}) },
      local: {
        get: async (key: unknown) => pick({ tabLifecycle: opts.policy }, key),
        set: async () => {},
      },
      session: {
        get: async (key: unknown) => pick(session, key),
        set: async (items: Record<string, unknown>) => {
          calls.sessionSet.push(items)
          Object.assign(session, items)
        },
        remove: async (key: string) => { calls.sessionRemoved.push(key); delete session[key] },
      },
    },
  }
  return calls
}

// Every tab here would be vetoed by the guarded sweep: active in the focused
// window, pinned, and audible.
const GUARDED_TABS = [
  { id: 1, windowId: 1, active: true, pinned: false, audible: false, url: "https://a.example" },
  { id: 2, windowId: 1, active: false, pinned: true, audible: false, url: "https://b.example" },
  { id: 3, windowId: 1, active: false, pinned: false, audible: true, url: "https://c.example" },
]

describe("closeGroupWhenDone sweep", () => {
  let originalChrome: unknown

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome
    namedGroups.set(LABEL, GROUP_ID)
  })
  afterEach(() => {
    namedGroups.delete(LABEL)
    ;(globalThis as { chrome?: unknown }).chrome = originalChrome as typeof chrome
  })

  test("deletes the whole idle group and never consults the dirty-state check", async () => {
    const calls = installChrome({
      policy: { reuse: true, idleCloseMinutes: 1, closeGroupWhenDone: true },
      groupTabs: GUARDED_TABS,
      profileTabs: 12,
    })
    await runTabLifecycleSweep(NOW)
    expect(calls.removed).toEqual([[1, 2, 3]])
    expect(calls.scripted).toBe(0)
    expect(calls.created).toBe(0)
  })

  test("drops the group's idle stamp instead of re-stamping it", async () => {
    const calls = installChrome({
      policy: { reuse: true, idleCloseMinutes: 1, closeGroupWhenDone: true },
      groupTabs: GUARDED_TABS,
      profileTabs: 12,
    })
    await runTabLifecycleSweep(NOW)
    expect(calls.sessionRemoved).toContain(`groupLastSeen:${LABEL}`)
    expect(calls.sessionSet.some((s) => `groupLastSeen:${LABEL}` in s)).toBe(false)
  })

  test("mints a survivor tab when the group is the entire profile", async () => {
    const calls = installChrome({
      policy: { reuse: true, idleCloseMinutes: 1, closeGroupWhenDone: true },
      groupTabs: GUARDED_TABS,
      profileTabs: 3,
    })
    await runTabLifecycleSweep(NOW)
    expect(calls.created).toBe(1)
    expect(calls.removed).toEqual([[1, 2, 3]])
  })

  test("off by default: the same idle group survives under the guarded sweep", async () => {
    const calls = installChrome({
      policy: { reuse: true, idleCloseMinutes: 1 },
      groupTabs: GUARDED_TABS,
      profileTabs: 12,
    })
    await runTabLifecycleSweep(NOW)
    expect(calls.removed).toEqual([])
    expect(calls.created).toBe(0)
  })
})
