type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleSearchActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  const searchApi = (chrome as typeof chrome & {
    search?: { query?: (info: { text: string; tabId: number }) => Promise<void> }
  }).search

  if (action.type === "search_capability") {
    return {
      success: true,
      data: { available: typeof searchApi?.query === "function" }
    }
  }

  if (action.type === "search_query") {
    if (typeof searchApi?.query !== "function") {
      return {
        success: false,
        error: "websearch is unavailable in this browser context: chrome.search.query is not exposed; no fallback provider was used"
      }
    }
    const query = String(action.query || "")
    if (!query.trim()) return { success: false, error: "websearch requires a non-empty query" }
    if (!Number.isInteger(tabId) || tabId <= 0) {
      return { success: false, error: "websearch requires a managed target tab" }
    }
    try {
      // Query the browser's configured default provider into the allocator's
      // already-managed tab. Chrome forbids combining tabId with disposition.
      await searchApi.query({ text: query, tabId })
      return { success: true, data: { tabId, query } }
    } catch (err) {
      return { success: false, error: `default-provider search failed: ${(err as Error).message}` }
    }
  }
  return { success: false, error: `unknown search action: ${action.type}` }
}
