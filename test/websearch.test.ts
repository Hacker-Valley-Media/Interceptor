import { afterEach, describe, expect, mock, test } from "bun:test"

import { webSearchQuery, buildTabCreateAction, shouldCloseFailedSearchTab, SEARCH_DEPRECATION_WARNING } from "../cli/commands/compound"
import { normalizeArgs } from "../cli/normalize"
import { handleSearchActions } from "../extension/src/background/capabilities/search"
import { needsTab } from "../extension/src/background/no-tab-actions"
import { classify } from "../cli/mcp/tiers"

const originalChrome = globalThis.chrome

afterEach(() => {
  globalThis.chrome = originalChrome
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
