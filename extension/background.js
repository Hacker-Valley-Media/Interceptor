// extension/src/background.ts
var nativePort = null;
var connectionReady = false;
var isConnecting = false;
var reconnectDelay = 1000;
function emitEvent(event, data = {}) {
  sendToHost({ type: "event", event, ...data });
}
var MESSAGE_QUEUE_CAP = 50;
var messageQueue = [];
var EXT_REQUEST_TIMEOUT_MS = 30000;
var pendingRequests = new Map;
function connectToHost() {
  if (nativePort || isConnecting)
    return;
  isConnecting = true;
  const port = chrome.runtime.connectNative("com.slopbrowser.host");
  const handshakeTimer = setTimeout(() => {
    console.error("native host handshake timeout (10s)");
    port.disconnect();
  }, 1e4);
  port.onMessage.addListener((msg) => {
    if (msg.type === "pong") {
      if (!connectionReady) {
        clearTimeout(handshakeTimer);
        connectionReady = true;
        reconnectDelay = 1000;
        isConnecting = false;
        console.log("native host connected (pong received)");
        emitEvent("connection_established");
        while (messageQueue.length > 0) {
          const queued = messageQueue.shift();
          handleDaemonMessage(queued);
        }
      }
      if (keepalivePongTimer) {
        clearTimeout(keepalivePongTimer);
        keepalivePongTimer = null;
      }
      return;
    }
    handleDaemonMessage(msg);
  });
  port.onDisconnect.addListener(() => {
    const dyingPort = nativePort;
    connectionReady = false;
    isConnecting = false;
    const lastError = chrome.runtime.lastError;
    if (lastError) {
      console.error("native host disconnected:", lastError.message);
    }
    console.log("connection_lost", lastError?.message);
    for (const [id, req] of pendingRequests) {
      clearTimeout(req.timer);
      console.error(`orphaned request ${id} (${req.action}) — native port disconnected`);
      if (dyingPort) {
        try {
          dyingPort.postMessage({ id, result: { success: false, error: "native port disconnected" } });
        } catch {}
      }
    }
    pendingRequests.clear();
    nativePort = null;
    const jitter = Math.random() * reconnectDelay * 0.3;
    setTimeout(connectToHost, reconnectDelay + jitter);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });
  nativePort = port;
  port.postMessage({ type: "ping" });
}
async function handleDaemonMessage(msg) {
  if (!msg.action || !msg.id)
    return;
  if (!connectionReady) {
    if (messageQueue.length >= MESSAGE_QUEUE_CAP) {
      const evicted = messageQueue.shift();
      if (evicted.id) {
        sendToHost({ id: evicted.id, result: { success: false, error: "message queue full — daemon not connected" } });
      }
    }
    if (messageQueue.length >= MESSAGE_QUEUE_CAP / 2) {
      console.warn(`message queue at ${messageQueue.length}/${MESSAGE_QUEUE_CAP}`);
    }
    messageQueue.push(msg);
    if (!nativePort)
      connectToHost();
    return;
  }
  if (pendingRequests.has(msg.id)) {
    sendToHost({ id: msg.id, result: { success: false, error: "duplicate request ID" } });
    return;
  }
  const requestTimer = setTimeout(() => {
    pendingRequests.delete(msg.id);
    sendToHost({ id: msg.id, result: { success: false, error: "extension timeout" } });
  }, EXT_REQUEST_TIMEOUT_MS);
  const startTime = Date.now();
  const shortId = msg.id.slice(0, 8);
  console.log(`[${shortId}] executing ${msg.action.type}`);
  pendingRequests.set(msg.id, { action: msg.action.type, tabId: msg.tabId, timestamp: startTime, timer: requestTimer });
  const action = msg.action;
  let tabId = msg.tabId;
  if (!tabId && needsTab(action.type)) {
    const stored = await chrome.storage.session.get("activeTabId");
    tabId = stored.activeTabId;
  }
  if (!tabId && needsTab(action.type)) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = activeTab?.id;
    if (tabId) {
      chrome.storage.session.set({ activeTabId: tabId });
    }
  }
  if (!tabId && needsTab(action.type)) {
    clearTimeout(requestTimer);
    pendingRequests.delete(msg.id);
    sendToHost({ id: msg.id, result: { success: false, error: "no active tab" } });
    return;
  }
  if (tabId) {
    chrome.storage.session.set({ activeTabId: tabId });
  }
  if (tabId && needsTab(action.type) && !action.anyTab) {
    const inGroup = await isTabInSlopGroup(tabId);
    if (!inGroup && slopGroupId !== null) {
      clearTimeout(requestTimer);
      pendingRequests.delete(msg.id);
      sendToHost({ id: msg.id, result: { success: false, error: `tab ${tabId} is not in the slop group — use 'slop tab new' to create managed tabs` } });
      return;
    }
  }
  if (SENSITIVE_ACTIONS.has(action.type) && tabId && action.expectedUrl) {
    const urlErr = await verifyTabUrl(tabId, action.expectedUrl);
    if (urlErr) {
      clearTimeout(requestTimer);
      pendingRequests.delete(msg.id);
      sendToHost({ id: msg.id, result: { success: false, error: urlErr, tabId } });
      return;
    }
  }
  try {
    const result = await routeAction(action, tabId);
    if (tabId)
      result.tabId = tabId;
    clearTimeout(requestTimer);
    pendingRequests.delete(msg.id);
    console.log(`[${shortId}] complete ${action.type} ${Date.now() - startTime}ms`);
    sendToHost({ id: msg.id, result });
  } catch (err) {
    clearTimeout(requestTimer);
    pendingRequests.delete(msg.id);
    console.error(`[${shortId}] error ${action.type} ${Date.now() - startTime}ms: ${err.message}`);
    sendToHost({ id: msg.id, result: { success: false, error: err.message, tabId } });
  }
}
function needsTab(type) {
  const noTabActions = new Set([
    "status",
    "reload_extension",
    "tab_create",
    "tab_list",
    "window_create",
    "window_list",
    "window_get_all",
    "history_search",
    "history_delete_all",
    "bookmark_tree",
    "bookmark_search",
    "bookmark_create",
    "downloads_search",
    "browsing_data_remove",
    "session_list",
    "session_restore",
    "notification_create",
    "notification_clear",
    "search_query"
  ]);
  return !noTabActions.has(type);
}
var slopGroupId = null;
async function ensureSlopGroup() {
  if (slopGroupId !== null) {
    try {
      await chrome.tabGroups.get(slopGroupId);
      return slopGroupId;
    } catch {
      slopGroupId = null;
    }
  }
  const groups = await chrome.tabGroups.query({ title: "slop" });
  if (groups.length > 0) {
    slopGroupId = groups[0].id;
    return slopGroupId;
  }
  return -1;
}
async function addTabToSlopGroup(tabId) {
  let groupId = await ensureSlopGroup();
  if (groupId === -1) {
    groupId = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(groupId, { title: "slop", color: "cyan" });
    slopGroupId = groupId;
  } else {
    await chrome.tabs.group({ tabIds: tabId, groupId });
  }
  return groupId;
}
async function isTabInSlopGroup(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (slopGroupId === null)
    await ensureSlopGroup();
  return slopGroupId !== null && tab.groupId === slopGroupId;
}
var SENSITIVE_ACTIONS = new Set(["evaluate", "cookies_get", "cookies_set", "cookies_delete", "storage_read", "storage_write", "storage_delete"]);
async function verifyTabUrl(tabId, expectedUrl) {
  if (!expectedUrl)
    return null;
  const tab = await chrome.tabs.get(tabId);
  if (tab.url && tab.url !== expectedUrl) {
    return `tab URL changed since last state read — expected ${expectedUrl}, got ${tab.url}`;
  }
  return null;
}
async function routeAction(action, tabId) {
  switch (action.type) {
    case "status":
      return { success: true, data: { connected: true, version: chrome.runtime.getManifest().version } };
    case "reload_extension":
      setTimeout(() => chrome.runtime.reload(), 100);
      return { success: true, data: "reloading in 100ms" };
    case "screenshot": {
      const format = action.format === "png" ? "png" : "jpeg";
      const quality = action.quality || 50;
      const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format, quality });
      const filename = `slop-screenshot-${Date.now()}.${format === "png" ? "png" : "jpg"}`;
      const downloadId = await chrome.downloads.download({
        url: dataUrl,
        filename,
        conflictAction: "uniquify"
      });
      const filePath = await new Promise((resolve) => {
        function onChanged(delta) {
          if (delta.id === downloadId && delta.state?.current === "complete") {
            chrome.downloads.onChanged.removeListener(onChanged);
            chrome.downloads.search({ id: downloadId }, (items) => {
              resolve(items[0]?.filename || filename);
            });
          }
        }
        chrome.downloads.onChanged.addListener(onChanged);
        setTimeout(() => {
          chrome.downloads.onChanged.removeListener(onChanged);
          resolve(filename);
        }, 5000);
      });
      return { success: true, data: filePath };
    }
    case "page_capture": {
      const mhtml = await chrome.pageCapture.saveAsMHTML({ tabId });
      const text = await mhtml.text();
      return { success: true, data: { size: text.length, preview: text.slice(0, 500) } };
    }
    case "navigate":
      await chrome.tabs.update(tabId, { url: action.url });
      await waitForTabLoad(tabId);
      return { success: true };
    case "go_back":
      await chrome.tabs.goBack(tabId);
      await waitForTabLoad(tabId);
      return { success: true };
    case "go_forward":
      await chrome.tabs.goForward(tabId);
      await waitForTabLoad(tabId);
      return { success: true };
    case "reload":
      await chrome.tabs.reload(tabId, { bypassCache: !!action.bypassCache });
      await waitForTabLoad(tabId);
      return { success: true };
    case "tab_create": {
      const newTab = await chrome.tabs.create({ url: action.url || "about:blank" });
      if (newTab.id) {
        const groupId = await addTabToSlopGroup(newTab.id);
        return { success: true, data: { tabId: newTab.id, url: newTab.url, groupId } };
      }
      return { success: true, data: { tabId: newTab.id, url: newTab.url } };
    }
    case "tab_close":
      await chrome.tabs.remove(action.tabId || tabId);
      return { success: true };
    case "tab_switch":
      await chrome.tabs.update(action.tabId, { active: true });
      return { success: true };
    case "tab_list": {
      const tabs = await chrome.tabs.query({});
      await ensureSlopGroup();
      const tabData = tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
        muted: t.mutedInfo?.muted,
        pinned: t.pinned,
        groupId: t.groupId,
        managed: slopGroupId !== null && t.groupId === slopGroupId
      }));
      return { success: true, data: tabData };
    }
    case "tab_duplicate": {
      const dup = await chrome.tabs.duplicate(tabId);
      return { success: true, data: { tabId: dup?.id } };
    }
    case "tab_reload":
      await chrome.tabs.reload(tabId, { bypassCache: !!action.bypassCache });
      await waitForTabLoad(tabId);
      return { success: true };
    case "tab_mute":
      await chrome.tabs.update(tabId, { muted: !!(action.muted ?? true) });
      return { success: true };
    case "tab_pin":
      await chrome.tabs.update(tabId, { pinned: !!(action.pinned ?? true) });
      return { success: true };
    case "tab_zoom_get": {
      const zoom = await chrome.tabs.getZoom(tabId);
      return { success: true, data: { zoom } };
    }
    case "tab_zoom_set":
      await chrome.tabs.setZoom(tabId, action.zoom);
      return { success: true };
    case "tab_group": {
      const groupId = await chrome.tabs.group({ tabIds: tabId, groupId: action.groupId });
      if (action.title || action.color) {
        await chrome.tabGroups.update(groupId, {
          title: action.title,
          color: action.color
        });
      }
      return { success: true, data: { groupId } };
    }
    case "tab_ungroup":
      await chrome.tabs.ungroup(tabId);
      return { success: true };
    case "tab_move":
      await chrome.tabs.move(tabId, {
        windowId: action.windowId,
        index: action.index ?? -1
      });
      return { success: true };
    case "tab_discard":
      await chrome.tabs.discard(tabId);
      return { success: true };
    case "window_create": {
      const win = await chrome.windows.create({
        url: action.url,
        type: action.windowType || "normal",
        width: action.width,
        height: action.height,
        left: action.left,
        top: action.top,
        incognito: !!action.incognito,
        focused: action.focused !== false
      });
      return { success: true, data: { windowId: win.id, tabs: win.tabs?.map((t) => ({ id: t.id, url: t.url })) } };
    }
    case "window_close":
      await chrome.windows.remove(action.windowId);
      return { success: true };
    case "window_focus":
      await chrome.windows.update(action.windowId, { focused: true });
      return { success: true };
    case "window_resize":
      await chrome.windows.update(action.windowId || (await chrome.windows.getCurrent()).id, {
        width: action.width,
        height: action.height,
        left: action.left,
        top: action.top,
        state: action.state
      });
      return { success: true };
    case "window_list":
    case "window_get_all": {
      const windows = await chrome.windows.getAll({ populate: true });
      return {
        success: true,
        data: windows.map((w) => ({
          id: w.id,
          type: w.type,
          state: w.state,
          focused: w.focused,
          width: w.width,
          height: w.height,
          left: w.left,
          top: w.top,
          incognito: w.incognito,
          tabs: w.tabs?.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active }))
        }))
      };
    }
    case "cookies_get": {
      const cookies = await chrome.cookies.getAll({ domain: action.domain });
      return { success: true, data: cookies };
    }
    case "cookies_set": {
      const cookie = await chrome.cookies.set(action.cookie);
      return { success: true, data: cookie };
    }
    case "cookies_delete":
      await chrome.cookies.remove({ url: action.url, name: action.name });
      return { success: true };
    case "history_search": {
      const items = await chrome.history.search({
        text: action.query || "",
        maxResults: action.maxResults || 50,
        startTime: action.startTime,
        endTime: action.endTime
      });
      return { success: true, data: items.map((i) => ({ url: i.url, title: i.title, lastVisit: i.lastVisitTime, visitCount: i.visitCount })) };
    }
    case "history_visits": {
      const visits = await chrome.history.getVisits({ url: action.url });
      return { success: true, data: visits };
    }
    case "history_delete":
      await chrome.history.deleteUrl({ url: action.url });
      return { success: true };
    case "history_delete_range":
      await chrome.history.deleteRange({ startTime: action.startTime, endTime: action.endTime });
      return { success: true };
    case "history_delete_all":
      await chrome.history.deleteAll();
      return { success: true };
    case "bookmark_tree": {
      const tree = await chrome.bookmarks.getTree();
      return { success: true, data: tree };
    }
    case "bookmark_search": {
      const results = await chrome.bookmarks.search(action.query);
      return { success: true, data: results.map((b) => ({ id: b.id, title: b.title, url: b.url, parentId: b.parentId })) };
    }
    case "bookmark_create": {
      const bm = await chrome.bookmarks.create({
        title: action.title,
        url: action.url,
        parentId: action.parentId
      });
      return { success: true, data: bm };
    }
    case "bookmark_delete":
      await chrome.bookmarks.remove(action.id);
      return { success: true };
    case "bookmark_update":
      await chrome.bookmarks.update(action.id, {
        title: action.title,
        url: action.url
      });
      return { success: true };
    case "downloads_start": {
      const downloadId = await chrome.downloads.download({
        url: action.url,
        filename: action.filename,
        saveAs: !!action.saveAs
      });
      return { success: true, data: { downloadId } };
    }
    case "downloads_search": {
      const items = await chrome.downloads.search({
        query: action.query ? [action.query] : undefined,
        limit: action.limit || 20,
        orderBy: ["-startTime"]
      });
      return {
        success: true,
        data: items.map((d) => ({
          id: d.id,
          url: d.url,
          filename: d.filename,
          state: d.state,
          bytesReceived: d.bytesReceived,
          totalBytes: d.totalBytes,
          mime: d.mime,
          startTime: d.startTime
        }))
      };
    }
    case "downloads_cancel":
      await chrome.downloads.cancel(action.downloadId);
      return { success: true };
    case "downloads_pause":
      await chrome.downloads.pause(action.downloadId);
      return { success: true };
    case "downloads_resume":
      await chrome.downloads.resume(action.downloadId);
      return { success: true };
    case "browsing_data_remove": {
      const since = action.since || 0;
      const types = {};
      const requested = action.types || ["cache"];
      for (const t of requested) {
        if (t === "cache")
          types.cache = true;
        if (t === "cookies")
          types.cookies = true;
        if (t === "history")
          types.history = true;
        if (t === "formData")
          types.formData = true;
        if (t === "downloads")
          types.downloads = true;
        if (t === "localStorage")
          types.localStorage = true;
        if (t === "indexedDB")
          types.indexedDB = true;
        if (t === "serviceWorkers")
          types.serviceWorkers = true;
        if (t === "passwords")
          types.passwords = true;
      }
      await chrome.browsingData.remove({ since }, types);
      return { success: true };
    }
    case "session_list": {
      const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: action.maxResults || 10 });
      return {
        success: true,
        data: sessions.map((s) => ({
          tab: s.tab ? { url: s.tab.url, title: s.tab.title, sessionId: s.tab.sessionId } : undefined,
          window: s.window ? { sessionId: s.window.sessionId, tabCount: s.window.tabs?.length } : undefined,
          lastModified: s.lastModified
        }))
      };
    }
    case "session_restore": {
      const restored = await chrome.sessions.restore(action.sessionId);
      return { success: true, data: restored };
    }
    case "notification_create": {
      const notifId = await chrome.notifications.create(action.notifId || "", {
        type: "basic",
        title: action.title || "slop-browser",
        message: action.message || "",
        iconUrl: action.iconUrl || "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      });
      return { success: true, data: { notifId } };
    }
    case "notification_clear":
      await chrome.notifications.clear(action.notifId);
      return { success: true };
    case "search_query":
      await chrome.search.query({ text: action.query, disposition: "NEW_TAB" });
      return { success: true };
    case "frames_list": {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return { success: true, data: frames?.map((f) => ({ frameId: f.frameId, url: f.url, parentFrameId: f.parentFrameId })) };
    }
    case "headers_modify": {
      const rules = action.rules;
      if (!rules || rules.length === 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: Array.from({ length: 100 }, (_, i) => i + 1) });
        return { success: true, data: "all header rules cleared" };
      }
      const dnrRules = rules.map((r, i) => ({
        id: i + 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{
            header: r.header,
            operation: r.operation === "remove" ? "remove" : "set",
            value: r.value
          }]
        },
        condition: { urlFilter: "*" }
      }));
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: dnrRules.map((r) => r.id),
        addRules: dnrRules
      });
      return { success: true };
    }
    case "evaluate": {
      const code = action.code;
      const world = action.world === "ISOLATED" ? "ISOLATED" : "MAIN";
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world,
        args: [code],
        func: (c) => {
          try {
            const w = window;
            if (w.trustedTypes) {
              if (!w.__slop_tt_policy) {
                w.__slop_tt_policy = w.trustedTypes.createPolicy("slop-eval", {
                  createScript: (s) => s
                });
              }
              const trusted = w.__slop_tt_policy.createScript(c);
              const r2 = (0, eval)(trusted);
              return { success: true, data: typeof r2 === "object" && r2 !== null ? JSON.parse(JSON.stringify(r2)) : r2 };
            }
            const r = (0, eval)(c);
            return { success: true, data: typeof r === "object" && r !== null ? JSON.parse(JSON.stringify(r)) : r };
          } catch (e) {
            return { success: false, error: e.message };
          }
        }
      });
      return results[0]?.result ?? { success: false, error: "no result" };
    }
    default:
      return await sendToContentScript(tabId, action);
  }
}
var wsChannel = null;
var wsReady = false;
var WS_URL = "ws://localhost:19222";
function connectWsChannel() {
  if (wsChannel && (wsChannel.readyState === WebSocket.OPEN || wsChannel.readyState === WebSocket.CONNECTING))
    return;
  try {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      wsChannel = ws;
      wsReady = true;
      ws.send(JSON.stringify({ type: "extension" }));
      console.log("ws channel connected");
    };
    ws.onclose = () => {
      wsReady = false;
      wsChannel = null;
    };
    ws.onerror = () => {
      wsReady = false;
      wsChannel = null;
    };
  } catch {}
}
function sendToHost(msg) {
  const sent = nativePort ? (nativePort.postMessage(msg), true) : false;
  if (!sent && wsReady && wsChannel) {
    try {
      wsChannel.send(JSON.stringify(msg));
    } catch {}
  }
}
async function sendToContentScript(tabId, action) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "execute_action", action }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response ?? { success: false, error: "no response from content script" });
      }
    });
  });
}
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
var keepalivePongTimer = null;
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "keepalive")
    return;
  if (!nativePort) {
    connectToHost();
    return;
  }
  if (connectionReady) {
    nativePort.postMessage({ type: "ping" });
    keepalivePongTimer = setTimeout(() => {
      console.error("keepalive pong timeout (5s) — forcing reconnect");
      if (nativePort)
        nativePort.disconnect();
    }, 5000);
  }
});
chrome.tabs.onRemoved.addListener(async (removedTabId) => {
  if (slopGroupId === null)
    return;
  try {
    const tabs = await chrome.tabs.query({ groupId: slopGroupId });
    if (tabs.length === 0) {
      slopGroupId = null;
    }
  } catch {
    slopGroupId = null;
  }
});
chrome.runtime.onInstalled.addListener(() => {
  connectToHost();
  connectWsChannel();
  ensureSlopGroup();
});
chrome.runtime.onStartup.addListener(() => {
  connectToHost();
  connectWsChannel();
  ensureSlopGroup();
});
connectToHost();
connectWsChannel();
