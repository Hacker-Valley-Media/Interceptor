import { sendNetDirect } from "../content-bridge"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handlePassiveNetActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "net_log": {
      const result = await sendNetDirect(tabId, {
        type: "get_net_log",
        filter: action.filter as string | undefined,
        since: action.since as number | undefined
      }) as { success: boolean; data?: unknown[]; error?: string }
      if (!result.success) return { success: false, error: result.error || "failed to get passive net log" }
      let entries = result.data || []
      const limit = (action.limit as number) || 100
      entries = entries.slice(-limit)
      return { success: true, data: entries }
    }

    case "net_clear": {
      const result = await sendNetDirect(tabId, { type: "clear_net_log" }) as {
        success: boolean; error?: string
      }
      return result.success
        ? { success: true, data: "passive net log cleared" }
        : { success: false, error: result.error }
    }

    case "net_headers": {
      const result = await sendNetDirect(tabId, {
        type: "get_captured_headers",
        filter: action.filter as string | undefined
      }) as { success: boolean; data?: unknown[]; error?: string }
      if (!result.success) return { success: false, error: result.error || "failed to get captured headers" }
      return { success: true, data: result.data }
    }

    case "sse_log": {
      const result = await sendNetDirect(tabId, {
        type: "get_sse_log",
        filter: action.filter as string | undefined,
        limit: action.limit as number | undefined
      }) as { success: boolean; data?: unknown[]; error?: string }
      if (!result.success) return { success: false, error: result.error || "failed to get SSE log" }
      return { success: true, data: result.data || [] }
    }
    case "sse_streams": {
      const result = await sendNetDirect(tabId, {
        type: "get_sse_streams"
      }) as { success: boolean; data?: unknown[]; error?: string }
      if (!result.success) return { success: false, error: result.error || "failed to get SSE streams" }
      return { success: true, data: result.data || [] }
    }
    case "sse_chunk": {
      const result = await sendNetDirect(tabId, {
        type: "get_sse_chunk",
        filter: action.filter as string | undefined,
        since: action.since as number | undefined
      }) as { success: boolean; data?: unknown; error?: string }
      if (!result.success) return { success: false, error: result.error || "failed to get SSE chunk" }
      return { success: true, data: result.data }
    }

    case "set_net_overrides": {
      const result = await sendNetDirect(tabId, {
        type: "set_net_overrides",
        rules: action.rules as unknown[]
      }) as { success: boolean; error?: string }
      return result.success
        ? { success: true, data: { overrides: "set", ruleCount: Array.isArray(action.rules) ? (action.rules as unknown[]).length : 0 } }
        : { success: false, error: result.error || "failed to set net overrides" }
    }

    case "clear_net_overrides": {
      const result = await sendNetDirect(tabId, {
        type: "clear_net_overrides"
      }) as { success: boolean; error?: string }
      return result.success
        ? { success: true, data: "net overrides cleared" }
        : { success: false, error: result.error || "failed to clear net overrides" }
    }
  }
  return { success: false, error: `unknown passive-net action: ${action.type}` }
}
