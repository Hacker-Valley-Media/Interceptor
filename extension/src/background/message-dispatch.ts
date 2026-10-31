import { sendToHost, activeTransport, connectToHost, connectWsChannel } from "./transport"
import {
  SENSITIVE_ACTIONS, verifyTabUrl, hasTabGroupApi, hydrateNamedGroups, readoptNamedGroups, labelForGroupId,
  GROUP_LABEL_RE, ensureNamedGroup, isTabInNamedGroup, isTabInAnyManagedGroup, anyManagedGroupKnown
} from "./tab-group"
import { routeAction } from "./router"
import { needsTab } from "./no-tab-actions"
import { isReadAction, TAB_FREE_ACTIONS } from "./read-actions"
import { resolveWorkingTabId } from "./resolve-tab"
import { recordGroupActivity } from "./tab-lifecycle"
import { consumeSwitchBack } from "./switch-back"

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

/**
 * A soft session group with no tab of its own falls back
 * to the tab the user is viewing. A read may still use it (and says so);
 * anything else refuses, so input never lands on the user's tab.
 */
export function softFallbackError(actionType: string, label: string, tabId: number, host: string): string | null {
  if (isReadAction(actionType)) return null
  return `your session group '${label}' has no tabs, so this would act on the tab the user is viewing (${tabId}, ${host}). Open a page first (interceptor open <url>), or pass --any-tab if the user asked you to act on that tab.`
}

/** A soft fallback read that the managed-tab gate refused (other groups are open). */
export function softFallbackGateError(label: string, tabId: number, host: string): string {
  return `your session group '${label}' has no tabs, and the tab the user is viewing (${tabId}, ${host}) is not an Interceptor tab. Open a page first (interceptor open <url>), or pass --any-tab if the user asked you to read that tab.`
}

export function softFallbackNote(tabId: number, host: string): string {
  return `reading the active tab ${tabId} (${host}), which is not one of this session's tabs; run 'interceptor open <url>' to work in your own tab`
}

/** Automatic session labels (cli/parse.ts deriveSessionGroupLabel). */
export const SESSION_LABEL_RE = /^s-[0-9a-f]{16}$/

/**
 * A caller with a session identity may not close another
 * session's group or tabs without --any-tab. `owner` is the label of the
 * group being closed (or holding the tab being closed).
 */
export function foreignSessionCloseError(kind: "group" | "tab", owner: string | null, caller: string, target: string | number): string | null {
  if (!owner || owner === caller || !SESSION_LABEL_RE.test(owner)) return null
  return kind === "group"
    ? `group '${owner}' belongs to another agent session that may still be working (yours is '${caller}'). Leave it. Close your own with 'interceptor group close'; pass --any-tab only if the user named this group`
    : `tab ${target} belongs to another agent session's group '${owner}' (yours is '${caller}'). Leave it to that agent; pass --any-tab only if the user named this tab`
}

