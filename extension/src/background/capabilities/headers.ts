type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleHeaderActions(
  action: { type: string; [key: string]: unknown },
  _tabId: number
): Promise<ActionResult> {
  if (action.type !== "headers_modify") {
    return { success: false, error: `unknown header action: ${action.type}` }
  }
  const rules = action.rules as Array<{ operation: string; header: string; value?: string }> | undefined
  if (!rules || rules.length === 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: Array.from({ length: 100 }, (_, i) => i + 1)
    })
    return { success: true, data: "all header rules cleared" }
  }
  const dnrRules: chrome.declarativeNetRequest.Rule[] = rules.map((r, i) => ({
    id: i + 1,
    priority: 1,
    action: {
      type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [{
        header: r.header,
        operation: r.operation === "remove"
          ? "remove" as chrome.declarativeNetRequest.HeaderOperation
          : "set" as chrome.declarativeNetRequest.HeaderOperation,
        value: r.value
      }]
    },
    condition: { urlFilter: "*" }
  }))
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: dnrRules.map(r => r.id),
    addRules: dnrRules
  })
  return { success: true }
}
