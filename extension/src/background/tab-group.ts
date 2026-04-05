export let slopGroupId: number | null = null

export async function ensureSlopGroup(): Promise<number> {
  if (slopGroupId !== null) {
    try {
      await chrome.tabGroups.get(slopGroupId)
      return slopGroupId
    } catch {
      slopGroupId = null
    }
  }
  const groups = await chrome.tabGroups.query({ title: "slop" })
  if (groups.length > 0) {
    slopGroupId = groups[0].id
    return slopGroupId
  }
  return -1
}

export async function addTabToSlopGroup(tabId: number): Promise<number> {
  let groupId = await ensureSlopGroup()
  if (groupId === -1) {
    groupId = await chrome.tabs.group({ tabIds: tabId })
    await chrome.tabGroups.update(groupId, { title: "slop", color: "cyan" })
    slopGroupId = groupId
  } else {
    await chrome.tabs.group({ tabIds: tabId, groupId })
  }
  return groupId
}

export async function isTabInSlopGroup(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId)
  if (slopGroupId === null) await ensureSlopGroup()
  return slopGroupId !== null && tab.groupId === slopGroupId
}

export const SENSITIVE_ACTIONS = new Set([
  "evaluate", "cookies_get", "cookies_set", "cookies_delete",
  "storage_read", "storage_write", "storage_delete"
])

export async function verifyTabUrl(tabId: number, expectedUrl?: string): Promise<string | null> {
  if (!expectedUrl) return null
  const tab = await chrome.tabs.get(tabId)
  if (tab.url && tab.url !== expectedUrl) {
    return `tab URL changed since last state read — expected ${expectedUrl}, got ${tab.url}`
  }
  return null
}

export function registerTabGroupListeners(): void {
  chrome.tabs.onRemoved.addListener(async (_removedTabId) => {
    if (slopGroupId === null) return
    try {
      const tabs = await chrome.tabs.query({ groupId: slopGroupId })
      if (tabs.length === 0) slopGroupId = null
    } catch {
      slopGroupId = null
    }
  })
}
