// Raw CDP sessions on browser tabs.
//
// A local client (the CLI, or a program on the daemon's IPC socket) sends any
// CDP method to a tab and receives that tab's CDP events. A session keeps
// chrome.debugger attached between calls, which Page.startScreencast and
// Fetch.enable need; without one a command attaches, runs and detaches.
//
// Two things hold a session open: an explicit attach, and an event
// subscription. A subscription is a lease the daemon renews while its client
// is connected, so a client or daemon that goes away never leaves a debugger
// attached. An explicit attach stays until the client detaches.
//
// Network capture and request overrides share the attachment. Events reach
// them through their own chrome.debugger listener (cdp.ts); this module adds a
// second listener and consumes nothing.

import {
  acquireDebugger, releaseDebugger, debuggerAttached, rawFetchOwners
} from "./cdp"
import { networkCaptureConfigs, networkOverrideConfigs } from "./network-capture"
import { sendToHost } from "./transport"

export const RAW_CDP_ACTIONS = new Set([
  "cdp_tab_attach", "cdp_tab_detach", "cdp_tab_send", "cdp_tab_status",
  "cdp_tab_subscribe", "cdp_tab_unsubscribe", "cdp_tab_renew"
])

/** How long a subscription lives without a renewal from the daemon. */
export const SUBSCRIPTION_TTL_MS = 35_000
const SWEEP_INTERVAL_MS = 10_000

type RawSession = { explicit: boolean; subscriptions: Set<string> }
type Subscription = { id: string; tabId: number; filter: string[]; holds: boolean; expiresAt: number }

const sessions = new Map<number, RawSession>()
const subscriptions = new Map<string, Subscription>()
// Tabs opened from a tab in a session (OAuth popups), keyed to that tab.
const followedTabs = new Map<number, number>()
let sweepTimer: ReturnType<typeof setInterval> | null = null

export function hasDebuggerApi(): boolean {
  return typeof chrome !== "undefined" && typeof chrome.debugger?.attach === "function"
}

// The WebSocket channel carries large frames with one hop less.
let postToDaemon = (msg: unknown): void => {
  if (sendToHost(msg, true) === "failed") sendToHost(msg)
}

function post(tabId: number, ids: string[], method: string, params: unknown, sessionId?: string): void {
  if (ids.length === 0) return
  // "type" stays the first key: the daemon recognizes event frames by their
  // prefix so a screencast does not write one log line per frame.
  postToDaemon({ type: "cdp_event", subscriptions: ids, tabId, method, params, ...(sessionId ? { sessionId } : {}) })
}

function subscribersOf(tabId: number, method?: string): string[] {
  const ids: string[] = []
  for (const sub of subscriptions.values()) {
    if (sub.tabId !== tabId) continue
    if (method && sub.filter.length > 0 && !sub.filter.some(prefix => method.startsWith(prefix))) continue
    ids.push(sub.id)
  }
  return ids
}

/** Session events are not CDP events, so a method filter never drops them. */
function postLifecycle(tabId: number, method: string, params: Record<string, unknown>): void {
  post(tabId, subscribersOf(tabId), method, params)
}

async function openSession(tabId: number): Promise<RawSession> {
  const existing = sessions.get(tabId)
  if (existing) return existing
  await acquireDebugger(tabId)
  // Another call may have opened the session while this one attached.
  const raced = sessions.get(tabId)
  if (raced) {
    await releaseDebugger(tabId)
    return raced
  }
  const session: RawSession = { explicit: false, subscriptions: new Set() }
  sessions.set(tabId, session)
  return session
}

async function stopFetchInterception(tabId: number): Promise<void> {
  if (!rawFetchOwners.delete(tabId)) return
  // A paused request with nobody left to continue it stalls the tab's network.
  try { await chrome.debugger.sendCommand({ tabId }, "Fetch.disable") } catch {}
}

async function closeSession(tabId: number): Promise<void> {
  if (!sessions.delete(tabId)) return
  for (const [popup, root] of followedTabs) if (root === tabId) followedTabs.delete(popup)
  if (debuggerAttached.has(tabId)) {
    await stopFetchInterception(tabId)
    // The attachment may outlive the session when network capture shares it.
    try { await chrome.debugger.sendCommand({ tabId }, "Page.stopScreencast") } catch {}
  }
  await releaseDebugger(tabId)
}

async function closeSessionIfUnheld(tabId: number): Promise<void> {
  const session = sessions.get(tabId)
  if (session && !session.explicit && session.subscriptions.size === 0) await closeSession(tabId)
}

export async function attachTab(tabId: number): Promise<{ tabId: number; alreadyAttached: boolean }> {
  const alreadyAttached = sessions.get(tabId)?.explicit === true
  const session = await openSession(tabId)
  session.explicit = true
  return { tabId, alreadyAttached }
}

/** End the tab's session for every holder. Subscriptions stay registered and stop holding. */
export async function detachTab(tabId: number): Promise<{ tabId: number; detached: boolean }> {
  const session = sessions.get(tabId)
  if (!session) return { tabId, detached: false }
  postLifecycle(tabId, "Interceptor.detached", { reason: "client_detached" })
  for (const id of session.subscriptions) {
    const sub = subscriptions.get(id)
    if (sub) sub.holds = false
  }
  await closeSession(tabId)
  return { tabId, detached: true }
}

