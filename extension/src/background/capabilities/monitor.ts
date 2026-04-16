import { sendToHost } from "../transport"
import { addTabToInterceptorGroup, ensureInterceptorGroup, isTabInInterceptorGroup } from "../tab-group"

const FOCUS_SWITCH_GUARD_MS = 2000

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

interface AttachmentRecord {
  key: string
  tabId: number
  documentId?: string
  frameId: number
  url?: string
  openerTabId?: number
  attachedAt: number
  detachedAt?: number
  lifecycle?: string
  reason: "start" | "reload" | "history" | "fragment" | "child_tab" | "tab_replaced" | "focus_switch"
}

interface TrustedActionRecord {
  seq: number
  tabId: number
  documentId?: string
  kind: "click" | "submit" | "key"
  at: number
}

interface SessionRecord {
  sessionId: string
  rootTabId: number
  startedAt: number
  instruction?: string
  paused: boolean
  seq: number
  counts: { evt: number; mut: number; net: number; nav: number }
  url?: string
  attachments: Map<string, AttachmentRecord>
  activeAttachmentKey?: string
  lastTrustedAction?: TrustedActionRecord
}

interface PendingChildTabRecord {
  sessionId: string
  openerTabId: number
  createdAt: number
}

const sessions = new Map<string, SessionRecord>()
const activeSessionByTab = new Map<number, string>()
const pendingChildTabs = new Map<number, PendingChildTabRecord>()

const CHILD_TAB_WINDOW_MS = 5000
const TRUSTED_ACTION_KINDS = new Set(["click", "submit", "key"])

let webNavRegistered = false
let tabsRegistered = false
let runtimeMsgRegistered = false

function attachmentKey(tabId: number, documentId?: string): string {
  return `${tabId}:${documentId || "unknown"}`
}

function nextSeq(session: SessionRecord): number {
  return session.seq++
}

function getActiveSessionForTab(tabId: number): SessionRecord | undefined {
  const sid = activeSessionByTab.get(tabId)
  if (!sid) return undefined
  return sessions.get(sid)
}

/**
 * Focus-follow (PRD-34) needs to find the session even when the activated tab
 * isn't yet in `activeSessionByTab`. V1 supports one session at a time, so the
 * first non-paused session wins. Returning undefined when no session is active
 * keeps the listener a no-op for non-recording windows.
 */
function findFirstActiveSession(): SessionRecord | undefined {
  for (const session of sessions.values()) {
    if (!session.paused) return session
  }
  return undefined
}

function getCurrentAttachment(session: SessionRecord): AttachmentRecord | undefined {
  if (!session.activeAttachmentKey) return undefined
  return session.attachments.get(session.activeAttachmentKey)
}

function createAttachment(
  tabId: number,
  documentId: string | undefined,
  frameId: number,
  url: string | undefined,
  lifecycle: string | undefined,
  reason: AttachmentRecord["reason"],
  openerTabId?: number
): AttachmentRecord {
  return {
    key: attachmentKey(tabId, documentId),
    tabId,
    documentId,
    frameId,
    url,
    openerTabId,
    attachedAt: Date.now(),
    detachedAt: undefined,
    lifecycle,
    reason
  }
}

function emitMonEvent(
  session: SessionRecord,
  kind: string,
  extra: Record<string, unknown> = {},
  attachmentOverride?: AttachmentRecord
): number {
  const seq = nextSeq(session)
  session.counts.evt++
  if (kind === "mut") session.counts.mut++
  else if (kind === "fetch" || kind === "xhr" || kind === "sse") session.counts.net++
  else if (kind === "nav") session.counts.nav++

  const attachment = attachmentOverride || getCurrentAttachment(session)
  const base: Record<string, unknown> = {}
  if (attachment) {
    base.tid = attachment.tabId
    if (attachment.documentId) base.doc = attachment.documentId
    if (attachment.lifecycle) base.lif = attachment.lifecycle
    if (attachment.url && extra.u === undefined && extra.url === undefined) base.u = attachment.url
  }

  sendToHost({
    type: "event",
    event: kind,
    sid: session.sessionId,
    s: seq,
    t: Date.now(),
    ...base,
    ...extra
  })

  return seq
}

function recordTrustedAction(
  session: SessionRecord,
  kind: string,
  seq: number,
  tabId: number,
  documentId?: string
): void {
  if (!TRUSTED_ACTION_KINDS.has(kind)) return
  session.lastTrustedAction = {
    seq,
    tabId,
    documentId,
    kind: kind as TrustedActionRecord["kind"],
    at: Date.now()
  }
}

