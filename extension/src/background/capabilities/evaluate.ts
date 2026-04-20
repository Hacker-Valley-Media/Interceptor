import { waitForTabLoad } from "../content-bridge"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

const CSP_BYPASS_RULE_ID_BASE = 910_000

export function isCspEvalError(error: string | undefined): boolean {
  if (!error) return false
  return /content security policy|script-src|unsafe-eval|trustedscript/i.test(error)
    && /eval|evaluating a string|string as javascript|trusted types/i.test(error)
}

export function buildCspBypassRule(tabId: number): chrome.declarativeNetRequest.Rule {
  return {
    id: CSP_BYPASS_RULE_ID_BASE + tabId,
    priority: 10,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" }
      ]
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: ["main_frame", "sub_frame"]
    }
  }
}

async function executeWithUserScripts(
  tabId: number,
  world: "MAIN" | "USER_SCRIPT",
  code: string
): Promise<{ available: boolean; result?: ActionResult }> {
  try {
    if (!chrome.userScripts || typeof chrome.userScripts.execute !== "function") {
      return { available: false }
    }
    const results = await chrome.userScripts.execute({
      target: { tabId },
      js: [{ code }],
      world
    })
    const first = results[0]
    if (!first) return { available: true, result: { success: false, error: "no result" } }
    if (first.error) return { available: true, result: { success: false, error: first.error } }
    return { available: true, result: { success: true, data: first.result } }
  } catch (err) {
    const message = (err as Error).message || String(err)
    if (/userScripts|Developer mode|Allow User Scripts|permission|undefined/i.test(message)) {
      return { available: false }
    }
    return { available: true, result: { success: false, error: message } }
  }
}

async function executeEval(
  tabId: number,
  world: "MAIN" | "ISOLATED",
  code: string
): Promise<ActionResult> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    args: [code],
    func: async (c: string) => {
      function clone(v: unknown): unknown {
        if (v === null || v === undefined) return v
        const t = typeof v
        if (t === "string" || t === "number" || t === "boolean") return v
        if (t === "bigint") return (v as bigint).toString()
        try {
          return JSON.parse(JSON.stringify(v))
        } catch {
          try { return String(v) } catch { return null }
        }
      }
      try {
        const w = window as any
        let source = c
        if (w.trustedTypes) {
          if (!w.__interceptor_tt_policy) {
            try {
              w.__interceptor_tt_policy = w.trustedTypes.createPolicy("interceptor-eval", {
                createScript: (s: string) => s
              })
            } catch {
              try {
                w.__interceptor_tt_policy = w.trustedTypes.createPolicy("interceptor-eval-" + Date.now(), {
                  createScript: (s: string) => s
                })
              } catch {}
            }
          }
          if (w.__interceptor_tt_policy) {
            source = w.__interceptor_tt_policy.createScript(c)
          }
        }
        let r: unknown = (0, eval)(source as string)
        if (r && typeof (r as any).then === "function") {
          r = await (r as Promise<unknown>)
        }
        return { success: true, data: clone(r) }
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) }
      }
    }
  })
  return (results[0]?.result as ActionResult) ?? { success: false, error: "no result" }
}

async function installCspBypassForTab(tabId: number): Promise<void> {
  const rule = buildCspBypassRule(tabId)
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [rule.id],
    addRules: [rule]
  })
}

async function reloadTabForCspRetry(tabId: number): Promise<void> {
  await chrome.tabs.reload(tabId, { bypassCache: true })
  await waitForTabLoad(tabId, 15_000)
}

export async function handleEvaluateActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  if (action.type !== "evaluate") {
    return { success: false, error: `unknown evaluate action: ${action.type}` }
  }
  const code = action.code as string
  const world = (action.world as string) === "ISOLATED" ? "ISOLATED" : "MAIN"
  const initialUserScriptWorld = world === "MAIN" ? "MAIN" : "USER_SCRIPT"
  const userScriptAttempt = await executeWithUserScripts(tabId, initialUserScriptWorld, code)
  if (userScriptAttempt.available) {
    if (
      !userScriptAttempt.result?.success &&
      world === "MAIN" &&
      isCspEvalError(userScriptAttempt.result?.error)
    ) {
      const fallback = await executeWithUserScripts(tabId, "USER_SCRIPT", code)
      if (fallback.available) return fallback.result ?? { success: false, error: "no result" }
    }
    return userScriptAttempt.result ?? { success: false, error: "no result" }
  }
  const first = await executeEval(tabId, world as "MAIN" | "ISOLATED", code)
  if (first.success || world !== "MAIN" || !isCspEvalError(first.error)) {
    return first
  }

  try {
    await installCspBypassForTab(tabId)
    await reloadTabForCspRetry(tabId)
  } catch (err) {
    return {
      success: false,
      error: `MAIN-world eval hit page CSP and automatic CSP bypass setup failed: ${(err as Error).message}`,
      data: { originalError: first.error, cspBypassAttempted: false }
    }
  }

  const retried = await executeEval(tabId, "MAIN", code)
  if (retried.success) {
    return {
      ...retried,
      data: {
        value: retried.data,
        cspBypassApplied: true,
        originalError: first.error
      }
    }
  }

  return {
    success: false,
    error: retried.error || first.error || "MAIN-world eval failed after CSP bypass retry",
    data: {
      originalError: first.error,
      cspBypassApplied: true
    }
  }
}
