import { debuggerAttached } from "./cdp"

export type CapturedNetworkEntry = {
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

export type NetworkCaptureConfig = { enabled: boolean; patterns: string[]; startedAt: number }

export type NetworkOverrideRule = {
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

export const networkCaptureConfigs = new Map<number, NetworkCaptureConfig>()
export const networkCaptureLogs = new Map<number, CapturedNetworkEntry[]>()
export const pendingNetworkEntries = new Map<string, CapturedNetworkEntry>()
export const networkOverrideConfigs = new Map<number, NetworkOverrideRule[]>()
export const fetchInterceptionEnabled = new Set<number>()

export function networkEntryKey(tabId: number, requestId: string): string {
  return `${tabId}:${requestId}`
}

export function getNetworkLogs(tabId: number): CapturedNetworkEntry[] {
  const logs = networkCaptureLogs.get(tabId)
  if (logs) return logs
  const next: CapturedNetworkEntry[] = []
  networkCaptureLogs.set(tabId, next)
  return next
}

export function clearNetworkLogs(tabId: number): void {
  networkCaptureLogs.set(tabId, [])
  for (const key of Array.from(pendingNetworkEntries.keys())) {
    if (key.startsWith(`${tabId}:`)) pendingNetworkEntries.delete(key)
  }
}

export function appendNetworkLog(tabId: number, entry: CapturedNetworkEntry): void {
  const logs = getNetworkLogs(tabId)
  logs.push(entry)
  if (logs.length > NETWORK_LOG_LIMIT) logs.splice(0, logs.length - NETWORK_LOG_LIMIT)
}

export function truncateBody(body?: string): string | undefined {
  if (!body) return body
  return body.length > NETWORK_BODY_LIMIT ? body.slice(0, NETWORK_BODY_LIMIT) + "\n... (truncated)" : body
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function matchesCapturePatterns(url: string, patterns: string[]): boolean {
  if (!patterns.length) return true
  return patterns.some(pattern => {
    const regex = new RegExp(escapeRegExp(pattern).replace(/\\\*/g, ".*"), "i")
    return regex.test(url)
  })
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

export function findMatchingNetworkOverrideRule(
  url: string,
  method: string | undefined,
  resourceType: string | undefined,
  rules: NetworkOverrideRule[]
): NetworkOverrideRule | null {
  for (const rule of rules) {
    if (rule.urlPattern && !matchesCapturePatterns(url, [rule.urlPattern])) continue
    if (!matchesRequestMethod(method, rule.methods)) continue
    if (!matchesRequestResourceType(resourceType, rule.resourceTypes)) continue
    return rule
  }
  return null
}

export function applyNetworkOverrideRule(
  request: Record<string, any>,
  _resourceType: string | undefined,
  rule: NetworkOverrideRule
): { url?: string; headers?: Array<{ name: string; value: string }>; postData?: string } {
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
    for (const [name, value] of Object.entries(rule.setHeaders)) headerMap.set(name.toLowerCase(), value)
  }
  const headers = Array.from(headerMap.entries()).map(([name, value]) => ({ name, value }))
  const postData = rule.postData !== undefined ? rule.postData : request.postData
  return {
    url: nextUrl.toString() !== request.url ? nextUrl.toString() : undefined,
    headers,
    postData
  }
}

export async function ensureDebuggerSession(tabId: number): Promise<void> {
  if (debuggerAttached.has(tabId)) return
  await chrome.debugger.attach({ tabId }, "1.3")
  debuggerAttached.add(tabId)
}

export async function refreshFetchInterception(tabId: number): Promise<void> {
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
    try { await chrome.debugger.sendCommand({ tabId }, "Fetch.disable") } catch {}
    fetchInterceptionEnabled.delete(tabId)
  }
}

export async function enableNetworkCapture(tabId: number, patterns: string[]): Promise<void> {
  await ensureDebuggerSession(tabId)
  await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
    maxTotalBufferSize: 10000000,
    maxResourceBufferSize: 2000000
  })
  networkCaptureConfigs.set(tabId, { enabled: true, patterns, startedAt: Date.now() })
  clearNetworkLogs(tabId)
}

export async function disableNetworkCapture(tabId: number): Promise<void> {
  networkCaptureConfigs.set(tabId, {
    enabled: false,
    patterns: networkCaptureConfigs.get(tabId)?.patterns || [],
    startedAt: networkCaptureConfigs.get(tabId)?.startedAt || Date.now()
  })
  try { await chrome.debugger.sendCommand({ tabId }, "Network.disable") } catch {}
}