function detachAttachment(
  session: SessionRecord,
  attachment: AttachmentRecord,
  reason: string
): void {
  attachment.detachedAt = Date.now()
  emitMonEvent(session, "mon_detach", { reason }, attachment)
}

function activateAttachment(session: SessionRecord, attachment: AttachmentRecord): void {
  session.attachments.set(attachment.key, attachment)
  session.activeAttachmentKey = attachment.key
  session.url = attachment.url || session.url
  activeSessionByTab.set(attachment.tabId, session.sessionId)
}

function switchToAttachment(
  session: SessionRecord,
  nextAttachment: AttachmentRecord,
  reason: string
): void {
  const current = getCurrentAttachment(session)
  if (current && current.key === nextAttachment.key) {
    current.url = nextAttachment.url || current.url
    current.lifecycle = nextAttachment.lifecycle || current.lifecycle
    current.openerTabId = nextAttachment.openerTabId ?? current.openerTabId
    current.reason = nextAttachment.reason
    session.url = current.url || session.url
    return
  }

  if (current) {
    const detachReason =
      reason === "child_tab" ? "child_tab_handoff" :
      reason === "focus_switch" ? "focus_switch_handoff" :
      "document_replaced"
    detachAttachment(session, current, detachReason)
    if (current.tabId !== nextAttachment.tabId) {
      activeSessionByTab.delete(current.tabId)
      void sendDisarmToTab(current.tabId, current.documentId)
    }
  }

  activateAttachment(session, nextAttachment)
  emitMonEvent(session, "mon_attach", {
    reason,
    ...(nextAttachment.openerTabId !== undefined ? { openerTid: nextAttachment.openerTabId } : {}),
    ...(nextAttachment.url ? { u: nextAttachment.url } : {})
  }, nextAttachment)
}

async function sendTabMessage(
  tabId: number,
  payload: Record<string, unknown>,
  documentId?: string
): Promise<unknown> {
  if (documentId) {
    return chrome.tabs.sendMessage(tabId, payload, { documentId } as chrome.tabs.MessageSendOptions)
  }
  return chrome.tabs.sendMessage(tabId, payload)
}

async function ensureContentScript(
  tabId: number,
  documentId?: string
): Promise<{ connected: boolean; error?: string }> {
  try {
    await sendTabMessage(tabId, { type: "monitor_ping" }, documentId)
    return { connected: true }
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] })
    } catch (injectErr) {
      return { connected: false, error: `content script could not be re-injected on tab ${tabId} — try 'interceptor reload': ${(injectErr as Error).message}` }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    try {
      await sendTabMessage(tabId, { type: "monitor_ping" }, documentId)
      return { connected: true }
    } catch (retryErr) {
      return { connected: false, error: `content script re-injected but still not responding on tab ${tabId} — try 'interceptor reload': ${(retryErr as Error).message}` }
    }
  }
}

async function sendArmToTab(
  tabId: number,
  sessionId: string,
  startedAt: number,
  documentId?: string
): Promise<{ success: boolean; error?: string }> {
  const check = await ensureContentScript(tabId, documentId)
  if (!check.connected) return { success: false, error: check.error }
  try {
    await sendTabMessage(tabId, { type: "monitor_arm", sessionId, startedAt }, documentId)
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

async function sendDisarmToTab(tabId: number, documentId?: string): Promise<unknown> {
  try {
    return await sendTabMessage(tabId, { type: "monitor_disarm" }, documentId)
  } catch (err) {
    console.error(`sendDisarmToTab failed for tab ${tabId}:`, (err as Error).message)
    return null
  }
}

async function getTopFrameContext(tabId: number): Promise<{
  documentId?: string
  url?: string
  lifecycle?: string
}> {
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 })
    return {
      documentId: (frame as { documentId?: string } | undefined)?.documentId,
      url: frame?.url,
      lifecycle: (frame as { documentLifecycle?: string } | undefined)?.documentLifecycle
    }
  } catch {
    return {}
  }
}