async function tabHost(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab.url) return "unknown page"
    // A hostless URL such as data: is page-controlled text, and this ends up
    // in a warning that sits outside the MCP fence.
    const url = new URL(tab.url)
    return url.host || url.protocol
  } catch {
    return "unknown page"
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

/** Issue #162: "no active tab" on a windowless profile should say so and name the fix. */
export function noActiveTabError(windowCount: number | null): string {
  return windowCount === 0
    ? "no browser window is open in this profile — 'interceptor open <url>' creates one in the background"
    : "no active tab"
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

  let softFallback: string | undefined
  let softFallbackRefusal: string | undefined
  let softFallbackTab = false
  if (!tabId && needsTab(action.type)) {
    // No pre-gate persist here: the post-gate persist below is the only
    // auto-target write, so a request the group gate rejects (e.g. the
    // browser-active tab is unmanaged) can never poison the stored target.
    // A profile with zero windows answers this with [] on current Chrome and
    // rejects with "No current window" on older builds (issue #162); either
    // way the useful error names the fix, so both paths go through
    // noActiveTabError below.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [] as chrome.tabs.Tab[])
    tabId = activeTab?.id
    // A soft session that reaches this point has no tab of its own. Browsers
    // without tab groups (Safari) cannot give a session its own tab, so they
    // keep the old fallback.
    if (tabId && groupSoft && hasTabGroupApi()) {
      // The user's tab is never saved as the session's target, even when
      // --any-tab authorized this one call: the next call without it must
      // not inherit the user's tab through the stored-target path.
      softFallbackTab = true
      if (action.anyTab !== true && !TAB_FREE_ACTIONS.has(action.type)) {
        const host = await tabHost(tabId)
        const refusal = softFallbackError(action.type, groupLabel!, tabId, host)
        if (refusal) {
          fail(refusal)
          return
        }
        softFallback = softFallbackNote(tabId, host)
        softFallbackRefusal = softFallbackGateError(groupLabel!, tabId, host)
      }
    }
  }

  if (!tabId && needsTab(action.type)) {
    const windows = await chrome.windows.getAll().catch(() => null)
    fail(noActiveTabError(windows ? windows.length : null))
    return
  }

  // `window new --tab` moves a tab, so it passes the same gate as any verb on it.
  const moveTabId = action.type === "window_create" && typeof action.moveTabId === "number" ? action.moveTabId : undefined
  if (moveTabId !== undefined) tabId = moveTabId

  let switchBack = false
  if (tabId && (needsTab(action.type) || moveTabId !== undefined) && !action.anyTab) {
    const membershipError = await managedTabGateError(tabId, groupLabel, groupHard)
    if (membershipError) {
      // One exemption: `tab switch` back to the tab the window was
      // showing before Interceptor's own switch. The user's tab is never
      // persisted as an auto-target below.
      switchBack = action.type === "tab_switch" && await consumeSwitchBack(tabId, groupLabel)
      if (!switchBack) {
        fail(softFallbackRefusal ?? membershipError)
        return
      }
    }
  }

  // Closing another session's group or tab needs --any-tab.
  if (groupSoft && action.anyTab !== true && hasTabGroupApi()
      && (action.type === "group_close" || action.type === "tab_close" || moveTabId !== undefined)) {
    let refusal: string | null = null
    if (action.type === "group_close") {
      const label = typeof action.label === "string" ? action.label : null
      if (label && await ensureNamedGroup(label) !== -1) refusal = foreignSessionCloseError("group", label, groupLabel!, label)
    } else {
      const closeId = moveTabId ?? ((action.tabId as number) || tabId)
      try {
        const tab = await chrome.tabs.get(closeId!)
        // A restart empties the session registry; titles still name the group.
        await readoptNamedGroups()
        refusal = foreignSessionCloseError("tab", labelForGroupId(tab.groupId), groupLabel!, closeId!)
      } catch {}
    }
    if (refusal) {
      fail(refusal)
      return
    }
  }

  // Persist the auto-target only AFTER the group gate has passed — a rejected
  // cross-group request must never poison another group's (or the global)
  // auto-target key. A soft fallback tab is the user's, never the session's.
  if (tabId && !switchBack && !softFallbackTab && action.keepTarget !== true) setActiveTabId(tabId, groupLabel)

  if (SENSITIVE_ACTIONS.has(action.type) && tabId && action.expectedUrl) {
    const urlErr = await verifyTabUrl(tabId, action.expectedUrl as string)
    if (urlErr) {
      clearTimeout(requestTimer)
      pendingRequests.delete(msg.id)
      sendToHost({ id: msg.id, result: { success: false, error: urlErr, tabId } }, respondViaWs)
      return
    }
  }

  // Only accepted tab activity refreshes the idle timer. Invalid labels,
  // empty hard groups, stale ids, rejected cross-group targets, and stale
  // expected-URL requests must not keep a group alive. Metadata polls such as
  // status/group_list never count.
  if (needsTab(action.type) || action.type === "tab_create") recordGroupActivity(groupLabel ?? "")

  try {
    const result = await routeAction(action, tabId!)
    if (tabId) result.tabId = tabId
    if (softFallback && result.success) result.warning = result.warning ? `${softFallback}; ${result.warning}` : softFallback
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
