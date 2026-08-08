import { shouldRetryContentScript, INPUT_ACTIONS, isResponseLoss } from "../../../shared/content-script-retry"

async function injectContentScript(
  tabId: number,
  frameId?: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const target = frameId !== undefined
      ? { tabId, frameIds: [frameId] }
      : { tabId }
    await chrome.scripting.executeScript({ target, files: ["content.js"] })
    await new Promise(resolve => setTimeout(resolve, 200))
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

type ContentScriptResult = { success: boolean; error?: string; data?: unknown }

const NAVIGATION_CAPABLE_ACTIONS = new Set(["click", "click_at", "dblclick", "find_and_click", "click_selector"])

/**
 * Safari can unload a content script before delivering its async sendResponse
 * callback when a click starts a navigation. Chrome closes the message channel
 * in that case; Safari may leave it pending forever. Treat a loading/url update
 * on the exact target tab as the acknowledgement for click-like actions only.
 */
export async function sendToContentScriptOnce(
  tabId: number,
  action: { type: string; [key: string]: unknown },
  frameId?: number
): Promise<ContentScriptResult> {
  const watchesNavigation = NAVIGATION_CAPABLE_ACTIONS.has(action.type)
  let initialUrl: string | undefined
  if (watchesNavigation) {
    try { initialUrl = (await chrome.tabs.get(tabId)).url } catch {}
  }

  return new Promise((resolve) => {
    let settled = false
    let navigationFailureTimer: ReturnType<typeof setTimeout> | null = null
    let navigationListener: ((
      updatedTabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => void) | null = null

    const finish = (result: ContentScriptResult): void => {
      if (settled) return
      settled = true
      if (navigationFailureTimer) clearTimeout(navigationFailureTimer)
      if (navigationListener) chrome.tabs.onUpdated.removeListener(navigationListener)
      resolve(result)
    }

    const navigationResult = (url?: string): ContentScriptResult => ({
      success: true,
      data: { navigated: true, url },
    })

    if (watchesNavigation) {
      navigationListener = (updatedTabId, changeInfo, tab) => {
        if (updatedTabId !== tabId) return
        if (changeInfo.status !== "loading" && typeof changeInfo.url !== "string") return
        finish(navigationResult(changeInfo.url ?? tab.url))
      }
      chrome.tabs.onUpdated.addListener(navigationListener)
    }

    const targetFrame = frameId !== undefined ? frameId : 0
    chrome.tabs.sendMessage(
      tabId,
      { type: "execute_action", action },
      { frameId: targetFrame } as chrome.tabs.MessageSendOptions,
      (response) => {
        if (chrome.runtime.lastError) {
          const error = chrome.runtime.lastError.message
          if (watchesNavigation && shouldRetryContentScript(error)) {
            // Chromium reports the closing message channel before onUpdated;
            // Safari can omit the callback and deliver only onUpdated. Keep the
            // listener alive briefly, then use the exact tab's URL/status as a
            // fallback instead of replaying a click against the new document.
            navigationFailureTimer = setTimeout(async () => {
              try {
                const tab = await chrome.tabs.get(tabId)
                if (
                  tab.status === "loading" ||
                  (typeof initialUrl === "string" && typeof tab.url === "string" && tab.url !== initialUrl)
                ) {
                  finish(navigationResult(tab.url))
                  return
                }
              } catch {}
              finish({ success: false, error })
            }, 250)
          } else {
            finish({ success: false, error })
          }
        } else {
          finish(response ?? { success: false, error: "no response from content script" })
        }
      }
    )
  })
}

// Detect Chrome-restricted origins where chrome.scripting.executeScript will
// always fail (chrome://, edge://, brave://, the Chrome Web Store, etc.).
// We surface a fast, actionable error in that case instead of waiting for
// the upstream timeout and surfacing the raw "Cannot access contents of"
// message.
function isChromeRestrictedInjectError(error: string | undefined): boolean {
  if (!error) return false
  return (
    /Cannot access (?:contents of )?(?:url|chrome|edge|brave|webstore)/i.test(error) ||
    /chrome:\/\/|chrome-untrusted:\/\/|edge:\/\/|brave:\/\//i.test(error) ||
    /chromewebstore\.google\.com|chrome\.google\.com\/webstore/i.test(error) ||
    /Extensions cannot be added to/i.test(error)
  )
}

export async function sendToContentScript(
  tabId: number,
  action: { type: string; [key: string]: unknown },
  frameId?: number
): Promise<unknown> {
  const first = await sendToContentScriptOnce(tabId, action, frameId)
  if (first.success || !shouldRetryContentScript(first.error)) return first

  // A dead reply channel on a DELIVERED input action must not trigger a blind
  // re-execution — the action may have landed (a click that navigates tears
  // the channel down as a side effect of succeeding). Navigation cases for
  // click-like actions already resolve as {navigated:true} in
  // sendToContentScriptOnce; this guards the rest (worker death with the
  // reply in flight, same-URL reloads). Delivery failures ("Receiving end
  // does not exist") mean no receiver existed — those stay on the retry path
  // below for every action type.
  if (INPUT_ACTIONS.has(action.type) && isResponseLoss(first.error)) {
    let navigating = false
    try { navigating = (await chrome.tabs.get(tabId)).status === "loading" } catch {}
    if (navigating) {
      return {
        success: true,
        data: `${action.type} delivered; the page began navigating before the reply arrived`,
        warning: "reply channel closed during navigation — re-read page state to confirm the outcome",
      }
    }
    return {
      success: false,
      error: `${action.type} was delivered but the reply channel closed (${first.error}) — not auto-retried to avoid firing it twice; re-read page state to confirm the outcome, then retry deliberately`,
    }
  }

  // Before reinjecting via executeScript (which re-evaluates content.js and
  // blows away the in-page refRegistry the consumer has been using), give the
  // manifest's `document_idle` auto-inject a brief window to fire and handle
  // the message. Most "Receiving end does not exist" errors on freshly-opened
  // http(s) tabs are timing races against document_idle, not genuine
  // missing-script states.
  await new Promise(resolve => setTimeout(resolve, 250))
  const retryWithoutInject = await sendToContentScriptOnce(tabId, action, frameId)
  if (retryWithoutInject.success) return retryWithoutInject

  const injected = await injectContentScript(tabId, frameId)
  if (!injected.success) {
    if (isChromeRestrictedInjectError(injected.error)) {
      return {
        success: false,
        error: `tab ${tabId} has no content script and could not be re-injected (likely a chrome://, edge://, brave://, or Chrome Web Store page). Use 'interceptor open <url>' for a fresh tab.`,
      }
    }
    return {
      success: false,
      error: `content script unavailable on tab ${tabId} and reinjection failed: ${injected.error}`,
    }
  }

  const retried = await sendToContentScriptOnce(tabId, action, frameId)
  if (retried.success) return retried

  return {
    success: false,
    error: `content script re-injected on tab ${tabId} but action still failed: ${retried.error || "unknown error"}`,
  }
}

export async function sendNetDirect(
  tabId: number,
  msg: { type: string; [key: string]: unknown }
): Promise<unknown> {
  const sendOnce = (): Promise<{ success: boolean; error?: string; data?: unknown }> => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 } as chrome.tabs.MessageSendOptions, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message })
      } else {
        resolve(response ?? { success: false, error: "no response from content script" })
      }
    })
  })

  const first = await sendOnce()
  if (first.success || !shouldRetryContentScript(first.error)) return first

  const injected = await injectContentScript(tabId, 0)
  if (!injected.success) {
    return {
      success: false,
      error: `content script unavailable on tab ${tabId} and reinjection failed: ${injected.error}`
    }
  }

  const retried = await sendOnce()
  if (retried.success) return retried

  return {
    success: false,
    error: `content script re-injected on tab ${tabId} but message still failed: ${retried.error || "unknown error"}`
  }
}

export function waitForTabLoad(
  tabId: number,
  timeoutMs = 15000
): Promise<{ ready: boolean; elapsed: number }> {
  return new Promise((resolve) => {
    const start = Date.now()
    const stage1Timeout = Math.min(timeoutMs, 10000)

    const hardTimer = setTimeout(async () => {
      chrome.tabs.onUpdated.removeListener(listener)
      const probeResult = await probeContentReady(tabId, Math.max(timeoutMs - (Date.now() - start), 1000))
      resolve({ ready: probeResult, elapsed: Date.now() - start })
    }, timeoutMs)

    function listener(updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) {
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

export async function probeContentReady(tabId: number, timeoutMs: number): Promise<boolean> {
  try {
    const result = await sendToContentScript(tabId, {
      type: "wait_stable", ms: 500, timeout: Math.min(timeoutMs, 5000)
    }) as { success: boolean; data?: { stable: boolean } }
    return result.success && (result.data?.stable ?? true)
  } catch {
    return false
  }
}
