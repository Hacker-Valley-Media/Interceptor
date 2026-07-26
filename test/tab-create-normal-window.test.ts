import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolveNormalWindowPlacement, groupWarningFor } from "../extension/src/background/capabilities/tabs"

// resolveNormalWindowPlacement is the primary half of the tab_create fix: it
// pins a new tab to a groupable *normal* window so chrome.tabs.group won't
// reject with "Tabs can only be moved to and from normal windows". The
// tab-group resilience suite covers the second half (grouping tolerates
// failure); this covers the window selection itself — focused-normal
// preference, normal[0] fallback, the create-a-window path (which must carry
// the target url so the new window's one tab IS the requested tab, not an
// orphan NTP + a second tab), and the MV2/Electron and error-path empty
// returns (which make the caller fall back to chrome.tabs.create's default
// placement).

const g = globalThis as unknown as { chrome?: unknown }
let savedChrome: unknown

type WindowStub = { id?: number; focused?: boolean; tabs?: { id?: number; url?: string }[] }

function installChromeMock(opts: {
  windows?: "absent" | "no-getall"
  getAll?: WindowStub[] | (() => never)
  create?: WindowStub | (() => never)
}) {
  const calls = { getAll: 0, create: 0, createArgs: undefined as unknown }
  let windows: unknown
  if (opts.windows === "absent") {
    windows = undefined
  } else if (opts.windows === "no-getall") {
    windows = {} // present but getAll not a function
  } else {
    windows = {
      async getAll() {
        calls.getAll++
        if (typeof opts.getAll === "function") return (opts.getAll as () => never)()
        return opts.getAll ?? []
      },
      ...(opts.create !== undefined
        ? {
            async create(args: unknown) {
              calls.create++
              calls.createArgs = args
              if (typeof opts.create === "function") return (opts.create as () => never)()
              return opts.create
            },
          }
        : {}),
    }
  }
  ;(g as { chrome: unknown }).chrome = { windows }
  return calls
}

beforeEach(() => { savedChrome = g.chrome })
afterEach(() => { (g as { chrome: unknown }).chrome = savedChrome })

const URL = "https://example.com/"

describe("resolveNormalWindowPlacement", () => {
  test("prefers the focused normal window (no created tab)", async () => {
    installChromeMock({ getAll: [{ id: 1 }, { id: 2, focused: true }, { id: 3 }] })
    expect(await resolveNormalWindowPlacement(false, URL)).toEqual({ windowId: 2 })
  })

  test("falls back to the first normal window when none is focused", async () => {
    installChromeMock({ getAll: [{ id: 5 }, { id: 7 }] })
    expect(await resolveNormalWindowPlacement(false, URL)).toEqual({ windowId: 5 })
  })

  test("creates a normal window carrying the url; its initial tab is returned (no orphan NTP)", async () => {
    const initialTab = { id: 12, url: URL }
    const calls = installChromeMock({ getAll: [], create: { id: 99, tabs: [initialTab] } })
    const placement = await resolveNormalWindowPlacement(true, URL)
    expect(placement.windowId).toBe(99)
    // The window's one tab IS the requested tab — the caller must NOT create a
    // second tab (which would leave the NTP orphan this path used to produce).
    expect(placement.createdTab).toEqual(initialTab as unknown as chrome.tabs.Tab)
    expect(calls.create).toBe(1)
    expect(calls.createArgs).toEqual({ url: URL, focused: true })
  })

  test("a background create is unfocused and still carries the url", async () => {
    const calls = installChromeMock({ getAll: [], create: { id: 42, tabs: [{ id: 7, url: URL }] } })
    await resolveNormalWindowPlacement(false, URL)
    expect(calls.createArgs).toEqual({ url: URL, focused: false })
  })

  test("created window without a tabs array degrades to windowId-only placement", async () => {
    installChromeMock({ getAll: [], create: { id: 31 } })
    expect(await resolveNormalWindowPlacement(false, URL)).toEqual({ windowId: 31, createdTab: undefined })
  })

  test("returns {} on MV2/Electron (chrome.windows absent) — default placement", async () => {
    installChromeMock({ windows: "absent" })
    expect(await resolveNormalWindowPlacement(false, URL)).toEqual({})
  })

  test("returns {} when chrome.windows.getAll is not a function", async () => {
    installChromeMock({ windows: "no-getall" })
    expect(await resolveNormalWindowPlacement(false, URL)).toEqual({})
  })

  test("returns {} when getAll throws (never propagates)", async () => {
    installChromeMock({ getAll: () => { throw new Error("getAll blew up") } })
    expect(await resolveNormalWindowPlacement(false, URL)).toEqual({})
  })

  test("returns {} when create throws for an empty window list", async () => {
    installChromeMock({ getAll: [], create: () => { throw new Error("create blew up") } })
    expect(await resolveNormalWindowPlacement(true, URL)).toEqual({})
  })
})

// Grouping failure must be VISIBLE, not just a console.warn: per-agent
// isolation (named groups) and default-group targeting both depend on the tab
// actually being grouped. -1 with the group API present is a real failure the
// tab_create result surfaces as `groupWarning`; -1 without the API
// (MV2/Electron) is the normal ungrouped world — no warning.
describe("groupWarningFor", () => {
  test("warns when grouping failed despite the group API being available", () => {
    const warning = groupWarningFor(-1, true)
    expect(warning).toBeDefined()
    expect(warning).toContain("not added to a tab group")
    expect(warning).toContain("isolation")
  })

  test("silent when the group API is unavailable (MV2/Electron)", () => {
    expect(groupWarningFor(-1, false)).toBeUndefined()
  })

  test("silent on successful grouping regardless of API flag", () => {
    expect(groupWarningFor(5, true)).toBeUndefined()
    expect(groupWarningFor(0, true)).toBeUndefined()
  })
})
