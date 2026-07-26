import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolveNormalWindowId } from "../extension/src/background/capabilities/tabs"

// resolveNormalWindowId is the primary half of the tab_create fix: it pins a new
// tab to a groupable *normal* window so chrome.tabs.group won't reject with
// "Tabs can only be moved to and from normal windows". The tab-group resilience
// suite covers the second half (grouping tolerates failure); this covers the
// window selection itself — focused-normal preference, normal[0] fallback, the
// create-a-window path, and the MV2/Electron and error-path undefined returns
// (which make the caller fall back to chrome.tabs.create's default placement).

const g = globalThis as unknown as { chrome?: unknown }
let savedChrome: unknown

type WindowStub = { id?: number; focused?: boolean }

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

describe("resolveNormalWindowId", () => {
  test("prefers the focused normal window", async () => {
    installChromeMock({ getAll: [{ id: 1 }, { id: 2, focused: true }, { id: 3 }] })
    expect(await resolveNormalWindowId(false)).toBe(2)
  })

  test("falls back to the first normal window when none is focused", async () => {
    installChromeMock({ getAll: [{ id: 5 }, { id: 7 }] })
    expect(await resolveNormalWindowId(false)).toBe(5)
  })

  test("creates a normal window when none exists, honoring the focus intent", async () => {
    const calls = installChromeMock({ getAll: [], create: { id: 99 } })
    expect(await resolveNormalWindowId(true)).toBe(99)
    expect(calls.create).toBe(1)
    expect(calls.createArgs).toEqual({ focused: true })
  })

  test("a background create is unfocused", async () => {
    const calls = installChromeMock({ getAll: [], create: { id: 42 } })
    await resolveNormalWindowId(false)
    expect(calls.createArgs).toEqual({ focused: false })
  })

  test("returns undefined on MV2/Electron (chrome.windows absent) — default placement", async () => {
    installChromeMock({ windows: "absent" })
    expect(await resolveNormalWindowId(false)).toBeUndefined()
  })

  test("returns undefined when chrome.windows.getAll is not a function", async () => {
    installChromeMock({ windows: "no-getall" })
    expect(await resolveNormalWindowId(false)).toBeUndefined()
  })

  test("returns undefined when getAll throws (never propagates)", async () => {
    installChromeMock({ getAll: () => { throw new Error("getAll blew up") } })
    expect(await resolveNormalWindowId(false)).toBeUndefined()
  })

  test("returns undefined when create throws for an empty window list", async () => {
    installChromeMock({ getAll: [], create: () => { throw new Error("create blew up") } })
    expect(await resolveNormalWindowId(true)).toBeUndefined()
  })
})
