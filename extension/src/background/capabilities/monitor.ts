import { sendToHost } from "../transport"
import { ensureInterceptorGroup, isTabInInterceptorGroup, interceptorGroupId } from "../tab-group"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

interface SessionRecord {
  sessionId: string
  tabId: number
  startedAt: number
  instruction?: string
  paused: boolean
  seq: number
  counts: { evt: number; mut: number; net: number; nav: number }
  url?: string
}

const sessions = new Map<string, SessionRecord>()
const activeSessionByTab = new Map<number, string>()

let webNavRegistered = false

function nextSeq(session: SessionRecord): number {
  return session.seq++
}

function emitMonEvent(session: SessionRecord, kind: string, extra: Record<string, unknown> = {}): void {
  const seq = nextSeq(session)
  session.counts.evt++
  if (kind === "mut") session.counts.mut++
  else if (kind === "fetch" || kind === "xhr") session.counts.net++
  else if (kind === "nav") session.counts.nav++

  sendToHost({
    type: "event",
    event: kind,
    sid: session.sessionId,
    s: seq,
    t: Date.now(),
    ...extra
  })
}

function getActiveSessionForTab(tabId: number): SessionRecord | undefined {
  const sid = activeSessionByTab.get(tabId)
  if (!sid) return undefined
  return sessions.get(sid)
}

async function ensureContentScript(tabId: number): Promise<{ connected: boolean; error?: string }> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "monitor_ping" })
    return { connected: true }
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] })
    } catch (injectErr) {
      return { connected: false, error: `content script could not be re-injected on tab ${tabId} — try 'interceptor reload': ${(injectErr as Error).message}` }
    }
    await new Promise(r => setTimeout(r, 200))
    try {
      await chrome.tabs.sendMessage(tabId, { type: "monitor_ping" })
      return { connected: true }
    } catch (retryErr) {
      return { connected: false, error: `content script re-injected but still not responding on tab ${tabId} — try 'interceptor reload': ${(retryErr as Error).message}` }
    }
  }
}

async function sendArmToTab(tabId: number, sessionId: string, startedAt: number): Promise<{ success: boolean; error?: string }> {
  const check = await ensureContentScript(tabId)
  if (!check.connected) return { success: false, error: check.error }
  try {
    await chrome.tabs.sendMessage(tabId, { type: "monitor_arm", sessionId, startedAt })
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

async function sendDisarmToTab(tabId: number): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "monitor_disarm" })
  } catch (err) {
    console.error(`sendDisarmToTab failed for tab ${tabId}:`, (err as Error).message)
    return null
  }
}

function registerWebNavListenersOnce(): void {
  if (webNavRegistered) return
  webNavRegistered = true

  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return
    const session = getActiveSessionForTab(details.tabId)
    if (!session || session.paused) return
    const isReload = details.transitionType === "reload"
    emitMonEvent(session, "nav", {
      u: details.url,
      typ: isReload ? "reload" : "hard",
      tt: details.transitionType,
      tq: details.transitionQualifiers
    })
    session.url = details.url
  })

  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return
    const session = getActiveSessionForTab(details.tabId)
    if (!session || session.paused) return
    emitMonEvent(session, "nav", {
      u: details.url,
      typ: "history",
      tt: details.transitionType,
      tq: details.transitionQualifiers
    })
    session.url = details.url
    sendArmToTab(details.tabId, session.sessionId, session.startedAt).then(res => {
      if (!res.success) console.error(`re-arm after history nav failed on tab ${details.tabId}:`, res.error)
    })
  })

  chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
    if (details.frameId !== 0) return
    const session = getActiveSessionForTab(details.tabId)
    if (!session || session.paused) return
    emitMonEvent(session, "nav", {
      u: details.url,
      typ: "reference",
      tt: details.transitionType,
      tq: details.transitionQualifiers
    })
    session.url = details.url
    sendArmToTab(details.tabId, session.sessionId, session.startedAt).then(res => {
      if (!res.success) console.error(`re-arm after fragment nav failed on tab ${details.tabId}:`, res.error)
    })
  })

  chrome.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId !== 0) return
    const session = getActiveSessionForTab(details.tabId)
    if (!session || session.paused) return
    sendArmToTab(details.tabId, session.sessionId, session.startedAt).then(res => {
      if (!res.success) console.error(`re-arm after navigation completed failed on tab ${details.tabId}:`, res.error)
    })
  })

  chrome.tabs.onRemoved.addListener((tabId) => {
    const session = getActiveSessionForTab(tabId)
    if (!session) return
    const dur = Date.now() - session.startedAt
    sendToHost({
      type: "event",
      event: "mon_stop",
      sid: session.sessionId,
      s: nextSeq(session),
      t: Date.now(),
      reason: "tab_closed",
      evt: session.counts.evt,
      mut: session.counts.mut,
      net: session.counts.net,
      nav: session.counts.nav,
      dur
    })
    sessions.delete(session.sessionId)
    activeSessionByTab.delete(tabId)
  })
}

