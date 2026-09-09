import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolveNormalWindowPlacement } from "../extension/src/background/capabilities/tabs"
import {
  addTabToInterceptorGroup, addTabToNamedGroup, managedGroupWindows, namedGroups
} from "../extension/src/background/tab-group"

// New managed tabs must land in the window that already holds Interceptor
// groups, not in whatever window the user happens to be focused on. Otherwise
// every fresh agent session (soft per-session group) mints its group in the
// user's current window and groups end up scattered one-per-window.
//
// And a NEW group must be minted in the tab's own window: chrome.tabs.group
// without createProperties.windowId defaults to the "current" (last active)
// window and moves the tab there, which collapses a background-created window.

const g = globalThis as unknown as { chrome?: unknown }
let savedChrome: unknown

type Win = { id?: number; focused?: boolean }
type Grp = { id: number; title?: string; windowId: number }

function installChromeMock(opts: {
  windows: Win[]
  groups?: Grp[] | (() => never)
  tabWindowId?: number | (() => never)
  noGroupApi?: boolean
}) {
  const groupCalls: unknown[] = []
  const mock: Record<string, unknown> = {
    windows: {
      getAll: async () => opts.windows,
      get: async (id: number) => ({ id, type: "normal" }),
    },
    tabs: {
      get: async (id: number) => {
        if (typeof opts.tabWindowId === "function") return opts.tabWindowId()
        return { id, windowId: opts.tabWindowId ?? 1 }
      },
      group: async (args: unknown) => { groupCalls.push(args); return 555 },
    },
    tabGroups: {
      query: async () => (typeof opts.groups === "function" ? opts.groups() : opts.groups ?? []),
      get: async () => { throw new Error("no such group") },
      update: async () => {},
    },
    storage: {}, // no session area -> registry persistence no-ops
  }
  if (opts.noGroupApi) delete mock.tabGroups
  g.chrome = mock
  return { groupCalls }
}

beforeEach(() => { savedChrome = g.chrome; namedGroups.clear() })
afterEach(() => { g.chrome = savedChrome; namedGroups.clear() })

const URL = "https://example.com/"
const A_FOCUSED_B = [{ id: 1, focused: true }, { id: 2 }]

describe("resolveNormalWindowPlacement — home on the window that already holds managed groups", () => {
  test("R1: a hosting window beats the focused window", async () => {
    installChromeMock({ windows: A_FOCUSED_B, groups: [{ id: 10, title: "interceptor-other", windowId: 2 }] })
    expect(await resolveNormalWindowPlacement(false, URL, "fresh")).toEqual({ windowId: 2 })
  })

  test("R1: the default brand group counts as a hosting group", async () => {
    installChromeMock({ windows: A_FOCUSED_B, groups: [{ id: 10, title: "interceptor", windowId: 2 }] })
    expect(await resolveNormalWindowPlacement(false, URL, "fresh")).toEqual({ windowId: 2 })
  })

  test("R1: an ungrouped (default-group) call homes on a hosting window too", async () => {
    installChromeMock({ windows: A_FOCUSED_B, groups: [{ id: 10, title: "interceptor-other", windowId: 2 }] })
    expect(await resolveNormalWindowPlacement(false, URL)).toEqual({ windowId: 2 })
  })

  test("R2: the caller's own named group's window beats a focused hosting window", async () => {
    installChromeMock({
      windows: A_FOCUSED_B,
      groups: [{ id: 10, title: "interceptor-a", windowId: 1 }, { id: 11, title: "interceptor-mine", windowId: 2 }],
    })
    expect(await resolveNormalWindowPlacement(false, URL, "mine")).toEqual({ windowId: 2 })
  })

  test("R2: the registry locates the own group even when its title was rebranded", async () => {
    namedGroups.set("mine", 20)
    installChromeMock({
      windows: A_FOCUSED_B,
      groups: [{ id: 21, title: "interceptor-a", windowId: 1 }, { id: 20, title: "Acme-mine", windowId: 2 }],
    })
    expect(await resolveNormalWindowPlacement(false, URL, "mine")).toEqual({ windowId: 2 })
  })

  test("R2: an ungrouped call homes on the default group's window over a named group's window", async () => {
    installChromeMock({
      windows: A_FOCUSED_B,
      groups: [{ id: 10, title: "interceptor-a", windowId: 1 }, { id: 11, title: "interceptor", windowId: 2 }],
    })
    expect(await resolveNormalWindowPlacement(false, URL)).toEqual({ windowId: 2 })
  })

  test("R3: the focused window wins when several windows host groups", async () => {
    installChromeMock({
      windows: A_FOCUSED_B,
      groups: [{ id: 10, title: "interceptor-a", windowId: 1 }, { id: 11, title: "interceptor-b", windowId: 2 }],
    })
    expect(await resolveNormalWindowPlacement(false, URL, "fresh")).toEqual({ windowId: 1 })
  })

  test("R3: among unfocused hosting windows the one holding most groups wins", async () => {
    installChromeMock({
      windows: [{ id: 1 }, { id: 2 }, { id: 3 }],
      groups: [
        { id: 10, title: "interceptor-a", windowId: 2 },
        { id: 11, title: "interceptor-b", windowId: 3 },
        { id: 12, title: "interceptor-c", windowId: 3 },
      ],
    })
    expect(await resolveNormalWindowPlacement(false, URL, "fresh")).toEqual({ windowId: 3 })
  })

  test("R3: a tie between hosting windows keeps getAll order", async () => {
    installChromeMock({
      windows: [{ id: 1 }, { id: 2 }, { id: 3 }],
      groups: [{ id: 10, title: "interceptor-a", windowId: 3 }, { id: 11, title: "interceptor-b", windowId: 2 }],
    })
    expect(await resolveNormalWindowPlacement(false, URL, "fresh")).toEqual({ windowId: 2 })
  })

  test("R4: unmanaged groups do not count", async () => {
    installChromeMock({ windows: A_FOCUSED_B, groups: [{ id: 10, title: "Shopping", windowId: 2 }] })
    expect(await resolveNormalWindowPlacement(false, URL, "fresh")).toEqual({ windowId: 1 })
  })

  test("R4: a hosting window absent from the normal list is ignored", async () => {
    installChromeMock({ windows: [{ id: 1, focused: true }], groups: [{ id: 10, title: "interceptor-a", windowId: 99 }] })
    expect(await resolveNormalWindowPlacement(false, URL, "a")).toEqual({ windowId: 1 })
  })

  test("R4: no managed groups → the focused normal window (unchanged)", async () => {
    installChromeMock({ windows: A_FOCUSED_B, groups: [] })
    expect(await resolveNormalWindowPlacement(false, URL, "fresh")).toEqual({ windowId: 1 })
  })

  test("R4: no groups and no focus → the first normal window (unchanged)", async () => {
    installChromeMock({ windows: [{ id: 5 }, { id: 7 }], groups: [] })
    expect(await resolveNormalWindowPlacement(false, URL)).toEqual({ windowId: 5 })
  })

  test("R4: tabGroups.query rejecting falls back to the plain pick", async () => {
    installChromeMock({ windows: A_FOCUSED_B, groups: () => { throw new Error("No current window") } })
    expect(await resolveNormalWindowPlacement(false, URL, "fresh")).toEqual({ windowId: 1 })
  })

  test("R4: group API absent → the plain pick", async () => {
    installChromeMock({ windows: A_FOCUSED_B, noGroupApi: true })
    expect(await resolveNormalWindowPlacement(false, URL, "fresh")).toEqual({ windowId: 1 })
  })
})

