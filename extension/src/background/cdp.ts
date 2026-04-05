import {
  networkCaptureConfigs, networkOverrideConfigs, fetchInterceptionEnabled,
  pendingNetworkEntries, networkEntryKey, findMatchingNetworkOverrideRule,
  applyNetworkOverrideRule, matchesCapturePatterns, truncateBody,
  appendNetworkLog, clearNetworkLogs
} from "./network-capture"

export let debuggerAttached = new Set<number>()
export let infoBannerHeight = 0

export async function cdpCommand(
  tabId: number,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
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
