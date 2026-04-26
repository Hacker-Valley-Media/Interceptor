// screenshot-cors.ts
//
// Per-tab session DNR rule that grants CORS clearance to subresource fetches
// during the lifetime of a single screenshot operation. Mirrors the lifecycle
// pattern used by `evaluate.ts`'s buildCspBypassRule / installCspBypassForTab,
// just with a different rule-ID base and different header set.
//
// Lifecycle:
//   const installed = await installScreenshotCorsRule(tabId)
//   try { ... do the screenshot ... }
//   finally { await uninstallScreenshotCorsRule(tabId) }
//
// Blast radius:
//   - tabIds: [tabId] — only the tab being screenshotted is affected.
//   - resourceTypes: image, font, media, stylesheet, xmlhttprequest — only
//     subresources the screenshot library re-fetches. main_frame and sub_frame
//     are intentionally excluded so the page's own CSP / COEP / frame-options
//     behavior is not modified.
//   - Session rule (not dynamic): the rule is in-memory only and does not
//     persist across browser restarts.
//
// Tradeoff:
//   - `Access-Control-Allow-Credentials` is removed (not set to "false")
//     because spec-compliant browsers reject `ACAO: *` paired with
//     `ACAC: true`. Sites with credentialed cross-origin XHRs in flight
//     during the screenshot will see those requests behave as Origin-
//     restricted for the duration of the capture.

const SCREENSHOT_CORS_RULE_ID_BASE = 920_000

export function buildScreenshotCorsRule(tabId: number): chrome.declarativeNetRequest.Rule {
  return {
    id: SCREENSHOT_CORS_RULE_ID_BASE + tabId,
    priority: 10,
    action: {
      type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
      responseHeaders: [
        { header: "access-control-allow-origin", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: "*" },
        { header: "access-control-allow-credentials", operation: "remove" as chrome.declarativeNetRequest.HeaderOperation },
        { header: "cross-origin-resource-policy", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: "cross-origin" }
      ]
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: [
        "image" as chrome.declarativeNetRequest.ResourceType,
        "font" as chrome.declarativeNetRequest.ResourceType,
        "media" as chrome.declarativeNetRequest.ResourceType,
        "stylesheet" as chrome.declarativeNetRequest.ResourceType,
        "xmlhttprequest" as chrome.declarativeNetRequest.ResourceType
      ]
    }
  }
}

export async function installScreenshotCorsRule(tabId: number): Promise<void> {
  const rule = buildScreenshotCorsRule(tabId)
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [rule.id],
    addRules: [rule]
  })
}

export async function uninstallScreenshotCorsRule(tabId: number): Promise<void> {
  const ruleId = SCREENSHOT_CORS_RULE_ID_BASE + tabId
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId]
    })
  } catch {
    // best-effort teardown — never let a cleanup failure mask the original
    // screenshot result
  }
}
