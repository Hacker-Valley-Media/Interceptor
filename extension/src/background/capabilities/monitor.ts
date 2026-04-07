import { sendToHost } from "../transport"

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

async function sendArmToTab(tabId: number, sessionId: string, startedAt: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "monitor_arm", sessionId, startedAt })
  } catch {}
}

async function sendDisarmToTab(tabId: number): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "monitor_disarm" })
  } catch {
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
  })

  chrome.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId !== 0) return
    const session = getActiveSessionForTab(details.tabId)
    if (!session || session.paused) return
    sendArmToTab(details.tabId, session.sessionId, session.startedAt)
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

export async function handleMonitorActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "monitor_start": {
      if (activeSessionByTab.has(tabId)) {
        const existingSid = activeSessionByTab.get(tabId)!
        return {
          success: false,
          error: `monitor already active on tab ${tabId} (session ${existingSid.slice(0, 8)})`,
          data: { sessionId: existingSid }
        }
      }
      const sessionId = crypto.randomUUID()
      const startedAt = Date.now()
      const instruction = (action.instruction as string) || undefined
      let url: string | undefined
      try {
        const tab = await chrome.tabs.get(tabId)
        url = tab.url
      } catch {}
      const session: SessionRecord = {
        sessionId,
        tabId,
        startedAt,
        instruction,
        paused: false,
        seq: 0,
        counts: { evt: 0, mut: 0, net: 0, nav: 0 },
        url
      }
      sessions.set(sessionId, session)
      activeSessionByTab.set(tabId, sessionId)
      sendToHost({
        type: "event",
        event: "mon_start",
        sid: sessionId,
        s: nextSeq(session),
        t: startedAt,
        tid: tabId,
        url,
        ins: instruction
      })
      await sendArmToTab(tabId, sessionId, startedAt)
      return { success: true, data: { sessionId, tabId, startedAt, url, instruction } }
    }

    case "monitor_stop": {
      const sid = activeSessionByTab.get(tabId)
      if (!sid) {
        return { success: false, error: `no active monitor session on tab ${tabId}` }
      }
      const session = sessions.get(sid)!
      const disarmRes = await sendDisarmToTab(tabId) as { success?: boolean; counts?: { evt: number; mut: number; net: number } } | null
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
      activeSessionByTab.delete(tabId)
      return {
        success: true,
        data: {
          sessionId: sid,
          tabId,
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
      const sid = activeSessionByTab.get(tabId)
      if (!sid) return { success: false, error: `no active monitor session on tab ${tabId}` }
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
      const sid = activeSessionByTab.get(tabId)
      if (!sid) return { success: false, error: `no active monitor session on tab ${tabId}` }
      const session = sessions.get(sid)!
      session.paused = false
      sendToHost({
        type: "event",
        event: "mon_resume",
        sid,
        s: nextSeq(session),
        t: Date.now()
      })
      await sendArmToTab(tabId, sid, session.startedAt)
      return { success: true, data: { sessionId: sid, paused: false } }
    }
  }
  return { success: false, error: `unknown monitor action: ${action.type}` }
}
