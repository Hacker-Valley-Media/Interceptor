import {
  networkCaptureConfigs, networkOverrideConfigs, fetchInterceptionEnabled,
  pendingNetworkEntries, networkEntryKey, findMatchingNetworkOverrideRule,
  applyNetworkOverrideRule, matchesCapturePatterns, truncateBody,
  appendNetworkLog, clearNetworkLogs
} from "./network-capture"

export let debuggerAttached = new Set<number>()
export let infoBannerHeight = 0

// Tabs whose paused requests a raw CDP session answers (cdp-session.ts). The
// override handler below leaves those requests alone: a second
// Fetch.continueRequest for the same request id fails for the client.
export const rawFetchOwners = new Set<number>()

// Tabs this module attached on demand, and how many users each one has: one
// per command in flight plus one per raw CDP session. Network capture and
// request overrides attach through ensureDebuggerSession and stay attached,
// so a tab they use is never detached here.
const selfAttached = new Set<number>()
const debuggerHolds = new Map<number, number>()
const attachLocks = new Map<number, Promise<unknown>>()

function withAttachLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const run = (attachLocks.get(tabId) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => {})
  attachLocks.set(tabId, tail)
  void tail.then(() => { if (attachLocks.get(tabId) === tail) attachLocks.delete(tabId) })
  return run
}

function debuggerUsedInternally(tabId: number): boolean {
  return !!networkCaptureConfigs.get(tabId)?.enabled || (networkOverrideConfigs.get(tabId)?.length || 0) > 0
}

/**
 * Attach the debugger to the tab if nothing in this extension has it yet, and
 * count one more user. Every acquire needs one releaseDebugger.
 */
export function acquireDebugger(tabId: number): Promise<void> {
  return withAttachLock(tabId, async () => {
    if (!debuggerAttached.has(tabId)) {
      try {
        await chrome.debugger.attach({ tabId }, "1.3")
      } catch (err) {
        const message = (err as Error).message || String(err)
        if (!/already attached/i.test(message)) throw err
        // A tab takes one chrome.debugger client. Chrome gives the same answer
        // when the client is this extension (a session that outlived a service
        // worker restart) and when it is another one; only our own session
        // accepts a command.
        const ours = await chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo").then(() => true, () => false)
        if (!ours) {
          throw new Error(`tab ${tabId} already has a debugger client attached (another extension or automation tool); nothing was attached. Close that client and retry.`)
        }
      }
      debuggerAttached.add(tabId)
      selfAttached.add(tabId)
    }
    debuggerHolds.set(tabId, (debuggerHolds.get(tabId) ?? 0) + 1)
  })
}

/** Drop one user. The last one detaches a tab this module attached. */
export function releaseDebugger(tabId: number): Promise<void> {
  return withAttachLock(tabId, async () => {
    const holds = (debuggerHolds.get(tabId) ?? 0) - 1
    if (holds > 0) {
      debuggerHolds.set(tabId, holds)
      return
    }
    debuggerHolds.delete(tabId)
    if (!selfAttached.has(tabId) || debuggerUsedInternally(tabId)) return
    selfAttached.delete(tabId)
    debuggerAttached.delete(tabId)
    try { await chrome.debugger.detach({ tabId }) } catch {}
  })
}

export async function cdpCommand(
  tabId: number,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  await acquireDebugger(tabId)
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params)
  } finally {
    await releaseDebugger(tabId)
  }
}

export async function cdpAttachActDetach<T>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>
): Promise<{ success: boolean; data?: T; error?: string }> {
  try {
    const result = await cdpCommand(tabId, method, params) as T
    return { success: true, data: result }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export async function cdpInjectSourceCapabilitiesMock(tabId: number): Promise<void> {
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

export function registerCdpListeners(): void {
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    const tabId = source.tabId
    if (!tabId) return
    const config = networkCaptureConfigs.get(tabId)
    const overrideRules = networkOverrideConfigs.get(tabId) || []
    try {
      if (method === "Fetch.requestPaused") {
        if (rawFetchOwners.has(tabId)) return
        const request = (params as Record<string, any>).request || {}
        const rule = findMatchingNetworkOverrideRule(
          request.url || "", request.method,
          (params as Record<string, any>).resourceType, overrideRules
        )
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
        const existing = pendingNetworkEntries.get(networkEntryKey(tabId, requestId))
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
          const bodyResult = await chrome.debugger.sendCommand(
            { tabId }, "Network.getResponseBody", { requestId }
          ) as { body?: string; base64Encoded?: boolean }
          existing.responseBody = bodyResult.base64Encoded
            ? "[base64 body omitted]"
            : truncateBody(bodyResult.body)
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
      selfAttached.delete(source.tabId)
      debuggerHolds.delete(source.tabId)
      rawFetchOwners.delete(source.tabId)
      fetchInterceptionEnabled.delete(source.tabId)
      networkCaptureConfigs.delete(source.tabId)
      networkOverrideConfigs.delete(source.tabId)
      clearNetworkLogs(source.tabId)
    }
    if (reason === "canceled_by_user") {
      console.log("debugger detached by user (DevTools opened)")
    }
  })
}