function registerWebNavListenersOnce(): void {
  if (webNavRegistered) return
  webNavRegistered = true

  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return

    const pendingChild = pendingChildTabs.get(details.tabId)
    if (pendingChild) {
      const session = sessions.get(pendingChild.sessionId)
      if (session && !session.paused) {
        addTabToInterceptorGroup(details.tabId).catch(() => {})
        switchToAttachment(
          session,
          createAttachment(
            details.tabId,
            details.documentId,
            details.frameId,
            details.url,
            details.documentLifecycle,
            "child_tab",
            pendingChild.openerTabId
          ),
          "child_tab"
        )
        emitMonEvent(session, "nav", {
          u: details.url,
          typ: details.transitionType === "reload" ? "reload" : "hard",
          tt: details.transitionType,
          tq: details.transitionQualifiers
        })
      }
      pendingChildTabs.delete(details.tabId)
      return
    }

    const session = getActiveSessionForTab(details.tabId)
    if (!session || session.paused) return

    const current = getCurrentAttachment(session)
    if (!current || current.documentId !== details.documentId) {
      switchToAttachment(
        session,
        createAttachment(
          details.tabId,
          details.documentId,
          details.frameId,
          details.url,
          details.documentLifecycle,
          details.transitionType === "reload" ? "reload" : "start"
        ),
        details.transitionType === "reload" ? "reload" : "start"
      )
    } else {
      current.url = details.url
      current.lifecycle = details.documentLifecycle
      session.url = details.url
    }

    emitMonEvent(session, "nav", {
      u: details.url,
      typ: details.transitionType === "reload" ? "reload" : "hard",
      tt: details.transitionType,
      tq: details.transitionQualifiers
    })
  })

  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return
    const session = getActiveSessionForTab(details.tabId)
    if (!session || session.paused) return
    const current = getCurrentAttachment(session)
    if (current) {
      current.url = details.url
      current.lifecycle = details.documentLifecycle
      if (details.documentId) current.documentId = details.documentId
      session.url = details.url
    }
    emitMonEvent(session, "nav", {
      u: details.url,
      typ: "history",
      tt: details.transitionType,
      tq: details.transitionQualifiers
    })
    void sendArmToTab(details.tabId, session.sessionId, session.startedAt, current?.documentId).then((res) => {
      if (!res.success) console.error(`re-arm after history nav failed on tab ${details.tabId}:`, res.error)
    })
  })

  chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
    if (details.frameId !== 0) return
    const session = getActiveSessionForTab(details.tabId)
    if (!session || session.paused) return
    const current = getCurrentAttachment(session)
    if (current) {
      current.url = details.url
      current.lifecycle = details.documentLifecycle
      if (details.documentId) current.documentId = details.documentId
      session.url = details.url
    }
    emitMonEvent(session, "nav", {
      u: details.url,
      typ: "reference",
      tt: details.transitionType,
      tq: details.transitionQualifiers
    })
    void sendArmToTab(details.tabId, session.sessionId, session.startedAt, current?.documentId).then((res) => {
      if (!res.success) console.error(`re-arm after fragment nav failed on tab ${details.tabId}:`, res.error)
    })
  })

  chrome.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId !== 0) return
    const session = getActiveSessionForTab(details.tabId)
    if (!session || session.paused) return
    const current = getCurrentAttachment(session)
    void sendArmToTab(details.tabId, session.sessionId, session.startedAt, current?.documentId).then((res) => {
      if (!res.success) console.error(`re-arm after navigation completed failed on tab ${details.tabId}:`, res.error)
    })
  })

  chrome.webNavigation.onTabReplaced.addListener((details) => {
    const session = getActiveSessionForTab(details.replacedTabId)
    if (!session || session.paused) return
    const current = getCurrentAttachment(session)
    if (!current) return

    detachAttachment(session, current, "tab_replaced")
    activeSessionByTab.delete(details.replacedTabId)

    const replacement = createAttachment(
      details.tabId,
      current.documentId,
      0,
      current.url,
      current.lifecycle,
      "tab_replaced",
      current.openerTabId
    )
    activateAttachment(session, replacement)
    emitMonEvent(session, "mon_attach", {
      reason: "tab_replaced",
      ...(replacement.url ? { u: replacement.url } : {})
    }, replacement)
  })
}

