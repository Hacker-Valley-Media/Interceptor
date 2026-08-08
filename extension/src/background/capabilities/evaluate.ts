import { IK_TT_POLICY, TT_POLICY_NAME } from "../../inject-keys"
import { waitForTabLoad } from "../content-bridge"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

const CSP_BYPASS_RULE_ID_BASE = 910_000

export function isTrustedTypesError(error: string | undefined): boolean {
  if (!error) return false
  return /trusted ?types|trustedscript|require-trusted-types-for|createPolicy/i.test(error)
}

export function isCspUnsafeEvalError(error: string | undefined): boolean {
  if (!error) return false
  if (isTrustedTypesError(error)) return false
  return /content security policy|script-src|unsafe-eval/i.test(error)
    && /eval|evaluating a string|string as javascript/i.test(error)
}

export function isCspEvalError(error: string | undefined): boolean {
  if (!error) return false
  return isTrustedTypesError(error) || isCspUnsafeEvalError(error)
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
    args: [code, IK_TT_POLICY, TT_POLICY_NAME],
    func: async (c: string, ttKey: string, ttName: string) => {
      const TT = Symbol.for(ttKey)
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
          if (!w[TT]) {
            try {
              w[TT] = w.trustedTypes.createPolicy(ttName, {
                createScript: (s: string) => s
              })
            } catch {
              try {
                w[TT] = w.trustedTypes.createPolicy(ttName + "-" + Date.now(), {
                  createScript: (s: string) => s
                })
              } catch {}
            }
          }
          if (w[TT]) {
            source = w[TT].createScript(c)
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

/**
 * Run a per-tab evaluation through the CSP / Trusted-Types escalation chain:
 *   1. try the `run` callback in the requested world
 *   2. on a Trusted-Types-only failure (MAIN), retry in ISOLATED
 *   3. on any unsafe-eval CSP / TT failure (MAIN), strip the page's CSP response
 *      header via a per-tab declarativeNetRequest rule + reload, then retry
 *
 * `run` performs the actual in-page work and returns an ActionResult — e.g.
 * clone-eval for the `evaluate` capability, or blob-URL normalization for the
 * binary sink. On the fallback / bypass paths the successful result's `data` is
 * wrapped as `{ value, trustedTypesFallback | cspBypassApplied, originalError }`;
 * callers that need the raw value should unwrap `data.value` when present.
 *
 * This is the shared bypass core (lifted out of handleEvaluateActions) so every
 * capability that evals into a page inherits the same strict-CSP / Trusted-Types
 * handling instead of reimplementing a weaker one.
 */
export async function runWithCspStripBypass(
  tabId: number,
  world: "MAIN" | "ISOLATED",
  run: (tabId: number, world: "MAIN" | "ISOLATED") => Promise<ActionResult>
): Promise<ActionResult> {
  const first = await run(tabId, world)
  if (first.success || world !== "MAIN") {
    return first
  }

  if (isTrustedTypesError(first.error) && !isCspUnsafeEvalError(first.error)) {
    const isolated = await run(tabId, "ISOLATED")
    if (isolated.success) {
      return {
        ...isolated,
        data: {
          value: isolated.data,
          trustedTypesFallback: true,
          originalError: first.error
        }
      }
    }
    // ISOLATED also failed under Trusted Types (require-trusted-types-for
    // 'script' blocks eval in every world). Fall through to the CSP-strip
    // bypass + reload path below — buildCspBypassRule removes the entire CSP
    // response header (including require-trusted-types-for), so a reloaded page
    // accepts MAIN-world eval.
  }

  if (!isCspUnsafeEvalError(first.error) && !isTrustedTypesError(first.error)) {
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

  const retried = await run(tabId, "MAIN")
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
      if (
        fallback.available &&
        (fallback.result?.success || !isCspEvalError(fallback.result?.error))
      ) {
        return fallback.result ?? { success: false, error: "no result" }
      }
      // userScripts could not beat the page's CSP / Trusted-Types either — fall
      // through to the executeEval CSP-strip bypass + reload path below.
    } else {
      return userScriptAttempt.result ?? { success: false, error: "no result" }
    }
  }
  // Trusted-Types / unsafe-eval CSP escalation now lives in the shared
  // runWithCspStripBypass core (see above) so `evaluate` and the binary sink
  // share one bypass implementation. The userScripts attempt above remains
  // evaluate-specific.
  return runWithCspStripBypass(
    tabId,
    world as "MAIN" | "ISOLATED",
    (t, w) => executeEval(t, w, code)
  )
}
