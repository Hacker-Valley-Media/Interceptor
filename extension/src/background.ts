import { buildLinkedInEventExtractionPayload } from "./linkedin/event-page-extraction-payload"
import { buildLinkedInAttendeeCliPayload } from "./linkedin/event-attendees-extraction-payload"
import { buildLinkedInEventAttendeeOverrideRules } from "./linkedin/event-attendees-request-override"
import { enrichLinkedInAttendee } from "./linkedin/attendee-profile-enrichment"
import { extractLinkedInEventId, normalizeText } from "./linkedin/linkedin-shared-types"
import { fetchLinkedInEventAttendeesById } from "./linkedin/professional-event-api"

type ActiveTransport = "none" | "native" | "websocket"

let nativePort: chrome.runtime.Port | null = null
let activeTransport: ActiveTransport = "none"
let isConnecting = false
let reconnectDelay = 1000

let offscreenIdleTimer: ReturnType<typeof setTimeout> | null = null
const OFFSCREEN_IDLE_MS = 30_000

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] })
  if (contexts.length > 0) {
    resetOffscreenTimer()
    return
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS" as chrome.offscreen.Reason],
    justification: "Image crop, stitch, and diff operations"
  })
  resetOffscreenTimer()
}

function resetOffscreenTimer() {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer)
  offscreenIdleTimer = setTimeout(async () => {
    try { await chrome.offscreen.closeDocument() } catch {}
    offscreenIdleTimer = null
  }, OFFSCREEN_IDLE_MS)
}

async function sendToOffscreen(msg: Record<string, unknown>): Promise<unknown> {
  await ensureOffscreen()
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...msg, target: "offscreen" }, resolve)
  })
}

function emitEvent(event: string, data: Record<string, unknown> = {}) {
  sendToHost({ type: "event", event, ...data })
}
const MESSAGE_QUEUE_CAP = 50
const messageQueue: Array<{ id?: string; action?: { type: string; [key: string]: unknown }; tabId?: number }> = []

const EXT_REQUEST_TIMEOUT_MS = 180_000
const pendingRequests = new Map<string, { action: string; tabId?: number; timestamp: number; timer: ReturnType<typeof setTimeout>; viaWs?: boolean }>()

function drainMessageQueue() {
  while (messageQueue.length > 0) {
    const queued = messageQueue.shift()!
    handleDaemonMessage(queued)
  }
}

function connectToHost() {
  if (nativePort || isConnecting) return
  isConnecting = true

  const port = chrome.runtime.connectNative("com.slopbrowser.host")

  const handshakeTimer = setTimeout(() => {
    console.error("native host handshake timeout (10s)")
    port.disconnect()
  }, 10000)

  port.onMessage.addListener((msg: { id?: string; type?: string; action?: { type: string; [key: string]: unknown }; tabId?: number }) => {
    if (msg.type === "pong") {
      clearTimeout(handshakeTimer)
      activeTransport = "native"
      reconnectDelay = 1000
      isConnecting = false
      console.log("native host connected (pong received)")
      emitEvent("connection_established")
      drainMessageQueue()
      if (keepalivePongTimer) {
        clearTimeout(keepalivePongTimer)
        keepalivePongTimer = null
      }
      return
    }
    handleDaemonMessage(msg)
  })

  port.onDisconnect.addListener(() => {
    const dyingPort = nativePort
    isConnecting = false
    const lastError = chrome.runtime.lastError
    if (lastError) {
      console.error("native host disconnected:", lastError.message)
    }
    console.log("connection_lost", lastError?.message)
    nativePort = null
    if (wsReady && wsChannel) {
      activeTransport = "websocket"
      console.log("native host down but ws channel active, switching to websocket")
      return
    }
    if (activeTransport === "native") activeTransport = "none"
    for (const [id, req] of pendingRequests) {
      clearTimeout(req.timer)
      console.error(`orphaned request ${id} (${req.action}) — native port disconnected`)
      if (dyingPort) {
        try { dyingPort.postMessage({ id, result: { success: false, error: "native port disconnected" } }) } catch {}
      }
    }
    pendingRequests.clear()
    const jitter = Math.random() * reconnectDelay * 0.3
    setTimeout(connectToHost, reconnectDelay + jitter)
    reconnectDelay = Math.min(reconnectDelay * 2, 30000)
  })

  nativePort = port
  port.postMessage({ type: "ping" })
}

async function handleDaemonMessage(msg: { id?: string; action?: { type: string; [key: string]: unknown }; tabId?: number }) {
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
    if (!nativePort) connectToHost()
    if (!wsChannel || wsChannel.readyState === WebSocket.CLOSED) connectWsChannel()
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
  pendingRequests.set(msg.id, { action: msg.action.type, tabId: msg.tabId, timestamp: startTime, timer: requestTimer, viaWs: respondViaWs })

  const action = msg.action
  let tabId = msg.tabId

  if (!tabId && needsTab(action.type)) {
    const stored = await chrome.storage.session.get("activeTabId")
    tabId = stored.activeTabId
  }

  if (!tabId && needsTab(action.type)) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
    tabId = activeTab?.id
    if (tabId) {
      chrome.storage.session.set({ activeTabId: tabId })
    }
  }

  if (!tabId && needsTab(action.type)) {
    clearTimeout(requestTimer)
    pendingRequests.delete(msg.id)
    sendToHost({ id: msg.id, result: { success: false, error: "no active tab" } }, respondViaWs)
    return
  }

  if (tabId) {
    chrome.storage.session.set({ activeTabId: tabId })
  }

  if (tabId && needsTab(action.type) && !action.anyTab) {
    const inGroup = await isTabInSlopGroup(tabId)
    if (!inGroup && slopGroupId !== null) {
      clearTimeout(requestTimer)
      pendingRequests.delete(msg.id)
      sendToHost({ id: msg.id, result: { success: false, error: `tab ${tabId} is not in the slop group — use 'slop tab new' to create managed tabs` } }, respondViaWs)
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

function needsTab(type: string): boolean {
  const noTabActions = new Set([
    "status", "reload_extension", "tab_create", "tab_list", "window_create", "window_list", "window_get_all",
    "history_search", "history_delete_all", "bookmark_tree", "bookmark_search",
    "bookmark_create", "downloads_search", "browsing_data_remove",
    "session_list", "session_restore", "notification_create", "notification_clear",
    "search_query"
  ])
  return !noTabActions.has(type)
}

let slopGroupId: number | null = null

async function ensureSlopGroup(): Promise<number> {
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

async function addTabToSlopGroup(tabId: number): Promise<number> {
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

async function isTabInSlopGroup(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId)
  if (slopGroupId === null) await ensureSlopGroup()
  return slopGroupId !== null && tab.groupId === slopGroupId
}

const SENSITIVE_ACTIONS = new Set(["evaluate", "cookies_get", "cookies_set", "cookies_delete", "storage_read", "storage_write", "storage_delete"])

async function verifyTabUrl(tabId: number, expectedUrl?: string): Promise<string | null> {
  if (!expectedUrl) return null
  const tab = await chrome.tabs.get(tabId)
  if (tab.url && tab.url !== expectedUrl) {
    return `tab URL changed since last state read — expected ${expectedUrl}, got ${tab.url}`
  }
  return null
}

let debuggerAttached = new Set<number>()
let infoBannerHeight = 0

async function cdpCommand(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const target = { tabId }
  const isAttached = debuggerAttached.has(tabId)
  if (!isAttached) {
    await chrome.debugger.attach(target, "1.3")
    debuggerAttached.add(tabId)
  }
  try {
    const result = await chrome.debugger.sendCommand(target, method, params)
    return result
  } finally {
    if (!isAttached) {
      try {
        await chrome.debugger.detach(target)
        debuggerAttached.delete(tabId)
      } catch {}
    }
  }
}

async function cdpAttachActDetach<T>(tabId: number, method: string, params?: Record<string, unknown>): Promise<{ success: boolean; data?: T; error?: string }> {
  try {
    const result = await cdpCommand(tabId, method, params) as T
    return { success: true, data: result }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

async function cdpInjectSourceCapabilitiesMock(tabId: number): Promise<void> {
  try {
    await cdpCommand(tabId, "Page.addScriptToEvaluateOnNewDocument", {
      source: `
        if (typeof UIEvent !== 'undefined') {
          const origDesc = Object.getOwnPropertyDescriptor(UIEvent.prototype, 'sourceCapabilities');
          if (origDesc) {
            Object.defineProperty(UIEvent.prototype, 'sourceCapabilities', {
              get() {
                if (!this.isTrusted && origDesc.get) return origDesc.get.call(this);
                return new InputDeviceCapabilities({ firesTouchEvents: false });
              },
              configurable: true
            });
          }
        }
      `
    })
  } catch {}
}

type CapturedNetworkEntry = {
  tabId: number
  requestId: string
  url: string
  method: string
  resourceType?: string
  timestamp: number
  status?: number
  mimeType?: string
  requestHeaders?: Record<string, unknown>
  responseHeaders?: Record<string, unknown>
  requestPostData?: string
  responseBody?: string
  errorText?: string
}

type NetworkCaptureConfig = {
  enabled: boolean
  patterns: string[]
  startedAt: number
}

type NetworkOverrideRule = {
  id?: string
  urlPattern?: string
  methods?: string[]
  resourceTypes?: string[]
  replaceUrl?: string
  queryAddOrReplace?: Record<string, string | number | boolean>
  queryRemove?: string[]
  setHeaders?: Record<string, string>
  removeHeaders?: string[]
  postData?: string
}

const NETWORK_LOG_LIMIT = 250
const NETWORK_BODY_LIMIT = 120000
const networkCaptureConfigs = new Map<number, NetworkCaptureConfig>()
const networkCaptureLogs = new Map<number, CapturedNetworkEntry[]>()
const pendingNetworkEntries = new Map<string, CapturedNetworkEntry>()
const networkOverrideConfigs = new Map<number, NetworkOverrideRule[]>()
const fetchInterceptionEnabled = new Set<number>()

function networkEntryKey(tabId: number, requestId: string): string {
  return `${tabId}:${requestId}`
}

function getNetworkLogs(tabId: number): CapturedNetworkEntry[] {
  const logs = networkCaptureLogs.get(tabId)
  if (logs) return logs
  const next: CapturedNetworkEntry[] = []
  networkCaptureLogs.set(tabId, next)
  return next
}

function clearNetworkLogs(tabId: number) {
  networkCaptureLogs.set(tabId, [])
  for (const key of Array.from(pendingNetworkEntries.keys())) {
    if (key.startsWith(`${tabId}:`)) pendingNetworkEntries.delete(key)
  }
}

function appendNetworkLog(tabId: number, entry: CapturedNetworkEntry) {
  const logs = getNetworkLogs(tabId)
  logs.push(entry)
  if (logs.length > NETWORK_LOG_LIMIT) {
    logs.splice(0, logs.length - NETWORK_LOG_LIMIT)
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function matchesCapturePatterns(url: string, patterns: string[]): boolean {
  if (!patterns.length) return true
  return patterns.some(pattern => {
    const regex = new RegExp(escapeRegExp(pattern).replace(/\\\*/g, ".*"), "i")
    return regex.test(url)
  })
}

function truncateBody(body?: string): string | undefined {
  if (!body) return body
  return body.length > NETWORK_BODY_LIMIT ? body.slice(0, NETWORK_BODY_LIMIT) + "\n... (truncated)" : body
}

function matchesRequestMethod(method: string | undefined, allowed: string[] | undefined): boolean {
  if (!allowed || !allowed.length) return true
  if (!method) return false
  return allowed.map(item => item.toUpperCase()).includes(method.toUpperCase())
}

function matchesRequestResourceType(resourceType: string | undefined, allowed: string[] | undefined): boolean {
  if (!allowed || !allowed.length) return true
  if (!resourceType) return false
  return allowed.map(item => item.toLowerCase()).includes(resourceType.toLowerCase())
}

function findMatchingNetworkOverrideRule(url: string, method: string | undefined, resourceType: string | undefined, rules: NetworkOverrideRule[]): NetworkOverrideRule | null {
  for (const rule of rules) {
    if (rule.urlPattern && !matchesCapturePatterns(url, [rule.urlPattern])) continue
    if (!matchesRequestMethod(method, rule.methods)) continue
    if (!matchesRequestResourceType(resourceType, rule.resourceTypes)) continue
    return rule
  }
  return null
}

function applyNetworkOverrideRule(request: Record<string, any>, resourceType: string | undefined, rule: NetworkOverrideRule): { url?: string; headers?: Array<{ name: string; value: string }>; postData?: string } {
  const nextUrl = new URL(rule.replaceUrl || request.url)
  if (rule.queryRemove?.length) {
    for (const key of rule.queryRemove) nextUrl.searchParams.delete(key)
  }
  if (rule.queryAddOrReplace) {
    for (const [key, value] of Object.entries(rule.queryAddOrReplace)) {
      nextUrl.searchParams.set(key, String(value))
    }
  }
  const headerMap = new Map<string, string>()
  for (const [name, value] of Object.entries(request.headers || {})) {
    headerMap.set(name.toLowerCase(), String(value))
  }
  if (rule.removeHeaders?.length) {
    for (const header of rule.removeHeaders) headerMap.delete(header.toLowerCase())
  }
  if (rule.setHeaders) {
    for (const [name, value] of Object.entries(rule.setHeaders)) {
      headerMap.set(name.toLowerCase(), value)
    }
  }
  const headers = Array.from(headerMap.entries()).map(([name, value]) => ({ name, value }))
  const postData = rule.postData !== undefined ? rule.postData : request.postData
  return {
    url: nextUrl.toString() !== request.url ? nextUrl.toString() : undefined,
    headers,
    postData
  }
}

async function refreshFetchInterception(tabId: number): Promise<void> {
  const hasOverrides = (networkOverrideConfigs.get(tabId)?.length || 0) > 0
  await ensureDebuggerSession(tabId)
  if (hasOverrides && !fetchInterceptionEnabled.has(tabId)) {
    await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }]
    })
    fetchInterceptionEnabled.add(tabId)
    return
  }
  if (!hasOverrides && fetchInterceptionEnabled.has(tabId)) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Fetch.disable")
    } catch {}
    fetchInterceptionEnabled.delete(tabId)
  }
}

async function ensureDebuggerSession(tabId: number): Promise<void> {
  if (debuggerAttached.has(tabId)) return
  await chrome.debugger.attach({ tabId }, "1.3")
  debuggerAttached.add(tabId)
}

async function enableNetworkCapture(tabId: number, patterns: string[]): Promise<void> {
  await ensureDebuggerSession(tabId)
  await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
    maxTotalBufferSize: 10000000,
    maxResourceBufferSize: 2000000
  })
  networkCaptureConfigs.set(tabId, { enabled: true, patterns, startedAt: Date.now() })
  clearNetworkLogs(tabId)
}

