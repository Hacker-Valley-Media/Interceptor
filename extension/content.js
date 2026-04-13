// extension/src/content.ts
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "execute_action") {
    handleAction(msg.action).then(sendResponse).catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (msg.type === "get_state") {
    try {
      sendResponse(getPageState(msg.full));
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }
});
function getPageState(full = false) {
  domDirty = false;
  const elements = getInteractiveElements();
  const tree = buildElementTree(elements);
  const scrollY = window.scrollY;
  const scrollHeight = document.documentElement.scrollHeight;
  const viewportHeight = window.innerHeight;
  const active = document.activeElement;
  let focusedStr = "none";
  if (active && active !== document.body && active !== document.documentElement) {
    const fRef = getOrAssignRef(active);
    const fRole = getEffectiveRole(active);
    const fName = getAccessibleName(active);
    focusedStr = `${fRef} ${fRole || active.tagName.toLowerCase()} "${fName}"`;
  }
  const state = {
    url: location.href,
    title: document.title,
    elementTree: tree,
    focused: focusedStr,
    scrollPosition: { y: scrollY, height: scrollHeight, viewportHeight },
    timestamp: Date.now()
  };
  if (full) {
    state.staticText = document.body.innerText.slice(0, 5000);
  }
  cacheSnapshot();
  return { success: true, data: state };
}
var selectorMap = new Map;
var nextIndex = 0;
var domDirty = false;
var refRegistry = new Map;
var elementToRef = new WeakMap;
var refMetadata = new Map;
var nextRefId = 1;
function getOrAssignRef(el) {
  const existing = elementToRef.get(el);
  if (existing) {
    const ref = refRegistry.get(existing);
    if (ref?.deref() === el)
      return existing;
  }
  const refId = `e${nextRefId++}`;
  refRegistry.set(refId, new WeakRef(el));
  elementToRef.set(el, refId);
  return refId;
}
function resolveRef(refId) {
  const ref = refRegistry.get(refId);
  if (ref) {
    const el = ref.deref();
    if (el && el.isConnected && isVisible(el))
      return el;
  }
  const meta = refMetadata.get(refId);
  if (meta) {
    const match = findBestMatch(meta.name, meta.role);
    if (match && match.score >= 70) {
      staleWarning = `stale ref ${refId} re-resolved to ${match.refId} (${match.role} '${match.name}', score: ${match.score})`;
      return match.element;
    }
  }
  return null;
}
var staleWarning = null;
function pruneStaleRefs() {
  for (const [id, ref] of refRegistry) {
    const el = ref.deref();
    if (!el || !el.isConnected)
      refRegistry.delete(id);
  }
}
var domObserver = new MutationObserver(() => {
  domDirty = true;
});
if (document.body) {
  domObserver.observe(document.body, { childList: true, subtree: true });
}
window.addEventListener("beforeunload", () => {
  domObserver.disconnect();
});
var INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "DETAILS", "SUMMARY"]);
var INTERACTIVE_ROLES = new Set(["button", "link", "tab", "menuitem", "checkbox", "radio", "switch", "textbox", "combobox", "listbox", "option", "slider"]);
function getShadowRoot(el) {
  if (el.shadowRoot)
    return el.shadowRoot;
  try {
    if (typeof chrome !== "undefined" && chrome.dom?.openOrClosedShadowRoot) {
      return chrome.dom.openOrClosedShadowRoot(el);
    }
  } catch {}
  return null;
}
function walkWithShadow(root, callback) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    const el = node;
    callback(el);
    const shadow = getShadowRoot(el);
    if (shadow)
      walkWithShadow(shadow, callback);
    node = walker.nextNode();
  }
}
function getInteractiveElements() {
  selectorMap.clear();
  nextIndex = 0;
  pruneStaleRefs();
  const results = [];
  walkWithShadow(document.body, (el) => {
    if (isInteractive(el, INTERACTIVE_TAGS, INTERACTIVE_ROLES) && isVisible(el)) {
      const idx = nextIndex++;
      const selector = buildSelector(el);
      selectorMap.set(idx, selector);
      const refId = getOrAssignRef(el);
      const tag = el.tagName.toLowerCase();
      const text = getAccessibleName(el);
      const attrs = getRelevantAttrs(el);
      refMetadata.set(refId, { role: getEffectiveRole(el), name: text, tag, value: (el.value || "").slice(0, 40) });
      results.push({ index: idx, refId, element: el, selector, tag, text, attrs });
    }
  });
  return results;
}
function isInteractive(el, tags, roles) {
  if (tags.has(el.tagName))
    return true;
  const role = el.getAttribute("role");
  if (role && roles.has(role))
    return true;
  if (el.hasAttribute("onclick"))
    return true;
  if (el.getAttribute("contenteditable") === "true")
    return true;
  if (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1")
    return true;
  if (el.namespaceURI === "http://www.w3.org/2000/svg") {
    const svgTag = el.tagName.toLowerCase();
    if (svgTag === "a" && (el.hasAttribute("href") || el.getAttributeNS("http://www.w3.org/1999/xlink", "href")))
      return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("tabindex"))
      return true;
    if (role && roles.has(role))
      return true;
    const cursor = getComputedStyle(el).cursor;
    if (cursor === "pointer")
      return true;
  }
  return false;
}
function isVisible(el) {
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none")
    return false;
  const pos = style.position;
  if (pos !== "fixed" && pos !== "sticky") {
    if (!el.offsetParent && el.tagName !== "BODY")
      return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0)
    return false;
  return true;
}
function getEffectiveRole(el) {
  const explicit = el.getAttribute("role");
  if (explicit)
    return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a" && el.hasAttribute("href"))
    return "link";
  if (tag === "button" || tag === "summary")
    return "button";
  if (tag === "select")
    return "combobox";
  if (tag === "textarea")
    return "textbox";
  if (tag === "nav")
    return "navigation";
  if (tag === "main")
    return "main";
  if (tag === "aside")
    return "complementary";
  if (tag === "form")
    return "form";
  if (tag === "img")
    return "img";
  if (tag === "details")
    return "group";
  if (tag === "ul" || tag === "ol")
    return "list";
  if (tag === "li")
    return "listitem";
  if (tag === "table")
    return "table";
  if (tag === "tr")
    return "row";
  if (tag === "td")
    return "cell";
  if (tag === "th")
    return "columnheader";
  if (/^h[1-6]$/.test(tag))
    return "heading";
  if (tag === "header") {
    if (!el.closest("article, section"))
      return "banner";
  }
  if (tag === "footer") {
    if (!el.closest("article, section"))
      return "contentinfo";
  }
  if (tag === "section") {
    const name = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
    if (name)
      return "region";
  }
  if (el.namespaceURI === "http://www.w3.org/2000/svg") {
    if (tag === "a")
      return "link";
    if (el.hasAttribute("onclick") || getComputedStyle(el).cursor === "pointer")
      return "button";
    return "img";
  }
  if (tag === "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    const inputRoles = {
      checkbox: "checkbox",
      radio: "radio",
      range: "slider",
      search: "searchbox",
      email: "textbox",
      tel: "textbox",
      url: "textbox",
      number: "spinbutton",
      text: "textbox",
      password: "textbox"
    };
    return inputRoles[type] || "textbox";
  }
  return "";
}
function getAccessibleName(el) {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim())
    return ariaLabel.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).map((id) => {
      const ref = document.getElementById(id);
      return ref ? (ref.textContent || "").trim() : "";
    }).filter(Boolean);
    if (parts.length)
      return parts.join(" ");
  }
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    const id = el.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label && (label.textContent || "").trim())
        return (label.textContent || "").trim();
    }
    const parentLabel = el.closest("label");
    if (parentLabel && (parentLabel.textContent || "").trim())
      return (parentLabel.textContent || "").trim();
  }
  if (tag === "IMG") {
    const alt = el.getAttribute("alt");
    if (alt && alt.trim())
      return alt.trim();
  }
  const title = el.getAttribute("title");
  if (title && title.trim())
    return title.trim();
  return (el.textContent || "").trim().slice(0, 80);
}
function buildSelector(el) {
  if (el.id)
    return `#${CSS.escape(el.id)}`;
  const parts = [];
  let current = el;
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(selector);
    current = parent;
  }
  return parts.join(" > ");
}
function getRelevantAttrs(el) {
  const attrs = [];
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role");
  if (role)
    attrs.push(`role="${role}"`);
  if (tag === "a") {
    const href = el.getAttribute("href");
    if (href)
      attrs.push(`href="${href.slice(0, 60)}"`);
  }
  if (tag === "input") {
    const type = el.getAttribute("type");
    if (type)
      attrs.push(`type="${type}"`);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder)
      attrs.push(`placeholder="${placeholder}"`);
    const value = el.value;
    if (value)
      attrs.push(`value="${value.slice(0, 40)}"`);
    if (el.checked)
      attrs.push("checked");
    if (el.disabled)
      attrs.push("disabled");
  }
  if (tag === "select" || tag === "textarea") {
    const value = el.value;
    if (value)
      attrs.push(`value="${value.slice(0, 40)}"`);
  }
  if (tag === "img") {
    const src = el.getAttribute("src");
    if (src)
      attrs.push(`src="${src.slice(0, 60)}"`);
    const alt = el.getAttribute("alt");
    if (alt)
      attrs.push(`alt="${alt.slice(0, 40)}"`);
  }
  const expanded = el.getAttribute("aria-expanded");
  if (expanded)
    attrs.push(`expanded=${expanded}`);
  const pressed = el.getAttribute("aria-pressed");
  if (pressed)
    attrs.push(`pressed=${pressed}`);
  const selected = el.getAttribute("aria-selected");
  if (selected === "true")
    attrs.push("selected");
  const ariaHidden = el.getAttribute("aria-hidden");
  if (ariaHidden === "true")
    attrs.push("aria-hidden");
  if (el.ariaDisabled === "true" || el.disabled)
    attrs.push("disabled");
  const live = el.getAttribute("aria-live");
  if (live && live !== "off")
    attrs.push(`live="${live}"`);
  const required = el.getAttribute("aria-required") || (el.hasAttribute("required") ? "true" : null);
  if (required === "true")
    attrs.push("required");
  const invalid = el.getAttribute("aria-invalid");
  if (invalid === "true")
    attrs.push("invalid");
  return attrs.join(" ");
}
function buildElementTree(elements) {
  return elements.map((e) => {
    const role = getEffectiveRole(e.element);
    const name = e.text ? ` "${e.text}"` : "";
    const attrStr = e.attrs ? ` ${e.attrs}` : "";
    return `[${e.refId}] ${role || e.tag}${name}${attrStr}`;
  }).join(`
`);
}
var LANDMARK_ROLES = new Set(["banner", "navigation", "main", "complementary", "contentinfo", "search", "form", "region"]);
var LANDMARK_TAGS = new Set(["NAV", "MAIN", "ASIDE", "HEADER", "FOOTER", "FORM", "SECTION"]);
function buildA11yTree(root, depth, maxDepth, filter) {
  if (depth > maxDepth)
    return "";
  const lines = [];
  function walk(el, d) {
    if (d > maxDepth)
      return;
    if (!isVisible(el) && el.tagName !== "BODY")
      return;
    const role = getEffectiveRole(el);
    const tag = el.tagName.toLowerCase();
    const isLandmark = LANDMARK_ROLES.has(role) || LANDMARK_TAGS.has(el.tagName);
    const isHeading = /^h[1-6]$/.test(tag) || role === "heading";
    const isInteractiveEl = isInteractive(el, INTERACTIVE_TAGS, INTERACTIVE_ROLES);
    const indent = "  ".repeat(d);
    if (isLandmark && !isInteractiveEl) {
      const name = getAccessibleName(el);
      const nameStr = name && name !== (el.textContent || "").trim().slice(0, 80) ? ` "${name}"` : "";
      lines.push(`${indent}${role || tag}${nameStr}`);
    }
    if (isHeading && filter === "all") {
      const name = getAccessibleName(el);
      lines.push(`${indent}heading "${name}"`);
    }
    if (isInteractiveEl) {
      const refId = getOrAssignRef(el);
      const name = getAccessibleName(el);
      const nameStr = name ? ` "${name}"` : "";
      const attrs = getRelevantAttrs(el);
      const attrStr = attrs ? ` ${attrs}` : "";
      lines.push(`${indent}[${refId}] ${role || tag}${nameStr}${attrStr}`);
    }
    const shadow = getShadowRoot(el);
    if (shadow) {
      lines.push(`${indent}  shadow-root`);
      for (const child of shadow.children) {
        walk(child, d + 2);
      }
    }
    for (const child of el.children) {
      walk(child, isLandmark ? d + 1 : d);
    }
  }
  walk(root, depth);
  return lines.join(`
`);
}
var lastSnapshot = [];
function cacheSnapshot() {
  const entries = [];
  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref();
    if (!el || !el.isConnected)
      continue;
    entries.push({
      refId,
      role: getEffectiveRole(el),
      name: getAccessibleName(el),
      value: (el.value || "").slice(0, 40),
      states: getRelevantAttrs(el)
    });
  }
  lastSnapshot = entries;
}
function computeSnapshotDiff() {
  if (lastSnapshot.length === 0) {
    return { success: false, error: "no previous snapshot — run 'interceptor tree' first" };
  }
  const oldMap = new Map(lastSnapshot.map((e) => [e.refId, e]));
  const current = [];
  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref();
    if (!el || !el.isConnected)
      continue;
    current.push({
      refId,
      role: getEffectiveRole(el),
      name: getAccessibleName(el),
      value: (el.value || "").slice(0, 40),
      states: getRelevantAttrs(el)
    });
  }
  const newMap = new Map(current.map((e) => [e.refId, e]));
  const changes = [];
  for (const [id] of oldMap) {
    if (!newMap.has(id))
      changes.push(`- ${id} (removed)`);
  }
  for (const [id, cur] of newMap) {
    const old = oldMap.get(id);
    if (!old) {
      changes.push(`+ ${id} ${cur.role} "${cur.name}" (new)`);
    } else {
      if (old.value !== cur.value)
        changes.push(`~ ${id} value: "${old.value}" → "${cur.value}"`);
      if (old.states !== cur.states)
        changes.push(`~ ${id} states: ${old.states} → ${cur.states}`);
      if (old.name !== cur.name)
        changes.push(`~ ${id} name: "${old.name}" → "${cur.name}"`);
    }
  }
  lastSnapshot = current;
  return { success: true, data: changes.length ? changes.join(`
`) : "no changes" };
}
async function handleAction(action) {
  const warnDirty = domDirty;
  staleWarning = null;
  const wantChanges = !!action.changes;
  if (wantChanges)
    cacheSnapshot();
  const result = await executeAction(action);
  if (staleWarning && result.success)
    result.warning = staleWarning;
  else if (warnDirty && result.success)
    result.warning = "DOM has changed since last state read";
  if (wantChanges && result.success) {
    const diffResult = computeSnapshotDiff();
    if (diffResult.success)
      result.changes = diffResult.data;
  }
  return result;
}
async function executeAction(action) {
  try {
    switch (action.type) {
      case "get_state":
        return getPageState(action.full);
      case "click": {
        const el = resolveElement(action.index, action.ref);
        if (!el)
          return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
        scrollIntoViewIfNeeded(el);
        dispatchClickSequence(el, action.x, action.y);
        const clickMsg = `clicked [${action.ref || action.index}]${action.x !== undefined ? ` at (${action.x},${action.y})` : ""}`;
        const mutated = await waitForMutation(200);
        if (!mutated) {
          return { success: true, data: clickMsg, warning: "no DOM change after click — if the site requires trusted events, try: interceptor click --os " + (action.ref || action.index) };
        }
        return { success: true, data: clickMsg };
      }
      case "dblclick": {
        const el = resolveElement(action.index, action.ref);
        if (!el)
          return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
        scrollIntoViewIfNeeded(el);
        dispatchClickSequence(el, action.x, action.y);
        const rect = el.getBoundingClientRect();
        const cx = action.x !== undefined ? rect.left + action.x : rect.left + rect.width / 2;
        const cy = action.y !== undefined ? rect.top + action.y : rect.top + rect.height / 2;
        el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        return { success: true };
      }
      case "rightclick": {
        const el = resolveElement(action.index, action.ref);
        if (!el)
          return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
        scrollIntoViewIfNeeded(el);
        const rect = el.getBoundingClientRect();
        const x = action.x !== undefined ? rect.left + action.x : rect.left + rect.width / 2;
        const y = action.y !== undefined ? rect.top + action.y : rect.top + rect.height / 2;
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
        return { success: true };
      }
      case "drag": {
        const el = resolveElement(action.index, action.ref);
        if (!el)
          return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
        scrollIntoViewIfNeeded(el);
        const dragRect = el.getBoundingClientRect();
        const fromX = dragRect.left + action.fromX;
        const fromY = dragRect.top + action.fromY;
        const toX = dragRect.left + action.toX;
        const toY = dragRect.top + action.toY;
        const steps = action.steps || 10;
        const duration = action.duration;
        const baseOpts = { bubbles: true, cancelable: true, button: 0 };
        el.dispatchEvent(new PointerEvent("pointerdown", { ...baseOpts, clientX: fromX, clientY: fromY }));
        el.dispatchEvent(new MouseEvent("mousedown", { ...baseOpts, clientX: fromX, clientY: fromY }));
        if (duration) {
          await new Promise((resolve) => {
            let step = 0;
            function tick() {
              step++;
              if (step > steps) {
                resolve();
                return;
              }
              const t = step / steps;
              const cx = fromX + (toX - fromX) * t;
              const cy = fromY + (toY - fromY) * t;
              const mx = (toX - fromX) / steps;
              const my = (toY - fromY) / steps;
              el.dispatchEvent(new PointerEvent("pointermove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }));
              el.dispatchEvent(new MouseEvent("mousemove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }));
              setTimeout(tick, duration / steps);
            }
            tick();
          });
        } else {
          for (let i = 1;i <= steps; i++) {
            const t = i / steps;
            const cx = fromX + (toX - fromX) * t;
            const cy = fromY + (toY - fromY) * t;
            const mx = (toX - fromX) / steps;
            const my = (toY - fromY) / steps;
            el.dispatchEvent(new PointerEvent("pointermove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }));
            el.dispatchEvent(new MouseEvent("mousemove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }));
          }
        }
        el.dispatchEvent(new PointerEvent("pointerup", { ...baseOpts, clientX: toX, clientY: toY }));
        el.dispatchEvent(new MouseEvent("mouseup", { ...baseOpts, clientX: toX, clientY: toY }));
        return { success: true, data: `dragged from (${action.fromX},${action.fromY}) to (${action.toX},${action.toY}) in ${steps} steps` };
      }
      case "input_text": {
        const el = resolveElement(action.index, action.ref);
        if (!el)
          return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
        el.focus();
        const text = action.text;
        const tag = el.tagName;
        const isContentEditable = el.getAttribute("contenteditable") === "true" || el.isContentEditable;
        const isStandardInput = tag === "INPUT" || tag === "TEXTAREA";
        if (isStandardInput) {
          const inputEl = el;
          if (action.clear) {
            inputEl.value = "";
            inputEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set;
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(inputEl, (action.clear ? "" : inputEl.value) + text);
          } else {
            inputEl.value = (action.clear ? "" : inputEl.value) + text;
          }
          inputEl.dispatchEvent(new Event("input", { bubbles: true }));
          inputEl.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true, data: { typed: true, elementType: "input", method: "nativeSetter" } };
        }
        if (isContentEditable) {
          if (action.clear) {
            document.execCommand("selectAll", false);
            document.execCommand("delete", false);
          }
          document.execCommand("insertText", false, text);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return { success: true, data: { typed: true, elementType: "contenteditable", method: "execCommand" } };
        }
        const shadowRoot = getShadowRoot(el);
        if (shadowRoot) {
          const innerInput = shadowRoot.querySelector("input, textarea, [contenteditable='true']");
          if (innerInput) {
            return await executeAction({ type: "input_text", ref: getOrAssignRef(innerInput), text, clear: action.clear });
          }
        }
        const role = el.getAttribute("role");
        if (role === "textbox" || role === "combobox") {
          if (action.clear) {
            el.textContent = "";
          }
          el.textContent = (action.clear ? "" : el.textContent || "") + text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return { success: true, data: { typed: true, elementType: `role=${role}`, method: "textContent" } };
        }
        return { success: false, error: `element is <${tag.toLowerCase()}${isContentEditable ? " contenteditable" : ""}> — unsupported input type` };
      }
      case "select_option": {
        const el = resolveElement(action.index, action.ref);
        if (!el)
          return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
        el.value = action.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { success: true };
      }
      case "check": {
        const el = resolveElement(action.index, action.ref);
        if (!el)
          return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
        const target = action.checked !== undefined ? !!action.checked : !el.checked;
        if (el.checked !== target) {
          el.checked = target;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return { success: true, data: { checked: el.checked } };
      }
      case "scroll": {
        const dir = action.direction;
        const amount = action.amount || window.innerHeight * 0.8;
        switch (dir) {
          case "up":
            window.scrollBy(0, -amount);
            break;
          case "down":
            window.scrollBy(0, amount);
            break;
          case "top":
            window.scrollTo(0, 0);
            break;
          case "bottom":
            window.scrollTo(0, document.documentElement.scrollHeight);
            break;
        }
        return { success: true };
      }
      case "scroll_absolute": {
        window.scrollTo(0, action.y);
        return { success: true };
      }
      case "get_page_dimensions": {
        return {
          success: true,
          data: {
            scrollHeight: document.documentElement.scrollHeight,
            scrollWidth: document.documentElement.scrollWidth,
            viewportHeight: window.innerHeight,
            viewportWidth: window.innerWidth,
            scrollY: window.scrollY,
            scrollX: window.scrollX,
            devicePixelRatio: window.devicePixelRatio
          }
        };
      }
      case "evaluate": {
        return { success: false, error: "evaluate is handled by background script — this should not be reached" };
      }
      case "scroll_to": {
        const el = resolveElement(action.index, action.ref);
        if (!el)
          return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
        el.scrollIntoView({ block: "center", behavior: "instant" });
        return { success: true };
      }
      case "send_keys": {
        const keys = action.keys;
        const target = document.activeElement || document.body;
        dispatchKeySequence(target, keys);
        return { success: true };
      }
      case "wait":
        await new Promise((r) => setTimeout(r, action.ms));
        return { success: true };
      case "wait_for": {
        const selector = action.selector;
        const timeout = action.timeout || 1e4;
        const el = await waitForElement(selector, timeout);
        return el ? { success: true, data: `found: ${selector}` } : { success: false, error: `timeout waiting for: ${selector}` };
      }
      case "extract_text": {
        if (action.index !== undefined) {
          const el = resolveElement(action.index, action.ref);
          if (!el)
            return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
          return { success: true, data: (el.textContent || "").trim() };
        }
        return { success: true, data: document.body.innerText.slice(0, 1e4) };
      }
      case "extract_html": {
        if (action.index !== undefined) {
          const el = resolveElement(action.index, action.ref);
          if (!el)
            return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
          return { success: true, data: el.outerHTML.slice(0, 1e4) };
        }
        return { success: true, data: document.documentElement.outerHTML.slice(0, 50000) };
      }
      case "focus": {
        const el = resolveElement(action.index, action.ref);
        if (!el)
          return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
        el.focus();
        return { success: true };
      }
      case "blur": {
        document.activeElement?.blur();
        return { success: true };
      }
      case "hover": {
        const el = resolveElement(action.index, action.ref);
        if (!el)
          return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
        const hoverFromX = action.fromX;
        const hoverFromY = action.fromY;
        if (hoverFromX !== undefined && hoverFromY !== undefined) {
          const rect = el.getBoundingClientRect();
          const targetX = rect.left + rect.width / 2;
          const targetY = rect.top + rect.height / 2;
          const hoverSteps = action.steps || 5;
          const baseOpts = { bubbles: true, cancelable: true };
          for (let i = 0;i <= hoverSteps; i++) {
            const t = i / hoverSteps;
            const cx = hoverFromX + (targetX - hoverFromX) * t;
            const cy = hoverFromY + (targetY - hoverFromY) * t;
            const mx = (targetX - hoverFromX) / hoverSteps;
            const my = (targetY - hoverFromY) / hoverSteps;
            el.dispatchEvent(new PointerEvent("pointermove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }));
            el.dispatchEvent(new MouseEvent("mousemove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }));
          }
          el.dispatchEvent(new PointerEvent("pointerover", { ...baseOpts, clientX: targetX, clientY: targetY }));
          el.dispatchEvent(new MouseEvent("mouseover", { ...baseOpts, clientX: targetX, clientY: targetY }));
        } else {
          dispatchHoverSequence(el);
        }
        return { success: true };
      }
      case "query": {
        const selector = action.selector;
        const els = document.querySelectorAll(selector);
        return {
          success: true,
          data: {
            count: els.length,
            elements: Array.from(els).slice(0, 20).map((el, i) => ({
              index: i,
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || "").trim().slice(0, 80),
              id: el.id || undefined,
              classes: el.className || undefined
            }))
          }
        };
      }
      case "query_one": {
        const el = document.querySelector(action.selector);
        if (!el)
          return { success: false, error: `no element matching: ${action.selector}` };
        return {
          success: true,
          data: {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || "").trim().slice(0, 200),
            html: el.outerHTML.slice(0, 500),
            id: el.id || undefined,
            rect: el.getBoundingClientRect()
          }
        };
      }
      case "attr_get": {
        const el = resolveElement(action.index, action.ref) || document.querySelector(action.selector);
        if (!el)
          return { success: false, error: "element not found" };
        const name = action.name;
        return { success: true, data: el.getAttribute(name) };
      }
      case "attr_set": {
        const el = resolveElement(action.index, action.ref) || document.querySelector(action.selector);
        if (!el)
          return { success: false, error: "element not found" };
        el.setAttribute(action.name, action.value);
        return { success: true };
      }
      case "style_get": {
        const el = resolveElement(action.index, action.ref) || document.querySelector(action.selector);
        if (!el)
          return { success: false, error: "element not found" };
        const computed = getComputedStyle(el);
        if (action.property) {
          return { success: true, data: computed.getPropertyValue(action.property) };
        }
        const props = ["display", "visibility", "color", "backgroundColor", "fontSize", "position", "width", "height", "margin", "padding"];
        const styles = {};
        for (const p of props)
          styles[p] = computed.getPropertyValue(p);
        return { success: true, data: styles };
      }
      case "forms": {
        const forms = document.querySelectorAll("form");
        return {
          success: true,
          data: Array.from(forms).map((f, i) => ({
            index: i,
            action: f.action,
            method: f.method,
            id: f.id || undefined,
            fields: Array.from(f.elements).map((el) => ({
              tag: el.tagName.toLowerCase(),
              type: el.type,
              name: el.name,
              value: el.value?.slice(0, 40),
              placeholder: el.placeholder
            }))
          }))
        };
      }
      case "links": {
        const links = document.querySelectorAll("a[href]");
        return {
          success: true,
          data: Array.from(links).slice(0, 100).map((a) => ({
            href: a.href,
            text: (a.textContent || "").trim().slice(0, 60)
          }))
        };
      }
      case "images": {
        const imgs = document.querySelectorAll("img");
        return {
          success: true,
          data: Array.from(imgs).slice(0, 50).map((img) => ({
            src: img.src,
            alt: img.alt,
            width: img.naturalWidth,
            height: img.naturalHeight
          }))
        };
      }
      case "meta": {
        const metas = document.querySelectorAll("meta");
        const data = {};
        metas.forEach((m) => {
          const key = m.getAttribute("name") || m.getAttribute("property") || m.getAttribute("http-equiv");
          const val = m.getAttribute("content");
          if (key && val)
            data[key] = val.slice(0, 200);
        });
        data["title"] = document.title;
        data["canonical"] = document.querySelector('link[rel="canonical"]')?.href || "";
        data["lang"] = document.documentElement.lang || "";
        return { success: true, data };
      }
      case "storage_read": {
        const storageType = action.storageType === "session" ? sessionStorage : localStorage;
        if (action.key) {
          return { success: true, data: storageType.getItem(action.key) };
        }
        const all = {};
        for (let i = 0;i < storageType.length; i++) {
          const key = storageType.key(i);
          all[key] = storageType.getItem(key).slice(0, 200);
        }
        return { success: true, data: all };
      }
      case "storage_write": {
        const storageType = action.storageType === "session" ? sessionStorage : localStorage;
        storageType.setItem(action.key, action.value);
        return { success: true };
      }
      case "storage_delete": {
        const storageType = action.storageType === "session" ? sessionStorage : localStorage;
        storageType.removeItem(action.key);
        return { success: true };
      }
      case "clipboard_read": {
        const text = await navigator.clipboard.readText();
        return { success: true, data: text };
      }
      case "clipboard_write":
        await navigator.clipboard.writeText(action.text);
        return { success: true };
      case "selection_get": {
        const sel = window.getSelection();
        return { success: true, data: sel?.toString() || "" };
      }
      case "selection_set": {
        const el = resolveElement(action.index, action.ref);
        if (!el)
          return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
        el.setSelectionRange(action.start, action.end);
        return { success: true };
      }
      case "rect": {
        const el = resolveElement(action.index, action.ref) || document.querySelector(action.selector);
        if (!el)
          return { success: false, error: "element not found" };
        const r = el.getBoundingClientRect();
        return { success: true, data: { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom, right: r.right } };
      }
      case "exists": {
        const el = document.querySelector(action.selector);
        return { success: true, data: !!el };
      }
      case "count": {
        const els = document.querySelectorAll(action.selector);
        return { success: true, data: els.length };
      }
      case "table_data": {
        const table = action.index !== undefined ? resolveElement(action.index, action.ref) : document.querySelector(action.selector || "table");
        if (!table)
          return { success: false, error: "table not found" };
        const rows = [];
        table.querySelectorAll("tr").forEach((tr) => {
          const cells = [];
          tr.querySelectorAll("td, th").forEach((cell) => cells.push((cell.textContent || "").trim()));
          rows.push(cells);
        });
        return { success: true, data: rows };
      }
      case "page_info": {
        return {
          success: true,
          data: {
            url: location.href,
            title: document.title,
            readyState: document.readyState,
            doctype: document.doctype?.name,
            charset: document.characterSet,
            referrer: document.referrer,
            contentType: document.contentType,
            lastModified: document.lastModified,
            domain: document.domain,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            scroll: { x: window.scrollX, y: window.scrollY, maxX: document.documentElement.scrollWidth, maxY: document.documentElement.scrollHeight }
          }
        };
      }
      case "get_a11y_tree": {
        const maxDepth = action.depth || 15;
        const filter = action.filter || "interactive";
        const maxChars = action.maxChars || 50000;
        pruneStaleRefs();
        const treeOutput = buildA11yTree(document.body, 0, maxDepth, filter);
        const truncated = treeOutput.length > maxChars ? treeOutput.slice(0, maxChars) + `
... (truncated)` : treeOutput;
        cacheSnapshot();
        return { success: true, data: truncated };
      }
      case "diff": {
        if (!domDirty && lastSnapshot.length > 0) {
          return { success: true, data: { changes: 0, added: [], removed: [], changed: [] } };
        }
        const diffResult = computeSnapshotDiff();
        if (diffResult.success && typeof diffResult.data === "string") {
          const lines = diffResult.data === "no changes" ? [] : diffResult.data.split(`
`);
          const added = lines.filter((l) => l.startsWith("+ "));
          const removed = lines.filter((l) => l.startsWith("- "));
          const changed = lines.filter((l) => l.startsWith("~ "));
          return { success: true, data: { changes: lines.length, added, removed, changed, total: lines.length } };
        }
        return diffResult;
      }
      case "find_element": {
        const query = (action.query || "").toLowerCase();
        const targetRole = (action.role || "").toLowerCase();
        const limit = action.limit || 10;
        const results = [];
        for (const [refId, weakRef] of refRegistry) {
          const el = weakRef.deref();
          if (!el || !el.isConnected || !isVisible(el))
            continue;
          const role = getEffectiveRole(el).toLowerCase();
          const name = getAccessibleName(el).toLowerCase();
          let score = 0;
          if (targetRole && role !== targetRole)
            continue;
          if (targetRole && role === targetRole)
            score += 50;
          if (query) {
            if (name === query)
              score += 100;
            else if (name.includes(query))
              score += 60;
            const id = el.getAttribute("id")?.toLowerCase();
            if (id?.includes(query))
              score += 50;
            const placeholder = el.getAttribute("placeholder")?.toLowerCase();
            if (placeholder?.includes(query))
              score += 40;
            const value = (el.value || "").toLowerCase();
            if (value.includes(query))
              score += 30;
          }
          if (score > 0)
            results.push({ refId, role: getEffectiveRole(el), name: getAccessibleName(el), score });
        }
        results.sort((a, b) => b.score - a.score);
        return { success: true, data: results.slice(0, limit) };
      }
      case "modals": {
        const modals = [];
        const dialogEls = document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]');
        dialogEls.forEach((el) => {
          if (!isVisible(el))
            return;
          const ref = getOrAssignRef(el);
          const rect = el.getBoundingClientRect();
          const interactiveChildren = el.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"]').length;
          modals.push({
            ref,
            role: getEffectiveRole(el) || "dialog",
            name: getAccessibleName(el),
            rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
            children: interactiveChildren
          });
        });
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const overlays = document.querySelectorAll("*");
        overlays.forEach((el) => {
          if (el.matches('dialog[open], [role="dialog"], [aria-modal="true"]'))
            return;
          const style = getComputedStyle(el);
          if (style.position !== "fixed" && style.position !== "absolute")
            return;
          const z = parseInt(style.zIndex);
          if (isNaN(z) || z < 100)
            return;
          const rect = el.getBoundingClientRect();
          if (rect.width * rect.height > vw * vh * 0.25) {
            const ref = getOrAssignRef(el);
            modals.push({
              ref,
              role: "overlay",
              name: getAccessibleName(el) || el.tagName.toLowerCase(),
              rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
              children: el.querySelectorAll("a, button, input, select, textarea").length
            });
          }
        });
        return { success: true, data: { modals } };
      }
      case "panels": {
        const panels = [];
        const expandedEls = document.querySelectorAll('[aria-expanded="true"]');
        expandedEls.forEach((el) => {
          if (!isVisible(el))
            return;
          const ref = getOrAssignRef(el);
          const controls = el.getAttribute("aria-controls");
          let contentRef;
          if (controls) {
            const controlledEl = document.getElementById(controls);
            if (controlledEl)
              contentRef = getOrAssignRef(controlledEl);
          }
          panels.push({
            ref,
            role: getEffectiveRole(el) || el.tagName.toLowerCase(),
            name: getAccessibleName(el),
            expanded: true,
            contentRef
          });
        });
        return { success: true, data: { panels } };
      }
      case "click_at": {
        const cx = action.x;
        const cy = action.y;
        const targetEl = document.elementFromPoint(cx, cy);
        if (!targetEl)
          return { success: false, error: `no element at viewport coordinates (${cx}, ${cy})` };
        const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
        targetEl.dispatchEvent(new PointerEvent("pointerover", opts));
        targetEl.dispatchEvent(new MouseEvent("mouseover", opts));
        targetEl.dispatchEvent(new PointerEvent("pointerdown", opts));
        targetEl.dispatchEvent(new MouseEvent("mousedown", opts));
        if (targetEl.focus)
          targetEl.focus();
        targetEl.dispatchEvent(new PointerEvent("pointerup", opts));
        targetEl.dispatchEvent(new MouseEvent("mouseup", opts));
        targetEl.dispatchEvent(new MouseEvent("click", opts));
        const targetRef = getOrAssignRef(targetEl);
        return { success: true, data: { clicked: targetRef, tag: targetEl.tagName.toLowerCase(), at: { x: cx, y: cy } } };
      }
      case "what_at": {
        const wx = action.x;
        const wy = action.y;
        const whatEl = document.elementFromPoint(wx, wy);
        if (!whatEl)
          return { success: true, data: { element: null, at: { x: wx, y: wy } } };
        const whatRef = getOrAssignRef(whatEl);
        const whatRect = whatEl.getBoundingClientRect();
        return {
          success: true,
          data: {
            ref: whatRef,
            tag: whatEl.tagName.toLowerCase(),
            role: getEffectiveRole(whatEl),
            name: getAccessibleName(whatEl),
            rect: { top: whatRect.top, left: whatRect.left, width: whatRect.width, height: whatRect.height }
          }
        };
      }
      case "regions": {
        const regionElements = getInteractiveElements();
        const regions = regionElements.map((e) => {
          const rect = e.element.getBoundingClientRect();
          return {
            ref: e.refId,
            role: getEffectiveRole(e.element) || e.tag,
            name: e.text,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
          };
        });
        regions.sort((a, b) => a.y === b.y ? a.x - b.x : a.y - b.y);
        return { success: true, data: regions };
      }
      case "get_focus": {
        const active = document.activeElement;
        if (!active || active === document.body || active === document.documentElement) {
          return { success: true, data: { focused: null } };
        }
        const focusRef = getOrAssignRef(active);
        const focusRole = getEffectiveRole(active);
        const focusName = getAccessibleName(active);
        const isEditable = active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable || active.getAttribute("role") === "textbox";
        return {
          success: true,
          data: {
            focused: {
              ref: focusRef,
              tag: active.tagName.toLowerCase(),
              role: focusRole,
              name: focusName,
              type: active.type || undefined,
              editable: isEditable
            }
          }
        };
      }
      case "semantic_resolve": {
        const match = findBestMatch(action.name, action.role);
        if (!match)
          return { success: false, error: `no element matching ${action.role}:${action.name}` };
        return { success: true, data: { ref: match.refId, role: match.role, name: match.name, score: match.score } };
      }
      case "find_and_click": {
        const match = findBestMatch(action.name, action.role, action.text);
        if (!match)
          return { success: false, error: "no matching element found (score < 30)" };
        scrollIntoViewIfNeeded(match.element);
        dispatchClickSequence(match.element, action.x, action.y);
        return { success: true, data: { matched: { ref: match.refId, role: match.role, name: match.name, score: match.score }, actionResult: `clicked [${match.refId}]` } };
      }
      case "find_and_type": {
        const match = findBestMatch(action.name, action.role, action.text);
        if (!match)
          return { success: false, error: "no matching element found (score < 30)" };
        const typeResult = await executeAction({ type: "input_text", ref: match.refId, text: action.inputText, clear: action.clear });
        return { success: true, data: { matched: { ref: match.refId, role: match.role, name: match.name, score: match.score }, actionResult: typeResult } };
      }
      case "find_and_check": {
        const match = findBestMatch(action.name, action.role, action.text);
        if (!match)
          return { success: false, error: "no matching element found (score < 30)" };
        const checkResult = await executeAction({ type: "check", ref: match.refId, checked: action.checked });
        return { success: true, data: { matched: { ref: match.refId, role: match.role, name: match.name, score: match.score }, actionResult: checkResult } };
      }
      case "wait_stable": {
        const debounceMs = action.ms || 200;
        const timeoutMs = action.timeout || 5000;
        const stableResult = await waitForDomStable(debounceMs, timeoutMs);
        return { success: true, data: stableResult };
      }
      case "batch": {
        const actions = action.actions;
        if (!actions || !Array.isArray(actions))
          return { success: false, error: "batch requires actions array" };
        if (actions.length > 100)
          return { success: false, error: "batch limited to 100 sub-actions" };
        const stopOnError = !!action.stopOnError;
        const batchTimeout = action.timeout || 30000;
        const batchStart = Date.now();
        const results = [];
        for (const subAction of actions) {
          if (Date.now() - batchStart > batchTimeout) {
            results.push({ action: subAction.type, success: false, error: "batch timeout exceeded" });
            break;
          }
          try {
            const subResult = await executeAction(subAction);
            results.push({
              action: subAction.type,
              success: subResult.success,
              data: subResult.data,
              error: subResult.error,
              warning: subResult.warning
            });
            if (!subResult.success && stopOnError)
              break;
          } catch (err) {
            results.push({ action: subAction.type, success: false, error: err.message });
            if (stopOnError)
              break;
          }
        }
        return { success: true, data: { results, elapsed: Date.now() - batchStart } };
      }
      default:
        return { success: false, error: `unknown action type: ${action.type}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}
function resolveElement(indexOrRef, ref) {
  if (ref) {
    return resolveRef(ref);
  }
  if (indexOrRef === undefined)
    return null;
  const selector = selectorMap.get(indexOrRef);
  if (!selector)
    return null;
  const el = document.querySelector(selector);
  if (!el)
    return null;
  if (!isVisible(el))
    return null;
  return el;
}
function scrollIntoViewIfNeeded(el) {
  const rect = el.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > window.innerHeight) {
    el.scrollIntoView({ block: "center", behavior: "instant" });
  }
}
function dispatchClickSequence(el, atX, atY) {
  const rect = el.getBoundingClientRect();
  const x = atX !== undefined ? rect.left + atX : rect.left + rect.width / 2;
  const y = atY !== undefined ? rect.top + atY : rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
  el.dispatchEvent(new PointerEvent("pointerover", opts));
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  if (el.focus)
    el.focus();
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
}
function dispatchHoverSequence(el) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
  el.dispatchEvent(new PointerEvent("pointerover", opts));
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new PointerEvent("pointermove", opts));
  el.dispatchEvent(new MouseEvent("mousemove", opts));
}
var KEY_CODES = {
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Space: "Space",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12"
};
function getKeyCode(key) {
  if (KEY_CODES[key])
    return KEY_CODES[key];
  if (key.length === 1 && key >= "0" && key <= "9")
    return `Digit${key}`;
  if (key.length === 1 && /^[a-zA-Z]$/.test(key))
    return `Key${key.toUpperCase()}`;
  return KEY_CODES[key] || `Key${key.toUpperCase()}`;
}
function dispatchKeySequence(target, combo) {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const modifiers = {
    ctrlKey: parts.includes("Control"),
    shiftKey: parts.includes("Shift"),
    altKey: parts.includes("Alt"),
    metaKey: parts.includes("Meta")
  };
  const code = getKeyCode(key);
  const keyOpts = { key, code, bubbles: true, cancelable: true, ...modifiers };
  target.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
  target.dispatchEvent(new KeyboardEvent("keypress", keyOpts));
  target.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
}
function findBestMatch(name, role, text) {
  const query = (name || text || "").toLowerCase();
  const targetRole = (role || "").toLowerCase();
  let best = null;
  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref();
    if (!el || !el.isConnected || !isVisible(el))
      continue;
    const elRole = getEffectiveRole(el).toLowerCase();
    const elName = getAccessibleName(el).toLowerCase();
    let score = 0;
    if (targetRole && elRole !== targetRole)
      continue;
    if (targetRole && elRole === targetRole)
      score += 50;
    if (query) {
      if (elName === query)
        score += 100;
      else if (elName.includes(query))
        score += 60;
      const id = el.getAttribute("id")?.toLowerCase();
      if (id?.includes(query))
        score += 50;
      const placeholder = el.getAttribute("placeholder")?.toLowerCase();
      if (placeholder?.includes(query))
        score += 40;
    }
    if (score >= 30 && (!best || score > best.score)) {
      best = { refId, role: getEffectiveRole(el), name: getAccessibleName(el), score, element: el };
    }
  }
  return best;
}
function waitForDomStable(debounceMs = 200, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let mutationCount = 0;
    let debounceTimer = null;
    const hardTimeout = setTimeout(() => {
      observer.disconnect();
      if (debounceTimer)
        clearTimeout(debounceTimer);
      resolve({ stable: false, elapsed: Date.now() - start, mutations: mutationCount });
    }, timeoutMs);
    const observer = new MutationObserver(() => {
      mutationCount++;
      if (debounceTimer)
        clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        observer.disconnect();
        clearTimeout(hardTimeout);
        resolve({ stable: true, elapsed: Date.now() - start, mutations: mutationCount });
      }, debounceMs);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    debounceTimer = setTimeout(() => {
      observer.disconnect();
      clearTimeout(hardTimeout);
      resolve({ stable: true, elapsed: Date.now() - start, mutations: mutationCount });
    }, debounceMs);
  });
}
function waitForElement(selector, timeout) {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearTimeout(timer);
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
function waitForMutation(timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    const observer = new MutationObserver(() => {
      if (!resolved) {
        resolved = true;
        observer.disconnect();
        resolve(true);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        observer.disconnect();
        resolve(false);
      }
    }, timeoutMs);
  });
}
