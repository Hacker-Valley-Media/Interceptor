import { sendToHost, activeTransport, connectToHost, connectWsChannel } from "./transport"
import {
  SENSITIVE_ACTIONS, verifyTabUrl,
  GROUP_LABEL_RE, ensureNamedGroup, isTabInNamedGroup, isTabInAnyManagedGroup, anyManagedGroupKnown
} from "./tab-group"
import { routeAction } from "./router"
import { needsTab } from "./no-tab-actions"
import { resolveWorkingTabId } from "./resolve-tab"
import { recordGroupActivity } from "./tab-lifecycle"

export const MESSAGE_QUEUE_CAP = 50
export const messageQueue: Array<{
  id?: string
  action?: { type: string; [key: string]: unknown }
  tabId?: number
}> = []

const EXT_REQUEST_TIMEOUT_MS = 180_000
const EXT_LONG_REQUEST_TIMEOUT_MS = 600_000
export const pendingRequests = new Map<string, {
  action: string
  tabId?: number
  timestamp: number
  timer: ReturnType<typeof setTimeout>
  viaWs?: boolean
}>()

export type GroupDispatchScope = { label: string | undefined; soft: boolean; hard: boolean }

/** Pure group-gate decision shared by dispatch and its behavior tests. */
export function resolveGroupDispatchScope(action: { [key: string]: unknown }): GroupDispatchScope {
  const label = typeof action.group === "string" && action.group.length > 0
    ? action.group
    : undefined
  const soft = label !== undefined && action.groupSoft === true
  return { label, soft, hard: label !== undefined && !soft && action.anyTab !== true }
}

/**
 * Resolve the explicit-target membership gate to an error string instead of
 * allowing a stale chrome tab lookup to escape before the daemon response is
 * sent. Returning null means the target passed the gate.
 */
export async function managedTabGateError(
  tabId: number,
  groupLabel: string | undefined,
  groupHard: boolean
): Promise<string | null> {
  try {
    if (groupHard) {
      const inNamed = await isTabInNamedGroup(tabId, groupLabel!)
      return inNamed
        ? null
        : `tab ${tabId} is not in group '${groupLabel}' — pass the owning group, or --any-tab to bypass`
    }
    const inAny = await isTabInAnyManagedGroup(tabId)
    return !inAny && anyManagedGroupKnown()
      ? `tab ${tabId} is not in the interceptor group — use 'interceptor tab new' to create managed tabs`
      : null
  } catch {
    const groupArg = groupHard && groupLabel ? ` --group ${groupLabel}` : ""
    return `tab ${tabId} is unavailable; run 'interceptor tabs${groupArg}' to refresh tab IDs and retry`
  }
}

// the auto-target is per-group. Grouped requests use "activeTabId:<label>"
// so concurrent agents on one context never clobber each other's target; the bare
// "activeTabId" key keeps serving ungrouped requests exactly as before.
function activeTabKey(group?: string): string {
  return group ? `activeTabId:${group}` : "activeTabId"
}

async function getActiveTabId(group?: string): Promise<number | undefined> {
  const storage = chrome.storage as typeof chrome.storage & { session?: chrome.storage.StorageArea }
  const area = storage.session ?? chrome.storage.local
  const key = activeTabKey(group)
  const stored = await area.get(key) as Record<string, number | undefined>
  return stored[key]
}

async function setActiveTabId(tabId: number, group?: string): Promise<void> {
  const storage = chrome.storage as typeof chrome.storage & { session?: chrome.storage.StorageArea }
  const area = storage.session ?? chrome.storage.local
  await area.set({ [activeTabKey(group)]: tabId })
}