async function disableNetworkCapture(tabId: number): Promise<void> {
  networkCaptureConfigs.set(tabId, {
    enabled: false,
    patterns: networkCaptureConfigs.get(tabId)?.patterns || [],
    startedAt: networkCaptureConfigs.get(tabId)?.startedAt || Date.now()
  })
  try {
    await chrome.debugger.sendCommand({ tabId }, "Network.disable")
  } catch {}
}

function stripJsonPrefix(body: string): string {
  return body
    .replace(/^for\s*\(;;\s*\);?\s*/, "")
    .replace(/^\)\]\}',?\s*/, "")
    .trim()
}

function tryParseJsonBody(body?: string): unknown | null {
  if (!body) return null
  const cleaned = stripJsonPrefix(body)
  if (!cleaned || (!["{", "["].includes(cleaned[0]))) return null
  try {
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

function normalizeText(value?: string | null): string {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase()
}

function extractLinkedInEventId(url?: string | null): string | null {
  if (!url) return null
  return url.match(/\/events\/(\d+)/)?.[1] || null
}

function walkValues(value: unknown, visitor: (key: string | null, value: unknown, path: string[]) => void, path: string[] = [], seen = new WeakSet<object>()) {
  visitor(path.length ? path[path.length - 1] : null, value, path)
  if (!value || typeof value !== "object") return
  if (seen.has(value as object)) return
  seen.add(value as object)
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkValues(item, visitor, [...path, String(index)], seen))
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    walkValues(child, visitor, [...path, key], seen)
  }
}

function collectStringCandidates(value: unknown, keyHints: string[]): Array<{ key: string | null; path: string[]; value: string }> {
  const results: Array<{ key: string | null; path: string[]; value: string }> = []
  walkValues(value, (key, current, path) => {
    if (typeof current !== "string") return
    if (!key) return
    const lowerKey = key.toLowerCase()
    if (keyHints.some(hint => lowerKey.includes(hint))) {
      const normalized = current.replace(/\s+/g, " ").trim()
      if (normalized) results.push({ key, path, value: normalized })
    }
  })
  return results
}

function collectNumberCandidates(value: unknown, keyHints: string[]): Array<{ key: string | null; path: string[]; value: number }> {
  const results: Array<{ key: string | null; path: string[]; value: number }> = []
  walkValues(value, (key, current, path) => {
    if (!key) return
    const lowerKey = key.toLowerCase()
    if (!keyHints.some(hint => lowerKey.includes(hint))) return
    if (typeof current === "number" && Number.isFinite(current)) {
      results.push({ key, path, value: current })
      return
    }
    if (typeof current === "string" && /^\d[\d,]*$/.test(current.trim())) {
      results.push({ key, path, value: parseInt(current.replace(/,/g, ""), 10) })
    }
  })
  return results
}

function pickBestString(candidates: Array<{ value: string }>, preferred?: string | null, fallbackContains?: string | null): string | null {
  if (!candidates.length) return null
  const preferredNormalized = normalizeText(preferred)
  if (preferredNormalized) {
    const exact = candidates.find(candidate => normalizeText(candidate.value) === preferredNormalized)
    if (exact) return exact.value
    const contains = candidates.find(candidate => normalizeText(candidate.value).includes(preferredNormalized) || preferredNormalized.includes(normalizeText(candidate.value)))
    if (contains) return contains.value
  }
  const fallbackNormalized = normalizeText(fallbackContains)
  if (fallbackNormalized) {
    const matched = candidates.find(candidate => normalizeText(candidate.value).includes(fallbackNormalized))
    if (matched) return matched.value
  }
  return candidates.slice().sort((a, b) => b.value.length - a.value.length)[0].value
}

function pickBestNumber(candidates: Array<{ value: number }>, preferred?: number | null): number | null {
  if (!candidates.length) return null
  if (preferred !== undefined && preferred !== null) {
    const exact = candidates.find(candidate => candidate.value === preferred)
    if (exact) return exact.value
  }
  return candidates.slice().sort((a, b) => b.value - a.value)[0].value
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000
    const date = new Date(millis)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d{13}$/.test(trimmed)) return toIsoTimestamp(parseInt(trimmed, 10))
  if (/^\d{10}$/.test(trimmed)) return toIsoTimestamp(parseInt(trimmed, 10))
  const date = new Date(trimmed)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function collectIsoCandidates(value: unknown, keyHints: string[]): string[] {
  const results: string[] = []
  walkValues(value, (key, current) => {
    if (!key) return
    const lowerKey = key.toLowerCase()
    if (!keyHints.some(hint => lowerKey.includes(hint))) return
    const iso = toIsoTimestamp(current)
    if (iso) results.push(iso)
  })
  return results
}