let runtimeMsgRegistered = false

function registerRuntimeMessageListenerOnce(): void {
  if (runtimeMsgRegistered) return
  runtimeMsgRegistered = true
  chrome.runtime.onMessage.addListener(monitorRuntimeMessageListener)
}

export function registerMonitorListeners(): void {
  registerWebNavListenersOnce()
  registerRuntimeMessageListenerOnce()
}

function monitorRuntimeMessageListener(msg: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void): boolean | void {
  if (!msg || typeof msg !== "object") return
  if (msg.type !== "mon_evt") return
  try {
    const tabId = sender.tab?.id
    const frameId = sender.frameId ?? 0
    if (tabId === undefined) {
      sendResponse({ success: false, error: "no tab id on sender" })
      return true
    }
    const session = getActiveSessionForTab(tabId)
    if (!session) {
      sendResponse({ success: false, error: "no active session for tab" })
      return true
    }
    if (session.paused) {
      sendResponse({ success: true, dropped: "paused" })
      return true
    }
    const obj = msg.obj || {}
    const kind = obj.k || "unknown"
    const stripped: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k === "k") continue
      stripped[k] = v
    }
    if (frameId !== 0) stripped.fid = frameId
    emitMonEvent(session, kind, stripped)
    sendResponse({ success: true })
  } catch (err) {
    try { sendResponse({ success: false, error: (err as Error).message }) } catch {}
  }
  return true
}

async function resolveTabForMonitor(): Promise<{ tabId?: number; error?: string }> {
  const groupId = await ensureInterceptorGroup()
  if (groupId !== -1) {
    const tabs = await chrome.tabs.query({ groupId })
    if (tabs.length > 0) {
      const active = tabs.find(t => t.active) || tabs[0]
      if (active.id) return { tabId: active.id }
    }
  }
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (activeTab?.id) {
    const inGroup = await isTabInInterceptorGroup(activeTab.id)
    if (inGroup) return { tabId: activeTab.id }
  }
  return { error: "no interceptor-managed tab found — use 'interceptor tab new' or pass --tab" }
}

function resolveSessionWithoutTab(): { tabId: number; sessionId: string } | undefined {
  for (const [tid, sid] of activeSessionByTab) {
    return { tabId: tid, sessionId: sid }
  }
  return undefined
}