export function drainMessageQueue(): void {
  while (messageQueue.length > 0) {
    const queued = messageQueue.shift()!
    handleDaemonMessage(queued)
  }
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

  const requestTimeoutMs = msg.action.type === "binary_sink_save"
    ? EXT_LONG_REQUEST_TIMEOUT_MS
    : EXT_REQUEST_TIMEOUT_MS
  const requestTimer = setTimeout(() => {
    const req = pendingRequests.get(msg.id!)
    pendingRequests.delete(msg.id!)
    sendToHost({ id: msg.id, result: { success: false, error: "extension timeout" } }, req?.viaWs)
  }, requestTimeoutMs)

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
  // Tab-targeted actions name their target tab in `action.tabId` — the CLI puts
  // the `tab close <id>` / `tab switch <id>` argument there, while the top-level
  // `msg.tabId` only carries the global `--tab` override. Without honoring the
  // explicit target here, resolution below falls through to the active tab, so a
  // tab-targeted request group-validates and operates on whatever tab is
  // foregrounded: `tab close <id>` fails with "tab <active-id> is not in the
  // interceptor group" and leaves <id> open, and switch-then-close acknowledges
  // while the tab survives. The explicit target wins over `--tab`: the tab
  // handlers act on `action.tabId` whenever it is present, so the gate below
  // must validate that same tab, never a different one.
  let tabId = resolveWorkingTabId(msg.tabId, action.tabId)

  const fail = (error: string): void => {
    clearTimeout(requestTimer)
    pendingRequests.delete(msg.id!)
    sendToHost({ id: msg.id, result: { success: false, error } }, respondViaWs)
  }

  // per-request group scope rides inside the action payload.
  const { label: groupLabel, soft: groupSoft, hard: groupHard } = resolveGroupDispatchScope(action)
  if (groupLabel && !GROUP_LABEL_RE.test(groupLabel)) {
    fail(`invalid group label '${groupLabel}' — must match [A-Za-z0-9_-]{1,32}`)
    return
  }
  // A soft group was auto-minted by the CLI from the caller's session id.
  // Nobody asked for isolation. It homes tab creation, policy reuse and the
  // idle sweep, but must never become a hard isolation gate: empty-group
  // resolution falls back to the active tab (as ungrouped requests always
  // have), and explicit --tab targets are gated like ungrouped requests.
  if (!tabId && needsTab(action.type)) {
    tabId = await getActiveTabId(groupLabel)
    if (tabId && groupHard) {
      // Stored per-group target may be dead (tab closed outside group_close) or
      // no longer a member of the group; validate MEMBERSHIP (not mere existence)
      // and fall through to the group's own tabs otherwise — this also self-heals
      // a stale key.
      let stillInGroup = false
      try { stillInGroup = await isTabInNamedGroup(tabId, groupLabel!) } catch {}
      if (!stillInGroup) tabId = undefined
    } else if (tabId && groupSoft) {
      // Automatic scope is not an isolation boundary: the session's targeting
      // chain survives as long as the tab EXISTS, whichever group holds it
      // (it may legitimately point at a fallback-resolved default-group tab).
      try { await chrome.tabs.get(tabId) } catch { tabId = undefined }
    }
  }

  if (!tabId && needsTab(action.type) && groupLabel) {
    // Grouped requests resolve ONLY within their group — never the browser-active
    // tab, which is frequently another agent's (the cross-agent bleed this feature
    // exists to prevent).
    const groupId = await ensureNamedGroup(groupLabel)
    if (groupId !== -1) {
      const groupTabs = await chrome.tabs.query({ groupId })
      const candidate = groupTabs
        .filter(t => typeof t.id === "number")
        .sort((a, b) => (b.id as number) - (a.id as number))[0]
      tabId = candidate?.id
    }
    if (!tabId && groupHard) {
      // Explicitly-grouped requests resolve only within their group. Soft
      // scope (or --any-tab) falls through to the active-tab path below
      // instead — that IS the pre-derivation behavior for a bare call, and
      // hard-failing here broke read-the-user's-tab workflows.
      fail(`group '${groupLabel}' has no tabs — open one with 'interceptor open <url> --group ${groupLabel}', pass --any-tab to target the active tab, or set INTERCEPTOR_GROUP= (empty) to opt out of group scoping`)
      return
    }
  }

  if (!tabId && needsTab(action.type)) {
    // No pre-gate persist here: the post-gate persist below is the only
    // auto-target write, so a request the group gate rejects (e.g. the
    // browser-active tab is unmanaged) can never poison the stored target.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
    tabId = activeTab?.id
  }

  if (!tabId && needsTab(action.type)) {
    fail("no active tab")
    return
  }

  if (tabId && needsTab(action.type) && !action.anyTab) {
    const membershipError = await managedTabGateError(tabId, groupLabel, groupHard)
    if (membershipError) {
      fail(membershipError)
      return
    }
  }

  // Only accepted tab activity refreshes the idle timer. Invalid labels,
  // empty hard groups, stale ids, and rejected cross-group targets must not
  // keep a group alive. Meta polls such as status/group_list never count.
  if (needsTab(action.type) || action.type === "tab_create") recordGroupActivity(groupLabel ?? "")

  // Persist the auto-target only AFTER the group gate has passed — a rejected
  // cross-group request must never poison another group's (or the global)
  // auto-target key.
  if (tabId) setActiveTabId(tabId, groupLabel)

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