function pickBestParsedResponse(entries: CapturedNetworkEntry[], clues: { title?: string | null; organizerName?: string | null; postText?: string | null; posterName?: string | null; eventId?: string | null; url?: string | null }, mode: "event" | "post"): { entry: CapturedNetworkEntry; parsed: unknown } | null {
  const parsedEntries = entries
    .filter(entry => !isNoiseLinkedInUrl(entry.url))
    .map(entry => ({ entry, parsed: tryParseJsonBody(entry.responseBody) }))
    .filter(item => item.parsed !== null) as Array<{ entry: CapturedNetworkEntry; parsed: unknown }>
  let best: { entry: CapturedNetworkEntry; parsed: unknown; score: number } | null = null
  for (const item of parsedEntries) {
    const haystack = normalizeText(item.entry.responseBody)
    let score = 0
    if (mode === "event") {
      if (/voyager\/api\/events\/dash\/professionalevents/i.test(item.entry.url)) score += 120
      if (clues.eventId && item.entry.url.includes(clues.eventId)) score += 60
      if (clues.title && haystack.includes(normalizeText(clues.title))) score += 35
      if (clues.organizerName && haystack.includes(normalizeText(clues.organizerName))) score += 20
      if (/events|event/i.test(item.entry.url)) score += 15
    } else {
      if (/voyagerSocialDash(Reactions|Comments)|socialDetailUrn|ugcPost|comment|reaction/i.test(item.entry.url)) score += 100
      if (clues.postText && haystack.includes(normalizeText(clues.postText).slice(0, 80))) score += 45
      if (clues.posterName && haystack.includes(normalizeText(clues.posterName))) score += 20
      if (/comment|social|feed|activity|update|ugc|share/i.test(item.entry.url)) score += 20
    }
    if (item.entry.status && item.entry.status >= 200 && item.entry.status < 300) score += 5
    if (item.entry.mimeType?.includes("json")) score += 5
    if (!best || score > best.score) best = { ...item, score }
  }
  return best ? { entry: best.entry, parsed: best.parsed } : null
}

function extractFollowerCountFromText(text?: string | null): number | null {
  if (!text) return null
  const match = text.match(/(\d[\d,]*)\s+followers?/i)
  return match ? parseInt(match[1].replace(/,/g, ""), 10) : null
}

function isNoiseLinkedInUrl(url: string): boolean {
  return /messaging|policy\/notices|realtimeFrontendSubscriptions|presenceStatuses|deliveryAcknowledgements|seenReceipts|quickReplies|psettings|DVyeH0l6|tracking/i.test(url)
}

async function getLinkedInCsrfTokenFromPassiveCapture(tabId?: number): Promise<string | null> {
  if (!tabId) return null
  try {
    const result = await sendNetDirect(tabId, { type: "get_captured_headers", filter: "linkedin.com" }) as { success: boolean; data?: Array<{ headers: Record<string, string> }> }
    if (!result.success || !result.data) return null
    for (let i = result.data.length - 1; i >= 0; i--) {
      const csrf = result.data[i].headers["csrf-token"]
      if (csrf) return csrf.replace(/^"|"$/g, "")
    }
  } catch {}
  return null
}

async function getLinkedInCsrfToken(tabId?: number): Promise<string | null> {
  const passive = await getLinkedInCsrfTokenFromPassiveCapture(tabId)
  if (passive) return passive
  try {
    const cookie = await chrome.cookies.get({ url: "https://www.linkedin.com", name: "JSESSIONID" })
    if (!cookie?.value) return null
    return cookie.value.replace(/^"|"$/g, "")
  } catch {
    return null
  }
}

async function fetchLinkedInJson(url: string): Promise<unknown | null> {
  const csrfToken = await getLinkedInCsrfToken()
  const headers: Record<string, string> = {
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "x-restli-protocol-version": "2.0.0"
  }
  if (csrfToken) headers["csrf-token"] = csrfToken
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function fetchLinkedInEventDetailsById(eventId: string): Promise<unknown | null> {
  const url = `https://www.linkedin.com/voyager/api/events/dash/professionalEvents?decorationId=com.linkedin.voyager.dash.deco.events.ProfessionalEventDetailPage-49&eventIdentifier=${eventId}&q=eventIdentifier`
  return await fetchLinkedInJson(url)
}

async function fetchLinkedInEventAttendeesById(eventId: string, maxCount = 250): Promise<Array<{ user_id: string; display_name: string; headline: string }>> {
  const pageSize = 50
  let start = 0
  const attendees: Array<{ user_id: string; display_name: string; headline: string }> = []
  while (start < maxCount) {
    const url = `https://www.linkedin.com/voyager/api/graphql?variables=(count:${pageSize},start:${start},origin:EVENT_PAGE_CANNED_SEARCH,query:(flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:eventAttending,value:List(${eventId})),(key:resultType,value:List(PEOPLE))),includeFiltersInResponse:false))&&queryId=voyagerSearchDashClusters.a789a8e572711844816fa31872de1e2f`
    const json = await fetchLinkedInJson(url) as Record<string, any> | null
    const included = Array.isArray(json?.included) ? json!.included : []
    const pageAttendees = included
      .filter(item => item?.$type === "com.linkedin.voyager.dash.search.EntityResultViewModel")
      .map(item => {
        const entityUrn = item.entityUrn || ""
        const match = String(entityUrn).match(/fsd_profile:([^,)]+)/)
        return {
          user_id: match?.[1] || "",
          display_name: item?.image?.accessibilityText || "",
          headline: item?.primarySubtitle?.text || ""
        }
      })
      .filter(item => item.user_id && item.display_name)
    if (!pageAttendees.length) break
    attendees.push(...pageAttendees)
    if (pageAttendees.length < pageSize) break
    start += pageSize
  }
  return attendees
}

function extractPostIdFromLogs(entries: CapturedNetworkEntry[], postText: string | null): string | null {
  const clue = normalizeText(postText).slice(0, 80)
  for (const entry of entries) {
    if (!entry.responseBody) continue
    const body = entry.responseBody
    if (clue && !normalizeText(body).includes(clue)) continue
    const match = body.match(/urn:li:ugcPost:(\d{6,})/)
    if (match) return match[1]
  }
  for (const entry of entries) {
    const match = (entry.responseBody || "").match(/urn:li:ugcPost:(\d{6,})/)
    if (match) return match[1]
  }
  return null
}

async function fetchLinkedInReactionsByPostId(postId: string, maxCount = 100): Promise<Array<{ user_id: string; display_name: string; headline?: string }>> {
  const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(count:${maxCount},start:0,threadUrn:${encodeURIComponent(`urn:li:ugcPost:${postId}`)})&&queryId=voyagerSocialDashReactions.9c8a84d441790b2edf06110ed28b675c`
  const json = await fetchLinkedInJson(url) as Record<string, any> | null
  const included = Array.isArray(json?.included) ? json!.included : []
  return included
    .filter(item => item?.$type === "com.linkedin.voyager.dash.social.Reaction")
    .map(item => ({
      user_id: String(item.preDashActorUrn || "").split(":").pop() || "",
      display_name: item?.reactorLockup?.title?.text || "",
      headline: item?.reactorLockup?.subtitle?.text || undefined
    }))
    .filter(item => item.user_id)
}

async function fetchLinkedInCommentsByPostId(postId: string, maxCount = 100): Promise<Array<{ comment_id: string; user_id: string; comment_text: string }>> {
  const encodedPostId = encodeURIComponent(`urn:li:ugcPost:${postId}`)
  const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(count:${maxCount},numReplies:100,socialDetailUrn:urn%3Ali%3Afsd_socialDetail%3A%28${encodedPostId}%2C${encodedPostId}%2Curn%3Ali%3AhighlightedReply%3A-%29,sortOrder:RELEVANCE,start:0)&&queryId=voyagerSocialDashComments.053c2a505a15e5561b6df67b905d056a`
  const json = await fetchLinkedInJson(url) as Record<string, any> | null
  const included = Array.isArray(json?.included) ? json!.included : []
  return included
    .filter(item => item?.$type === "com.linkedin.voyager.dash.social.Comment")
    .map(item => ({
      comment_id: item.urn || "",
      user_id: String(item?.commenter?.actor?.["*profileUrn"] || item?.commenter?.actor?.["*companyUrn"] || "").split(":").pop() || "",
      comment_text: item?.commentary?.text || ""
    }))
    .filter(item => item.comment_id)
}

function extractEventDataFromParsed(parsed: unknown, dom: Record<string, any>) {
  const titleCandidates = collectStringCandidates(parsed, ["title", "name", "headline", "eventname"])
  const organizerCandidates = collectStringCandidates(parsed, ["organizer", "owner", "host", "author", "actor", "name", "fullname", "displayname"])
  const descriptionCandidates = collectStringCandidates(parsed, ["description", "details", "summary", "about", "body"])
  const attendeeNameCandidates = collectStringCandidates(parsed, ["attendee", "member", "participant", "name", "fullname", "displayname"])
  const attendeeCountCandidates = collectNumberCandidates(parsed, ["attendeecount", "membercount", "participantcount", "totalattendees", "totalmembers", "count"])
  const dateCandidates = collectIsoCandidates(parsed, ["start", "end", "time", "date"])
  return {
    title: pickBestString(titleCandidates, dom.title),
    organizerName: pickBestString(organizerCandidates, dom.organizerName),
    startTimeIso: dateCandidates[0] || null,
    endTimeIso: dateCandidates[1] || null,
    attendeeCount: pickBestNumber(attendeeCountCandidates, dom.attendeeCountFromScreen),
    attendeeNames: attendeeNameCandidates
      .map(candidate => candidate.value)
      .filter(value => /^[A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){0,3}$/.test(value))
      .filter((value, index, array) => array.indexOf(value) === index)
      .slice(0, 25),
    detailsText: pickBestString(descriptionCandidates, dom.detailsText, normalizeText(dom.detailsText).slice(0, 80))
  }
}

