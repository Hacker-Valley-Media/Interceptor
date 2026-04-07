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
            source = w.__slop_tt_policy.createScript(c)
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
