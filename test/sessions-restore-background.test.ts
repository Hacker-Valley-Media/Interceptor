import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { handleSessionActions } from "../extension/src/background/capabilities/sessions"
import { namedGroups } from "../extension/src/background/tab-group"

// `sessions restore <id>` must not change what the person is looking at.
// chrome.sessions.restore makes the restored tab the active tab of its window,
// so the default reopens the entry's pages as background tabs in the caller's
// group and only `--activate` (action.active) reaches the browser's own restore.

const g = globalThis as unknown as { chrome?: unknown }
let savedChrome: unknown

type Calls = {
  restored: string[]
  created: Record<string, unknown>[]
  updated: Array<[number, Record<string, unknown>]>
  sessionSet: Record<string, unknown>[]
}

const RECENT = [
  { lastModified: 3, tab: { sessionId: "11", url: "https://a.example/", title: "A" } },
  {
    lastModified: 2,
    window: {
      sessionId: "20",
      tabs: [
        { sessionId: "21", url: "https://w1.example/" },
        { sessionId: "22", url: "https://w2.example/" },
      ],
    },
  },
]

function installChrome(): Calls {
  const calls: Calls = { restored: [], created: [], updated: [], sessionSet: [] }
  const session: Record<string, unknown> = {}
  let nextTabId = 100
  g.chrome = {
    sessions: {
      getRecentlyClosed: async () => RECENT,
      restore: async (id: string) => { calls.restored.push(id); return { lastModified: 9, tab: { id: 7, active: true } } },
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: "normal" }],
      get: async (id: number) => ({ id, type: "normal" }),
    },
    tabs: {
      create: async (props: Record<string, unknown>) => {
        calls.created.push(props)
        return { id: nextTabId++, url: props.url, windowId: 1 }
      },
      get: async (id: number) => ({ id, windowId: 1 }),
      group: async () => 555,
      update: async (id: number, props: Record<string, unknown>) => { calls.updated.push([id, props]); return { id } },
      query: async () => [],
    },
    tabGroups: {
      query: async () => [],
      get: async () => { throw new Error("no such group") },
      update: async () => {},
    },
    storage: {
      managed: { get: async () => ({}) },
      local: { get: async () => ({}), set: async () => {} },
      session: {
        get: async (key: unknown) => (typeof key === "string" && key in session ? { [key]: session[key] } : {}),
        set: async (items: Record<string, unknown>) => { calls.sessionSet.push(items); Object.assign(session, items) },
        remove: async () => {},
      },
    },
  }
  return calls
}

beforeEach(() => { savedChrome = g.chrome; namedGroups.clear() })
afterEach(() => { g.chrome = savedChrome; namedGroups.clear() })

const restore = (extra: Record<string, unknown>) =>
  handleSessionActions({ type: "session_restore", group: "lane1", ...extra }, 0)

describe("sessions restore is background-first", () => {
  test("default reopens the closed tab in the background and never calls the browser's restore", async () => {
    const calls = installChrome()
    const result = await restore({ sessionId: "11" })
    expect(result.success).toBe(true)
    expect(calls.restored).toEqual([])
    expect(calls.created).toEqual([{ url: "https://a.example/", active: false, windowId: 1 }])
    expect(calls.updated.some(([, props]) => props.active === true)).toBe(false)
    const data = result.data as { method: string; tabs: Array<{ group: string; reused: boolean }>; note: string }
    expect(data.method).toBe("reopen")
    expect(data.tabs).toHaveLength(1)
    expect(data.tabs[0]).toMatchObject({ group: "lane1", reused: false, url: "https://a.example/" })
    expect(data.note).toContain("--activate")
  })

  test("default refreshes the caller group's idle stamp so the sweep does not take the tab straight back", async () => {
    const calls = installChrome()
    await restore({ sessionId: "11" })
    await Promise.resolve()
    expect(calls.sessionSet.some((s) => "groupLastSeen:lane1" in s)).toBe(true)
  })

  test("a window entry reopens every one of its pages, all in the background", async () => {
    const calls = installChrome()
    const result = await restore({ sessionId: "20" })
    expect(calls.created.map((c) => [c.url, c.active])).toEqual([
      ["https://w1.example/", false],
      ["https://w2.example/", false],
    ])
    expect((result.data as { tabs: unknown[] }).tabs).toHaveLength(2)
  })

  test("the id of one tab inside a closed window reopens only that tab", async () => {
    const calls = installChrome()
    await restore({ sessionId: "22" })
    expect(calls.created.map((c) => c.url)).toEqual(["https://w2.example/"])
  })

  test("an unknown id fails, opens nothing, and points at the list", async () => {
    const calls = installChrome()
    const result = await restore({ sessionId: "999" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("interceptor sessions")
    expect(calls.created).toEqual([])
    expect(calls.restored).toEqual([])
  })

  test("--activate uses the browser's own restore and opens nothing itself", async () => {
    const calls = installChrome()
    const result = await restore({ sessionId: "11", active: true })
    expect(calls.restored).toEqual(["11"])
    expect(calls.created).toEqual([])
    expect(result.data).toMatchObject({ method: "native", tab: { id: 7 } })
  })
})
