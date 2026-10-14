import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  namedGroups,
  removeTabsAndEmptiedGroups,
  ungroupBeforeClose,
} from "../extension/src/background/tab-group"
import { runTabLifecycleSweep } from "../extension/src/background/tab-lifecycle"
import { handleTabActions } from "../extension/src/background/capabilities/tabs"
import { handleWindowActions } from "../extension/src/background/capabilities/windows"

// Issue #301: Chrome saves every tab group, and a group whose last tabs are
// closed with chrome.tabs.remove stays behind as a CLOSED saved group (a chip on
// the bookmarks bar, synced to every profile on the account) that the extension
// can never see again. A group emptied by ungrouping is deleted instead. These
// pin the ordering (ungroup, then remove), the scope (only a managed group that
// the close empties), and that every close path goes through it.

const LANE = 7 // named group "lane1"
const OTHER = 8 // named group "lane2"
const DEFAULT = 5 // the shared default group, titled "interceptor"
const USER = 9 // a group the person made by hand

type Tab = { id: number; groupId: number; windowId: number; active?: boolean; pinned?: boolean; audible?: boolean; url?: string }

const g = globalThis as unknown as { chrome?: unknown }
let savedChrome: unknown

function installChrome(tabs: Tab[], opts: { ungroupThrows?: boolean; noUngroup?: boolean; session?: Record<string, unknown> } = {}) {
  const calls: Array<["ungroup" | "remove", number[]]> = []
  const session: Record<string, unknown> = { ...(opts.session ?? {}) }
  const pick = (store: Record<string, unknown>, key: unknown): Record<string, unknown> => {
    if (typeof key === "string") return key in store ? { [key]: store[key] } : {}
    if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => k in store).map((k) => [k, store[k]]))
    return { ...store }
  }
  const tabsApi: Record<string, unknown> = {
    query: async (q: { groupId?: number; windowId?: number } = {}) =>
      tabs.filter((t) => (q.groupId === undefined || t.groupId === q.groupId)
        && (q.windowId === undefined || t.windowId === q.windowId)),
    get: async (id: number) => tabs.find((t) => t.id === id) ?? Promise.reject(new Error(`No tab with id: ${id}`)),
    remove: async (ids: number | number[]) => { calls.push(["remove", [ids].flat()]) },
    ungroup: async (ids: number | number[]) => {
      if (opts.ungroupThrows) throw new Error("Tabs cannot be edited right now (user may be dragging a tab).")
      calls.push(["ungroup", [ids].flat()])
    },
  }
  if (opts.noUngroup) delete tabsApi.ungroup
  ;(g as { chrome: unknown }).chrome = {
    tabs: tabsApi,
    tabGroups: {
      query: async () => [
        { id: DEFAULT, title: "interceptor", windowId: 1 },
        { id: LANE, title: "interceptor-lane1", windowId: 1 },
        { id: OTHER, title: "interceptor-lane2", windowId: 1 },
        { id: USER, title: "reading list", windowId: 1 },
      ],
      get: async (id: number) => ({ id, windowId: 1 }),
    },
    windows: { getLastFocused: async () => ({ id: 1, focused: false }) },
    scripting: { executeScript: async () => [{ result: false }] }, // every page reads as clean
    storage: {
      managed: { get: async () => ({}) },
      local: { get: async () => ({}), set: async () => {} },
      session: {
        get: async (key: unknown) => pick(session, key),
        set: async (items: Record<string, unknown>) => { Object.assign(session, items) },
        remove: async (key: string | string[]) => { for (const k of [key].flat()) delete session[k] },
      },
    },
  }
  return calls
}

beforeEach(() => {
  savedChrome = g.chrome
  namedGroups.set("lane1", LANE)
  namedGroups.set("lane2", OTHER)
})
afterEach(() => {
  namedGroups.delete("lane1")
  namedGroups.delete("lane2")
  ;(g as { chrome: unknown }).chrome = savedChrome
})

const LANE_TABS: Tab[] = [
  { id: 1, groupId: LANE, windowId: 1 },
  { id: 2, groupId: LANE, windowId: 1 },
]

