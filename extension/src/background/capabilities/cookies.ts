type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleCookieActions(
  action: { type: string; [key: string]: unknown },
  _tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "cookies_get": {
      const cookies = await chrome.cookies.getAll({ domain: action.domain as string })
      return { success: true, data: cookies }
    }

    case "cookies_set": {
      const cookie = await chrome.cookies.set(action.cookie as chrome.cookies.SetDetails)
      return { success: true, data: cookie }
    }

    case "cookies_delete":
      await chrome.cookies.remove({ url: action.url as string, name: action.name as string })
      return { success: true }
  }
  return { success: false, error: `unknown cookie action: ${action.type}` }
}