export async function sendToTab(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string
): Promise<unknown> {
  if (method === "Fetch.enable" && (networkOverrideConfigs.get(tabId)?.length || 0) > 0) {
    throw new Error(`tab ${tabId} has request override rules, which use Fetch interception. Clear them ('interceptor override clear') before a raw session enables Fetch.`)
  }
  // Network capture needs the domain; the client's disable is a no-op for it.
  if (method === "Network.disable" && networkCaptureConfigs.get(tabId)?.enabled) return {}
  const target = sessionId ? { tabId, sessionId } : { tabId }
  if (!sessions.has(tabId)) {
    await acquireDebugger(tabId)
    try {
      return await chrome.debugger.sendCommand(target, method, params)
    } finally {
      await releaseDebugger(tabId)
    }
  }
  const result = await chrome.debugger.sendCommand(target, method, params)
  if (!sessionId && sessions.has(tabId)) {
    if (method === "Fetch.enable") rawFetchOwners.add(tabId)
    if (method === "Fetch.disable") rawFetchOwners.delete(tabId)
  }
  return result
}

function ensureSweep(): void {
  if (sweepTimer || subscriptions.size === 0) return
  sweepTimer = setInterval(() => { void sweepExpiredSubscriptions() }, SWEEP_INTERVAL_MS)
}

export async function subscribeTab(
  tabId: number,
  id: string,
  filter: string[],
  attach: boolean
): Promise<{ subscription: string; tabId: number; attached: boolean }> {
  if (attach) {
    const session = await openSession(tabId)
    session.subscriptions.add(id)
  }
  subscriptions.set(id, { id, tabId, filter, holds: attach, expiresAt: Date.now() + SUBSCRIPTION_TTL_MS })
  ensureSweep()
  return { subscription: id, tabId, attached: debuggerAttached.has(tabId) }
}

export async function unsubscribe(id: string): Promise<boolean> {
  const sub = subscriptions.get(id)
  if (!sub) return false
  subscriptions.delete(id)
  if (subscriptions.size === 0 && sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  const session = sessions.get(sub.tabId)
  if (session?.subscriptions.delete(id)) {
    // Nobody can receive Fetch.requestPaused for this tab any more.
    if (session.subscriptions.size === 0) await stopFetchInterception(sub.tabId)
    await closeSessionIfUnheld(sub.tabId)
  }
  return true
}

/** Extend the leases the daemon still has clients for; returns the ids this side no longer knows. */
export function renewSubscriptions(ids: string[], now = Date.now()): string[] {
  const gone: string[] = []
  for (const id of ids) {
    const sub = subscriptions.get(id)
    if (sub) sub.expiresAt = now + SUBSCRIPTION_TTL_MS
    else gone.push(id)
  }
  return gone
}

export async function sweepExpiredSubscriptions(now = Date.now()): Promise<void> {
  for (const sub of [...subscriptions.values()]) {
    if (sub.expiresAt <= now) await unsubscribe(sub.id)
  }
}

export function sessionStatus(): Array<Record<string, unknown>> {
  const tabIds = new Set<number>([...sessions.keys(), ...[...subscriptions.values()].map(s => s.tabId)])
  return [...tabIds].map(tabId => {
    const session = sessions.get(tabId)
    return {
      tabId,
      attached: debuggerAttached.has(tabId),
      session: !!session,
      explicit: session?.explicit === true,
      subscriptions: subscribersOf(tabId).length,
      fetchOwned: rawFetchOwners.has(tabId),
      sharedWithCapture: !!networkCaptureConfigs.get(tabId)?.enabled
    }
  })
}

/**
 * A tab opened from a tab in a session, while that session lasts. The group
 * gate lets raw CDP reach it so a client can follow an OAuth popup, which is
 * never a managed tab.
 */
export function isFollowedPopup(tabId: number): boolean {
  const root = followedTabs.get(tabId)
  return root !== undefined && sessions.has(root)
}

export function registerRawCdpListeners(): void {
  if (!hasDebuggerApi()) return

  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId
    if (!tabId) return
    post(tabId, subscribersOf(tabId, method), method, params, (source as { sessionId?: string }).sessionId)
  })

  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId
    // A child session (iframe, worker) ending is a CDP event, not the tab's detach.
    if (!tabId || (source as { sessionId?: string }).sessionId) return
    postLifecycle(tabId, "Interceptor.detached", { reason })
    const session = sessions.get(tabId)
    if (!session) return
    sessions.delete(tabId)
    for (const id of session.subscriptions) {
      const sub = subscriptions.get(id)
      if (sub) sub.holds = false
    }
    for (const [popup, root] of followedTabs) if (root === tabId) followedTabs.delete(popup)
  })

  chrome.tabs.onCreated.addListener((tab) => {
    const opener = tab.openerTabId
    if (typeof tab.id !== "number" || typeof opener !== "number") return
    const root = sessions.has(opener) ? opener : followedTabs.get(opener)
    if (root !== undefined) followedTabs.set(tab.id, root)
    postLifecycle(root ?? opener, "Interceptor.tabCreated", {
      tabId: tab.id,
      openerTabId: opener,
      url: tab.pendingUrl || tab.url || "",
      windowId: tab.windowId
    })
  })

  chrome.tabs.onRemoved.addListener((tabId) => {
    const root = followedTabs.get(tabId)
    postLifecycle(tabId, "Interceptor.tabRemoved", { tabId })
    if (root !== undefined) postLifecycle(root, "Interceptor.tabRemoved", { tabId })
    followedTabs.delete(tabId)
  })
}

/** Test-only: send event frames to `sink` instead of the daemon. */
export function setCdpEventSinkForTesting(sink: (msg: unknown) => void): void {
  postToDaemon = sink
}