async function handleFocusActivated(tabId: number): Promise<void> {
  const session = findFirstActiveSession()
  if (!session) return

  const current = getCurrentAttachment(session)
  if (current && current.tabId === tabId) return

  // Don't fight the child-tab handoff path — onCommitted will attach with
  // reason "child_tab" once the child document commits.
  if (pendingChildTabs.has(tabId)) return

  // Privacy: only auto-attach to tabs the user opted into via the interceptor group.
  let inGroup = false
  try { inGroup = await isTabInInterceptorGroup(tabId) } catch { return }
  if (!inGroup) return

  // Recheck — async gap above could have racing onCreated handoff
  if (pendingChildTabs.has(tabId)) return
  if (current && current.tabId === tabId) return

  // Avoid a thrash if a focus_switch on this same tab just happened
  if (current && current.attachedAt && current.tabId === tabId &&
      Date.now() - current.attachedAt < FOCUS_SWITCH_GUARD_MS) return

  let ctx: { documentId?: string; url?: string; lifecycle?: string } = {}
  try { ctx = await getTopFrameContext(tabId) } catch {}

  let tabUrl = ctx.url
  if (!tabUrl) {
    try { const tab = await chrome.tabs.get(tabId); tabUrl = tab.url } catch {}
  }

  const next = createAttachment(
    tabId,
    ctx.documentId,
    0,
    tabUrl,
    ctx.lifecycle,
    "focus_switch"
  )
  switchToAttachment(session, next, "focus_switch")

  const armRes = await sendArmToTab(tabId, session.sessionId, session.startedAt, ctx.documentId)
  if (!armRes.success) {
    console.error(`focus_switch arm failed for tab ${tabId}: ${armRes.error}`)
  }
}

function registerTabListenersOnce(): void {
  if (tabsRegistered) return
  tabsRegistered = true

  // PRD-34 — focus-follow within the interceptor group.
  // When the user manually activates another tab in the cyan group, the
  // session detaches from the previous tab and attaches to the new one.
  // Personal tabs (outside the group) are never followed.
  chrome.tabs.onActivated.addListener((info) => {
    void handleFocusActivated(info.tabId)
  })

  chrome.tabs.onCreated.addListener((tab) => {
    if (!tab.id || tab.openerTabId === undefined) return
    const session = getActiveSessionForTab(tab.openerTabId)
    if (!session || session.paused) return
    const current = getCurrentAttachment(session)
    if (!current || current.tabId !== tab.openerTabId) return
    const trusted = session.lastTrustedAction
    if (!trusted) return
    if (trusted.tabId !== current.tabId) return
    if (Date.now() - trusted.at > CHILD_TAB_WINDOW_MS) return

    pendingChildTabs.set(tab.id, {
      sessionId: session.sessionId,
      openerTabId: tab.openerTabId,
      createdAt: Date.now()
    })
  })

  chrome.tabs.onRemoved.addListener((tabId) => {
    pendingChildTabs.delete(tabId)
    const session = getActiveSessionForTab(tabId)
    if (!session) return
    const current = getCurrentAttachment(session)
    const dur = Date.now() - session.startedAt
    try {
      if (current) {
        try { detachAttachment(session, current, "tab_closed") } catch (err) {
          console.error(`detachAttachment during tab_closed failed:`, (err as Error).message)
        }
      }
      try {
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
      } catch (err) {
        console.error(`sendToHost(mon_stop/tab_closed) failed:`, (err as Error).message)
      }
    } finally {
      sessions.delete(session.sessionId)
      activeSessionByTab.delete(tabId)
      clearPendingChildTabsForSession(session.sessionId)
    }
  })
}

function registerRuntimeMessageListenerOnce(): void {
  if (runtimeMsgRegistered) return
  runtimeMsgRegistered = true
  chrome.runtime.onMessage.addListener(monitorRuntimeMessageListener)
}

export function registerMonitorListeners(): void {
  registerWebNavListenersOnce()
  registerTabListenersOnce()
  registerRuntimeMessageListenerOnce()
}

