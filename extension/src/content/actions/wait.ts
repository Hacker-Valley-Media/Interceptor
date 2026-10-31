import { waitForElement, waitForDomStable } from "../input-simulation"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleWait(action: Action): Promise<ActionResult> {
  await new Promise(r => setTimeout(r, action.ms as number))
  return { success: true }
}

export async function handleWaitFor(action: Action): Promise<ActionResult> {
  const selector = action.selector as string
  const timeout = (action.timeout as number) || 10000
  const el = await waitForElement(selector, timeout)
  return el
    ? { success: true, data: `found: ${selector}` }
    : { success: false, error: `timeout waiting for: ${selector}` }
}

// Only `batch` reaches this: its sub-actions run here, not through the router.
export async function handleWaitStable(action: Action): Promise<ActionResult> {
  const debounceMs = (action.ms as number) || 200
  const timeoutMs = (action.timeout as number) || 5000
  const stableResult = await waitForDomStable(debounceMs, timeoutMs)
  return { success: true, data: stableResult }
}

let quietObserver: MutationObserver | null = null
let lastMutation = 0
let mutations = 0

/**
 * How long the DOM has been quiet. The background holds the clock for
 * `wait_stable` (see waitStable in content-bridge.ts): this answers with
 * performance.now(), which a hidden tab does not throttle.
 */
export function handleDomQuiet(action: Action): ActionResult {
  if (action.stop) {
    quietObserver?.disconnect()
    quietObserver = null
    return { success: true }
  }
  if (!quietObserver) {
    mutations = 0
    lastMutation = performance.now()
    quietObserver = new MutationObserver((records) => {
      mutations += records.length
      lastMutation = performance.now()
    })
    quietObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
  }
  return { success: true, data: { quietMs: performance.now() - lastMutation, mutations } }
}
