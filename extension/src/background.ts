let nativePort: chrome.runtime.Port | null = null

function connectToHost() {
  if (nativePort) return

  nativePort = chrome.runtime.connectNative("com.slopbrowser.host")

  nativePort.onMessage.addListener((msg: { id?: string; action?: { type: string; [key: string]: unknown }; tabId?: number }) => {
    handleDaemonMessage(msg)
  })

  nativePort.onDisconnect.addListener(() => {
    nativePort = null
    const lastError = chrome.runtime.lastError
    if (lastError) {
      console.error("native host disconnected:", lastError.message)
    }
    setTimeout(connectToHost, 2000)
  })
}

async function handleDaemonMessage(msg: { id?: string; action?: { type: string; [key: string]: unknown }; tabId?: number }) {
  if (!msg.action || !msg.id) return

  const action = msg.action
  let tabId = msg.tabId

  if (!tabId && needsTab(action.type)) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
    tabId = activeTab?.id
  }

  if (!tabId && needsTab(action.type)) {
    sendToHost({ id: msg.id, result: { success: false, error: "no active tab" } })
    return
  }

  try {
    const result = await routeAction(action, tabId!)
    sendToHost({ id: msg.id, result })
  } catch (err) {
    sendToHost({ id: msg.id, result: { success: false, error: (err as Error).message } })
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

async function routeAction(action: { type: string; [key: string]: unknown }, tabId: number): Promise<{ success: boolean; error?: string; data?: unknown }> {
  switch (action.type) {

    // === META ===
    case "status":
      return { success: true, data: { connected: true, version: chrome.runtime.getManifest().version } }

    case "reload_extension":
      setTimeout(() => chrome.runtime.reload(), 100)
      return { success: true, data: "reloading in 100ms" }

    // === SCREENSHOTS & CAPTURE ===
    case "screenshot": {
      const format = (action.format as string) === "png" ? "png" : "jpeg"
      const quality = (action.quality as number) || 80
      const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format, quality })
      return { success: true, data: { dataUrl } }
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
      const tabData = tabs.map(t => ({
        id: t.id, url: t.url, title: t.title, active: t.active,
        windowId: t.windowId, muted: t.mutedInfo?.muted, pinned: t.pinned,
        groupId: t.groupId
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
      return { success: true, data: { windowId: win.id, tabs: win.tabs?.map(t => ({ id: t.id, url: t.url })) } }
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

    // === JAVASCRIPT EVALUATION ===
    case "evaluate": {
      const code = action.code as string
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [code],
        func: (c: string) => {
          try {
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
    default:
      return await sendToContentScript(tabId, action) as { success: boolean; error?: string; data?: unknown }
  }
}

function sendToHost(msg: unknown) {
  if (nativePort) {
    nativePort.postMessage(msg)
  }
}

async function sendToContentScript(tabId: number, action: { type: string; [key: string]: unknown }): Promise<unknown> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "execute_action", action }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message })
      } else {
        resolve(response ?? { success: false, error: "no response from content script" })
      }
    })
  })
}

function waitForTabLoad(tabId: number, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }, timeoutMs)

    function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }

    chrome.tabs.onUpdated.addListener(listener)
  })
}

chrome.runtime.onInstalled.addListener(connectToHost)
chrome.runtime.onStartup.addListener(connectToHost)
connectToHost()
