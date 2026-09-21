import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runTabLifecycleSweep } from "../extension/src/background/tab-lifecycle"
import { namedGroups } from "../extension/src/background/tab-group"

// Sweep-level tests for `closeGroupWhenDone`. The guard math is covered pure in
// tab-lifecycle.test.ts; what these pin down is the wiring the pure functions
// cannot see: that purge mode reaches chrome.tabs.remove with the WHOLE group
// (no dirty-state veto, no guard veto), that it mints a survivor tab when the
// group is the entire profile OR the count is unreadable, that it waits while a
// person is present without re-stamping, and that it drops the group's stamp.

const GROUP_ID = 7
const LABEL = "lane1"
const STAMP_KEY = `groupLastSeen:${LABEL}`
const NOW = 1_700_000_000_000

type Calls = {
  removed: number[][]
  createArgs: Record<string, unknown>[]
  queries: Record<string, unknown>[]
  sessionRemoved: string[]
  sessionSet: Record<string, unknown>[]
  scripted: number
}

function installChrome(opts: {
  policy: Record<string, unknown>
  groupTabs: unknown[]
  profileTabs: number
  focused?: boolean // is the browser's window 1 the OS-focused window? default: no
  countRejects?: boolean // the normal-window count query fails
  createRejects?: boolean // the survivor tab cannot be created
  liveGroups?: Array<{ id: number; title: string; windowId: number }> // what the tab strip really holds
}) {
  const calls: Calls = { removed: [], createArgs: [], queries: [], sessionRemoved: [], sessionSet: [], scripted: 0 }
  const session: Record<string, unknown> = { [STAMP_KEY]: NOW - 5 * 60_000 }
  const pick = (store: Record<string, unknown>, key: unknown): Record<string, unknown> => {
    if (typeof key !== "string") return { ...store }
    return key in store ? { [key]: store[key] } : {}
  }
  const allTabs = () =>
    Array.from({ length: opts.profileTabs }, (_, i) => ({ id: 1000 + i, windowId: 1 }))

  ;(globalThis as { chrome: unknown }).chrome = {
    tabGroups: {
      query: async () => opts.liveGroups ?? [],
      get: async (id: number) => (id === GROUP_ID ? { id, windowId: 1 } : Promise.reject(new Error("no group"))),
    },
    tabs: {
      query: async (q: { groupId?: number; windowType?: string } = {}) => {
        calls.queries.push(q)
        if (q.groupId === GROUP_ID) return opts.groupTabs
        if (q.windowType === "normal" && opts.countRejects) throw new Error("tabs.query failed")
        return allTabs()
      },
      remove: async (ids: number[]) => { calls.removed.push(ids) },
      create: async (props: Record<string, unknown>) => {
        calls.createArgs.push(props)
        if (opts.createRejects) throw new Error("tabs.create failed")
        return { id: 9999 }
      },
    },
    windows: { getLastFocused: async () => ({ id: 1, focused: opts.focused === true }) },
    scripting: {
      // Every page reads as dirty, so the guarded sweep keeps whatever G2-G5 let through.
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

const PURGE = { reuse: true, idleCloseMinutes: 1, closeGroupWhenDone: true }

// Every tab here survives the guarded sweep: the active tab (focus unknown
// protects it), the pinned tab, and a plain tab whose page reads as dirty.
const STUCK_TABS = [
  { id: 1, windowId: 1, active: true, pinned: false, audible: false, url: "https://a.example" },
  { id: 2, windowId: 1, active: false, pinned: true, audible: false, url: "https://b.example" },
  { id: 3, windowId: 1, active: false, pinned: false, audible: false, url: "https://c.example" },
]

const stampTouched = (calls: Calls) =>
  calls.sessionRemoved.includes(STAMP_KEY) || calls.sessionSet.some((s) => STAMP_KEY in s)

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
    const calls = installChrome({ policy: PURGE, groupTabs: STUCK_TABS, profileTabs: 12 })
    await runTabLifecycleSweep(NOW)
    expect(calls.removed).toEqual([[1, 2, 3]])
    expect(calls.scripted).toBe(0)
    expect(calls.createArgs).toEqual([])
  })

  test("drops the group's idle stamp instead of re-stamping it", async () => {
    const calls = installChrome({ policy: PURGE, groupTabs: STUCK_TABS, profileTabs: 12 })
    await runTabLifecycleSweep(NOW)
    expect(calls.sessionRemoved).toContain(STAMP_KEY)
    expect(calls.sessionSet.some((s) => STAMP_KEY in s)).toBe(false)
  })

  test("mints a survivor tab, in the group's own window, when the group is the entire profile", async () => {
    const calls = installChrome({ policy: PURGE, groupTabs: STUCK_TABS, profileTabs: 3 })
    await runTabLifecycleSweep(NOW)
    expect(calls.createArgs).toEqual([{ windowId: 1, active: false }])
    expect(calls.removed).toEqual([[1, 2, 3]])
  })

  test("counts tabs in normal windows only", async () => {
    const calls = installChrome({ policy: PURGE, groupTabs: STUCK_TABS, profileTabs: 12 })
    await runTabLifecycleSweep(NOW)
    expect(calls.queries).toContainEqual({ windowType: "normal" })
  })

  test("an unreadable tab count still mints the survivor before removing anything", async () => {
    const calls = installChrome({ policy: PURGE, groupTabs: STUCK_TABS, profileTabs: 12, countRejects: true })
    await runTabLifecycleSweep(NOW)
    expect(calls.createArgs).toHaveLength(1)
    expect(calls.removed).toEqual([[1, 2, 3]])
  })

  test("a survivor that cannot be created skips the group: nothing removed, stamp untouched", async () => {
    const calls = installChrome({ policy: PURGE, groupTabs: STUCK_TABS, profileTabs: 3, createRejects: true })
    await runTabLifecycleSweep(NOW)
    expect(calls.createArgs).toHaveLength(1)
    expect(calls.removed).toEqual([])
    expect(stampTouched(calls)).toBe(false)
  })

  test("waits while the person is looking at one of the group's tabs, without re-stamping", async () => {
    const calls = installChrome({ policy: PURGE, groupTabs: STUCK_TABS, profileTabs: 12, focused: true })
    await runTabLifecycleSweep(NOW)
    expect(calls.removed).toEqual([])
    expect(calls.createArgs).toEqual([])
    expect(stampTouched(calls)).toBe(false)

    // Focus moves to another app: the very next tick deletes the group.
    const later = installChrome({ policy: PURGE, groupTabs: STUCK_TABS, profileTabs: 12, focused: false })
    await runTabLifecycleSweep(NOW + 60_000)
    expect(later.removed).toEqual([[1, 2, 3]])
  })

  test("waits while a tab in the group is playing sound, without re-stamping", async () => {
    const playing = STUCK_TABS.map((t) => (t.id === 3 ? { ...t, audible: true } : t))
    const calls = installChrome({ policy: PURGE, groupTabs: playing, profileTabs: 12 })
    await runTabLifecycleSweep(NOW)
    expect(calls.removed).toEqual([])
    expect(stampTouched(calls)).toBe(false)
  })

  test("off by default: the same idle group survives under the guarded sweep", async () => {
    const calls = installChrome({
      policy: { reuse: true, idleCloseMinutes: 1 },
      groupTabs: STUCK_TABS,
      profileTabs: 12,
    })
    await runTabLifecycleSweep(NOW)
    expect(calls.removed).toEqual([])
    expect(calls.createArgs).toEqual([])
    // The one G2-G5 candidate (tab 3) was screened and kept as dirty, and that
    // all-dirty pass is what re-stamps the idle clock.
    expect(calls.scripted).toBe(1)
    expect(calls.sessionSet.some((s) => STAMP_KEY in s)).toBe(true)
  })
})

