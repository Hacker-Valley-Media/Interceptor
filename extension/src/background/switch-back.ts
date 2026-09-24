// `tab switch` back to the user's tab.
//
// `tab switch <managed>` replaces whatever the window was showing, and the tab
// it replaced is usually the user's own, unmanaged tab, which the group gate
// then refuses as a switch target. So an agent that foregrounds a tab for a
// trusted click could not give the view back. The tab_switch handler records
// what the window was showing; the dispatcher lets exactly that tab through
// the gate once, and never persists it as an auto-target.
import { isTabInAnyManagedGroup } from "./tab-group"

export function priorActiveKey(windowId: number): string {
  return `priorActive:${windowId}`
}

function sessionArea(): chrome.storage.StorageArea {
  const storage = chrome.storage as typeof chrome.storage & { session?: chrome.storage.StorageArea }
  return storage.session ?? chrome.storage.local
}

/**
 * Before activating `targetId`: remember the tab its window was showing, but
 * only when that tab is the user's (unmanaged). A managed prior passes the
 * gate on its own, and recording it would overwrite the user's tab after a
 * managed-to-managed switch, which is exactly when the way back matters.
 * `isManaged` is injectable for tests; production uses the group registry.
 */
export async function rememberPriorActive(
  targetId: number,
  isManaged: (tabId: number) => Promise<boolean> = isTabInAnyManagedGroup
): Promise<void> {
  try {
    const target = await chrome.tabs.get(targetId)
    const [prior] = await chrome.tabs.query({ active: true, windowId: target.windowId })
    if (typeof prior?.id !== "number" || prior.id === targetId) return
    let managed = false
    try { managed = await isManaged(prior.id) } catch {}
    if (managed) return
    await sessionArea().set({ [priorActiveKey(target.windowId)]: prior.id })
  } catch {}
}

/**
 * One-shot: true when `tabId` is the tab that was showing in its window before
 * Interceptor's own switch. Clears the record so the exemption is not reusable.
 */
export async function consumeSwitchBack(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId)
    const key = priorActiveKey(tab.windowId)
    const stored = await sessionArea().get(key) as Record<string, number | undefined>
    if (stored[key] !== tabId) return false
    await sessionArea().remove(key)
    return true
  } catch {
    return false
  }
}
