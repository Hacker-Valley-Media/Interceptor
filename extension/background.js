// extension/src/background.ts
var nativePort = null;
var connectionReady = false;
var isConnecting = false;
var reconnectDelay = 1000;
var offscreenIdleTimer = null;
var OFFSCREEN_IDLE_MS = 30000;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length > 0) {
    resetOffscreenTimer();
    return;
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Image crop, stitch, and diff operations"
  });
  resetOffscreenTimer();
}
function resetOffscreenTimer() {
  if (offscreenIdleTimer)
    clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(async () => {
    try {
      await chrome.offscreen.closeDocument();
    } catch {}
    offscreenIdleTimer = null;
  }, OFFSCREEN_IDLE_MS);
}
async function sendToOffscreen(msg) {
  await ensureOffscreen();
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...msg, target: "offscreen" }, resolve);
  });
}
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
    isConnecting = false;
    const lastError = chrome.runtime.lastError;
    if (lastError) {
      console.error("native host disconnected:", lastError.message);
    }
    console.log("connection_lost", lastError?.message);
    nativePort = null;
    if (wsReady && wsChannel) {
      console.log("native host down but ws channel active, staying ready");
      return;
    }
    connectionReady = false;
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
var debuggerAttached = new Set;
async function cdpCommand(tabId, method, params) {
  const target = { tabId };
  const isAttached = debuggerAttached.has(tabId);
  if (!isAttached) {
    await chrome.debugger.attach(target, "1.3");
    debuggerAttached.add(tabId);
  }
  try {
    const result = await chrome.debugger.sendCommand(target, method, params);
    return result;
  } finally {
    if (!isAttached) {
      try {
        await chrome.debugger.detach(target);
        debuggerAttached.delete(tabId);
      } catch {}
    }
  }
}
async function cdpAttachActDetach(tabId, method, params) {
  try {
    const result = await cdpCommand(tabId, method, params);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    debuggerAttached.delete(source.tabId);
  }
  if (reason === "canceled_by_user") {
    console.log("debugger detached by user (DevTools opened)");
  }
});
async function routeAction(action, tabId) {
  switch (action.type) {
    case "os_click": {
      const win = await chrome.windows.getCurrent();
      const windowBounds = { left: win.left || 0, top: win.top || 0, width: win.width || 0, height: win.height || 0 };
      let pageX = action.x;
      let pageY = action.y;
      if ((action.index !== undefined || action.ref) && (pageX === undefined || pageY === undefined)) {
        const rectResult = await sendToContentScript(tabId, { type: "rect", index: action.index, ref: action.ref });
        if (!rectResult.success || !rectResult.data)
          return { success: false, error: "failed to get element coordinates for os_click" };
        const rect = rectResult.data;
        pageX = rect.left + rect.width / 2;
        pageY = rect.top + rect.height / 2;
      }
      if (pageX === undefined || pageY === undefined)
        return { success: false, error: "os_click requires element target or x,y coordinates" };
      const chromeUiHeight = action.chromeUiHeight || 88 + (debuggerAttached.has(tabId) ? 35 : 0);
      return { success: true, data: { method: "os_event", screenTarget: { pageX, pageY }, windowBounds, button: action.button || "left", clickCount: action.clickCount || 1, chromeUiHeight } };
    }
    case "os_key": {
      return { success: true, data: { method: "os_event", key: action.key, modifiers: action.modifiers || [] } };
    }
    case "os_type": {
      if (action.index !== undefined || action.ref) {
        await sendToContentScript(tabId, { type: "focus", index: action.index, ref: action.ref });
        await new Promise((r) => setTimeout(r, 50));
      }
      return { success: true, data: { method: "os_event", text: action.text } };
    }
    case "os_move": {
      const win = await chrome.windows.getCurrent();
      const windowBounds = { left: win.left || 0, top: win.top || 0, width: win.width || 0, height: win.height || 0 };
      const chromeUiHeight = action.chromeUiHeight || 88 + (debuggerAttached.has(tabId) ? 35 : 0);
      return { success: true, data: { method: "os_event", path: action.path, windowBounds, duration: action.duration || 100, chromeUiHeight } };
    }
    case "screenshot_background": {
      const format = action.format === "png" ? "image/png" : "image/jpeg";
      const quality = (action.quality || 50) / 100;
      try {
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
        if (contexts.length === 0) {
          await chrome.offscreen.createDocument({
            url: "offscreen.html",
            reasons: ["USER_MEDIA"],
            justification: "Background tab screenshot via tabCapture"
          });
        }
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({ target: "offscreen", type: "capture_start", streamId }, () => resolve());
        });
        await new Promise((r) => setTimeout(r, 300));
        const frameResult = await sendToOffscreen({ type: "capture_frame", format, quality });
        await sendToOffscreen({ type: "capture_stop" });
        if (!frameResult.success)
          return { success: false, error: frameResult.error || "capture frame failed" };
        const dataUrl = frameResult.data;
        const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
        return { success: true, data: { dataUrl, format: action.format || "jpeg", size: sizeBytes, method: "tabCapture" } };
      } catch (err) {
        return { success: false, error: `tabCapture failed: ${err.message}` };
      }
    }
    case "cdp_tree": {
      const depth = action.depth || undefined;
      const result = await cdpAttachActDetach(tabId, "Accessibility.getFullAXTree", depth ? { depth } : undefined);
      if (!result.success)
        return { success: false, error: result.error };
      const nodes = result.data?.nodes || [];
      const formatted = nodes.map((n) => {
        const role = n.role?.value || "";
        const name = n.name?.value || "";
        const nodeId = n.nodeId || "";
        return `[${nodeId}] ${role} "${name}"`;
      }).join(`
`);
      return { success: true, data: formatted || "empty tree" };
    }
    case "capabilities": {
      const daemonConnected = connectionReady;
      const hasTabCapture = true;
      const hasDebugger = chrome.runtime.getManifest().permissions?.includes("debugger") ?? false;
      const debuggerActive = debuggerAttached.size > 0;
      return { success: true, data: { layers: { os_input: daemonConnected, tabCapture: hasTabCapture, cdp_debugger: hasDebugger, debugger_active: debuggerActive }, daemon: daemonConnected, infoBannerHeight: debuggerActive ? 35 : 0 } };
    }
    case "status":
      return { success: true, data: { connected: true, version: chrome.runtime.getManifest().version } };
    case "reload_extension":
      setTimeout(() => chrome.runtime.reload(), 100);
      return { success: true, data: "reloading in 100ms" };
    case "screenshot": {
      const format = action.format === "png" ? "png" : "jpeg";
      const quality = action.quality || 50;
      if (action.full) {
        const dims = await sendToContentScript(tabId, { type: "get_page_dimensions" });
        if (!dims.success || !dims.data)
          return { success: false, error: "failed to get page dimensions" };
        const { scrollHeight, viewportHeight, viewportWidth, scrollY: origScrollY, devicePixelRatio } = dims.data;
        const stripCount = Math.ceil(scrollHeight / viewportHeight);
        const strips = [];
        for (let i = 0;i < stripCount; i++) {
          const scrollTo = i * viewportHeight;
          await sendToContentScript(tabId, { type: "scroll_absolute", y: scrollTo });
          await new Promise((r) => setTimeout(r, 150));
          const stripUrl = await chrome.tabs.captureVisibleTab(undefined, { format, quality });
          const stripHeight = i === stripCount - 1 ? scrollHeight - scrollTo : viewportHeight;
          strips.push({ dataUrl: stripUrl, y: Math.round(scrollTo * devicePixelRatio) });
          if (i < stripCount - 1)
            await new Promise((r) => setTimeout(r, 500));
        }
        await sendToContentScript(tabId, { type: "scroll_absolute", y: origScrollY });
        const stitchResult = await sendToOffscreen({
          type: "stitch",
          strips,
          totalWidth: Math.round(viewportWidth * devicePixelRatio),
          totalHeight: Math.round(scrollHeight * devicePixelRatio),
          format,
          quality: quality / 100
        });
        if (!stitchResult.success)
          return { success: false, error: stitchResult.error };
        const stitchedUrl = stitchResult.data;
        const stitchedSize = Math.round((stitchedUrl.length - stitchedUrl.indexOf(",") - 1) * 0.75);
        if (action.save) {
          return { success: true, data: { dataUrl: stitchedUrl, format, size: stitchedSize, save: true, strips: stripCount } };
        }
        return { success: true, data: { dataUrl: stitchedUrl, format, size: stitchedSize, strips: stripCount } };
      }
      let dataUrl;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format, quality });
      } catch (captureErr) {
        const fallback = await routeAction({ type: "screenshot_background", format: action.format, quality: action.quality }, tabId);
        if (fallback.success && fallback.data) {
          fallback.data.fallback = "tabCapture (captureVisibleTab failed)";
        }
        return fallback;
      }
      const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
      if (action.save) {
        return { success: true, data: { dataUrl, format, size: sizeBytes, save: true } };
      }
      let clip = action.clip;
      if (!clip && action.element !== undefined) {
        const elemResult = await sendToContentScript(tabId, { type: "rect", index: action.element });
        if (elemResult.success && elemResult.data) {
          clip = elemResult.data;
        }
      }
      if (clip) {
        const cropResult = await sendToOffscreen({ type: "crop", dataUrl, clip });
        if (!cropResult.success)
          return { success: false, error: cropResult.error };
        const croppedUrl = cropResult.data;
        const croppedSize = Math.round((croppedUrl.length - croppedUrl.indexOf(",") - 1) * 0.75);
        return { success: true, data: { dataUrl: croppedUrl, format, size: croppedSize, clip } };
      }
      if (format === "png" && sizeBytes > 800 * 1024) {
        return { success: true, data: { dataUrl, format, size: sizeBytes, warning: "PNG exceeds 800KB — consider using JPEG for smaller responses" } };
      }
      return { success: true, data: { dataUrl, format, size: sizeBytes } };
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
    case "canvas_list": {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const canvases = Array.from(document.querySelectorAll("canvas"));
          function walkShadowRoots(root) {
            const found = [];
            const children = root instanceof ShadowRoot ? Array.from(root.children) : Array.from(root.children);
            for (const child of children) {
              if (child.tagName === "CANVAS")
                found.push(child);
              const shadow = child.shadowRoot;
              if (shadow)
                found.push(...walkShadowRoots(shadow));
              found.push(...walkShadowRoots(child));
            }
            return found;
          }
          const shadowCanvases = walkShadowRoots(document.body);
          const all = [...new Set([...canvases, ...shadowCanvases])];
          return all.map((c, i) => {
            const rect = c.getBoundingClientRect();
            let contextType = "none";
            try {
              if (c.getContext("2d"))
                contextType = "2d";
              else if (c.getContext("webgl2"))
                contextType = "webgl2";
              else if (c.getContext("webgl"))
                contextType = "webgl";
              else if (c.getContext("bitmaprenderer"))
                contextType = "bitmaprenderer";
            } catch {}
            const style = getComputedStyle(c);
            const hidden = style.display === "none" || style.visibility === "hidden" || c.width === 0 && c.height === 0;
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
              className: c.className || undefined
            };
          });
        }
      });
      return { success: true, data: results[0]?.result ?? [] };
    }
    case "canvas_read": {
      const canvasIdx = action.canvasIndex;
      const fmt = action.format === "png" ? "image/png" : "image/jpeg";
      const qual = action.quality || 0.5;
      const region = action.region;
      const isWebgl = action.webgl;
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [canvasIdx, fmt, qual, region ?? null, isWebgl ?? false],
        func: (idx, format, quality, reg, webgl) => {
          const canvases = Array.from(document.querySelectorAll("canvas"));
          const c = canvases[idx];
          if (!c)
            return { success: false, error: `no canvas at index ${idx}` };
          try {
            if (reg) {
              const ctx = c.getContext("2d");
              if (!ctx)
                return { success: false, error: "canvas has no 2d context for region read" };
              const data = ctx.getImageData(reg.x, reg.y, reg.width, reg.height);
              const tmpCanvas = document.createElement("canvas");
              tmpCanvas.width = reg.width;
              tmpCanvas.height = reg.height;
              const tmpCtx = tmpCanvas.getContext("2d");
              tmpCtx.putImageData(data, 0, 0);
              return { success: true, data: tmpCanvas.toDataURL(format, quality) };
            }
            if (webgl) {
              const gl = c.getContext("webgl2") || c.getContext("webgl");
              if (!gl)
                return { success: false, error: "canvas has no webgl context" };
              const pixels = new Uint8Array(c.width * c.height * 4);
              gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
              const tmpCanvas = document.createElement("canvas");
              tmpCanvas.width = c.width;
              tmpCanvas.height = c.height;
              const tmpCtx = tmpCanvas.getContext("2d");
              const imageData = tmpCtx.createImageData(c.width, c.height);
              for (let row = 0;row < c.height; row++) {
                const srcOff = row * c.width * 4;
                const dstOff = (c.height - 1 - row) * c.width * 4;
                imageData.data.set(pixels.subarray(srcOff, srcOff + c.width * 4), dstOff);
              }
              tmpCtx.putImageData(imageData, 0, 0);
              return { success: true, data: tmpCanvas.toDataURL(format, quality) };
            }
            return { success: true, data: c.toDataURL(format, quality) };
          } catch (e) {
            if (e.message?.includes("tainted"))
              return { success: false, error: "canvas is tainted (cross-origin content)" };
            return { success: false, error: e.message };
          }
        }
      });
      const res = results[0]?.result;
      if (!res)
        return { success: false, error: "no result from canvas read" };
      if (!res.success)
        return { success: false, error: res.error };
      const dataUrl = res.data;
      const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
      if (sizeBytes > 800 * 1024) {
        return { success: true, data: { dataUrl, size: sizeBytes, warning: "Response exceeds 800KB — consider JPEG or smaller region" } };
      }
      return { success: true, data: { dataUrl, size: sizeBytes } };
    }
    case "capture_start": {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      if (contexts.length === 0) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["USER_MEDIA"],
          justification: "Tab capture stream processing"
        });
      }
      chrome.runtime.sendMessage({ target: "offscreen", type: "capture_start", streamId });
      return { success: true, data: { streamId, tabId } };
    }
    case "capture_frame": {
      const fmt = action.format === "png" ? "image/png" : "image/jpeg";
      const qual = action.quality || 50;
      const frameResult = await sendToOffscreen({ type: "capture_frame", format: fmt, quality: qual / 100 });
      if (!frameResult.success)
        return { success: false, error: frameResult.error };
      return { success: true, data: { dataUrl: frameResult.data } };
    }
    case "capture_stop": {
      const stopResult = await sendToOffscreen({ type: "capture_stop" });
      try {
        await chrome.offscreen.closeDocument();
      } catch {}
      return { success: true };
    }
    case "canvas_diff": {
      const image1 = action.image1;
      const image2 = action.image2;
      const threshold = action.threshold || 0;
      const returnImage = action.returnImage || false;
      const diffResult = await sendToOffscreen({ type: "diff", image1, image2, threshold, returnImage });
      if (!diffResult.success)
        return { success: false, error: diffResult.error };
      return { success: true, data: diffResult.data };
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
    default: {
      const contentResult = await sendToContentScript(tabId, action, action.frameId);
      if (action.type === "click" && contentResult.success && contentResult.warning?.includes("no DOM change") && connectionReady) {
        console.log("auto-escalating click to OS-level input");
        const osResult = await routeAction({ ...action, type: "os_click" }, tabId);
        if (osResult.success) {
          return { success: true, data: { ...typeof osResult.data === "object" && osResult.data || {}, escalated: { from: "synthetic", to: "os_click", reason: "no DOM mutation after synthetic click" } }, tabId };
        }
        return { success: false, error: "click failed at all layers", data: { diagnostics: { layers_tried: ["synthetic", "os_click"], reason: "synthetic produced no DOM change, os_click failed", suggestion: "verify element is interactive and Chrome window is visible" } } };
      }
      if (!contentResult.success && contentResult.error) {
        contentResult.data = { ...typeof contentResult.data === "object" && contentResult.data ? contentResult.data : {}, diagnostics: { layer_tried: "content_script", reason: contentResult.error, suggestion: action.type === "click" ? "try: slop click --os " + (action.ref || action.index || "") : undefined } };
      }
      return contentResult;
    }
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
      if (!connectionReady) {
        connectionReady = true;
        reconnectDelay = 1000;
        isConnecting = false;
        console.log("connection ready via ws channel");
        while (messageQueue.length > 0) {
          const queued = messageQueue.shift();
          handleDaemonMessage(queued);
        }
      }
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : "");
        console.log("ws onmessage:", JSON.stringify(msg).slice(0, 200));
        if (msg.id && msg.action) {
          handleDaemonMessage(msg);
        }
      } catch (err) {
        console.error("ws onmessage error:", err);
      }
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
async function sendToContentScript(tabId, action, frameId) {
  return new Promise((resolve) => {
    const targetFrame = frameId !== undefined ? frameId : 0;
    const opts = { frameId: targetFrame };
    chrome.tabs.sendMessage(tabId, { type: "execute_action", action }, opts, (response) => {
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
    const start = Date.now();
    const stage1Timeout = Math.min(timeoutMs, 1e4);
    const hardTimer = setTimeout(async () => {
      chrome.tabs.onUpdated.removeListener(listener);
      const probeResult = await probeContentReady(tabId, Math.max(timeoutMs - (Date.now() - start), 1000));
      resolve({ ready: probeResult, elapsed: Date.now() - start });
    }, timeoutMs);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(hardTimer);
        chrome.tabs.onUpdated.removeListener(listener);
        const remaining = Math.max(timeoutMs - (Date.now() - start), 2000);
        probeContentReady(tabId, remaining).then((ready) => {
          resolve({ ready, elapsed: Date.now() - start });
        });
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && tab.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(hardTimer);
        const remaining = Math.max(timeoutMs - (Date.now() - start), 2000);
        const ready = await probeContentReady(tabId, remaining);
        resolve({ ready, elapsed: Date.now() - start });
      }
    }, stage1Timeout);
  });
}
async function probeContentReady(tabId, timeoutMs) {
  try {
    const result = await sendToContentScript(tabId, { type: "wait_stable", ms: 500, timeout: Math.min(timeoutMs, 5000) });
    return result.success && (result.data?.stable ?? true);
  } catch {
    return false;
  }
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
