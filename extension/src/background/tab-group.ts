export let interceptorGroupId: number | null = null

export async function ensureInterceptorGroup(): Promise<number> {
  if (interceptorGroupId !== null) {
    try {
      await chrome.tabGroups.get(interceptorGroupId)
      return interceptorGroupId
    } catch {
      interceptorGroupId = null
    }
  }
  const groups = await chrome.tabGroups.query({ title: "interceptor" })
  if (groups.length > 0) {
    interceptorGroupId = groups[0].id
    return interceptorGroupId
  }
  return -1
}

export async function addTabToInterceptorGroup(tabId: number): Promise<number> {
  let groupId = await ensureInterceptorGroup()
  if (groupId === -1) {
    groupId = await chrome.tabs.group({ tabIds: tabId })
    await chrome.tabGroups.update(groupId, { title: "interceptor", color: "cyan" })
    interceptorGroupId = groupId
  } else {
    await chrome.tabs.group({ tabIds: tabId, groupId })
  }
  return groupId
}

export async function isTabInInterceptorGroup(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId)
  if (interceptorGroupId === null) await ensureInterceptorGroup()
  return interceptorGroupId !== null && tab.groupId === interceptorGroupId
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
    if (interceptorGroupId === null) return
    try {
      const tabs = await chrome.tabs.query({ groupId: interceptorGroupId })
      if (tabs.length === 0) interceptorGroupId = null
    } catch {
      interceptorGroupId = null
    }
  })
}
