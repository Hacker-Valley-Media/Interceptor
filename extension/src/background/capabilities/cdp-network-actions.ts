import {
  enableNetworkCapture, disableNetworkCapture, getNetworkLogs,
  networkOverrideConfigs, refreshFetchInterception
} from "../network-capture"
import type { NetworkOverrideRule } from "../network-capture"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleCdpNetworkActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "network_intercept": {
      if (action.enabled === false) {
        await disableNetworkCapture(tabId)
        return { success: true, data: { enabled: false, captured: getNetworkLogs(tabId).length } }
      }
      const patterns = Array.isArray(action.patterns) ? (action.patterns as string[]) : []
      await enableNetworkCapture(tabId, patterns)
      return { success: true, data: { enabled: true, patterns } }
    }

    case "network_log": {
      const since = (action.since as number) || 0
      const limit = (action.limit as number) || 100
      const logs = getNetworkLogs(tabId)
        .filter(entry => !since || entry.timestamp >= since)
        .slice(-limit)
      return { success: true, data: logs }
    }

    case "network_override": {
      const rules = action.enabled === false
        ? []
        : ((action.rules as NetworkOverrideRule[] | undefined) || [])
      networkOverrideConfigs.set(tabId, rules)
      await refreshFetchInterception(tabId)
      return { success: true, data: { enabled: rules.length > 0, ruleCount: rules.length, rules } }
    }
  }
  return { success: false, error: `unknown cdp-network action: ${action.type}` }
}