function extractPostDataFromParsed(parsed: unknown, dom: Record<string, any>) {
  const textCandidates = collectStringCandidates(parsed, ["commentary", "text", "message", "description", "body"])
  const posterCandidates = collectStringCandidates(parsed, ["author", "actor", "owner", "name", "fullname", "displayname"])
  const followerCountCandidates = collectNumberCandidates(parsed, ["followercount", "followerscount"])
  const reactionCountCandidates = collectNumberCandidates(parsed, ["reactioncount", "likecount", "likes", "reaction"])
  const commentCountCandidates = collectNumberCandidates(parsed, ["commentcount", "commentscount", "comments"])
  const repostCountCandidates = collectNumberCandidates(parsed, ["repostcount", "sharecount", "shares", "reposts"])
  return {
    postText: pickBestString(textCandidates, dom.post?.text, normalizeText(dom.post?.text).slice(0, 80)),
    posterName: pickBestString(posterCandidates, dom.post?.posterName),
    followerCount: pickBestNumber(followerCountCandidates, extractFollowerCountFromText(dom.post?.followerCountText)),
    likes: pickBestNumber(reactionCountCandidates, dom.post?.engagement?.likes),
    comments: pickBestNumber(commentCountCandidates, dom.post?.engagement?.comments),
    reposts: pickBestNumber(repostCountCandidates, dom.post?.engagement?.reposts)
  }
}

function validateValue(networkValue: unknown, domValue: unknown): boolean | null {
  if (networkValue === undefined || networkValue === null || domValue === undefined || domValue === null) return null
  if (typeof networkValue === "number" && typeof domValue === "number") return networkValue === domValue
  const left = normalizeText(String(networkValue))
  const right = normalizeText(String(domValue))
  if (!left || !right) return null
  return left === right || left.includes(right) || right.includes(left)
}

async function buildLinkedInEventExtraction(tabId: number, action: { type: string; [key: string]: unknown }): Promise<{ success: boolean; error?: string; data?: unknown }> {
  const currentTab = await chrome.tabs.get(tabId)
  const targetUrl = (action.url as string | undefined) || currentTab.url || ""
  if (!targetUrl) return { success: false, error: "linkedin event extraction requires a URL or active tab URL" }
  if (currentTab.url !== targetUrl) {
    await chrome.tabs.update(tabId, { url: targetUrl })
    await waitForTabLoad(tabId, 20000)
  }
  const waitMs = (action.waitMs as number) || 500
  await new Promise(resolve => setTimeout(resolve, waitMs))
  await sendToContentScript(tabId, { type: "wait_stable", ms: 800, timeout: 6000 })
  const domResult = await sendToContentScript(tabId, { type: "linkedin_event_dom" }) as { success: boolean; data?: Record<string, unknown>; error?: string }
  if (!domResult.success || !domResult.data) return { success: false, error: domResult.error || "failed to extract LinkedIn DOM data" }
  const netResult = await sendNetDirect(tabId, { type: "get_net_log", filter: "linkedin.com" }) as { success: boolean; data?: Array<{ url: string; method: string; status: number; body: string; type: string; timestamp: number; tabUrl: string }>; error?: string }
  const passiveEntries = (netResult.success && netResult.data) ? netResult.data : []
  const logs: CapturedNetworkEntry[] = passiveEntries.map((e, i) => ({
    tabId,
    requestId: `passive-${i}`,
    url: e.url,
    method: e.method,
    timestamp: e.timestamp,
    status: e.status,
    mimeType: e.url.includes("json") || e.body?.startsWith("{") || e.body?.startsWith("[") ? "application/json" : undefined,
    responseBody: e.body
  }))
  return {
    success: true,
    data: await buildLinkedInEventExtractionPayload(targetUrl, domResult.data as Record<string, any>, logs)
  }
}

async function buildLinkedInAttendeesExtraction(tabId: number, action: { type: string; [key: string]: unknown }): Promise<{ success: boolean; error?: string; data?: unknown }> {
  const currentTab = await chrome.tabs.get(tabId)
  const targetUrl = (action.url as string | undefined) || currentTab.url || ""
  if (!targetUrl) return { success: false, error: "linkedin attendee extraction requires a URL or active tab URL" }

  const eventId = extractLinkedInEventId(targetUrl)
  if (!eventId) return { success: false, error: "could not derive LinkedIn event ID from URL" }

  const overrideRules = buildLinkedInEventAttendeeOverrideRules(targetUrl)
  await sendNetDirect(tabId, { type: "set_net_overrides", rules: overrideRules })

  if (currentTab.url !== targetUrl) {
    await chrome.tabs.update(tabId, { url: targetUrl })
    await waitForTabLoad(tabId, 20000)
  }

  const waitMs = (action.waitMs as number) || 500
  await new Promise(resolve => setTimeout(resolve, waitMs))
  await sendToContentScript(tabId, { type: "wait_stable", ms: 800, timeout: 6000 })

  const openResult = await sendToContentScript(tabId, { type: "linkedin_attendees_open" }) as { success: boolean; data?: { opened?: boolean }; error?: string }
  const modalOpened = !!(openResult.success && openResult.data?.opened)

  const modalRows = new Map<string, any>()
  let totalCount: number | null = null
  let batchesLoaded = 0
  if (modalOpened) {
    batchesLoaded = 1
    for (let i = 0; i < 10; i++) {
      const snapshot = await sendToContentScript(tabId, { type: "linkedin_attendees_snapshot" }) as { success: boolean; data?: { isOpen: boolean; totalCount: number | null; rows: any[]; showMoreVisible: boolean }; error?: string }
      if (!snapshot.success || !snapshot.data?.isOpen) break
      totalCount = snapshot.data.totalCount ?? totalCount
      for (const row of snapshot.data.rows || []) {
        const key = row.profileUrl || row.fullName || `${row.rowText}-${modalRows.size}`
        if (!modalRows.has(key)) modalRows.set(key, row)
      }
      if (!snapshot.data.showMoreVisible) break
      const showMore = await sendToContentScript(tabId, { type: "linkedin_attendees_show_more" }) as { success: boolean; data?: { clicked?: boolean }; error?: string }
      if (!showMore.success || !showMore.data?.clicked) break
      batchesLoaded += 1
      await new Promise(resolve => setTimeout(resolve, 1100))
    }
  }

  const apiAttendees = await fetchLinkedInEventAttendeesById(eventId, Math.max(totalCount || 0, 250))
  const modalRowsList = Array.from(modalRows.values())
  const mergedRows = apiAttendees.map(attendee => {
    const modalMatch = modalRowsList.find(row => normalizeText(row.fullName) === normalizeText(attendee.display_name))
    const fullName = modalMatch?.fullName || attendee.display_name || null
    const nameParts = fullName ? fullName.trim().split(/\s+/) : []
    return {
      profileUrl: modalMatch?.profileUrl || null,
      profileSlug: modalMatch?.profileSlug || null,
      fullName,
      firstName: modalMatch?.firstName || (nameParts[0] || null),
      lastName: modalMatch?.lastName || (nameParts.length > 1 ? nameParts.slice(1).join(" ") : null),
      connectionDegree: modalMatch?.connectionDegree || null,
      headline: modalMatch?.headline || attendee.headline || null,
      rowText: modalMatch?.rowText || "",
      userId: attendee.user_id || null
    }
  })

  const enrichLimit = (action.enrichLimit as number | undefined) || mergedRows.length
  const enrichTargets = mergedRows.slice(0, enrichLimit)
  const enrichments: Awaited<ReturnType<typeof enrichLinkedInAttendee>>[] = []
  for (const row of enrichTargets) {
    enrichments.push(await enrichLinkedInAttendee(row))
  }

  await sendNetDirect(tabId, { type: "clear_net_overrides" })

  return {
    success: true,
    data: buildLinkedInAttendeeCliPayload({
      eventId,
      pageUrl: targetUrl,
      modalOpened,
      totalCount,
      batchesLoaded,
      overrideRules,
      rows: enrichTargets,
      enrichments
    })
  }
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId
  if (!tabId) return
  const config = networkCaptureConfigs.get(tabId)
  const overrideRules = networkOverrideConfigs.get(tabId) || []

  try {
    if (method === "Fetch.requestPaused") {
      const request = (params as Record<string, any>).request || {}
      const rule = findMatchingNetworkOverrideRule(request.url || "", request.method, (params as Record<string, any>).resourceType, overrideRules)
      const payload = rule ? applyNetworkOverrideRule(request, (params as Record<string, any>).resourceType, rule) : {}
      await chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", {
        requestId: (params as Record<string, any>).requestId,
        ...(payload.url ? { url: payload.url } : {}),
        ...(payload.headers ? { headers: payload.headers } : {}),
        ...(payload.postData ? { postData: payload.postData } : {})
      })
      return
    }

    if (!config?.enabled) return

    if (method === "Network.requestWillBeSent") {
      const request = (params as Record<string, any>).request
      if (!request?.url || !matchesCapturePatterns(request.url, config.patterns)) return
      pendingNetworkEntries.set(networkEntryKey(tabId, (params as Record<string, any>).requestId), {
        tabId,
        requestId: (params as Record<string, any>).requestId,
        url: request.url,
        method: request.method || "GET",
        resourceType: (params as Record<string, any>).type,
        timestamp: Date.now(),
        requestHeaders: request.headers,
        requestPostData: truncateBody(request.postData)
      })
      return
    }

    if (method === "Network.responseReceived") {
      const requestId = (params as Record<string, any>).requestId
      const key = networkEntryKey(tabId, requestId)
      const existing = pendingNetworkEntries.get(key)
      if (!existing) return
      const response = (params as Record<string, any>).response || {}
      existing.status = response.status
      existing.mimeType = response.mimeType
      existing.responseHeaders = response.headers
      return
    }

    if (method === "Network.loadingFinished") {
      const requestId = (params as Record<string, any>).requestId
      const key = networkEntryKey(tabId, requestId)
      const existing = pendingNetworkEntries.get(key)
      if (!existing) return
      try {
        const bodyResult = await chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId }) as { body?: string; base64Encoded?: boolean }
        existing.responseBody = bodyResult.base64Encoded ? "[base64 body omitted]" : truncateBody(bodyResult.body)
      } catch {}
      appendNetworkLog(tabId, { ...existing })
      pendingNetworkEntries.delete(key)
      return
    }

    if (method === "Network.loadingFailed") {
      const requestId = (params as Record<string, any>).requestId
      const key = networkEntryKey(tabId, requestId)
      const existing = pendingNetworkEntries.get(key)
      if (!existing) return
      existing.errorText = (params as Record<string, any>).errorText || "loading failed"
      appendNetworkLog(tabId, { ...existing })
      pendingNetworkEntries.delete(key)
    }
  } catch (err) {
    console.error("network capture error:", (err as Error).message)
  }
})

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    debuggerAttached.delete(source.tabId)
    fetchInterceptionEnabled.delete(source.tabId)
    networkCaptureConfigs.delete(source.tabId)
    networkOverrideConfigs.delete(source.tabId)
    clearNetworkLogs(source.tabId)
  }
  if (reason === "canceled_by_user") {
    console.log("debugger detached by user (DevTools opened)")
  }
})

