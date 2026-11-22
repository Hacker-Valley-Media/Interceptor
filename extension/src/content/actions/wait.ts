import { waitForElement, waitForDomStable } from "../input-simulation"
import { getLastChildListMutation } from "../dom-observer"
import { queryAllDeep } from "../deep-query"

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
let idleTimer: ReturnType<typeof setTimeout> | null = null
// The fuller observer (attributes too) stays up between waits; it goes away
// after this long without a poll, and the next wait reseeds from the
// page-lifetime child-list clock.
export const QUIET_OBSERVER_IDLE_MS = 30_000

function disconnectQuietObserver(): void {
  quietObserver?.disconnect()
  quietObserver = null
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

/**
 * How long the DOM has been quiet. The background holds the clock for
 * `wait_stable` (see waitStable in content-bridge.ts): this answers with
 * performance.now(), which a hidden tab does not throttle.
 *
 * The first poll used to start the clock at "now", so every wait cost the
 * full debounce even on a page that had not changed in minutes (565 of 805
 * waits sat at the 200 ms floor). The clock now starts at the
 * page's last child-list mutation, which dom-observer.ts tracks from
 * content-script load, and the observer survives between waits.
 */
export function handleDomQuiet(action: Action, now = performance.now(), seed = getLastChildListMutation()): ActionResult {
  if (action.stop) {
    // Keep the clock; drop the observer only after a quiet spell with no polls.
    if (quietObserver && !idleTimer) idleTimer = setTimeout(disconnectQuietObserver, QUIET_OBSERVER_IDLE_MS)
    return { success: true }
  }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  if (!quietObserver) {
    mutations = 0
    lastMutation = Math.max(lastMutation, seed)
    quietObserver = new MutationObserver((records) => {
      mutations += records.length
      lastMutation = performance.now()
    })
    quietObserver.observe(document.body ?? document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
  }
  // A child-list change seen by the page-lifetime observer counts too.
  lastMutation = Math.max(lastMutation, getLastChildListMutation())
  return { success: true, data: { quietMs: Math.max(0, now - lastMutation), mutations } }
}

/** Test seam: forget the clock and observer. */
export function resetDomQuietForTest(): void {
  disconnectQuietObserver()
  lastMutation = 0
  mutations = 0
}

/**
 * One look at a wait condition. The
 * background polls this every 100 ms on its own clock, so a hidden tab's
 * throttled timers never stretch a wait.
 *   text      page text contains `text` (case-insensitive)
 *   gone      page text no longer contains `text`
 *   selector  at least `count` (default 1) elements match `selector`
 *   gone_selector  no element matches `selector`
 */
export function handleConditionCheck(action: Action): ActionResult {
  const kind = action.kind as string
  const needle = String(action.text ?? "").toLowerCase()
  const pageText = () => (document.body?.innerText ?? document.documentElement?.textContent ?? "").toLowerCase()
  try {
    switch (kind) {
      case "text": {
        const met = pageText().includes(needle)
        return { success: true, data: { met, observed: met ? `found "${action.text}"` : `"${action.text}" not on the page` } }
      }
      case "gone": {
        const met = !pageText().includes(needle)
        return { success: true, data: { met, observed: met ? `"${action.text}" is not on the page` : `"${action.text}" is still on the page` } }
      }
      case "selector":
      case "gone_selector": {
        const found = queryAllDeep(action.selector as string).length
        const want = typeof action.count === "number" ? action.count : 1
        const met = kind === "selector" ? found >= want : found === 0
        return { success: true, data: { met, observed: `${found} match${found === 1 ? "" : "es"} for ${action.selector}`, count: found } }
      }
      default:
        return { success: false, error: `unknown wait condition '${kind}'` }
    }
  } catch (err) {
    return { success: false, error: `invalid selector '${action.selector}': ${(err as Error).message}` }
  }
}
