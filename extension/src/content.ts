chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "execute_action") {
    handleAction(msg.action)
      .then(sendResponse)
      .catch((err: Error) => sendResponse({ success: false, error: err.message }))
    return true
  }
  if (msg.type === "get_state") {
    try {
      sendResponse(getPageState(msg.full))
    } catch (err) {
      sendResponse({ success: false, error: (err as Error).message })
    }
    return true
  }
})

function getPageState(full = false) {
  domDirty = false
  const elements = getInteractiveElements()
  const tree = buildElementTree(elements)
  const scrollY = window.scrollY
  const scrollHeight = document.documentElement.scrollHeight
  const viewportHeight = window.innerHeight

  const state: Record<string, unknown> = {
    url: location.href,
    title: document.title,
    elementTree: tree,
    scrollPosition: { y: scrollY, height: scrollHeight, viewportHeight },
    timestamp: Date.now()
  }

  if (full) {
    state.staticText = document.body.innerText.slice(0, 5000)
  }

  cacheSnapshot()
  return { success: true, data: state }
}

interface IndexedElement {
  index: number
  refId: string
  element: Element
  selector: string
  tag: string
  text: string
  attrs: string
}

const selectorMap = new Map<number, string>()
let nextIndex = 0
let domDirty = false

const refRegistry = new Map<string, WeakRef<Element>>()
const elementToRef = new WeakMap<Element, string>()
let nextRefId = 1

function getOrAssignRef(el: Element): string {
  const existing = elementToRef.get(el)
  if (existing) {
    const ref = refRegistry.get(existing)
    if (ref?.deref() === el) return existing
  }
  const refId = `e${nextRefId++}`
  refRegistry.set(refId, new WeakRef(el))
  elementToRef.set(el, refId)
  return refId
}

function resolveRef(refId: string): Element | null {
  const ref = refRegistry.get(refId)
  if (!ref) return null
  const el = ref.deref()
  if (!el || !el.isConnected) return null
  if (!isVisible(el)) return null
  return el
}

function pruneStaleRefs() {
  for (const [id, ref] of refRegistry) {
    const el = ref.deref()
    if (!el || !el.isConnected) refRegistry.delete(id)
  }
}

const domObserver = new MutationObserver(() => {
  domDirty = true
})

if (document.body) {
  domObserver.observe(document.body, { childList: true, subtree: true })
}

window.addEventListener("beforeunload", () => {
  domObserver.disconnect()
})

const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "DETAILS", "SUMMARY"])
const INTERACTIVE_ROLES = new Set(["button", "link", "tab", "menuitem", "checkbox", "radio", "switch", "textbox", "combobox", "listbox", "option", "slider"])

function getShadowRoot(el: Element): ShadowRoot | null {
  if ((el as HTMLElement).shadowRoot) return (el as HTMLElement).shadowRoot
  try {
    if (typeof chrome !== "undefined" && chrome.dom?.openOrClosedShadowRoot) {
      return chrome.dom.openOrClosedShadowRoot(el as HTMLElement) as ShadowRoot | null
    }
  } catch {}
  return null
}

function walkWithShadow(root: Node, callback: (el: Element) => void) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  let node: Node | null = walker.nextNode()
  while (node) {
    const el = node as Element
    callback(el)
    const shadow = getShadowRoot(el)
    if (shadow) walkWithShadow(shadow, callback)
    node = walker.nextNode()
  }
}

function getInteractiveElements(): IndexedElement[] {
  selectorMap.clear()
  nextIndex = 0
  pruneStaleRefs()

  const results: IndexedElement[] = []

  walkWithShadow(document.body, (el) => {
    if (isInteractive(el, INTERACTIVE_TAGS, INTERACTIVE_ROLES) && isVisible(el)) {
      const idx = nextIndex++
      const selector = buildSelector(el)
      selectorMap.set(idx, selector)
      const refId = getOrAssignRef(el)

      const tag = el.tagName.toLowerCase()
      const text = getAccessibleName(el)
      const attrs = getRelevantAttrs(el)

      results.push({ index: idx, refId, element: el, selector, tag, text, attrs })
    }
  })

  return results
}