async function routeAction(action: { type: string; [key: string]: unknown }, tabId: number): Promise<{ success: boolean; error?: string; data?: unknown; tabId?: number }> {
  switch (action.type) {

    // === OS-LEVEL INPUT (forwarded to daemon with window bounds) ===
    case "os_click": {
      const win = await chrome.windows.getCurrent()
      const windowBounds = { left: win.left || 0, top: win.top || 0, width: win.width || 0, height: win.height || 0 }
      let pageX = action.x as number | undefined
      let pageY = action.y as number | undefined

      if ((action.index !== undefined || action.ref) && (pageX === undefined || pageY === undefined)) {
        const rectResult = await sendToContentScript(tabId, { type: "rect", index: action.index, ref: action.ref }) as { success: boolean; data?: { left: number; top: number; width: number; height: number } }
        if (!rectResult.success || !rectResult.data) return { success: false, error: "failed to get element coordinates for os_click" }
        const rect = rectResult.data
        pageX = rect.left + rect.width / 2
        pageY = rect.top + rect.height / 2
      }

      if (pageX === undefined || pageY === undefined) return { success: false, error: "os_click requires element target or x,y coordinates" }

      const chromeUiHeight = (action.chromeUiHeight as number) || (88 + (debuggerAttached.has(tabId) ? 35 : 0))
      return { success: true, data: { method: "os_event", screenTarget: { pageX, pageY }, windowBounds, button: action.button || "left", clickCount: action.clickCount || 1, chromeUiHeight } }
    }

    case "os_key": {
      return { success: true, data: { method: "os_event", key: action.key, modifiers: action.modifiers || [] } }
    }

    case "os_type": {
      if (action.index !== undefined || action.ref) {
        await sendToContentScript(tabId, { type: "focus", index: action.index, ref: action.ref })
        await new Promise(r => setTimeout(r, 50))
      }
      return { success: true, data: { method: "os_event", text: action.text } }
    }

    case "os_move": {
      const win = await chrome.windows.getCurrent()
      const windowBounds = { left: win.left || 0, top: win.top || 0, width: win.width || 0, height: win.height || 0 }
      const chromeUiHeight = (action.chromeUiHeight as number) || (88 + (debuggerAttached.has(tabId) ? 35 : 0))
      return { success: true, data: { method: "os_event", path: action.path, windowBounds, duration: action.duration || 100, chromeUiHeight } }
    }

    case "screenshot_background": {
      const format = (action.format as string) === "png" ? "image/png" : "image/jpeg"
      const quality = ((action.quality as number) || 50) / 100
      try {
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
        const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] })
        if (contexts.length === 0) {
          await chrome.offscreen.createDocument({
            url: "offscreen.html",
            reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
            justification: "Background tab screenshot via tabCapture"
          })
        }
        await new Promise<void>((resolve) => {
          chrome.runtime.sendMessage({ target: "offscreen", type: "capture_start", streamId }, () => resolve())
        })
        await new Promise(r => setTimeout(r, 300))
        const frameResult = await sendToOffscreen({ type: "capture_frame", format, quality }) as { success: boolean; data?: string; error?: string }
        await sendToOffscreen({ type: "capture_stop" })
        if (!frameResult.success) return { success: false, error: frameResult.error || "capture frame failed" }
        const dataUrl = frameResult.data!
        const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75)
        return { success: true, data: { dataUrl, format: action.format || "jpeg", size: sizeBytes, method: "tabCapture" } }
      } catch (err) {
        return { success: false, error: `tabCapture failed: ${(err as Error).message}` }
      }
    }

    case "cdp_tree": {
      const depth = (action.depth as number) || undefined
      const result = await cdpAttachActDetach<{ nodes: unknown[] }>(tabId, "Accessibility.getFullAXTree", depth ? { depth } : undefined)
      if (!result.success) return { success: false, error: result.error }
      const nodes = result.data?.nodes || []
      const formatted = nodes.map((n: any) => {
        const role = n.role?.value || ""
        const name = n.name?.value || ""
        const nodeId = n.nodeId || ""
        return `[${nodeId}] ${role} "${name}"`
      }).join("\n")
      return { success: true, data: formatted || "empty tree" }
    }

    case "capabilities": {
      const daemonConnected = activeTransport !== "none"
      const hasTabCapture = true
      const hasDebugger = chrome.runtime.getManifest().permissions?.includes("debugger") ?? false
      const debuggerActive = debuggerAttached.size > 0
      return { success: true, data: { layers: { os_input: daemonConnected, tabCapture: hasTabCapture, cdp_debugger: hasDebugger, debugger_active: debuggerActive }, daemon: daemonConnected, infoBannerHeight: debuggerActive ? 35 : 0 } }
    }

    // === META ===
    case "status":
      return { success: true, data: { connected: true, version: chrome.runtime.getManifest().version } }

    case "reload_extension":
      setTimeout(() => chrome.runtime.reload(), 100)
      return { success: true, data: "reloading in 100ms" }

    // === SCREENSHOTS & CAPTURE ===
    case "screenshot": {
      const format = (action.format as string) === "png" ? "png" : "jpeg"
      const quality = (action.quality as number) || 50

      if (action.full) {
        const dims = await sendToContentScript(tabId, { type: "get_page_dimensions" }) as { success: boolean; data?: { scrollHeight: number; scrollWidth: number; viewportHeight: number; viewportWidth: number; scrollY: number; devicePixelRatio: number } }
        if (!dims.success || !dims.data) return { success: false, error: "failed to get page dimensions" }
        const { scrollHeight, viewportHeight, viewportWidth, scrollY: origScrollY, devicePixelRatio } = dims.data
        const stripCount = Math.ceil(scrollHeight / viewportHeight)
        const strips: { dataUrl: string; y: number }[] = []

        for (let i = 0; i < stripCount; i++) {
          const scrollTo = i * viewportHeight
          await sendToContentScript(tabId, { type: "scroll_absolute", y: scrollTo })
          await new Promise(r => setTimeout(r, 150))
          const stripUrl = await chrome.tabs.captureVisibleTab(undefined, { format, quality })
          const stripHeight = (i === stripCount - 1) ? scrollHeight - scrollTo : viewportHeight
          strips.push({ dataUrl: stripUrl, y: Math.round(scrollTo * devicePixelRatio) })
          if (i < stripCount - 1) await new Promise(r => setTimeout(r, 500))
        }

        await sendToContentScript(tabId, { type: "scroll_absolute", y: origScrollY })

        const stitchResult = await sendToOffscreen({
          type: "stitch",
          strips,
          totalWidth: Math.round(viewportWidth * devicePixelRatio),
          totalHeight: Math.round(scrollHeight * devicePixelRatio),
          format,
          quality: quality / 100
        }) as { success: boolean; data?: string; error?: string }

        if (!stitchResult.success) return { success: false, error: stitchResult.error }
        const stitchedUrl = stitchResult.data!
        const stitchedSize = Math.round((stitchedUrl.length - stitchedUrl.indexOf(",") - 1) * 0.75)

        if (action.save) {
          return { success: true, data: { dataUrl: stitchedUrl, format, size: stitchedSize, save: true, strips: stripCount } }
        }

        return { success: true, data: { dataUrl: stitchedUrl, format, size: stitchedSize, strips: stripCount } }
      }

      let dataUrl: string
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format, quality })
      } catch (captureErr) {
        const fallback = await routeAction({ type: "screenshot_background", format: action.format, quality: action.quality }, tabId)
        if (fallback.success && fallback.data) {
          (fallback.data as Record<string, unknown>).fallback = "tabCapture (captureVisibleTab failed)"
        }
        return fallback
      }
      const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75)

      if (action.save) {
        return { success: true, data: { dataUrl, format, size: sizeBytes, save: true } }
      }

      let clip = action.clip as { x: number; y: number; width: number; height: number } | undefined
      if (!clip && action.element !== undefined) {
        const elemResult = await sendToContentScript(tabId, { type: "rect", index: action.element }) as { success: boolean; data?: { x: number; y: number; width: number; height: number } }
        if (elemResult.success && elemResult.data) {
          clip = elemResult.data
        }
      }

      if (clip) {
        const cropResult = await sendToOffscreen({ type: "crop", dataUrl, clip }) as { success: boolean; data?: string; error?: string }
        if (!cropResult.success) return { success: false, error: cropResult.error }
        const croppedUrl = cropResult.data!
        const croppedSize = Math.round((croppedUrl.length - croppedUrl.indexOf(",") - 1) * 0.75)
        return { success: true, data: { dataUrl: croppedUrl, format, size: croppedSize, clip } }
      }

      if (format === "png" && sizeBytes > 800 * 1024) {
        return { success: true, data: { dataUrl, format, size: sizeBytes, warning: "PNG exceeds 800KB — consider using JPEG for smaller responses" } }
      }

      return { success: true, data: { dataUrl, format, size: sizeBytes } }
    }

    case "page_capture": {
      const mhtml = await chrome.pageCapture.saveAsMHTML({ tabId })
      const text = await (mhtml as Blob).text()
      return { success: true, data: { size: text.length, preview: text.slice(0, 500) } }
    }

    // === NAVIGATION ===
    case "navigate":
      await chrome.tabs.update(tabId, { url: action.url as string })
      await waitForTabLoad(tabId)
      return { success: true }

    case "go_back":
      await chrome.tabs.goBack(tabId)
      await waitForTabLoad(tabId)
      return { success: true }

    case "go_forward":
      await chrome.tabs.goForward(tabId)
      await waitForTabLoad(tabId)
      return { success: true }

    case "reload":
      await chrome.tabs.reload(tabId, { bypassCache: !!action.bypassCache })
      await waitForTabLoad(tabId)
      return { success: true }

    // === TABS ===
    case "tab_create": {
      const newTab = await chrome.tabs.create({ url: (action.url as string) || "about:blank" })
      if (newTab.id) {
        const groupId = await addTabToSlopGroup(newTab.id)
        return { success: true, data: { tabId: newTab.id, url: newTab.url, groupId } }
      }
      return { success: true, data: { tabId: newTab.id, url: newTab.url } }
    }

    case "tab_close":
      await chrome.tabs.remove((action.tabId as number) || tabId)
      return { success: true }

    case "tab_switch":
      await chrome.tabs.update(action.tabId as number, { active: true })
      return { success: true }

    case "tab_list": {
      const tabs = await chrome.tabs.query({})
      await ensureSlopGroup()
      const tabData = tabs.map(t => ({
        id: t.id, url: t.url, title: t.title, active: t.active,
        windowId: t.windowId, muted: t.mutedInfo?.muted, pinned: t.pinned,
        groupId: t.groupId,
        managed: slopGroupId !== null && t.groupId === slopGroupId
      }))
      return { success: true, data: tabData }
    }

    case "tab_duplicate": {
      const dup = await chrome.tabs.duplicate(tabId)
      return { success: true, data: { tabId: dup?.id } }
    }

    case "tab_reload":
      await chrome.tabs.reload(tabId, { bypassCache: !!action.bypassCache })
      await waitForTabLoad(tabId)
      return { success: true }

    case "tab_mute":
      await chrome.tabs.update(tabId, { muted: !!(action.muted ?? true) })
      return { success: true }

    case "tab_pin":
      await chrome.tabs.update(tabId, { pinned: !!(action.pinned ?? true) })
      return { success: true }

    case "tab_zoom_get": {
      const zoom = await chrome.tabs.getZoom(tabId)
      return { success: true, data: { zoom } }
    }

    case "tab_zoom_set":
      await chrome.tabs.setZoom(tabId, action.zoom as number)
      return { success: true }

    case "tab_group": {
      const groupId = await chrome.tabs.group({ tabIds: tabId, groupId: action.groupId as number | undefined })
      if (action.title || action.color) {
        await chrome.tabGroups.update(groupId, {
          title: action.title as string | undefined,
          color: action.color as chrome.tabGroups.ColorEnum | undefined
        })
      }
      return { success: true, data: { groupId } }
    }

    case "tab_ungroup":
      await chrome.tabs.ungroup(tabId)
      return { success: true }

    case "tab_move":
      await chrome.tabs.move(tabId, {
        windowId: action.windowId as number | undefined,
        index: (action.index as number) ?? -1
      })
      return { success: true }

    case "tab_discard":
      await chrome.tabs.discard(tabId)
      return { success: true }

    // === WINDOWS ===
    case "window_create": {
      const win = await chrome.windows.create({
        url: action.url as string | undefined,
        type: (action.windowType as chrome.windows.createTypeEnum) || "normal",
        width: action.width as number | undefined,
        height: action.height as number | undefined,
        left: action.left as number | undefined,
        top: action.top as number | undefined,
        incognito: !!action.incognito,
        focused: action.focused !== false
      })
      const firstTab = win.tabs?.[0]
      let groupId: number | undefined
      if (firstTab?.id && !action.incognito) {
        groupId = await addTabToSlopGroup(firstTab.id)
      }
      return { success: true, data: { windowId: win.id, groupId, tabs: win.tabs?.map(t => ({ id: t.id, url: t.url })) } }
    }

    case "window_close":
      await chrome.windows.remove(action.windowId as number)
      return { success: true }

    case "window_focus":
      await chrome.windows.update(action.windowId as number, { focused: true })
      return { success: true }

    case "window_resize":
      await chrome.windows.update(action.windowId as number || (await chrome.windows.getCurrent()).id, {
        width: action.width as number | undefined,
        height: action.height as number | undefined,
        left: action.left as number | undefined,
        top: action.top as number | undefined,
        state: action.state as chrome.windows.windowStateEnum | undefined
      })
      return { success: true }

    case "window_list":
    case "window_get_all": {
      const windows = await chrome.windows.getAll({ populate: true })
      return {
        success: true, data: windows.map(w => ({
          id: w.id, type: w.type, state: w.state, focused: w.focused,
          width: w.width, height: w.height, left: w.left, top: w.top,
          incognito: w.incognito,
          tabs: w.tabs?.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active }))
        }))
      }
    }

    // === COOKIES ===
    case "cookies_get": {
      const cookies = await chrome.cookies.getAll({ domain: action.domain as string })
      return { success: true, data: cookies }
    }

    case "cookies_set": {
      const cookie = await chrome.cookies.set(action.cookie as chrome.cookies.SetDetails)
      return { success: true, data: cookie }
    }

    case "cookies_delete":
      await chrome.cookies.remove({ url: action.url as string, name: action.name as string })
      return { success: true }

    // === HISTORY ===
    case "history_search": {
      const items = await chrome.history.search({
        text: (action.query as string) || "",
        maxResults: (action.maxResults as number) || 50,
        startTime: action.startTime as number | undefined,
        endTime: action.endTime as number | undefined
      })
      return { success: true, data: items.map(i => ({ url: i.url, title: i.title, lastVisit: i.lastVisitTime, visitCount: i.visitCount })) }
    }

    case "history_visits": {
      const visits = await chrome.history.getVisits({ url: action.url as string })
      return { success: true, data: visits }
    }

    case "history_delete":
      await chrome.history.deleteUrl({ url: action.url as string })
      return { success: true }

    case "history_delete_range":
      await chrome.history.deleteRange({ startTime: action.startTime as number, endTime: action.endTime as number })
      return { success: true }

    case "history_delete_all":
      await chrome.history.deleteAll()
      return { success: true }

    // === BOOKMARKS ===
    case "bookmark_tree": {
      const tree = await chrome.bookmarks.getTree()
      return { success: true, data: tree }
    }

    case "bookmark_search": {
      const results = await chrome.bookmarks.search(action.query as string)
      return { success: true, data: results.map(b => ({ id: b.id, title: b.title, url: b.url, parentId: b.parentId })) }
    }

    case "bookmark_create": {
      const bm = await chrome.bookmarks.create({
        title: action.title as string,
        url: action.url as string | undefined,
        parentId: action.parentId as string | undefined
      })
      return { success: true, data: bm }
    }

    case "bookmark_delete":
      await chrome.bookmarks.remove(action.id as string)
      return { success: true }

    case "bookmark_update":
      await chrome.bookmarks.update(action.id as string, {
        title: action.title as string | undefined,
        url: action.url as string | undefined
      })
      return { success: true }

    // === DOWNLOADS ===
    case "downloads_start": {
      const downloadId = await chrome.downloads.download({
        url: action.url as string,
        filename: action.filename as string | undefined,
        saveAs: !!action.saveAs
      })
      return { success: true, data: { downloadId } }
    }

    case "downloads_search": {
      const items = await chrome.downloads.search({
        query: action.query ? [action.query as string] : undefined,
        limit: (action.limit as number) || 20,
        orderBy: ["-startTime"]
      })
      return {
        success: true, data: items.map(d => ({
          id: d.id, url: d.url, filename: d.filename, state: d.state,
          bytesReceived: d.bytesReceived, totalBytes: d.totalBytes,
          mime: d.mime, startTime: d.startTime
        }))
      }
    }

    case "downloads_cancel":
      await chrome.downloads.cancel(action.downloadId as number)
      return { success: true }

    case "downloads_pause":
      await chrome.downloads.pause(action.downloadId as number)
      return { success: true }

    case "downloads_resume":
      await chrome.downloads.resume(action.downloadId as number)
      return { success: true }

    // === BROWSING DATA ===
    case "browsing_data_remove": {
      const since = (action.since as number) || 0
      const types: Record<string, boolean> = {}
      const requested = (action.types as string[]) || ["cache"]
      for (const t of requested) {
        if (t === "cache") types.cache = true
        if (t === "cookies") types.cookies = true
        if (t === "history") types.history = true
        if (t === "formData") types.formData = true
        if (t === "downloads") types.downloads = true
        if (t === "localStorage") types.localStorage = true
        if (t === "indexedDB") types.indexedDB = true
        if (t === "serviceWorkers") types.serviceWorkers = true
        if (t === "passwords") types.passwords = true
      }
      await chrome.browsingData.remove({ since }, types as chrome.browsingData.DataTypeSet)
      return { success: true }
    }

    // === SESSIONS ===
    case "session_list": {
      const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: (action.maxResults as number) || 10 })
      return {
        success: true, data: sessions.map(s => ({
          tab: s.tab ? { url: s.tab.url, title: s.tab.title, sessionId: s.tab.sessionId } : undefined,
          window: s.window ? { sessionId: s.window.sessionId, tabCount: s.window.tabs?.length } : undefined,
          lastModified: s.lastModified
        }))
      }
    }

    case "session_restore": {
      const restored = await chrome.sessions.restore(action.sessionId as string)
      return { success: true, data: restored }
    }

    // === NOTIFICATIONS ===
    case "notification_create": {
      const notifId = await chrome.notifications.create(action.notifId as string || "", {
        type: "basic",
        title: action.title as string || "slop-browser",
        message: action.message as string || "",
        iconUrl: action.iconUrl as string || "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      })
      return { success: true, data: { notifId } }
    }

    case "notification_clear":
      await chrome.notifications.clear(action.notifId as string)
      return { success: true }

    // === SEARCH ===
    case "search_query":
      await chrome.search.query({ text: action.query as string, disposition: "NEW_TAB" })
      return { success: true }

    // === FRAMES ===
    case "frames_list": {
      const frames = await chrome.webNavigation.getAllFrames({ tabId })
      return { success: true, data: frames?.map(f => ({ frameId: f.frameId, url: f.url, parentFrameId: f.parentFrameId })) }
    }

    case "network_intercept": {
      if (action.enabled === false) {
        await disableNetworkCapture(tabId)
        return { success: true, data: { enabled: false, captured: getNetworkLogs(tabId).length } }
      }
      const patterns = Array.isArray(action.patterns) ? (action.patterns as string[]) : []
      await enableNetworkCapture(tabId, patterns)
      return { success: true, data: { enabled: true, patterns } }
    }

    case "network_log": {
      const since = (action.since as number) || 0
      const limit = (action.limit as number) || 100
      const logs = getNetworkLogs(tabId)
        .filter(entry => !since || entry.timestamp >= since)
        .slice(-limit)
      return { success: true, data: logs }
    }

    case "network_override": {
      const rules = action.enabled === false ? [] : ((action.rules as NetworkOverrideRule[] | undefined) || [])
      networkOverrideConfigs.set(tabId, rules)
      await refreshFetchInterception(tabId)
      return { success: true, data: { enabled: rules.length > 0, ruleCount: rules.length, rules } }
    }

    case "net_log": {
      const result = await sendNetDirect(tabId, {
        type: "get_net_log",
        filter: action.filter as string | undefined,
        since: action.since as number | undefined
      }) as { success: boolean; data?: unknown[]; error?: string }
      if (!result.success) return { success: false, error: result.error || "failed to get passive net log" }
      let entries = result.data || []
      const limit = (action.limit as number) || 100
      entries = entries.slice(-limit)
      return { success: true, data: entries }
    }

    case "net_clear": {
      const result = await sendNetDirect(tabId, { type: "clear_net_log" }) as { success: boolean; error?: string }
      return result.success ? { success: true, data: "passive net log cleared" } : { success: false, error: result.error }
    }

    case "net_headers": {
      const result = await sendNetDirect(tabId, {
        type: "get_captured_headers",
        filter: action.filter as string | undefined
      }) as { success: boolean; data?: unknown[]; error?: string }
      if (!result.success) return { success: false, error: result.error || "failed to get captured headers" }
      return { success: true, data: result.data }
    }

    case "linkedin_event_extract":
      return await buildLinkedInEventExtraction(tabId, action)

    case "linkedin_attendees_extract":
      return await buildLinkedInAttendeesExtraction(tabId, action)

    // === DECLARATIVE NET REQUEST (HEADERS) ===
    case "headers_modify": {
      const rules = action.rules as Array<{ operation: string; header: string; value?: string }> | undefined
      if (!rules || rules.length === 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: Array.from({ length: 100 }, (_, i) => i + 1) })
        return { success: true, data: "all header rules cleared" }
      }
      const dnrRules: chrome.declarativeNetRequest.Rule[] = rules.map((r, i) => ({
        id: i + 1,
        priority: 1,
        action: {
          type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: [{
            header: r.header,
            operation: r.operation === "remove" ? "remove" as chrome.declarativeNetRequest.HeaderOperation : "set" as chrome.declarativeNetRequest.HeaderOperation,
            value: r.value
          }]
        },
        condition: { urlFilter: "*" }
      }))
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: dnrRules.map(r => r.id),
        addRules: dnrRules
      })
      return { success: true }
    }

    // === CANVAS INTELLIGENCE ===
    case "canvas_list": {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const canvases = Array.from(document.querySelectorAll("canvas"))
          function walkShadowRoots(root: Element | ShadowRoot): HTMLCanvasElement[] {
            const found: HTMLCanvasElement[] = []
            const children = root instanceof ShadowRoot ? Array.from(root.children) : Array.from(root.children)
            for (const child of children) {
              if (child.tagName === "CANVAS") found.push(child as HTMLCanvasElement)
              const shadow = (child as any).shadowRoot
              if (shadow) found.push(...walkShadowRoots(shadow))
              found.push(...walkShadowRoots(child))
            }
            return found
          }
          const shadowCanvases = walkShadowRoots(document.body)
          const all = [...new Set([...canvases, ...shadowCanvases])]
          return all.map((c, i) => {
            const rect = c.getBoundingClientRect()
            let contextType = "none"
            try {
              if (c.getContext("2d")) contextType = "2d"
              else if (c.getContext("webgl2")) contextType = "webgl2"
              else if (c.getContext("webgl")) contextType = "webgl"
              else if (c.getContext("bitmaprenderer")) contextType = "bitmaprenderer"
            } catch {}
            const style = getComputedStyle(c)
            const hidden = style.display === "none" || style.visibility === "hidden" || (c.width === 0 && c.height === 0)
            return {
              index: i,
              width: c.width,
              height: c.height,
              cssWidth: rect.width,
              cssHeight: rect.height,
              x: rect.x,
              y: rect.y,
              contextType,
              hidden,
              id: c.id || undefined,
              className: c.className || undefined,
            }
          })
        }
      })
      return { success: true, data: results[0]?.result ?? [] }
    }

    case "canvas_read": {
      const canvasIdx = action.canvasIndex as number
      const fmt = (action.format as string) === "png" ? "image/png" : "image/jpeg"
      const qual = (action.quality as number) || 0.5
      const region = action.region as { x: number; y: number; width: number; height: number } | undefined
      const isWebgl = action.webgl as boolean | undefined

      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [canvasIdx, fmt, qual, region ?? null, isWebgl ?? false],
        func: (idx: number, format: string, quality: number, reg: { x: number; y: number; width: number; height: number } | null, webgl: boolean) => {
          const canvases = Array.from(document.querySelectorAll("canvas"))
          const c = canvases[idx]
          if (!c) return { success: false, error: `no canvas at index ${idx}` }

          try {
            if (reg) {
              const ctx = c.getContext("2d")
              if (!ctx) return { success: false, error: "canvas has no 2d context for region read" }
              const data = ctx.getImageData(reg.x, reg.y, reg.width, reg.height)
              const tmpCanvas = document.createElement("canvas")
              tmpCanvas.width = reg.width
              tmpCanvas.height = reg.height
              const tmpCtx = tmpCanvas.getContext("2d")!
              tmpCtx.putImageData(data, 0, 0)
              return { success: true, data: tmpCanvas.toDataURL(format, quality) }
            }

            if (webgl) {
              const gl = c.getContext("webgl2") || c.getContext("webgl")
              if (!gl) return { success: false, error: "canvas has no webgl context" }
              const pixels = new Uint8Array(c.width * c.height * 4)
              gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
              const tmpCanvas = document.createElement("canvas")
              tmpCanvas.width = c.width
              tmpCanvas.height = c.height
              const tmpCtx = tmpCanvas.getContext("2d")!
              const imageData = tmpCtx.createImageData(c.width, c.height)
              for (let row = 0; row < c.height; row++) {
                const srcOff = row * c.width * 4
                const dstOff = (c.height - 1 - row) * c.width * 4
                imageData.data.set(pixels.subarray(srcOff, srcOff + c.width * 4), dstOff)
              }
              tmpCtx.putImageData(imageData, 0, 0)
              return { success: true, data: tmpCanvas.toDataURL(format, quality) }
            }

            return { success: true, data: c.toDataURL(format, quality) }
          } catch (e: any) {
            if (e.message?.includes("tainted")) return { success: false, error: "canvas is tainted (cross-origin content)" }
            return { success: false, error: e.message }
          }
        }
      })
      const res = results[0]?.result as { success: boolean; error?: string; data?: string } | undefined
      if (!res) return { success: false, error: "no result from canvas read" }
      if (!res.success) return { success: false, error: res.error }
      const dataUrl = res.data!
      const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75)
      if (sizeBytes > 800 * 1024) {
        return { success: true, data: { dataUrl, size: sizeBytes, warning: "Response exceeds 800KB — consider JPEG or smaller region" } }
      }
      return { success: true, data: { dataUrl, size: sizeBytes } }
    }

    // === TAB CAPTURE STREAM ===
    case "capture_start": {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] })
      if (contexts.length === 0) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
          justification: "Tab capture stream processing"
        })
      }
      chrome.runtime.sendMessage({ target: "offscreen", type: "capture_start", streamId })
      return { success: true, data: { streamId, tabId } }
    }

    case "capture_frame": {
      const fmt = (action.format as string) === "png" ? "image/png" : "image/jpeg"
      const qual = (action.quality as number) || 50
      const frameResult = await sendToOffscreen({ type: "capture_frame", format: fmt, quality: qual / 100 }) as { success: boolean; data?: string; error?: string }
      if (!frameResult.success) return { success: false, error: frameResult.error }
      return { success: true, data: { dataUrl: frameResult.data } }
    }

    case "capture_stop": {
      const stopResult = await sendToOffscreen({ type: "capture_stop" }) as { success: boolean }
      try { await chrome.offscreen.closeDocument() } catch {}
      return { success: true }
    }

    case "canvas_diff": {
      const image1 = action.image1 as string
      const image2 = action.image2 as string
      const threshold = (action.threshold as number) || 0
      const returnImage = (action.returnImage as boolean) || false
      const diffResult = await sendToOffscreen({ type: "diff", image1, image2, threshold, returnImage }) as { success: boolean; data?: unknown; error?: string }
      if (!diffResult.success) return { success: false, error: diffResult.error }
      return { success: true, data: diffResult.data }
    }

    // === JAVASCRIPT EVALUATION ===
    case "evaluate": {
      const code = action.code as string
      const world = (action.world as string) === "ISOLATED" ? "ISOLATED" : "MAIN"
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: world as "MAIN" | "ISOLATED",
        args: [code],
        func: (c: string) => {
          try {
            const w = window as any
            if (w.trustedTypes) {
              if (!w.__slop_tt_policy) {
                try {
                  w.__slop_tt_policy = w.trustedTypes.createPolicy("slop-eval", {
                    createScript: (s: string) => s
                  })
                } catch {
                  try {
                    w.__slop_tt_policy = w.trustedTypes.createPolicy("slop-eval-" + Date.now(), {
                      createScript: (s: string) => s
                    })
                  } catch {}
                }
              }
              if (w.__slop_tt_policy) {
                const trusted = w.__slop_tt_policy.createScript(c)
                const r = (0, eval)(trusted)
                return { success: true, data: (typeof r === "object" && r !== null) ? JSON.parse(JSON.stringify(r)) : r }
              }
            }
            const r = (0, eval)(c)
            return { success: true, data: (typeof r === "object" && r !== null) ? JSON.parse(JSON.stringify(r)) : r }
          } catch (e: any) {
            return { success: false, error: e.message }
          }
        }
      })
      return (results[0]?.result as { success: boolean; error?: string; data?: unknown }) ?? { success: false, error: "no result" }
    }

    // === CONTENT SCRIPT ACTIONS (forwarded to content.ts) ===
    default: {
      const contentResult = await sendToContentScript(tabId, action, action.frameId as number | undefined) as { success: boolean; error?: string; data?: unknown; warning?: string }

      if (action.type === "click" && contentResult.success && contentResult.warning?.includes("no DOM change") && activeTransport !== "none") {
        console.log("auto-escalating click to OS-level input")
        const osResult = await routeAction({ ...action, type: "os_click" }, tabId)
        if (osResult.success) {
          return { success: true, data: { ...((typeof osResult.data === "object" && osResult.data) || {}), escalated: { from: "synthetic", to: "os_click", reason: "no DOM mutation after synthetic click" } }, tabId }
        }
        return { success: false, error: "click failed at all layers", data: { diagnostics: { layers_tried: ["synthetic", "os_click"], reason: "synthetic produced no DOM change, os_click failed", suggestion: "verify element is interactive and Chrome window is visible" } } }
      }

      if (!contentResult.success && contentResult.error) {
        (contentResult as Record<string, unknown>).data = { ...(typeof contentResult.data === "object" && contentResult.data ? contentResult.data : {}), diagnostics: { layer_tried: "content_script", reason: contentResult.error, suggestion: action.type === "click" ? "try: slop click --os " + (action.ref || action.index || "") : undefined } }
      }

      return contentResult
    }
  }
}

