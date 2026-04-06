type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleSearchActions(
  action: { type: string; [key: string]: unknown },
  _tabId: number
): Promise<ActionResult> {
  if (action.type === "search_query") {
    await chrome.search.query({ text: action.query as string, disposition: "NEW_TAB" })
    return { success: true }
  }
  return { success: false, error: `unknown search action: ${action.type}` }
}