function monitorRuntimeMessageListener(
  msg: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean | void {
  if (!msg || typeof msg !== "object") return
  if (msg.type !== "mon_evt") return
  try {
    const tabId = sender.tab?.id
    const frameId = sender.frameId ?? 0
    const senderMeta = sender as chrome.runtime.MessageSender & {
      documentId?: string
      documentLifecycle?: string
    }
    const documentId = senderMeta.documentId
    const lifecycle = senderMeta.documentLifecycle

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

    const current = getCurrentAttachment(session)
    if (documentId && current?.documentId && current.documentId !== documentId) {
      sendResponse({ success: false, error: "sender document is not the active attachment" })
      return true
    }

    if (current && documentId) current.documentId = documentId
    if (current && lifecycle) current.lifecycle = lifecycle

    const obj = msg.obj || {}
    const kind = obj.k || "unknown"
    const stripped: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k === "k") continue
      stripped[k] = v
    }
    if (frameId !== 0) stripped.fid = frameId
    if (tabId !== undefined) stripped.tid = tabId
    if (documentId) stripped.doc = documentId
    if (lifecycle) stripped.lif = lifecycle

    const emittedSeq = emitMonEvent(session, kind, stripped, current)
    if (obj.tr !== false) {
      recordTrustedAction(session, kind, emittedSeq, tabId, documentId)
    }
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
      const active = tabs.find((tab) => tab.active) || tabs[0]
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

function clearPendingChildTabsForSession(sessionId: string): void {
  for (const [tabId, pending] of pendingChildTabs) {
    if (pending.sessionId === sessionId) pendingChildTabs.delete(tabId)
  }
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
      const frame = await getTopFrameContext(resolvedTabId)
      const initialAttachment = createAttachment(
        resolvedTabId,
        frame.documentId,
        0,
        frame.url || url,
        frame.lifecycle,
        "start"
      )
      const session: SessionRecord = {
        sessionId,
        rootTabId: resolvedTabId,
        startedAt,
        instruction,
        paused: false,
        seq: 0,
        counts: { evt: 0, mut: 0, net: 0, nav: 0 },
        url: initialAttachment.url || url,
        attachments: new Map([[initialAttachment.key, initialAttachment]]),
        activeAttachmentKey: initialAttachment.key
      }

      const armResult = await sendArmToTab(resolvedTabId, sessionId, startedAt, initialAttachment.documentId)
      if (!armResult.success) {
        return { success: false, error: armResult.error, tabId: resolvedTabId }
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
        url: session.url,
        ins: instruction
      })
      emitMonEvent(session, "mon_attach", {
        reason: "start",
        ...(session.url ? { u: session.url } : {})
      }, initialAttachment)

      return { success: true, data: { sessionId, tabId: resolvedTabId, startedAt, url: session.url, instruction } }
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
      const current = getCurrentAttachment(session)
      const disarmRes = await sendDisarmToTab(resolvedTabId, current?.documentId) as { success?: boolean; counts?: { evt: number; mut: number; net: number } } | null
      const dur = Date.now() - session.startedAt
      const countsSnapshot = { ...session.counts }
      try {
        if (current) {
          try { detachAttachment(session, current, "user_stop") } catch (err) {
            console.error(`detachAttachment during monitor_stop failed:`, (err as Error).message)
          }
        }
        try {
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
        } catch (err) {
          console.error(`sendToHost(mon_stop) failed:`, (err as Error).message)
        }
      } finally {
        sessions.delete(sid)
        activeSessionByTab.delete(resolvedTabId)
        clearPendingChildTabsForSession(sid)
      }
      return {
        success: true,
        data: {
          sessionId: sid,
          tabId: resolvedTabId,
          dur,
          evt: countsSnapshot.evt,
          mut: countsSnapshot.mut,
          net: countsSnapshot.net,
          nav: countsSnapshot.nav,
          contentDisarm: disarmRes
        }
      }
    }

    case "monitor_status": {
      if (action.tabId && typeof action.tabId === "number") {
        const sid = activeSessionByTab.get(action.tabId)
        if (!sid) return { success: true, data: { active: false, tabId: action.tabId } }
        const session = sessions.get(sid)!
        const current = getCurrentAttachment(session)
        return {
          success: true,
          data: {
            active: !session.paused,
            paused: session.paused,
            sessionId: session.sessionId,
            tabId: current?.tabId ?? action.tabId,
            documentId: current?.documentId,
            startedAt: session.startedAt,
            url: session.url,
            instruction: session.instruction,
            counts: session.counts,
            ageMs: Date.now() - session.startedAt
          }
        }
      }
      const list = Array.from(sessions.values()).map((session) => {
        const current = getCurrentAttachment(session)
        return {
          sessionId: session.sessionId,
          tabId: current?.tabId ?? session.rootTabId,
          documentId: current?.documentId,
          startedAt: session.startedAt,
          url: session.url,
          instruction: session.instruction,
          paused: session.paused,
          counts: session.counts,
          ageMs: Date.now() - session.startedAt
        }
      })
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
        t: Date.now(),
        ...(getCurrentAttachment(session) ? { tid: getCurrentAttachment(session)!.tabId } : {})
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
      const current = getCurrentAttachment(session)
      session.paused = false
      sendToHost({
        type: "event",
        event: "mon_resume",
        sid,
        s: nextSeq(session),
        t: Date.now(),
        ...(current ? { tid: current.tabId, doc: current.documentId } : {})
      })
      const armResult = await sendArmToTab(resolvedTabId, sid, session.startedAt, current?.documentId)
      if (!armResult.success) {
        console.error(`re-arm after resume failed on tab ${resolvedTabId}:`, armResult.error)
      }
      return { success: true, data: { sessionId: sid, paused: false } }
    }
  }
  return { success: false, error: `unknown monitor action: ${action.type}` }
}
