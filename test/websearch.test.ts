import { afterEach, describe, expect, mock, test } from "bun:test"

import { webSearchQuery, webSearchTimeout, buildTabCreateAction, shouldCloseFailedSearchTab, SEARCH_DEPRECATION_WARNING } from "../cli/commands/compound"
import { normalizeArgs } from "../cli/normalize"
import { handleSearchActions } from "../extension/src/background/capabilities/search"
import { handleTabActions } from "../extension/src/background/capabilities/tabs"
import { namedGroups } from "../extension/src/background/tab-group"
import { needsTab } from "../extension/src/background/no-tab-actions"
import { classify } from "../cli/mcp/tiers"

const originalChrome = globalThis.chrome

afterEach(() => {
  globalThis.chrome = originalChrome
  namedGroups.clear()
})

describe("websearch CLI contract", () => {
  test("preserves a multi-word query with flags in any order", () => {
    const args = normalizeArgs(["websearch", "--timeout", "9000", "bun", "websocket", "docs", "--text-only"])
    expect(args).toEqual(["websearch", "bun", "websocket", "docs", "--timeout", "9000", "--text-only"])
    expect(webSearchQuery(args)).toBe("bun websocket docs")
  })

  test("flags-only input produces an empty query", () => {
    expect(webSearchQuery(normalizeArgs(["websearch", "--text-only", "--no-wait"]))).toBe("")
  })

  test("accepts only non-negative integer timeouts", () => {
    expect(webSearchTimeout(["websearch", "query"])).toBe(5000)
    expect(webSearchTimeout(["websearch", "query", "--timeout", "0"])).toBe(0)
    expect(webSearchTimeout(["websearch", "query", "--timeout", "9000"])).toBe(9000)
    expect(webSearchTimeout(["websearch", "query", "--timeout"])).toBeNull()
    expect(webSearchTimeout(["websearch", "query", "--timeout", "-1"])).toBeNull()
    expect(webSearchTimeout(["websearch", "query", "--timeout", "later"])).toBeNull()
  })

  test("uses the open allocator policy and background-first defaults", () => {
    const action = buildTabCreateAction(["websearch", "query"], "about:blank", { policyDefault: true })
    expect(action).toEqual({ type: "tab_create", url: "about:blank", reusePolicy: true })
    expect(action.active).toBeUndefined()
    expect(buildTabCreateAction(["websearch", "query", "--activate"], "about:blank", { policyDefault: true }).active).toBe(true)
  })

  test("provider search is tab-targeted and MCP classifies it as mutating", () => {
    expect(needsTab("search_capability")).toBe(false)
    expect(needsTab("search_query")).toBe(true)
    expect(classify("browser", "websearch", []).tier).toBe("mutate")
    expect(classify("browser", "search", []).tier).toBe("mutate")
  })

  test("failure cleanup closes only a newly-created blank destination", () => {
    expect(shouldCloseFailedSearchTab(false, "about:blank")).toBe(true)
    expect(shouldCloseFailedSearchTab(false, "chrome://newtab/")).toBe(true)
    expect(shouldCloseFailedSearchTab(false, "https://provider.example/results")).toBe(false)
    expect(shouldCloseFailedSearchTab(true, "about:blank")).toBe(false)
  })

  test("revalidates a prepare-only reuse candidate before returning it", async () => {
    namedGroups.set("search", 44)
    const get = mock(async (tabId: number) => {
      if (tabId === 7) throw new Error("tab vanished")
      return { id: tabId, url: "about:blank" } as chrome.tabs.Tab
    })
    const create = mock(async () => ({ id: 8, url: "about:blank" }) as chrome.tabs.Tab)
    globalThis.chrome = {
      storage: {
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} }
      },
      tabs: {
        query: async () => [{ id: 7, url: "https://old.example" }],
        get,
        create,
        group: async () => 44
      },
      tabGroups: {
        get: async () => ({ id: 44, title: "interceptor-search" }),
        query: async () => [],
        update: async () => ({ id: 44 })
      }
    } as unknown as typeof chrome

    const result = await handleTabActions({
      type: "tab_create",
      url: "about:blank",
      group: "search",
      reuse: true,
      prepareOnly: true
    }, 0)

    expect(get).toHaveBeenCalledWith(7)
    expect(create).toHaveBeenCalledTimes(1)
    expect(result.data).toMatchObject({ tabId: 8, reused: false })
  })

  test("deprecated alias warning is the exact migration guidance", () => {
    expect(SEARCH_DEPRECATION_WARNING).toBe(
      "warning: 'interceptor search' is deprecated; use 'interceptor websearch' for the web or 'interceptor find' for the current page."
    )
  })
})

describe("Chrome default-provider search API", () => {
  test("targets the managed tab and never supplies disposition", async () => {
    const query = mock(async (_info: { text: string; tabId: number }) => {})
    globalThis.chrome = { search: { query } } as unknown as typeof chrome

    const result = await handleSearchActions({ type: "search_query", query: "literal query" }, 77)

    expect(result.success).toBe(true)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith({ text: "literal query", tabId: 77 })
    expect("disposition" in (query.mock.calls[0][0] as Record<string, unknown>)).toBe(false)
  })

  test("reports missing API explicitly", async () => {
    globalThis.chrome = {} as typeof chrome
    const capability = await handleSearchActions({ type: "search_capability" }, 0)
    expect(capability).toEqual({ success: true, data: { available: false } })
    const result = await handleSearchActions({ type: "search_query", query: "q" }, 77)
    expect(result.success).toBe(false)
    expect(result.error).toContain("no fallback provider")
  })

  test("surfaces provider API rejection", async () => {
    globalThis.chrome = {
      search: { query: mock(async () => { throw new Error("provider rejected") }) }
    } as unknown as typeof chrome
    const result = await handleSearchActions({ type: "search_query", query: "q" }, 77)
    expect(result.success).toBe(false)
    expect(result.error).toContain("provider rejected")
  })
})
