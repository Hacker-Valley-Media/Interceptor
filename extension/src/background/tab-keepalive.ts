// `tab keepalive <id>`: make a hidden managed tab read as visible and
// run its animation frames, so a page that gates rendering on visibility draws
// without `tab switch`. The page-side hooks live in ../inject-keepalive.ts and
// are installed inert on every page; this side flips them per tab and keeps a
// one-time flag so the state survives navigation in that tab.
//
// Deliberately NOT a heartbeat: the flag is written once by the command that
// set it, plays no audio, and touches none of the tab-lifecycle sweep guards
// (pinned / audible / active), so an idle keep-alive tab is still swept.
import { IK_KEEPALIVE } from "../inject-keys"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export const KEEPALIVE_NOTE =
  "the page now reads visible and its animation-frame callbacks run on a timer while the tab is hidden; " +
  "IntersectionObserver and ResizeObserver callbacks still wait for a real paint, and Chromium keeps its " +
  "background timer rate (about one wake-up per second after 10 s hidden)"

export function keepaliveKey(tabId: number): string {
  return `keepalive:${tabId}`
}

// storage.session is MV3-only; the MV2 package shares this module.
function sessionArea(): chrome.storage.StorageArea {
  const storage = chrome.storage as typeof chrome.storage & { session?: chrome.storage.StorageArea }
  return storage.session ?? chrome.storage.local
}

export async function isKeepaliveTab(tabId: number): Promise<boolean> {
  const key = keepaliveKey(tabId)
  const stored = await sessionArea().get(key) as Record<string, boolean | undefined>
  return stored[key] === true
}

/**
 * Flip the page-side state in every frame of the tab. `installed` is false when
 * the MAIN-world hooks are absent in the main frame (a chrome:// page, or a
 * page that loaded before the extension did).
 */
export async function applyKeepalive(tabId: number, on: boolean, frameId?: number): Promise<{ installed: boolean }> {
  const scripting = (chrome as typeof chrome & { scripting?: typeof chrome.scripting }).scripting
  if (!scripting || typeof scripting.executeScript !== "function") {
    throw new Error("tab keepalive needs chrome.scripting (MV3); this browser package does not provide it")
  }
  const results = await scripting.executeScript({
    target: frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] },
    world: "MAIN" as chrome.scripting.ExecutionWorld,
    injectImmediately: true,
    args: [IK_KEEPALIVE, on],
    // Serialised and recompiled in the page: no lexical scope, so the symbol
    // is re-derived from the string (see inject-keys.ts).
    func: (key: string, enable: boolean) => {
      const state = (window as unknown as Record<symbol, { set?: (v: boolean) => boolean } | undefined>)[Symbol.for(key)]
      if (!state || typeof state.set !== "function") return false
      state.set(enable)
      return true
    }
  })
  const main = results.find(r => r.frameId === 0) ?? results[0]
  return { installed: main?.result === true }
}

export async function setKeepalive(tabId: number, on: boolean): Promise<ActionResult> {
  let applied: { installed: boolean }
  try {
    applied = await applyKeepalive(tabId, on)
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
  if (!applied.installed) {
    return {
      success: false,
      error: `keep-alive hooks are not installed in tab ${tabId} (a chrome:// page, or a page loaded before the extension) — reload the tab and retry`
    }
  }
  if (on) await sessionArea().set({ [keepaliveKey(tabId)]: true })
  else await sessionArea().remove(keepaliveKey(tabId))
  return {
    success: true,
    data: { tabId, keepalive: on, note: on ? KEEPALIVE_NOTE : "the page reads its real visibility again" }
  }
}

/**
 * Re-apply after every navigation in a flagged tab, frame by frame (an iframe
 * that navigates later than the command would otherwise stay inert); forget
 * closed tabs.
 */
export function registerKeepaliveListeners(): void {
  const nav = (chrome as typeof chrome & { webNavigation?: typeof chrome.webNavigation }).webNavigation
  nav?.onCommitted?.addListener(async (details) => {
    try {
      if (await isKeepaliveTab(details.tabId)) await applyKeepalive(details.tabId, true, details.frameId)
    } catch {}
  })
  chrome.tabs?.onRemoved?.addListener((tabId) => {
    void Promise.resolve(sessionArea().remove(keepaliveKey(tabId))).catch(() => undefined)
  })
}