let wsChannel: WebSocket | null = null
let wsReady = false
let wsKeepAliveTimer: ReturnType<typeof setInterval> | null = null
const WS_URL = "ws://localhost:19222"

function startWsKeepAlive() {
  if (wsKeepAliveTimer) clearInterval(wsKeepAliveTimer)
  wsKeepAliveTimer = setInterval(() => {
    if (!wsChannel || wsChannel.readyState !== WebSocket.OPEN) {
      if (wsKeepAliveTimer) clearInterval(wsKeepAliveTimer)
      wsKeepAliveTimer = null
      return
    }
    try {
      wsChannel.send(JSON.stringify({ type: "keepalive", timestamp: Date.now() }))
    } catch {}
  }, 20_000)
}

function stopWsKeepAlive() {
  if (wsKeepAliveTimer) clearInterval(wsKeepAliveTimer)
  wsKeepAliveTimer = null
}

function connectWsChannel() {
  if (wsChannel && (wsChannel.readyState === WebSocket.OPEN || wsChannel.readyState === WebSocket.CONNECTING)) return
  try {
    const ws = new WebSocket(WS_URL)
    ws.onopen = () => {
      wsChannel = ws
      wsReady = true
      ws.send(JSON.stringify({ type: "extension" }))
      startWsKeepAlive()
      console.log("ws channel connected")
      if (activeTransport !== "native") {
        activeTransport = "websocket"
        reconnectDelay = 1000
        isConnecting = false
        console.log("connection ready via ws channel")
        drainMessageQueue()
      }
    }
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : "")
        console.log("ws onmessage:", JSON.stringify(msg).slice(0, 200))
        if (msg.id && msg.action) {
          msg._viaWs = true
          handleDaemonMessage(msg)
        }
      } catch (err) {
        console.error("ws onmessage error:", err)
      }
    }
    ws.onclose = () => {
      stopWsKeepAlive()
      wsReady = false
      wsChannel = null
      if (activeTransport === "websocket") activeTransport = "none"
    }
    ws.onerror = () => {
      stopWsKeepAlive()
      wsReady = false
      wsChannel = null
      if (activeTransport === "websocket") activeTransport = "none"
    }
  } catch {}
}

