import { sendToHost, activeTransport, connectToHost, connectWsChannel } from "./transport"
import { isTabInInterceptorGroup, interceptorGroupId, ensureInterceptorGroup, SENSITIVE_ACTIONS, verifyTabUrl } from "./tab-group"
import { routeAction } from "./router"

export const MESSAGE_QUEUE_CAP = 50
export const messageQueue: Array<{
  id?: string
  action?: { type: string; [key: string]: unknown }
  tabId?: number
}> = []

const EXT_REQUEST_TIMEOUT_MS = 180_000
export const pendingRequests = new Map<string, {
  action: string
  tabId?: number
  timestamp: number
  timer: ReturnType<typeof setTimeout>
  viaWs?: boolean
}>()

export function drainMessageQueue(): void {
  while (messageQueue.length > 0) {
    const queued = messageQueue.shift()!
    handleDaemonMessage(queued)
  }
}

export function needsTab(type: string): boolean {
  const noTabActions = new Set([
    "status", "reload_extension", "tab_create", "tab_list", "window_create", "window_list", "window_get_all",
    "history_search", "history_delete_all", "bookmark_tree", "bookmark_search",
    "bookmark_create", "downloads_search", "browsing_data_remove",
    "session_list", "session_restore", "notification_create", "notification_clear",
    "search_query", "monitor_status", "monitor_start", "monitor_pause", "monitor_resume",
    "monitor_stop"
  ])
  return !noTabActions.has(type)
}

export async function handleDaemonMessage(msg: {
  id?: string
  action?: { type: string; [key: string]: unknown }
  tabId?: number
}): Promise<void> {
  if (!msg.action || !msg.id) return

  if (activeTransport === "none") {
    if (messageQueue.length >= MESSAGE_QUEUE_CAP) {
      const evicted = messageQueue.shift()!
      if (evicted.id) {
        sendToHost({ id: evicted.id, result: { success: false, error: "message queue full — daemon not connected" } })
      }
    }
    if (messageQueue.length >= MESSAGE_QUEUE_CAP / 2) {
      console.warn(`message queue at ${messageQueue.length}/${MESSAGE_QUEUE_CAP}`)
    }
    messageQueue.push(msg)
    connectToHost()
    connectWsChannel()
    return
  }

  const respondViaWsEarly = !!(msg as any)._viaWs

  if (pendingRequests.has(msg.id)) {
    sendToHost({ id: msg.id, result: { success: false, error: "duplicate request ID" } }, respondViaWsEarly)
    return
  }

  const requestTimer = setTimeout(() => {
    const req = pendingRequests.get(msg.id!)
    pendingRequests.delete(msg.id!)
    sendToHost({ id: msg.id, result: { success: false, error: "extension timeout" } }, req?.viaWs)
  }, EXT_REQUEST_TIMEOUT_MS)

  const startTime = Date.now()
  const shortId = msg.id.slice(0, 8)
  const respondViaWs = !!(msg as any)._viaWs
  console.log(`[${shortId}] executing ${msg.action.type} (via ${respondViaWs ? "ws" : "native"})`)
  pendingRequests.set(msg.id, {
    action: msg.action.type,
    tabId: msg.tabId,
    timestamp: startTime,
    timer: requestTimer,
    viaWs: respondViaWs
  })

  const action = msg.action
  let tabId = msg.tabId

  if (!tabId && needsTab(action.type)) {
    const stored = await chrome.storage.session.get("activeTabId") as { activeTabId?: number }
    tabId = stored.activeTabId
  }

  if (!tabId && needsTab(action.type)) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
    tabId = activeTab?.id
    if (tabId) chrome.storage.session.set({ activeTabId: tabId })
  }

  if (!tabId && needsTab(action.type)) {
    clearTimeout(requestTimer)
    pendingRequests.delete(msg.id)
    sendToHost({ id: msg.id, result: { success: false, error: "no active tab" } }, respondViaWs)
    return
  }

  if (tabId) chrome.storage.session.set({ activeTabId: tabId })

  if (tabId && needsTab(action.type) && !action.anyTab) {
    const inGroup = await isTabInInterceptorGroup(tabId)
    if (!inGroup && interceptorGroupId !== null) {
      clearTimeout(requestTimer)
      pendingRequests.delete(msg.id)
      sendToHost({
        id: msg.id,
        result: {
          success: false,
          error: `tab ${tabId} is not in the interceptor group — use 'interceptor tab new' to create managed tabs`
        }
      }, respondViaWs)
      return
    }
  }

  if (SENSITIVE_ACTIONS.has(action.type) && tabId && action.expectedUrl) {
    const urlErr = await verifyTabUrl(tabId, action.expectedUrl as string)
    if (urlErr) {
      clearTimeout(requestTimer)
      pendingRequests.delete(msg.id)
      sendToHost({ id: msg.id, result: { success: false, error: urlErr, tabId } }, respondViaWs)
      return
    }
  }

  try {
    const result = await routeAction(action, tabId!)
    if (tabId) result.tabId = tabId
    clearTimeout(requestTimer)
    pendingRequests.delete(msg.id)
    console.log(`[${shortId}] complete ${action.type} ${Date.now() - startTime}ms`)
    sendToHost({ id: msg.id, result }, respondViaWs)
  } catch (err) {
    clearTimeout(requestTimer)
    pendingRequests.delete(msg.id)
    console.error(`[${shortId}] error ${action.type} ${Date.now() - startTime}ms: ${(err as Error).message}`)
    sendToHost({ id: msg.id, result: { success: false, error: (err as Error).message, tabId } }, respondViaWs)
  }
}