describe("closing a managed group's last tabs deletes the group", () => {
  test("the whole group is ungrouped, then removed", async () => {
    const calls = installChrome([...LANE_TABS, { id: 3, groupId: OTHER, windowId: 1 }])
    await removeTabsAndEmptiedGroups([1, 2])
    expect(calls).toEqual([["ungroup", [1, 2]], ["remove", [1, 2]]])
  })

  test("a group that keeps a tab is not ungrouped", async () => {
    const calls = installChrome(LANE_TABS)
    await removeTabsAndEmptiedGroups([1])
    expect(calls).toEqual([["remove", [1]]])
  })

  test("only the emptied group is ungrouped when one close spans two groups", async () => {
    const calls = installChrome([...LANE_TABS, { id: 3, groupId: OTHER, windowId: 1 }, { id: 4, groupId: OTHER, windowId: 1 }])
    await removeTabsAndEmptiedGroups([1, 2, 3])
    expect(calls).toEqual([["ungroup", [1, 2]], ["remove", [1, 2, 3]]])
  })

  test("the shared default group is deleted the same way", async () => {
    const calls = installChrome([{ id: 6, groupId: DEFAULT, windowId: 1 }])
    await removeTabsAndEmptiedGroups([6])
    expect(calls).toEqual([["ungroup", [6]], ["remove", [6]]])
  })

  test("a group Interceptor does not manage is left as the person made it", async () => {
    const calls = installChrome([{ id: 7, groupId: USER, windowId: 1 }])
    await removeTabsAndEmptiedGroups([7])
    expect(calls).toEqual([["remove", [7]]])
  })

  test("a failed ungroup does not stop the close", async () => {
    const calls = installChrome(LANE_TABS, { ungroupThrows: true })
    await removeTabsAndEmptiedGroups([1, 2])
    expect(calls).toEqual([["remove", [1, 2]]])
  })

  test("a browser without tabs.ungroup still closes", async () => {
    const calls = installChrome(LANE_TABS, { noUngroup: true })
    await removeTabsAndEmptiedGroups([1, 2])
    expect(calls).toEqual([["remove", [1, 2]]])
  })

  test("a group the registry lost is found again by its title", async () => {
    // Moved to another window or restored by the browser, the group has a new
    // id and tabGroups.onRemoved already dropped the old entry.
    namedGroups.delete("lane1")
    const calls = installChrome(LANE_TABS)
    await removeTabsAndEmptiedGroups([1, 2])
    expect(calls).toEqual([["ungroup", [1, 2]], ["remove", [1, 2]]])
  })

  test("ungroupBeforeClose alone removes nothing (the window_close path)", async () => {
    const calls = installChrome(LANE_TABS)
    await ungroupBeforeClose([1, 2])
    expect(calls).toEqual([["ungroup", [1, 2]]])
  })
})

describe("every close path deletes the group it empties", () => {
  test("group_close", async () => {
    const calls = installChrome([...LANE_TABS, { id: 3, groupId: OTHER, windowId: 1 }])
    const result = await handleTabActions({ type: "group_close", label: "lane1" }, 0)
    expect(result).toEqual({ success: true, data: { label: "lane1", groupId: LANE, closedTabs: 2 } })
    expect(calls).toEqual([["ungroup", [1, 2]], ["remove", [1, 2]]])
  })

  test("tab_close on the group's last tab", async () => {
    const calls = installChrome([{ id: 1, groupId: LANE, windowId: 1 }])
    await handleTabActions({ type: "tab_close", tabId: 1, group: "lane1" }, 1)
    expect(calls).toEqual([["ungroup", [1]], ["remove", [1]]])
  })

  test("tab_close on one tab of several keeps the group", async () => {
    const calls = installChrome(LANE_TABS)
    await handleTabActions({ type: "tab_close", tabId: 1, group: "lane1" }, 1)
    expect(calls).toEqual([["remove", [1]]])
  })

  test("window_close ungroups the window's managed groups before the window goes", async () => {
    const calls = installChrome([...LANE_TABS, { id: 3, groupId: OTHER, windowId: 2 }, { id: 4, groupId: USER, windowId: 1 }])
    const order: string[] = []
    const chromeMock = g.chrome as { windows: Record<string, unknown>; tabs: { ungroup: (ids: number[]) => Promise<void> } }
    const ungroup = chromeMock.tabs.ungroup
    chromeMock.tabs.ungroup = async (ids) => { order.push("ungroup"); await ungroup(ids) }
    chromeMock.windows.remove = async (id: number) => { order.push(`windows.remove ${id}`) }
    const result = await handleWindowActions({ type: "window_close", windowId: 1 }, 0)
    expect(result.success).toBe(true)
    expect(calls).toEqual([["ungroup", [1, 2]]])
    expect(order).toEqual(["ungroup", "windows.remove 1"])
  })

  test("the idle purge", async () => {
    const now = 1_700_000_000_000
    const calls = installChrome(
      [...LANE_TABS, { id: 50, groupId: -1, windowId: 1 }, { id: 51, groupId: -1, windowId: 1 }],
      { session: { "groupLastSeen:lane1": now - 5 * 60_000, "groupLastSeen:lane2": now, "groupLastSeen:": now } },
    )
    ;(g.chrome as { storage: { local: { get: unknown } } }).storage.local.get = async () =>
      ({ tabLifecycle: { reuse: true, idleCloseMinutes: 1, closeGroupWhenDone: true } })
    await runTabLifecycleSweep(now)
    expect(calls).toEqual([["ungroup", [1, 2]], ["remove", [1, 2]]])
  })

  test("the guarded sweep that closes only part of a group leaves it grouped", async () => {
    const now = 1_700_000_000_000
    const calls = installChrome(
      [{ id: 1, groupId: LANE, windowId: 1, active: true }, { id: 2, groupId: LANE, windowId: 1 }, { id: 50, groupId: -1, windowId: 1 }],
      { session: { "groupLastSeen:lane1": now - 5 * 60_000, "groupLastSeen:lane2": now, "groupLastSeen:": now } },
    )
    ;(g.chrome as { storage: { local: { get: unknown } } }).storage.local.get = async () =>
      ({ tabLifecycle: { reuse: true, idleCloseMinutes: 1 } })
    await runTabLifecycleSweep(now)
    expect(calls).toEqual([["remove", [2]]])
  })
})
