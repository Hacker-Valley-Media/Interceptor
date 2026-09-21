import { recordGroupActivity } from "../tab-lifecycle"
import { handleTabActions } from "./tabs"

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
      const sessionId = action.sessionId as string
      // chrome.sessions.restore makes the restored tab the active tab of its
      // window, so it is the explicit opt-in. The default reopens the entry's
      // pages through tab_create: background tabs, in the caller's group.
      if (action.active === true) {
        const restored = await chrome.sessions.restore(sessionId)
        return { success: true, data: { method: "native", ...restored } }
      }
      const recent = await chrome.sessions.getRecentlyClosed()
      const tabs = recent.flatMap((s) => {
        if (s.window?.sessionId === sessionId) return s.window.tabs ?? []
        return [s.tab, ...(s.window?.tabs ?? [])].filter((t) => t?.sessionId === sessionId)
      })
      const urls = tabs.map((t) => t?.url).filter((u): u is string => typeof u === "string" && u.length > 0)
      if (urls.length === 0) {
        return { success: false, error: `no recently closed tab or window has sessionId '${sessionId}'. Run 'interceptor sessions' to list them.` }
      }
      const group = typeof action.group === "string" ? action.group : undefined
      const reopened: unknown[] = []
      for (const url of urls) {
        const created = await handleTabActions(
          { type: "tab_create", url, reuse: false, group, groupColor: action.groupColor }, 0)
        if (!created.success) return created
        reopened.push(created.data)
      }
      recordGroupActivity(group ?? "")
      return {
        success: true,
        data: {
          method: "reopen",
          tabs: reopened,
          note: "Reopened in the background. History and form state are not restored, and the entry stays in 'interceptor sessions'. Pass --activate for the browser's own restore, which brings the tab to the front.",
        },
      }
    }
  }
  return { success: false, error: `unknown session action: ${action.type}` }
}
