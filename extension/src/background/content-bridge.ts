import { shouldRetryContentScript } from "../../../shared/content-script-retry"

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

async function sendToContentScriptOnce(
  tabId: number,
  action: { type: string; [key: string]: unknown },
  frameId?: number
): Promise<{ success: boolean; error?: string; data?: unknown }> {
  return new Promise((resolve) => {
    const targetFrame = frameId !== undefined ? frameId : 0
    chrome.tabs.sendMessage(
      tabId,
      { type: "execute_action", action },
      { frameId: targetFrame } as chrome.tabs.MessageSendOptions,
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message })
        } else {
          resolve(response ?? { success: false, error: "no response from content script" })
        }
      }
    )
  })
}

export async function sendToContentScript(
  tabId: number,
  action: { type: string; [key: string]: unknown },
  frameId?: number
): Promise<unknown> {
  const first = await sendToContentScriptOnce(tabId, action, frameId)
  if (first.success || !shouldRetryContentScript(first.error)) return first

  const injected = await injectContentScript(tabId, frameId)
  if (!injected.success) {
    return {
      success: false,
      error: `content script unavailable on tab ${tabId} and reinjection failed: ${injected.error}`
    }
  }

  const retried = await sendToContentScriptOnce(tabId, action, frameId)
  if (retried.success) return retried

  return {
    success: false,
    error: `content script re-injected on tab ${tabId} but action still failed: ${retried.error || "unknown error"}`
  }
}

export async function sendNetDirect(
  tabId: number,
  msg: { type: string; [key: string]: unknown }
): Promise<unknown> {
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
