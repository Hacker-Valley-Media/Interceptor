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

export async function handleWaitStable(action: Action): Promise<ActionResult> {
  const debounceMs = (action.ms as number) || 200
  const timeoutMs = (action.timeout as number) || 5000
  const stableResult = await waitForDomStable(debounceMs, timeoutMs)
  return { success: true, data: stableResult }
}
