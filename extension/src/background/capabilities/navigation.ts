import { waitForTabLoad } from "../content-bridge"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleNavigationActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "navigate":
      await chrome.tabs.update(tabId, { url: action.url as string })
      await waitForTabLoad(tabId)
      return { success: true }

    case "go_back":
      await chrome.tabs.goBack(tabId)
      await waitForTabLoad(tabId)
      return { success: true }

    case "go_forward":
      await chrome.tabs.goForward(tabId)
      await waitForTabLoad(tabId)
      return { success: true }

    case "reload":
      await chrome.tabs.reload(tabId, { bypassCache: !!action.bypassCache })
      await waitForTabLoad(tabId)
      return { success: true }
  }
  return { success: false, error: `unknown navigation action: ${action.type}` }
}