describe("managedGroupWindows", () => {
  test("reports the own window and per-window managed-group counts", async () => {
    installChromeMock({
      windows: [],
      groups: [
        { id: 10, title: "interceptor-a", windowId: 1 },
        { id: 11, title: "interceptor-b", windowId: 2 },
        { id: 12, title: "interceptor", windowId: 2 },
        { id: 13, title: "Unrelated", windowId: 3 },
      ],
    })
    const home = await managedGroupWindows("b")
    expect(home.own).toBe(2)
    expect([...home.hosting.entries()]).toEqual([[1, 1], [2, 2]])
  })

  test("is empty without the group API", async () => {
    installChromeMock({ windows: [], noGroupApi: true })
    expect(await managedGroupWindows("b")).toEqual({ hosting: new Map() })
  })
})

describe("R5: new groups are minted in the tab's own window", () => {
  test("named group: chrome.tabs.group carries createProperties.windowId of the tab", async () => {
    const { groupCalls } = installChromeMock({ windows: [], groups: [], tabWindowId: 7 })
    expect(await addTabToNamedGroup(5, "x")).toBe(555)
    expect(groupCalls).toEqual([{ tabIds: 5, createProperties: { windowId: 7 } }])
  })

  test("default group: chrome.tabs.group carries createProperties.windowId of the tab", async () => {
    const { groupCalls } = installChromeMock({ windows: [], groups: [], tabWindowId: 7 })
    expect(await addTabToInterceptorGroup(6)).toBe(555)
    expect(groupCalls).toEqual([{ tabIds: 6, createProperties: { windowId: 7 } }])
  })

  test("joining an existing group passes groupId and no createProperties", async () => {
    const { groupCalls } = installChromeMock({
      windows: [], groups: [{ id: 77, title: "interceptor-x", windowId: 2 }], tabWindowId: 7,
    })
    expect(await addTabToNamedGroup(5, "x")).toBe(77)
    expect(groupCalls).toEqual([{ tabIds: 5, groupId: 77 }])
  })

  test("a failing tabs.get degrades to a plain group call", async () => {
    const { groupCalls } = installChromeMock({
      windows: [], groups: [], tabWindowId: () => { throw new Error("No tab with id") },
    })
    expect(await addTabToNamedGroup(5, "y")).toBe(555)
    expect(groupCalls).toEqual([{ tabIds: 5 }])
  })
})