// A group whose id changed (moved to another window, re-created by the browser's
// own restore, restored after a restart) has no registry entry: tabGroups.onRemoved
// dropped it. The sweep has to find it again by title or it lives forever.
describe("the sweep re-adopts a group the registry lost", () => {
  let originalChrome: unknown

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome
    namedGroups.clear()
  })
  afterEach(() => {
    namedGroups.clear()
    ;(globalThis as { chrome?: unknown }).chrome = originalChrome as typeof chrome
  })

  const LIVE = [{ id: GROUP_ID, title: `interceptor-${LABEL}`, windowId: 1 }]

  test("an idle group known only by its title is swept", async () => {
    const calls = installChrome({ policy: PURGE, groupTabs: STUCK_TABS, profileTabs: 12, liveGroups: LIVE })
    await runTabLifecycleSweep(NOW)
    expect(namedGroups.get(LABEL)).toBe(GROUP_ID)
    expect(calls.removed).toEqual([[1, 2, 3]])
  })

  test("a title that is not a valid label, and a user's own group, are left alone", async () => {
    const calls = installChrome({
      policy: PURGE, groupTabs: STUCK_TABS, profileTabs: 12,
      liveGroups: [{ id: GROUP_ID, title: "interceptor-has spaces", windowId: 1 }, { id: 8, title: "Shopping", windowId: 1 }],
    })
    await runTabLifecycleSweep(NOW)
    expect(namedGroups.size).toBe(0)
    expect(calls.removed).toEqual([])
  })
})