function sendToHost(msg: unknown, forceWs?: boolean) {
  if (forceWs && wsReady && wsChannel) {
    try { wsChannel.send(JSON.stringify(msg)) } catch {}
    return
  }
  if (activeTransport === "native" && nativePort) {
    nativePort.postMessage(msg)
    return
  }
  if (activeTransport === "websocket" && wsReady && wsChannel) {
    try { wsChannel.send(JSON.stringify(msg)) } catch {}
    return
  }
  if (nativePort) {
    nativePort.postMessage(msg)
    return
  }
  if (wsReady && wsChannel) {
    try { wsChannel.send(JSON.stringify(msg)) } catch {}
  }
}

async function sendToContentScript(tabId: number, action: { type: string; [key: string]: unknown }, frameId?: number): Promise<unknown> {
  return new Promise((resolve) => {
    const targetFrame = frameId !== undefined ? frameId : 0
    const opts = { frameId: targetFrame }
    chrome.tabs.sendMessage(tabId, { type: "execute_action", action }, opts as chrome.tabs.MessageSendOptions, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message })
      } else {
        resolve(response ?? { success: false, error: "no response from content script" })
      }
    })
  })
}

async function sendNetDirect(tabId: number, msg: { type: string; [key: string]: unknown }): Promise<unknown> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 } as chrome.tabs.MessageSendOptions, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message })
      } else {
        resolve(response ?? { success: false, error: "no response from content script" })
      }
    })
  })
}

