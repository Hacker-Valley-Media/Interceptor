/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ensureInterceptorGroup, ensureNamedGroup, namedGroups } from "../extension/src/background/tab-group"
import { noActiveTabError } from "../extension/src/background/message-dispatch"

// Issue #162: on a profile with zero windows, chrome.tabGroups.query({})
// rejects with "No current window". The ensure* helpers run BEFORE tab_create
// reaches its create-a-window branch (reuse lookup / tab_list), so the
// rejection used to escape as the whole command's error. No windows means no
// groups: the helpers must answer -1, not throw.
let originalChrome: unknown
let queries = 0
beforeEach(() => {
  namedGroups.clear()
  queries = 0
  originalChrome = (globalThis as { chrome?: unknown }).chrome
  const noWindow = async () => { queries++; throw new Error("No current window") }
  ;(globalThis as { chrome: unknown }).chrome = {
    tabs: { group: async () => 1 },
    tabGroups: { query: noWindow, get: noWindow, update: async () => {} },
    storage: {
      session: { get: async () => ({}), set: async () => {} },
      local: { get: async () => ({}), set: async () => {} },
    },
  }
})
afterEach(() => { (globalThis as { chrome?: unknown }).chrome = originalChrome })

describe("tab groups on a windowless profile (issue #162)", () => {
  test("ensureNamedGroup answers -1 instead of throwing", async () => {
    await expect(ensureNamedGroup("prd159")).resolves.toBe(-1)
    expect(queries).toBeGreaterThan(0)
  })
  test("ensureInterceptorGroup answers -1 instead of throwing", async () => {
    await expect(ensureInterceptorGroup()).resolves.toBe(-1)
    expect(queries).toBeGreaterThan(0)
  })
})

describe("dispatcher no-active-tab error on a windowless profile (issue #162)", () => {
  test("names the fix when the profile has zero windows, stays terse otherwise", () => {
    expect(noActiveTabError(0)).toContain("no browser window is open in this profile")
    expect(noActiveTabError(0)).toContain("interceptor open <url>")
    expect(noActiveTabError(2)).toBe("no active tab")
    expect(noActiveTabError(null)).toBe("no active tab")
  })
})
