(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  function __accessProp(key) {
    return this[key];
  }
  var __toCommonJS = (from) => {
    var entry = (__moduleCache ??= new WeakMap).get(from), desc;
    if (entry)
      return entry;
    entry = __defProp({}, "__esModule", { value: true });
    if (from && typeof from === "object" || typeof from === "function") {
      for (var key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(entry, key))
          __defProp(entry, key, {
            get: __accessProp.bind(from, key),
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
          });
    }
    __moduleCache.set(from, entry);
    return entry;
  };
  var __moduleCache;
  var __returnValue = (v) => v;
  function __exportSetter(name, newValue) {
    this[name] = __returnValue.bind(null, newValue);
  }
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, {
        get: all[name],
        enumerable: true,
        configurable: true,
        set: __exportSetter.bind(all, name)
      });
  };

  // extension/src/popup.ts
  var exports_popup = {};
  __export(exports_popup, {
    terminalConnectionSnapshot: () => terminalConnectionSnapshot,
    renderConnectionHealth: () => renderConnectionHealth
  });
  var DOWNLOAD_URL = "https://github.com/Hacker-Valley-Media/Interceptor/releases/latest";
  var transportName = (transport) => ({
    native: "Native messaging",
    websocket: "WebSocket",
    "safari-native": "Safari native"
  })[transport ?? "native"];
  function renderConnectionHealth(health, snapshot) {
    health.replaceChildren();
    health.dataset.state = snapshot.state;
    health.setAttribute("aria-live", "polite");
    health.setAttribute("role", snapshot.state === "disconnected" ? "alert" : "status");
    const title = document.createElement("strong");
    title.style.display = "block";
    if (snapshot.state === "connecting") {
      title.textContent = "Checking Interceptor daemon...";
      health.appendChild(title);
      return;
    }
    if (snapshot.state === "connected") {
      title.textContent = "Interceptor daemon is healthy";
      const detail2 = document.createElement("div");
      detail2.className = "connection-detail";
      detail2.textContent = transportName(snapshot.transport);
      health.append(title, detail2);
      return;
    }
    const hostMissing = snapshot.nativeError?.toLowerCase().includes("specified native messaging host not found");
    title.textContent = hostMissing ? "Interceptor may not be installed" : "Interceptor daemon is not healthy";
    const detail = document.createElement("p");
    detail.className = "connection-detail";
    detail.textContent = hostMissing ? "Install or repair the desktop package, then reopen this popup." : "Start Interceptor by running any interceptor command, then reopen this popup.";
    health.append(title, detail);
    if (!hostMissing)
      return;
    const link = document.createElement("a");
    link.href = DOWNLOAD_URL;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Download latest Interceptor";
    health.appendChild(link);
  }
  function terminalConnectionSnapshot(snapshot, finalAttempt) {
    return finalAttempt && snapshot.state === "connecting" ? { state: "disconnected" } : snapshot;
  }
  var healthEl = document.getElementById("connectionHealth") ?? document.createElement("div");
  if (!healthEl.id) {
    healthEl.id = "connectionHealth";
    document.body.prepend(healthEl);
  }
  async function refreshConnectionHealth() {
    let renderedSnapshot = "";
    for (let attempt = 0;attempt <= 20; attempt += 1) {
      let snapshot;
      try {
        snapshot = await chrome.runtime.sendMessage({ type: "interceptor_connection_status" });
      } catch {
        snapshot = { state: "disconnected" };
      }
      if (!snapshot || !["connecting", "connected", "disconnected"].includes(snapshot.state)) {
        snapshot = { state: "disconnected" };
      }
      snapshot = terminalConnectionSnapshot(snapshot, attempt === 20);
      const snapshotKey = JSON.stringify(snapshot);
      if (snapshotKey !== renderedSnapshot) {
        renderConnectionHealth(healthEl, snapshot);
        renderedSnapshot = snapshotKey;
      }
      if (snapshot.state === "connected" || attempt === 20)
        return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  refreshConnectionHealth();
  var input = document.getElementById("contextId");
  var saveBtn = document.getElementById("save");
  var resetBtn = document.getElementById("reset");
  var statusEl = document.getElementById("status");
  function showStatus(msg, ms = 1800) {
    statusEl.textContent = msg;
    setTimeout(() => {
      statusEl.textContent = "";
    }, ms);
  }
  chrome.storage.local.get("contextId").then((stored) => {
    const contextId = stored.contextId;
    if (typeof contextId === "string")
      input.value = contextId;
  });
  saveBtn.addEventListener("click", async () => {
    const value = input.value.trim();
    if (!value) {
      showStatus("Context ID cannot be empty.");
      return;
    }
    await chrome.storage.local.set({ contextId: value });
    showStatus("Saved.");
  });
  resetBtn.addEventListener("click", async () => {
    await chrome.storage.local.remove("contextId");
    input.value = "";
    showStatus("Reset — new ID assigned on next connect.");
  });
  var hasTabGroups = !!chrome.tabGroups;
  if (hasTabGroups) {
    const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
    const wrap = document.createElement("div");
    wrap.style.marginTop = "14px";
    const brandLabel = document.createElement("label");
    brandLabel.textContent = "Tab group label";
    brandLabel.htmlFor = "brandTitle";
    wrap.appendChild(brandLabel);
    const titleInput = document.createElement("input");
    titleInput.id = "brandTitle";
    titleInput.type = "text";
    titleInput.placeholder = "e.g. interceptor";
    titleInput.spellcheck = false;
    wrap.appendChild(titleInput);
    const colorSelect = document.createElement("select");
    colorSelect.id = "brandColor";
    colorSelect.style.cssText = "width:100%;margin-top:6px;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;";
    for (const c of COLORS) {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      colorSelect.appendChild(opt);
    }
    colorSelect.value = "cyan";
    wrap.appendChild(colorSelect);
    const brandRow = document.createElement("div");
    brandRow.className = "row";
    const brandSave = document.createElement("button");
    brandSave.id = "brandSave";
    brandSave.textContent = "Save label";
    brandSave.style.cssText = "background:#0071e3;color:#fff;";
    brandRow.appendChild(brandSave);
    wrap.appendChild(brandRow);
    statusEl.parentElement?.insertBefore(wrap, statusEl);
    chrome.storage.local.get("brandTabGroup").then((stored) => {
      const b = stored.brandTabGroup;
      if (b && typeof b.title === "string")
        titleInput.value = b.title;
      if (b && typeof b.color === "string" && COLORS.includes(b.color))
        colorSelect.value = b.color;
    });
    brandSave.addEventListener("click", async () => {
      const title = titleInput.value.trim();
      if (!title) {
        showStatus("Tab group label cannot be empty.");
        return;
      }
      await chrome.storage.local.set({ brandTabGroup: { title, color: colorSelect.value } });
      showStatus("Tab group label saved.");
    });
    const DEFAULT_LIFECYCLE = { reuse: true, idleCloseMinutes: 10 };
    const lcWrap = document.createElement("div");
    lcWrap.style.marginTop = "14px";
    const lcLabel = document.createElement("label");
    lcLabel.textContent = "Tab lifecycle";
    lcWrap.appendChild(lcLabel);
    const reuseRow = document.createElement("label");
    reuseRow.style.cssText = "display:flex;align-items:center;gap:6px;font-weight:400;margin-bottom:6px;";
    const reuseCheck = document.createElement("input");
    reuseCheck.id = "lcReuse";
    reuseCheck.type = "checkbox";
    reuseCheck.style.cssText = "width:auto;";
    reuseCheck.checked = DEFAULT_LIFECYCLE.reuse;
    reuseRow.appendChild(reuseCheck);
    reuseRow.appendChild(document.createTextNode("Reuse tabs (named groups)"));
    lcWrap.appendChild(reuseRow);
    const idleRow = document.createElement("label");
    idleRow.style.cssText = "display:flex;align-items:center;gap:6px;font-weight:400;";
    idleRow.appendChild(document.createTextNode("Close idle groups after"));
    const idleInput = document.createElement("input");
    idleInput.id = "lcIdle";
    idleInput.type = "number";
    idleInput.min = "0";
    idleInput.step = "1";
    idleInput.style.cssText = "width:64px;";
    idleInput.value = String(DEFAULT_LIFECYCLE.idleCloseMinutes);
    idleRow.appendChild(idleInput);
    idleRow.appendChild(document.createTextNode("min (0 = never)"));
    lcWrap.appendChild(idleRow);
    const lcRow = document.createElement("div");
    lcRow.className = "row";
    const lcSave = document.createElement("button");
    lcSave.id = "lcSave";
    lcSave.textContent = "Save lifecycle";
    lcSave.style.cssText = "background:#0071e3;color:#fff;";
    lcRow.appendChild(lcSave);
    lcWrap.appendChild(lcRow);
    statusEl.parentElement?.insertBefore(lcWrap, statusEl);
    chrome.storage.local.get("tabLifecycle").then((stored) => {
      const lc = stored.tabLifecycle;
      if (lc && typeof lc.reuse === "boolean")
        reuseCheck.checked = lc.reuse;
      if (lc && typeof lc.idleCloseMinutes === "number" && Number.isFinite(lc.idleCloseMinutes)) {
        idleInput.value = String(Math.max(0, Math.round(lc.idleCloseMinutes)));
      }
    });
    lcSave.addEventListener("click", async () => {
      const idle = Math.max(0, Math.round(Number(idleInput.value)));
      if (!Number.isFinite(idle)) {
        showStatus("Idle minutes must be a number.");
        return;
      }
      await chrome.storage.local.set({ tabLifecycle: { reuse: reuseCheck.checked, idleCloseMinutes: idle } });
      showStatus("Tab lifecycle saved.");
    });
  }
})();
