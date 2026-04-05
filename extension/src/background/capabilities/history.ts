type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleHistoryActions(
  action: { type: string; [key: string]: unknown },
  _tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "history_search": {
      const items = await chrome.history.search({
        text: (action.query as string) || "",
        maxResults: (action.maxResults as number) || 50,
        startTime: action.startTime as number | undefined,
        endTime: action.endTime as number | undefined
      })
      return {
        success: true,
        data: items.map(i => ({ url: i.url, title: i.title, lastVisit: i.lastVisitTime, visitCount: i.visitCount }))
      }
    }

    case "history_visits": {
      const visits = await chrome.history.getVisits({ url: action.url as string })
      return { success: true, data: visits }
    }

    case "history_delete":
      await chrome.history.deleteUrl({ url: action.url as string })
      return { success: true }

    case "history_delete_range":
      await chrome.history.deleteRange({
        startTime: action.startTime as number,
        endTime: action.endTime as number
      })
      return { success: true }

    case "history_delete_all":
      await chrome.history.deleteAll()
      return { success: true }
  }
  return { success: false, error: `unknown history action: ${action.type}` }
}
