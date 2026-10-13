import {
  attachTab, detachTab, sendToTab, subscribeTab, unsubscribe,
  renewSubscriptions, sessionStatus, hasDebuggerApi
} from "../cdp-session"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

/** chrome.debugger rejects with the CDP error object as a JSON string. */
function cdpError(err: unknown): { message: string; code?: number } {
  const raw = (err as Error)?.message || String(err)
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; code?: unknown }
    if (parsed && typeof parsed.message === "string") {
      return { message: parsed.message, ...(typeof parsed.code === "number" ? { code: parsed.code } : {}) }
    }
  } catch {}
  return { message: raw }
}

function fail(err: unknown, prefix?: string): ActionResult {
  const { message, code } = cdpError(err)
  return {
    success: false,
    error: prefix ? `${prefix}: ${message}` : message,
    ...(code !== undefined ? { data: { cdpError: { code, message } } } : {})
  }
}

function parseFilter(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []
  return parts.filter((p): p is string => typeof p === "string").map(p => p.trim()).filter(Boolean)
}

export async function handleRawCdpActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  if (!hasDebuggerApi()) {
    return { success: false, error: "raw CDP needs chrome.debugger, which this browser does not provide" }
  }
  switch (action.type) {
    case "cdp_tab_attach":
      try {
        return { success: true, data: await attachTab(tabId) }
      } catch (err) {
        return fail(err)
      }

    case "cdp_tab_detach":
      return { success: true, data: await detachTab(tabId) }

    case "cdp_tab_send": {
      const method = typeof action.method === "string" ? action.method : ""
      if (!/^[A-Za-z]+\.[A-Za-z]+$/.test(method)) {
        return { success: false, error: "cdp_tab_send requires a CDP method such as 'Page.captureScreenshot'" }
      }
      const params = action.params
      if (params !== undefined && (params === null || typeof params !== "object" || Array.isArray(params))) {
        return { success: false, error: "cdp_tab_send params must be a JSON object" }
      }
      const sessionId = typeof action.sessionId === "string" && action.sessionId ? action.sessionId : undefined
      try {
        const result = await sendToTab(tabId, method, params as Record<string, unknown> | undefined, sessionId)
        return { success: true, data: result ?? {} }
      } catch (err) {
        return fail(err, method)
      }
    }

    case "cdp_tab_status":
      return { success: true, data: sessionStatus() }

    case "cdp_tab_subscribe": {
      const id = typeof action.subscription === "string" ? action.subscription : ""
      if (!id) return { success: false, error: "cdp_tab_subscribe requires a subscription id" }
      try {
        return { success: true, data: await subscribeTab(tabId, id, parseFilter(action.filter), action.attach !== false) }
      } catch (err) {
        return fail(err)
      }
    }

    case "cdp_tab_unsubscribe": {
      const id = typeof action.subscription === "string" ? action.subscription : ""
      return { success: true, data: { subscription: id, removed: await unsubscribe(id) } }
    }

    case "cdp_tab_renew": {
      const ids = Array.isArray(action.subscriptions)
        ? action.subscriptions.filter((id): id is string => typeof id === "string")
        : []
      return { success: true, data: { gone: renewSubscriptions(ids) } }
    }
  }
  return { success: false, error: `unknown raw CDP action: ${action.type}` }
}
