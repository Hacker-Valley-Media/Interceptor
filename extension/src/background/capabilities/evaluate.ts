type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleEvaluateActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  if (action.type !== "evaluate") {
    return { success: false, error: `unknown evaluate action: ${action.type}` }
  }
  const code = action.code as string
  const world = (action.world as string) === "ISOLATED" ? "ISOLATED" : "MAIN"
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: world as "MAIN" | "ISOLATED",
    args: [code],
    func: (c: string) => {
      try {
        const w = window as any
        if (w.trustedTypes) {
          if (!w.__slop_tt_policy) {
            try {
              w.__slop_tt_policy = w.trustedTypes.createPolicy("slop-eval", {
                createScript: (s: string) => s
              })
            } catch {
              try {
                w.__slop_tt_policy = w.trustedTypes.createPolicy("slop-eval-" + Date.now(), {
                  createScript: (s: string) => s
                })
              } catch {}
            }
          }
          if (w.__slop_tt_policy) {
            const trusted = w.__slop_tt_policy.createScript(c)
            const r = (0, eval)(trusted)
            return { success: true, data: (typeof r === "object" && r !== null) ? JSON.parse(JSON.stringify(r)) : r }
          }
        }
        const r = (0, eval)(c)
        return { success: true, data: (typeof r === "object" && r !== null) ? JSON.parse(JSON.stringify(r)) : r }
      } catch (e: any) {
        return { success: false, error: e.message }
      }
    }
  })
  return (results[0]?.result as ActionResult) ?? { success: false, error: "no result" }
}
