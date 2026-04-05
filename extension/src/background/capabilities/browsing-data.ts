type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleBrowsingDataActions(
  action: { type: string; [key: string]: unknown },
  _tabId: number
): Promise<ActionResult> {
  if (action.type === "browsing_data_remove") {
    const since = (action.since as number) || 0
    const types: Record<string, boolean> = {}
    const requested = (action.types as string[]) || ["cache"]
    for (const t of requested) {
      if (t === "cache") types.cache = true
      if (t === "cookies") types.cookies = true
      if (t === "history") types.history = true
      if (t === "formData") types.formData = true
      if (t === "downloads") types.downloads = true
      if (t === "localStorage") types.localStorage = true
      if (t === "indexedDB") types.indexedDB = true
      if (t === "serviceWorkers") types.serviceWorkers = true
      if (t === "passwords") types.passwords = true
    }
    await chrome.browsingData.remove({ since }, types as chrome.browsingData.DataTypeSet)
    return { success: true }
  }
  return { success: false, error: `unknown browsing data action: ${action.type}` }
}
