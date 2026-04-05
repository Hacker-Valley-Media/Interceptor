type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleSessionActions(
  action: { type: string; [key: string]: unknown },
  _tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "session_list": {
      const sessions = await chrome.sessions.getRecentlyClosed({
        maxResults: (action.maxResults as number) || 10
      })
      return {
        success: true,
        data: sessions.map(s => ({
          tab: s.tab ? { url: s.tab.url, title: s.tab.title, sessionId: s.tab.sessionId } : undefined,
          window: s.window ? { sessionId: s.window.sessionId, tabCount: s.window.tabs?.length } : undefined,
          lastModified: s.lastModified
        }))
      }
    }

    case "session_restore": {
      const restored = await chrome.sessions.restore(action.sessionId as string)
      return { success: true, data: restored }
    }
  }
  return { success: false, error: `unknown session action: ${action.type}` }
}
