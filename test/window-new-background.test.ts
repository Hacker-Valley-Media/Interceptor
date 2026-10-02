import { describe, expect, test } from "bun:test"
import { parseTabsCommand } from "../cli/commands/tabs"
import { handleWindowActions } from "../extension/src/background/capabilities/windows"

// `window new` is background-first. Chromium's own default for
// chrome.windows.create is focused: true (tabs_api.cc WindowsCreateFunction),
// so the CLI has to send the decision and the handler has to forward only an
// explicit true.

describe("window new — CLI parse", () => {
  test("plain: no url, focused false", async () => {
    expect(await parseTabsCommand(["window", "new"])).toEqual({ type: "window_create", url: undefined, incognito: false, focused: false })
  })
  test("url without flags", async () => {
    expect(await parseTabsCommand(["window", "new", "https://example.com"])).toEqual({ type: "window_create", url: "https://example.com", incognito: false, focused: false })
  })
  test("--activate alone is a flag, not a url", async () => {
    expect(await parseTabsCommand(["window", "new", "--activate"])).toEqual({ type: "window_create", url: undefined, incognito: false, focused: true })
  })
  test("url + --activate + --incognito in any order", async () => {
    expect(await parseTabsCommand(["window", "new", "--incognito", "https://example.com", "--activate"])).toEqual({ type: "window_create", url: "https://example.com", incognito: true, focused: true })
  })
})

describe("window_create — handler focus gate", () => {
  async function createWith(action: Record<string, unknown>) {
    const globals = globalThis as { chrome?: unknown }
    const originalChrome = globals.chrome
    let received: Record<string, unknown> | undefined
    globals.chrome = {
      windows: {
        create: async (data: Record<string, unknown>) => { received = data; return { id: 11, tabs: [] } },
      },
    }
    try {
      const result = await handleWindowActions({ type: "window_create", ...action }, 0)
      expect(result.success).toBe(true)
      return received!
    } finally {
      globals.chrome = originalChrome
    }
  }

  test("default sends focused: false", async () => {
    expect((await createWith({})).focused).toBe(false)
  })
  test("focused: false stays false", async () => {
    expect((await createWith({ focused: false })).focused).toBe(false)
  })
  test("only a literal true focuses", async () => {
    expect((await createWith({ focused: true })).focused).toBe(true)
    expect((await createWith({ focused: "true" })).focused).toBe(false)
  })
})

// A tab group lives in one window. `window new` in a group that already had a
// tab elsewhere used to add the new tab to that group, which pulled the tab
// back to the group's window and left the new window empty. A named group now
// moves into the new window first; the shared default group stays put and the
// result carries a groupWarning.
describe("window_create — the caller's group follows it into the new window", () => {
  async function create(action: Record<string, unknown>, groups: { id: number; title: string; windowId: number }[], moveFails = false) {
    const { namedGroups } = await import("../extension/src/background/tab-group")
    namedGroups.clear()
    const globals = globalThis as { chrome?: unknown }
    const originalChrome = globals.chrome
    const moves: unknown[] = []
    // The new tab is in window 11 until it is added to a group that lives elsewhere.
    let tabWindow = 11
    globals.chrome = {
      windows: {
        create: async () => ({ id: 11, tabs: [{ id: 77, url: "" }] }),
        get: async (id: number) => ({ id, type: "normal" }),
      },
      tabs: {
        get: async (id: number) => ({ id, windowId: tabWindow }),
        group: async (args: { groupId?: number }) => {
          const target = groups.find(x => x.id === args.groupId)
          if (target) tabWindow = target.windowId
          return args.groupId ?? 900
        },
      },
      tabGroups: {
        query: async () => groups,
        get: async (id: number) => { const x = groups.find(y => y.id === id); if (!x) throw new Error("no group"); return x },
        move: async (id: number, to: { windowId: number }) => {
          if (moveFails) throw new Error("Tabs cannot be edited right now")
          moves.push([id, to]); groups.find(x => x.id === id)!.windowId = to.windowId
        },
        update: async () => {},
      },
      storage: {},
    }
    try {
      const result = await handleWindowActions({ type: "window_create", ...action }, 0)
      return { data: result.data as { windowId: number; groupWarning?: string }, moves, tabWindow }
    } finally {
      globals.chrome = originalChrome
      namedGroups.clear()
    }
  }

  test("a named group in another window moves to the new window, so the tab stays there", async () => {
    const r = await create({ group: "mine" }, [{ id: 40, title: "interceptor-mine", windowId: 1 }])
    expect(r.moves).toEqual([[40, { windowId: 11, index: -1 }]])
    expect(r.tabWindow).toBe(11)
    expect(r.data.groupWarning).toBeUndefined()
  })

  test("a named group that could not be moved is reported, by name", async () => {
    const r = await create({ group: "mine" }, [{ id: 40, title: "interceptor-mine", windowId: 1 }], true)
    expect(r.tabWindow).toBe(1)
    expect(r.data.groupWarning).toContain("group 'mine' could not be moved")
    expect(r.data.groupWarning).not.toContain("shared default group")
  })

  test("a named group that does not exist yet moves nothing", async () => {
    const r = await create({ group: "fresh" }, [])
    expect(r.moves).toEqual([])
    expect(r.tabWindow).toBe(11)
  })

  test("the shared default group is not dragged along; the result says the tab has no window of its own", async () => {
    const r = await create({}, [{ id: 50, title: "interceptor", windowId: 1 }])
    expect(r.moves).toEqual([])
    expect(r.tabWindow).toBe(1)
    expect(r.data.groupWarning).toContain("no window of its own")
  })
})
