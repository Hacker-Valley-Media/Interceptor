/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { sendToContentScriptOnce, sendToContentScript } from "../extension/src/background/content-bridge"

type UpdatedListener = (
  tabId: number,
  changeInfo: chrome.tabs.OnUpdatedInfo,
  tab: chrome.tabs.Tab,
) => void

let originalChrome: unknown
let updatedListeners: Set<UpdatedListener>
let sendMessageCallback: ((response: unknown) => void) | undefined
let sendMessageCount: number
let runtimeState: { lastError?: { message?: string } }
let currentTab: chrome.tabs.Tab

beforeEach(() => {
  originalChrome = (globalThis as { chrome?: unknown }).chrome
  updatedListeners = new Set()
  sendMessageCallback = undefined
  sendMessageCount = 0
  runtimeState = {}
  currentTab = {
    id: 99,
    status: "complete",
    url: "https://example.com/",
  } as chrome.tabs.Tab
  ;(globalThis as { chrome: unknown }).chrome = {
    runtime: runtimeState,
    tabs: {
      get: async () => currentTab,
      onUpdated: {
        addListener: (listener: UpdatedListener) => updatedListeners.add(listener),
        removeListener: (listener: UpdatedListener) => updatedListeners.delete(listener),
      },
      sendMessage: (
        _tabId: number,
        _message: unknown,
        _options: unknown,
        callback: (response: unknown) => void,
      ) => {
        sendMessageCount++
        sendMessageCallback = callback
      },
    },
  }
})

afterEach(() => {
  ;(globalThis as { chrome?: unknown }).chrome = originalChrome
})

describe("content bridge navigation acknowledgement", () => {
  test("resolves a click when Safari unloads the content script during navigation", async () => {
    const pending = sendToContentScriptOnce(99, { type: "click", ref: "e1" })
    await Promise.resolve()

    expect(updatedListeners.size).toBe(1)
    for (const listener of updatedListeners) {
      listener(99, { status: "loading", url: "https://www.iana.org/help/example-domains" }, {
        id: 99,
        url: "https://www.iana.org/help/example-domains",
      } as chrome.tabs.Tab)
    }

    expect(await pending).toEqual({
      success: true,
      data: {
        navigated: true,
        url: "https://www.iana.org/help/example-domains",
      },
    })
    expect(updatedListeners.size).toBe(0)
    expect(sendMessageCallback).toBeDefined()
  })

  test("keeps the navigation listener after Chromium reports a closed channel", async () => {
    const pending = sendToContentScriptOnce(99, { type: "click", ref: "e1" })
    await Promise.resolve()

    runtimeState.lastError = { message: "message channel is closed" }
    sendMessageCallback?.(undefined)
    currentTab = {
      id: 99,
      status: "loading",
      url: "https://www.iana.org/help/example-domains",
    } as chrome.tabs.Tab
    for (const listener of updatedListeners) {
      listener(99, { status: "loading", url: currentTab.url }, currentTab)
    }

    expect(await pending).toEqual({
      success: true,
      data: {
        navigated: true,
        url: "https://www.iana.org/help/example-domains",
      },
    })
    expect(updatedListeners.size).toBe(0)
  })

  test("ordinary actions still require the content script response", async () => {
    const pending = sendToContentScriptOnce(99, { type: "extract_text" })

    expect(updatedListeners.size).toBe(0)
    sendMessageCallback?.({ success: true, data: "Example Domain" })

    expect(await pending).toEqual({ success: true, data: "Example Domain" })
  })

  test("click_selector is navigation-capable: bfcache teardown resolves as navigated, no replay", async () => {
    const pending = sendToContentScriptOnce(99, { type: "click_selector", selector: "a", nth: 0 })
    await Promise.resolve()

    expect(updatedListeners.size).toBe(1)
    runtimeState.lastError = { message: "The page keeping the extension port is moved into back/forward cache, so the message channel is closed." }
    sendMessageCallback?.(undefined)
    currentTab = { id: 99, status: "loading", url: "https://www.iana.org/" } as chrome.tabs.Tab
    for (const listener of updatedListeners) {
      listener(99, { status: "loading", url: currentTab.url }, currentTab)
    }

    expect(await pending).toEqual({ success: true, data: { navigated: true, url: "https://www.iana.org/" } })
    expect(sendMessageCount).toBe(1)
  })
})

describe("no double-fire for delivered input actions", () => {
  test("input action + reply-channel death + no navigation → honest failure, exactly one send", async () => {
    const pending = sendToContentScript(99, { type: "input_text", text: "hello" })
    await Promise.resolve()

    runtimeState.lastError = { message: "Attempting to use a disconnected port object" }
    sendMessageCallback?.(undefined)

    const result = await pending as { success: boolean; error?: string }
    expect(result.success).toBe(false)
    expect(result.error).toContain("not auto-retried to avoid firing it twice")
    expect(sendMessageCount).toBe(1)
  })

  test("input action + reply-channel death + tab navigating → delivered with warning, exactly one send", async () => {
    const pending = sendToContentScript(99, { type: "send_keys", keys: "Enter" })
    await Promise.resolve()

    currentTab = { id: 99, status: "loading", url: "https://example.com/next" } as chrome.tabs.Tab
    runtimeState.lastError = { message: "message channel is closed" }
    sendMessageCallback?.(undefined)

    const result = await pending as { success: boolean; data?: string; warning?: string }
    expect(result.success).toBe(true)
    expect(result.data).toContain("send_keys delivered")
    expect(result.warning).toContain("re-read page state")
    expect(sendMessageCount).toBe(1)
  })

  test("delivery failure keeps the retry path even for input actions", async () => {
    const pending = sendToContentScript(99, { type: "click", ref: "e1" })
    await Promise.resolve()

    // First send: no receiver ever existed — safe to retry.
    runtimeState.lastError = { message: "Could not establish connection. Receiving end does not exist." }
    sendMessageCallback?.(undefined)

    // click is navigation-capable: its once-layer holds the error ~250ms
    // (URL/status fallback), then the bridge waits another 250ms for
    // document_idle before re-sending without injecting.
    await new Promise(resolve => setTimeout(resolve, 650))
    expect(sendMessageCount).toBe(2)
    runtimeState.lastError = undefined
    sendMessageCallback?.({ success: true, data: "clicked [e1]" })

    expect(await pending).toEqual({ success: true, data: "clicked [e1]" })
  })

  test("reads with reply-channel death still retry (unchanged behavior)", async () => {
    const pending = sendToContentScript(99, { type: "extract_text" })
    await Promise.resolve()

    runtimeState.lastError = { message: "message channel is closed" }
    sendMessageCallback?.(undefined)

    await new Promise(resolve => setTimeout(resolve, 300))
    expect(sendMessageCount).toBe(2)
    runtimeState.lastError = undefined
    sendMessageCallback?.({ success: true, data: "Example Domain" })

    expect(await pending).toEqual({ success: true, data: "Example Domain" })
  })
})