function isInteractive(el: Element, tags: Set<string>, roles: Set<string>): boolean {
  if (tags.has(el.tagName)) return true
  const role = el.getAttribute("role")
  if (role && roles.has(role)) return true
  if (el.hasAttribute("onclick")) return true
  if (el.getAttribute("contenteditable") === "true") return true
  if (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") return true
  return false
}

function isVisible(el: Element): boolean {
  const style = getComputedStyle(el)
  if (style.visibility === "hidden" || style.display === "none") return false
  const pos = style.position
  if (pos !== "fixed" && pos !== "sticky") {
    if (!(el as HTMLElement).offsetParent && el.tagName !== "BODY") return false
  }
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  return true
}

function getEffectiveRole(el: Element): string {
  const explicit = el.getAttribute("role")
  if (explicit) return explicit

  const tag = el.tagName.toLowerCase()
  if (tag === "a" && el.hasAttribute("href")) return "link"
  if (tag === "button" || tag === "summary") return "button"
  if (tag === "select") return "combobox"
  if (tag === "textarea") return "textbox"
  if (tag === "nav") return "navigation"
  if (tag === "main") return "main"
  if (tag === "aside") return "complementary"
  if (tag === "form") return "form"
  if (tag === "img") return "img"
  if (tag === "details") return "group"
  if (tag === "ul" || tag === "ol") return "list"
  if (tag === "li") return "listitem"
  if (tag === "table") return "table"
  if (tag === "tr") return "row"
  if (tag === "td") return "cell"
  if (tag === "th") return "columnheader"
  if (/^h[1-6]$/.test(tag)) return "heading"
  if (tag === "header") {
    if (!el.closest("article, section")) return "banner"
  }
  if (tag === "footer") {
    if (!el.closest("article, section")) return "contentinfo"
  }
  if (tag === "section") {
    const name = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")
    if (name) return "region"
  }
  if (tag === "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase()
    const inputRoles: Record<string, string> = {
      checkbox: "checkbox", radio: "radio", range: "slider",
      search: "searchbox", email: "textbox", tel: "textbox",
      url: "textbox", number: "spinbutton", text: "textbox",
      password: "textbox"
    }
    return inputRoles[type] || "textbox"
  }
  return ""
}

function getAccessibleName(el: Element): string {
  const ariaLabel = el.getAttribute("aria-label")
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim()

  const labelledBy = el.getAttribute("aria-labelledby")
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).map(id => {
      const ref = document.getElementById(id)
      return ref ? (ref.textContent || "").trim() : ""
    }).filter(Boolean)
    if (parts.length) return parts.join(" ")
  }

  const tag = el.tagName
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    const id = el.getAttribute("id")
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`)
      if (label && (label.textContent || "").trim()) return (label.textContent || "").trim()
    }
    const parentLabel = el.closest("label")
    if (parentLabel && (parentLabel.textContent || "").trim()) return (parentLabel.textContent || "").trim()
  }

  if (tag === "IMG") {
    const alt = el.getAttribute("alt")
    if (alt && alt.trim()) return alt.trim()
  }

  const title = el.getAttribute("title")
  if (title && title.trim()) return title.trim()

  return (el.textContent || "").trim().slice(0, 80)
}

function buildSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`
  const parts: string[] = []
  let current: Element | null = el
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase()
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`)
      break
    }
    const parent = current.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === current!.tagName)
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1
        selector += `:nth-of-type(${idx})`
      }
    }
    parts.unshift(selector)
    current = parent
  }
  return parts.join(" > ")
}

function getRelevantAttrs(el: Element): string {
  const attrs: string[] = []
  const tag = el.tagName.toLowerCase()

  const role = el.getAttribute("role")
  if (role) attrs.push(`role="${role}"`)

  if (tag === "a") {
    const href = el.getAttribute("href")
    if (href) attrs.push(`href="${href.slice(0, 60)}"`)
  }
  if (tag === "input") {
    const type = el.getAttribute("type")
    if (type) attrs.push(`type="${type}"`)
    const placeholder = el.getAttribute("placeholder")
    if (placeholder) attrs.push(`placeholder="${placeholder}"`)
    const value = (el as HTMLInputElement).value
    if (value) attrs.push(`value="${value.slice(0, 40)}"`)
    if ((el as HTMLInputElement).checked) attrs.push("checked")
    if ((el as HTMLInputElement).disabled) attrs.push("disabled")
  }
  if (tag === "select" || tag === "textarea") {
    const value = (el as HTMLSelectElement | HTMLTextAreaElement).value
    if (value) attrs.push(`value="${value.slice(0, 40)}"`)
  }
  if (tag === "img") {
    const src = el.getAttribute("src")
    if (src) attrs.push(`src="${src.slice(0, 60)}"`)
    const alt = el.getAttribute("alt")
    if (alt) attrs.push(`alt="${alt.slice(0, 40)}"`)
  }

  const expanded = el.getAttribute("aria-expanded")
  if (expanded) attrs.push(`expanded=${expanded}`)

  const pressed = el.getAttribute("aria-pressed")
  if (pressed) attrs.push(`pressed=${pressed}`)

  const selected = el.getAttribute("aria-selected")
  if (selected === "true") attrs.push("selected")

  const ariaHidden = el.getAttribute("aria-hidden")
  if (ariaHidden === "true") attrs.push("aria-hidden")

  if ((el as HTMLElement).ariaDisabled === "true" || (el as HTMLButtonElement).disabled) attrs.push("disabled")

  const live = el.getAttribute("aria-live")
  if (live && live !== "off") attrs.push(`live="${live}"`)

  const required = el.getAttribute("aria-required") || (el.hasAttribute("required") ? "true" : null)
  if (required === "true") attrs.push("required")

  const invalid = el.getAttribute("aria-invalid")
  if (invalid === "true") attrs.push("invalid")

  return attrs.join(" ")
}

function buildElementTree(elements: IndexedElement[]): string {
  return elements.map(e => {
    const role = getEffectiveRole(e.element)
    const name = e.text ? ` "${e.text}"` : ""
    const attrStr = e.attrs ? ` ${e.attrs}` : ""
    return `[${e.refId}] ${role || e.tag}${name}${attrStr}`
  }).join("\n")
}

const LANDMARK_ROLES = new Set(["banner", "navigation", "main", "complementary", "contentinfo", "search", "form", "region"])
const LANDMARK_TAGS = new Set(["NAV", "MAIN", "ASIDE", "HEADER", "FOOTER", "FORM", "SECTION"])

function buildA11yTree(root: Element, depth: number, maxDepth: number, filter: string): string {
  if (depth > maxDepth) return ""
  const lines: string[] = []

  function walk(el: Element, d: number) {
    if (d > maxDepth) return
    if (!isVisible(el) && el.tagName !== "BODY") return

    const role = getEffectiveRole(el)
    const tag = el.tagName.toLowerCase()
    const isLandmark = LANDMARK_ROLES.has(role) || LANDMARK_TAGS.has(el.tagName)
    const isHeading = /^h[1-6]$/.test(tag) || role === "heading"
    const isInteractiveEl = isInteractive(el, INTERACTIVE_TAGS, INTERACTIVE_ROLES)
    const indent = "  ".repeat(d)

    if (isLandmark && !isInteractiveEl) {
      const name = getAccessibleName(el)
      const nameStr = name && name !== (el.textContent || "").trim().slice(0, 80) ? ` "${name}"` : ""
      lines.push(`${indent}${role || tag}${nameStr}`)
    }

    if (isHeading && filter === "all") {
      const name = getAccessibleName(el)
      lines.push(`${indent}heading "${name}"`)
    }

    if (isInteractiveEl) {
      const refId = getOrAssignRef(el)
      const name = getAccessibleName(el)
      const nameStr = name ? ` "${name}"` : ""
      const attrs = getRelevantAttrs(el)
      const attrStr = attrs ? ` ${attrs}` : ""
      lines.push(`${indent}[${refId}] ${role || tag}${nameStr}${attrStr}`)
    }

    const shadow = getShadowRoot(el)
    if (shadow) {
      lines.push(`${indent}  shadow-root`)
      for (const child of shadow.children) {
        walk(child, d + 2)
      }
    }

    for (const child of el.children) {
      walk(child, isLandmark ? d + 1 : d)
    }
  }

  walk(root, depth)
  return lines.join("\n")
}

interface SnapshotEntry {
  refId: string
  role: string
  name: string
  value: string
  states: string
}

let lastSnapshot: SnapshotEntry[] = []
let snapshotTabId: number | undefined

function cacheSnapshot() {
  const entries: SnapshotEntry[] = []
  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref()
    if (!el || !el.isConnected) continue
    entries.push({
      refId,
      role: getEffectiveRole(el),
      name: getAccessibleName(el),
      value: ((el as HTMLInputElement).value || "").slice(0, 40),
      states: getRelevantAttrs(el)
    })
  }
  lastSnapshot = entries
}

function computeSnapshotDiff(): { success: boolean; error?: string; data?: unknown } {
  if (lastSnapshot.length === 0) {
    return { success: false, error: "no previous snapshot — run 'slop tree' first" }
  }

  const oldMap = new Map(lastSnapshot.map(e => [e.refId, e]))
  const current: SnapshotEntry[] = []
  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref()
    if (!el || !el.isConnected) continue
    current.push({
      refId,
      role: getEffectiveRole(el),
      name: getAccessibleName(el),
      value: ((el as HTMLInputElement).value || "").slice(0, 40),
      states: getRelevantAttrs(el)
    })
  }
  const newMap = new Map(current.map(e => [e.refId, e]))

  const changes: string[] = []
  for (const [id] of oldMap) {
    if (!newMap.has(id)) changes.push(`- ${id} (removed)`)
  }
  for (const [id, cur] of newMap) {
    const old = oldMap.get(id)
    if (!old) {
      changes.push(`+ ${id} ${cur.role} "${cur.name}" (new)`)
    } else {
      if (old.value !== cur.value) changes.push(`~ ${id} value: "${old.value}" → "${cur.value}"`)
      if (old.states !== cur.states) changes.push(`~ ${id} states: ${old.states} → ${cur.states}`)
      if (old.name !== cur.name) changes.push(`~ ${id} name: "${old.name}" → "${cur.name}"`)
    }
  }

  lastSnapshot = current
  return { success: true, data: changes.length ? changes.join("\n") : "no changes" }
}

async function handleAction(action: { type: string; [key: string]: unknown }): Promise<{ success: boolean; error?: string; warning?: string; data?: unknown }> {
  const warnDirty = domDirty
  const result = await executeAction(action)
  if (warnDirty && result.success) result.warning = "DOM has changed since last state read"
  return result
}

async function executeAction(action: { type: string; [key: string]: unknown }): Promise<{ success: boolean; error?: string; warning?: string; data?: unknown }> {
  try {
    switch (action.type) {
      case "get_state":
        return getPageState(action.full as boolean)

      case "click": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
        if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
        scrollIntoViewIfNeeded(el)
        dispatchClickSequence(el)
        return { success: true, data: `clicked [${action.ref || action.index}]` }
      }

      case "dblclick": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
        if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
        scrollIntoViewIfNeeded(el)
        dispatchClickSequence(el)
        const rect = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }))
        return { success: true }
      }

      case "rightclick": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
        if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
        scrollIntoViewIfNeeded(el)
        const rect = el.getBoundingClientRect()
        const x = rect.left + rect.width / 2
        const y = rect.top + rect.height / 2
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }))
        return { success: true }
      }

      case "input_text": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) as HTMLInputElement | HTMLTextAreaElement | null
        if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
        el.focus()
        if (action.clear) {
          el.value = ""
          el.dispatchEvent(new Event("input", { bubbles: true }))
        }
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          "value"
        )?.set
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, (action.clear ? "" : el.value) + (action.text as string))
        } else {
          el.value = (action.clear ? "" : el.value) + (action.text as string)
        }
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
        return { success: true }
      }

      case "select_option": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) as HTMLSelectElement | null
        if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
        el.value = action.value as string
        el.dispatchEvent(new Event("change", { bubbles: true }))
        return { success: true }
      }

      case "check": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) as HTMLInputElement | null
        if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
        const target = action.checked !== undefined ? !!(action.checked) : !el.checked
        if (el.checked !== target) {
          el.checked = target
          el.dispatchEvent(new Event("change", { bubbles: true }))
          el.dispatchEvent(new Event("input", { bubbles: true }))
        }
        return { success: true, data: { checked: el.checked } }
      }

      case "scroll": {
        const dir = action.direction as string
        const amount = (action.amount as number) || window.innerHeight * 0.8
        switch (dir) {
          case "up": window.scrollBy(0, -amount); break
          case "down": window.scrollBy(0, amount); break
          case "top": window.scrollTo(0, 0); break
          case "bottom": window.scrollTo(0, document.documentElement.scrollHeight); break
        }
        return { success: true }
      }

      case "evaluate": {
        return { success: false, error: "evaluate is handled by background script — this should not be reached" }
      }

      case "scroll_to": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
        if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
        el.scrollIntoView({ block: "center", behavior: "instant" })
        return { success: true }
      }

      case "send_keys": {
        const keys = action.keys as string
        const target = document.activeElement || document.body
        dispatchKeySequence(target, keys)
        return { success: true }
      }

      case "wait":
        await new Promise(r => setTimeout(r, action.ms as number))
        return { success: true }

      case "wait_for": {
        const selector = action.selector as string
        const timeout = (action.timeout as number) || 10000
        const el = await waitForElement(selector, timeout)
        return el
          ? { success: true, data: `found: ${selector}` }
          : { success: false, error: `timeout waiting for: ${selector}` }
      }

      case "extract_text": {
        if (action.index !== undefined) {
          const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
          if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
          return { success: true, data: (el.textContent || "").trim() }
        }
        return { success: true, data: document.body.innerText.slice(0, 10000) }
      }

      case "extract_html": {
        if (action.index !== undefined) {
          const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
          if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
          return { success: true, data: el.outerHTML.slice(0, 10000) }
        }
        return { success: true, data: document.documentElement.outerHTML.slice(0, 50000) }
      }

      case "focus": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) as HTMLElement | null
        if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
        el.focus()
        return { success: true }
      }

      case "blur": {
        (document.activeElement as HTMLElement)?.blur()
        return { success: true }
      }

      case "hover": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
        if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
        dispatchHoverSequence(el)
        return { success: true }
      }

      case "query": {
        const selector = action.selector as string
        const els = document.querySelectorAll(selector)
        return {
          success: true, data: {
            count: els.length,
            elements: Array.from(els).slice(0, 20).map((el, i) => ({
              index: i,
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || "").trim().slice(0, 80),
              id: el.id || undefined,
              classes: el.className || undefined
            }))
          }
        }
      }

      case "query_one": {
        const el = document.querySelector(action.selector as string)
        if (!el) return { success: false, error: `no element matching: ${action.selector}` }
        return {
          success: true, data: {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || "").trim().slice(0, 200),
            html: el.outerHTML.slice(0, 500),
            id: el.id || undefined,
            rect: el.getBoundingClientRect()
          }
        }
      }

      case "attr_get": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) || document.querySelector(action.selector as string)
        if (!el) return { success: false, error: "element not found" }
        const name = action.name as string
        return { success: true, data: el.getAttribute(name) }
      }

      case "attr_set": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) || document.querySelector(action.selector as string)
        if (!el) return { success: false, error: "element not found" }
        el.setAttribute(action.name as string, action.value as string)
        return { success: true }
      }

      case "style_get": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) || document.querySelector(action.selector as string)
        if (!el) return { success: false, error: "element not found" }
        const computed = getComputedStyle(el)
        if (action.property) {
          return { success: true, data: computed.getPropertyValue(action.property as string) }
        }
        const props = ["display", "visibility", "color", "backgroundColor", "fontSize", "position", "width", "height", "margin", "padding"]
        const styles: Record<string, string> = {}
        for (const p of props) styles[p] = computed.getPropertyValue(p)
        return { success: true, data: styles }
      }

      case "forms": {
        const forms = document.querySelectorAll("form")
        return {
          success: true, data: Array.from(forms).map((f, i) => ({
            index: i,
            action: f.action,
            method: f.method,
            id: f.id || undefined,
            fields: Array.from(f.elements).map(el => ({
              tag: el.tagName.toLowerCase(),
              type: (el as HTMLInputElement).type,
              name: (el as HTMLInputElement).name,
              value: (el as HTMLInputElement).value?.slice(0, 40),
              placeholder: (el as HTMLInputElement).placeholder
            }))
          }))
        }
      }

      case "links": {
        const links = document.querySelectorAll("a[href]")
        return {
          success: true, data: Array.from(links).slice(0, 100).map(a => ({
            href: (a as HTMLAnchorElement).href,
            text: (a.textContent || "").trim().slice(0, 60)
          }))
        }
      }

      case "images": {
        const imgs = document.querySelectorAll("img")
        return {
          success: true, data: Array.from(imgs).slice(0, 50).map(img => ({
            src: (img as HTMLImageElement).src,
            alt: (img as HTMLImageElement).alt,
            width: (img as HTMLImageElement).naturalWidth,
            height: (img as HTMLImageElement).naturalHeight
          }))
        }
      }

      case "meta": {
        const metas = document.querySelectorAll("meta")
        const data: Record<string, string> = {}
        metas.forEach(m => {
          const key = m.getAttribute("name") || m.getAttribute("property") || m.getAttribute("http-equiv")
          const val = m.getAttribute("content")
          if (key && val) data[key] = val.slice(0, 200)
        })
        data["title"] = document.title
        data["canonical"] = (document.querySelector('link[rel="canonical"]') as HTMLLinkElement)?.href || ""
        data["lang"] = document.documentElement.lang || ""
        return { success: true, data }
      }

      case "storage_read": {
        const storageType = (action.storageType as string) === "session" ? sessionStorage : localStorage
        if (action.key) {
          return { success: true, data: storageType.getItem(action.key as string) }
        }
        const all: Record<string, string> = {}
        for (let i = 0; i < storageType.length; i++) {
          const key = storageType.key(i)!
          all[key] = storageType.getItem(key)!.slice(0, 200)
        }
        return { success: true, data: all }
      }

      case "storage_write": {
        const storageType = (action.storageType as string) === "session" ? sessionStorage : localStorage
        storageType.setItem(action.key as string, action.value as string)
        return { success: true }
      }

      case "storage_delete": {
        const storageType = (action.storageType as string) === "session" ? sessionStorage : localStorage
        storageType.removeItem(action.key as string)
        return { success: true }
      }

      case "clipboard_read": {
        const text = await navigator.clipboard.readText()
        return { success: true, data: text }
      }

      case "clipboard_write":
        await navigator.clipboard.writeText(action.text as string)
        return { success: true }

      case "selection_get": {
        const sel = window.getSelection()
        return { success: true, data: sel?.toString() || "" }
      }

      case "selection_set": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) as HTMLInputElement | HTMLTextAreaElement | null
        if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
        el.setSelectionRange(action.start as number, action.end as number)
        return { success: true }
      }

      case "rect": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) || document.querySelector(action.selector as string)
        if (!el) return { success: false, error: "element not found" }
        const r = el.getBoundingClientRect()
        return { success: true, data: { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom, right: r.right } }
      }

      case "exists": {
        const el = document.querySelector(action.selector as string)
        return { success: true, data: !!el }
      }

      case "count": {
        const els = document.querySelectorAll(action.selector as string)
        return { success: true, data: els.length }
      }

      case "table_data": {
        const table = (action.index !== undefined ? resolveElement(action.index as number | undefined, action.ref as string | undefined) : document.querySelector(action.selector as string || "table")) as HTMLTableElement | null
        if (!table) return { success: false, error: "table not found" }
        const rows: string[][] = []
        table.querySelectorAll("tr").forEach(tr => {
          const cells: string[] = []
          tr.querySelectorAll("td, th").forEach(cell => cells.push((cell.textContent || "").trim()))
          rows.push(cells)
        })
        return { success: true, data: rows }
      }

      case "page_info": {
        return {
          success: true, data: {
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
        }
      }

      case "get_a11y_tree": {
        const maxDepth = (action.depth as number) || 15
        const filter = (action.filter as string) || "interactive"
        const maxChars = (action.maxChars as number) || 50000
        pruneStaleRefs()
        const treeOutput = buildA11yTree(document.body, 0, maxDepth, filter)
        const truncated = treeOutput.length > maxChars
          ? treeOutput.slice(0, maxChars) + "\n... (truncated)"
          : treeOutput
        cacheSnapshot()
        return { success: true, data: truncated }
      }

      case "diff": {
        return computeSnapshotDiff()
      }

      case "find_element": {
        const query = (action.query as string || "").toLowerCase()
        const targetRole = (action.role as string || "").toLowerCase()
        const limit = (action.limit as number) || 10
        const results: { refId: string; role: string; name: string; score: number }[] = []

        for (const [refId, weakRef] of refRegistry) {
          const el = weakRef.deref()
          if (!el || !el.isConnected || !isVisible(el)) continue

          const role = getEffectiveRole(el).toLowerCase()
          const name = getAccessibleName(el).toLowerCase()
          let score = 0

          if (targetRole && role !== targetRole) continue
          if (targetRole && role === targetRole) score += 50

          if (query) {
            if (name === query) score += 100
            else if (name.includes(query)) score += 60
            const id = el.getAttribute("id")?.toLowerCase()
            if (id?.includes(query)) score += 50
            const placeholder = el.getAttribute("placeholder")?.toLowerCase()
            if (placeholder?.includes(query)) score += 40
            const value = ((el as HTMLInputElement).value || "").toLowerCase()
            if (value.includes(query)) score += 30
          }

          if (score > 0) results.push({ refId, role: getEffectiveRole(el), name: getAccessibleName(el), score })
        }

        results.sort((a, b) => b.score - a.score)
        return { success: true, data: results.slice(0, limit) }
      }

      default:
        return { success: false, error: `unknown action type: ${action.type}` }
    }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

function resolveElement(indexOrRef: number | undefined, ref?: string): Element | null {
  if (ref) {
    return resolveRef(ref)
  }
  if (indexOrRef === undefined) return null
  const selector = selectorMap.get(indexOrRef)
  if (!selector) return null
  const el = document.querySelector(selector)
  if (!el) return null
  if (!isVisible(el)) return null
  return el
}

function scrollIntoViewIfNeeded(el: Element) {
  const rect = el.getBoundingClientRect()
  if (rect.top < 0 || rect.bottom > window.innerHeight) {
    el.scrollIntoView({ block: "center", behavior: "instant" })
  }
}

function dispatchClickSequence(el: Element) {
  const rect = el.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }

  el.dispatchEvent(new PointerEvent("pointerover", opts))
  el.dispatchEvent(new MouseEvent("mouseover", opts))
  el.dispatchEvent(new PointerEvent("pointerdown", opts))
  el.dispatchEvent(new MouseEvent("mousedown", opts))
  if ((el as HTMLElement).focus) (el as HTMLElement).focus()
  el.dispatchEvent(new PointerEvent("pointerup", opts))
  el.dispatchEvent(new MouseEvent("mouseup", opts))
  el.dispatchEvent(new MouseEvent("click", opts))
}

function dispatchHoverSequence(el: Element) {
  const rect = el.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y }

  el.dispatchEvent(new PointerEvent("pointerover", opts))
  el.dispatchEvent(new MouseEvent("mouseover", opts))
  el.dispatchEvent(new PointerEvent("pointermove", opts))
  el.dispatchEvent(new MouseEvent("mousemove", opts))
}

const KEY_CODES: Record<string, string> = {
  Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace",
  Space: "Space", Delete: "Delete", Home: "Home", End: "End",
  PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
}

function getKeyCode(key: string): string {
  if (KEY_CODES[key]) return KEY_CODES[key]
  if (key.length === 1 && key >= "0" && key <= "9") return `Digit${key}`
  if (key.length === 1 && /^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`
  return KEY_CODES[key] || `Key${key.toUpperCase()}`
}

function dispatchKeySequence(target: Element, combo: string) {
  const parts = combo.split("+")
  const key = parts[parts.length - 1]
  const modifiers = {
    ctrlKey: parts.includes("Control"),
    shiftKey: parts.includes("Shift"),
    altKey: parts.includes("Alt"),
    metaKey: parts.includes("Meta")
  }

  const code = getKeyCode(key)
  const keyOpts = { key, code, bubbles: true, cancelable: true, ...modifiers }

  target.dispatchEvent(new KeyboardEvent("keydown", keyOpts))
  target.dispatchEvent(new KeyboardEvent("keypress", keyOpts))
  target.dispatchEvent(new KeyboardEvent("keyup", keyOpts))
}

function waitForElement(selector: string, timeout: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector)
    if (existing) { resolve(existing); return }

    const timer = setTimeout(() => {
      observer.disconnect()
      resolve(null)
    }, timeout)

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector)
      if (el) {
        clearTimeout(timer)
        observer.disconnect()
        resolve(el)
      }
    })

    observer.observe(document.body, { childList: true, subtree: true })
  })
}