export async function handleMonitorActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "monitor_start": {
      let resolvedTabId = tabId
      if (!resolvedTabId) {
        const resolved = await resolveTabForMonitor()
        if (resolved.error || !resolved.tabId) {
          return { success: false, error: resolved.error || "no interceptor-managed tab found" }
        }
        resolvedTabId = resolved.tabId
      }
      if (activeSessionByTab.has(resolvedTabId)) {
        const existingSid = activeSessionByTab.get(resolvedTabId)!
        return {
          success: false,
          error: `monitor already active on tab ${resolvedTabId} (session ${existingSid.slice(0, 8)})`,
          data: { sessionId: existingSid }
        }
      }
      const sessionId = crypto.randomUUID()
      const startedAt = Date.now()
      const instruction = (action.instruction as string) || undefined
      let url: string | undefined
      try {
        const tab = await chrome.tabs.get(resolvedTabId)
        url = tab.url
      } catch {}
      const session: SessionRecord = {
        sessionId,
        tabId: resolvedTabId,
        startedAt,
        instruction,
        paused: false,
        seq: 0,
        counts: { evt: 0, mut: 0, net: 0, nav: 0 },
        url
      }
      sessions.set(sessionId, session)
      activeSessionByTab.set(resolvedTabId, sessionId)
      sendToHost({
        type: "event",
        event: "mon_start",
        sid: sessionId,
        s: nextSeq(session),
        t: startedAt,
        tid: resolvedTabId,
        url,
        ins: instruction
      })
      const armResult = await sendArmToTab(resolvedTabId, sessionId, startedAt)
      if (!armResult.success) {
        sessions.delete(sessionId)
        activeSessionByTab.delete(resolvedTabId)
        return { success: false, error: armResult.error, tabId: resolvedTabId }
      }
      return { success: true, data: { sessionId, tabId: resolvedTabId, startedAt, url, instruction } }
    }

    case "monitor_stop": {
      let resolvedTabId = tabId
      let sid = activeSessionByTab.get(resolvedTabId)
      if (!sid) {
        const found = resolveSessionWithoutTab()
        if (found) { resolvedTabId = found.tabId; sid = found.sessionId }
      }
      if (!sid) {
        return { success: false, error: `no active monitor session on tab ${resolvedTabId || "(none)"}` }
      }
      const session = sessions.get(sid)!
      const disarmRes = await sendDisarmToTab(resolvedTabId) as { success?: boolean; counts?: { evt: number; mut: number; net: number } } | null
      const dur = Date.now() - session.startedAt
      sendToHost({
        type: "event",
        event: "mon_stop",
        sid: session.sessionId,
        s: nextSeq(session),
        t: Date.now(),
        reason: "user",
        evt: session.counts.evt,
        mut: session.counts.mut,
        net: session.counts.net,
        nav: session.counts.nav,
        dur
      })
      sessions.delete(sid)
      activeSessionByTab.delete(resolvedTabId)
      return {
        success: true,
        data: {
          sessionId: sid,
          tabId: resolvedTabId,
          dur,
          evt: session.counts.evt,
          mut: session.counts.mut,
          net: session.counts.net,
          nav: session.counts.nav,
          contentDisarm: disarmRes
        }
      }
    }

    case "monitor_status": {
      if (action.tabId && typeof action.tabId === "number") {
        const sid = activeSessionByTab.get(action.tabId)
        if (!sid) return { success: true, data: { active: false, tabId: action.tabId } }
        const s = sessions.get(sid)!
        return {
          success: true,
          data: {
            active: !s.paused,
            paused: s.paused,
            sessionId: s.sessionId,
            tabId: s.tabId,
            startedAt: s.startedAt,
            url: s.url,
            instruction: s.instruction,
            counts: s.counts,
            ageMs: Date.now() - s.startedAt
          }
        }
      }
      const list = Array.from(sessions.values()).map((s) => ({
        sessionId: s.sessionId,
        tabId: s.tabId,
        startedAt: s.startedAt,
        url: s.url,
        instruction: s.instruction,
        paused: s.paused,
        counts: s.counts,
        ageMs: Date.now() - s.startedAt
      }))
      return { success: true, data: { active: list.length > 0, sessions: list } }
    }

    case "monitor_pause": {
      let resolvedTabId = tabId
      let sid = activeSessionByTab.get(resolvedTabId)
      if (!sid) {
        const found = resolveSessionWithoutTab()
        if (found) { resolvedTabId = found.tabId; sid = found.sessionId }
      }
      if (!sid) return { success: false, error: `no active monitor session on tab ${resolvedTabId || "(none)"}` }
      const session = sessions.get(sid)!
      session.paused = true
      sendToHost({
        type: "event",
        event: "mon_pause",
        sid,
        s: nextSeq(session),
        t: Date.now()
      })
      return { success: true, data: { sessionId: sid, paused: true } }
    }

    case "monitor_resume": {
      let resolvedTabId = tabId
      let sid = activeSessionByTab.get(resolvedTabId)
      if (!sid) {
        const found = resolveSessionWithoutTab()
        if (found) { resolvedTabId = found.tabId; sid = found.sessionId }
      }
      if (!sid) return { success: false, error: `no active monitor session on tab ${resolvedTabId || "(none)"}` }
      const session = sessions.get(sid)!
      session.paused = false
      sendToHost({
        type: "event",
        event: "mon_resume",
        sid,
        s: nextSeq(session),
        t: Date.now()
      })
      const armResult = await sendArmToTab(resolvedTabId, sid, session.startedAt)
      if (!armResult.success) {
        console.error(`re-arm after resume failed on tab ${resolvedTabId}:`, armResult.error)
      }
      return { success: true, data: { sessionId: sid, paused: false } }
    }
  }
  return { success: false, error: `unknown monitor action: ${action.type}` }
}