function waitForTabLoad(tabId: number, timeoutMs = 15000): Promise<{ ready: boolean; elapsed: number }> {
  return new Promise((resolve) => {
    const start = Date.now()
    const stage1Timeout = Math.min(timeoutMs, 10000)

    const hardTimer = setTimeout(async () => {
      chrome.tabs.onUpdated.removeListener(listener)
      const probeResult = await probeContentReady(tabId, Math.max(timeoutMs - (Date.now() - start), 1000))
      resolve({ ready: probeResult, elapsed: Date.now() - start })
    }, timeoutMs)

    function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(hardTimer)
        chrome.tabs.onUpdated.removeListener(listener)
        const remaining = Math.max(timeoutMs - (Date.now() - start), 2000)
        probeContentReady(tabId, remaining).then((ready) => {
          resolve({ ready, elapsed: Date.now() - start })
        })
      }
    }

    chrome.tabs.onUpdated.addListener(listener)

    setTimeout(async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null)
      if (tab && tab.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener)
        clearTimeout(hardTimer)
        const remaining = Math.max(timeoutMs - (Date.now() - start), 2000)
        const ready = await probeContentReady(tabId, remaining)
        resolve({ ready, elapsed: Date.now() - start })
      }
    }, stage1Timeout)
  })
}

async function probeContentReady(tabId: number, timeoutMs: number): Promise<boolean> {
  try {
    const result = await sendToContentScript(tabId, { type: "wait_stable", ms: 500, timeout: Math.min(timeoutMs, 5000) }) as { success: boolean; data?: { stable: boolean } }
    return result.success && (result.data?.stable ?? true)
  } catch {
    return false
  }
}

let keepalivePongTimer: ReturnType<typeof setTimeout> | null = null

chrome.alarms.create("keepalive", { periodInMinutes: 0.5 })

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "keepalive") return
  if (!nativePort) connectToHost()
  if (!wsChannel || wsChannel.readyState === WebSocket.CLOSED) connectWsChannel()
  if (activeTransport === "native" && nativePort) {
    nativePort.postMessage({ type: "ping" })
    keepalivePongTimer = setTimeout(() => {
      console.error("keepalive pong timeout (5s) — forcing reconnect")
      if (nativePort) nativePort.disconnect()
    }, 5000)
  }
})

chrome.tabs.onRemoved.addListener(async (removedTabId) => {
  if (slopGroupId === null) return
  try {
    const tabs = await chrome.tabs.query({ groupId: slopGroupId })
    if (tabs.length === 0) {
      slopGroupId = null
    }
  } catch {
    slopGroupId = null
  }
})

chrome.runtime.onInstalled.addListener(() => { connectToHost(); connectWsChannel(); ensureSlopGroup() })
chrome.runtime.onStartup.addListener(() => { connectToHost(); connectWsChannel(); ensureSlopGroup() })
connectToHost()
connectWsChannel()
