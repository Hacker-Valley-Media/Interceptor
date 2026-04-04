import { extractLinkedInEventDom } from "./linkedin/event-page-dom-extraction"
import { clickManageAttendeesShowMore, extractManageAttendeesModal, openManageAttendeesModal } from "./linkedin/event-attendees-modal-dom"

const NET_BUFFER_CAP = 500
type PassiveCapturedEntry = { url: string; method: string; status: number; body: string; type: string; timestamp: number; tabUrl: string }
const netBuffer: PassiveCapturedEntry[] = []

type CapturedHeaderEntry = { url: string; method: string; headers: Record<string, string>; type: string; timestamp: number }
const capturedHeaders: CapturedHeaderEntry[] = []
const HEADER_CAP = 200

document.addEventListener("__slop_net", ((e: CustomEvent) => {
  try {
    const entry: PassiveCapturedEntry = { ...e.detail, tabUrl: location.href }
    if (netBuffer.length >= NET_BUFFER_CAP) netBuffer.shift()
    netBuffer.push(entry)
  } catch {}
}) as EventListener)

document.addEventListener("__slop_headers", ((e: CustomEvent) => {
  try {
    const entry: CapturedHeaderEntry = e.detail
    if (capturedHeaders.length >= HEADER_CAP) capturedHeaders.shift()
    capturedHeaders.push(entry)
  } catch {}
}) as EventListener)

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
  if (msg.type === "get_net_log") {
    try {
      let entries = netBuffer.slice()
      if (msg.filter) {
        const pattern = msg.filter.toLowerCase()
        entries = entries.filter(e => e.url.toLowerCase().includes(pattern))
      }
      if (msg.since) {
        entries = entries.filter(e => e.timestamp >= msg.since)
      }
      sendResponse({ success: true, data: entries })
    } catch (err) {
      sendResponse({ success: false, error: (err as Error).message })
    }
    return true
  }
  if (msg.type === "clear_net_log") {
    netBuffer.length = 0
    capturedHeaders.length = 0
    sendResponse({ success: true })
    return true
  }
  if (msg.type === "get_captured_headers") {
    try {
      let headers = capturedHeaders.slice()
      if (msg.filter) {
        const pattern = msg.filter.toLowerCase()
        headers = headers.filter(h => h.url.toLowerCase().includes(pattern))
      }
      sendResponse({ success: true, data: headers })
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

  const active = document.activeElement as HTMLElement | null
  let focusedStr = "none"
  if (active && active !== document.body && active !== document.documentElement) {
    const fRef = getOrAssignRef(active)
    const fRole = getEffectiveRole(active)
    const fName = getAccessibleName(active)
    focusedStr = `${fRef} ${fRole || active.tagName.toLowerCase()} "${fName}"`
  }

  const state: Record<string, unknown> = {
    url: location.href,
    title: document.title,
    elementTree: tree,
    focused: focusedStr,
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
const refMetadata = new Map<string, { role: string; name: string; tag: string; value: string }>()
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
  if (ref) {
    const el = ref.deref()
    if (el && el.isConnected && isVisible(el)) return el
  }
  const meta = refMetadata.get(refId)
  if (meta) {
    const match = findBestMatch(meta.name, meta.role)
    if (match && match.score >= 70) {
      staleWarning = `stale ref ${refId} re-resolved to ${match.refId} (${match.role} '${match.name}', score: ${match.score})`
      return match.element
    }
  }
  return null
}

let staleWarning: string | null = null

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

      refMetadata.set(refId, { role: getEffectiveRole(el), name: text, tag, value: ((el as HTMLInputElement).value || "").slice(0, 40) })

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
  if (el.namespaceURI === "http://www.w3.org/2000/svg") {
    const svgTag = el.tagName.toLowerCase()
    if (svgTag === "a" && (el.hasAttribute("href") || el.getAttributeNS("http://www.w3.org/1999/xlink", "href"))) return true
    if (el.hasAttribute("onclick") || el.hasAttribute("tabindex")) return true
    if (role && roles.has(role)) return true
    const cursor = getComputedStyle(el).cursor
    if (cursor === "pointer") return true
  }
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
  if (el.namespaceURI === "http://www.w3.org/2000/svg") {
    if (tag === "a") return "link"
    if (el.hasAttribute("onclick") || getComputedStyle(el).cursor === "pointer") return "button"
    return "img"
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

async function handleAction(action: { type: string; [key: string]: unknown }): Promise<{ success: boolean; error?: string; warning?: string; data?: unknown; changes?: unknown }> {
  const warnDirty = domDirty
  staleWarning = null
  const wantChanges = !!(action.changes)
  if (wantChanges) cacheSnapshot()
  const result = await executeAction(action)
  if (staleWarning && result.success) result.warning = staleWarning
  else if (warnDirty && result.success) result.warning = "DOM has changed since last state read"
  if (wantChanges && result.success) {
    const diffResult = computeSnapshotDiff()
    if (diffResult.success) (result as Record<string, unknown>).changes = diffResult.data
  }
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
        dispatchClickSequence(el, action.x as number | undefined, action.y as number | undefined)
        const clickMsg = `clicked [${action.ref || action.index}]${action.x !== undefined ? ` at (${action.x},${action.y})` : ""}`
        const mutated = await waitForMutation(200)
        if (!mutated) {
          return { success: true, data: clickMsg, warning: "no DOM change after click — if the site requires trusted events, try: slop click --os " + (action.ref || action.index) }
        }
        return { success: true, data: clickMsg }
      }

      case "dblclick": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
        if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
        scrollIntoViewIfNeeded(el)
        dispatchClickSequence(el, action.x as number | undefined, action.y as number | undefined)
        const rect = el.getBoundingClientRect()
        const cx = action.x !== undefined ? rect.left + (action.x as number) : rect.left + rect.width / 2
        const cy = action.y !== undefined ? rect.top + (action.y as number) : rect.top + rect.height / 2
        el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }))
        return { success: true }
      }

      case "rightclick": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
        if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
        scrollIntoViewIfNeeded(el)
        const rect = el.getBoundingClientRect()
        const x = action.x !== undefined ? rect.left + (action.x as number) : rect.left + rect.width / 2
        const y = action.y !== undefined ? rect.top + (action.y as number) : rect.top + rect.height / 2
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }))
        return { success: true }
      }

      case "drag": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
        if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
        scrollIntoViewIfNeeded(el)
        const dragRect = el.getBoundingClientRect()
        const fromX = dragRect.left + (action.fromX as number)
        const fromY = dragRect.top + (action.fromY as number)
        const toX = dragRect.left + (action.toX as number)
        const toY = dragRect.top + (action.toY as number)
        const steps = (action.steps as number) || 10
        const duration = action.duration as number | undefined

        const baseOpts = { bubbles: true, cancelable: true, button: 0 }

        el.dispatchEvent(new PointerEvent("pointerdown", { ...baseOpts, clientX: fromX, clientY: fromY }))
        el.dispatchEvent(new MouseEvent("mousedown", { ...baseOpts, clientX: fromX, clientY: fromY }))

        if (duration) {
          await new Promise<void>((resolve) => {
            let step = 0
            function tick() {
              step++
              if (step > steps) {
                resolve()
                return
              }
              const t = step / steps
              const cx = fromX + (toX - fromX) * t
              const cy = fromY + (toY - fromY) * t
              const mx = (toX - fromX) / steps
              const my = (toY - fromY) / steps
              el!.dispatchEvent(new PointerEvent("pointermove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }))
              el!.dispatchEvent(new MouseEvent("mousemove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }))
              setTimeout(tick, duration! / steps)
            }
            tick()
          })
        } else {
          for (let i = 1; i <= steps; i++) {
            const t = i / steps
            const cx = fromX + (toX - fromX) * t
            const cy = fromY + (toY - fromY) * t
            const mx = (toX - fromX) / steps
            const my = (toY - fromY) / steps
            el.dispatchEvent(new PointerEvent("pointermove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }))
            el.dispatchEvent(new MouseEvent("mousemove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }))
          }
        }

        el.dispatchEvent(new PointerEvent("pointerup", { ...baseOpts, clientX: toX, clientY: toY }))
        el.dispatchEvent(new MouseEvent("mouseup", { ...baseOpts, clientX: toX, clientY: toY }))
        return { success: true, data: `dragged from (${action.fromX},${action.fromY}) to (${action.toX},${action.toY}) in ${steps} steps` }
      }

      case "input_text": {
        const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) as HTMLElement | null
        if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
        el.focus()
        const text = action.text as string
        const tag = el.tagName
        const isContentEditable = el.getAttribute("contenteditable") === "true" || el.isContentEditable
        const isStandardInput = tag === "INPUT" || tag === "TEXTAREA"

        if (isStandardInput) {
          const inputEl = el as HTMLInputElement | HTMLTextAreaElement
          if (action.clear) {
            inputEl.value = ""
            inputEl.dispatchEvent(new Event("input", { bubbles: true }))
          }
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            "value"
          )?.set
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(inputEl, (action.clear ? "" : inputEl.value) + text)
          } else {
            inputEl.value = (action.clear ? "" : inputEl.value) + text
          }
          inputEl.dispatchEvent(new Event("input", { bubbles: true }))
          inputEl.dispatchEvent(new Event("change", { bubbles: true }))
          return { success: true, data: { typed: true, elementType: "input", method: "nativeSetter" } }
        }

        if (isContentEditable) {
          if (action.clear) {
            document.execCommand("selectAll", false)
            document.execCommand("delete", false)
          }
          document.execCommand("insertText", false, text)
          el.dispatchEvent(new Event("input", { bubbles: true }))
          return { success: true, data: { typed: true, elementType: "contenteditable", method: "execCommand" } }
        }

        const shadowRoot = getShadowRoot(el)
        if (shadowRoot) {
          const innerInput = shadowRoot.querySelector("input, textarea, [contenteditable='true']") as HTMLElement | null
          if (innerInput) {
            return await executeAction({ type: "input_text", ref: getOrAssignRef(innerInput), text, clear: action.clear })
          }
        }

        const role = el.getAttribute("role")
        if (role === "textbox" || role === "combobox") {
          if (action.clear) {
            el.textContent = ""
          }
          el.textContent = (action.clear ? "" : (el.textContent || "")) + text
          el.dispatchEvent(new Event("input", { bubbles: true }))
          return { success: true, data: { typed: true, elementType: `role=${role}`, method: "textContent" } }
        }

        return { success: false, error: `element is <${tag.toLowerCase()}${isContentEditable ? " contenteditable" : ""}> — unsupported input type` }
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

      case "scroll_absolute": {
        window.scrollTo(0, action.y as number)
        return { success: true }
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
        }
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
        const hoverFromX = action.fromX as number | undefined
        const hoverFromY = action.fromY as number | undefined
        if (hoverFromX !== undefined && hoverFromY !== undefined) {
          const rect = el.getBoundingClientRect()
          const targetX = rect.left + rect.width / 2
          const targetY = rect.top + rect.height / 2
          const hoverSteps = (action.steps as number) || 5
          const baseOpts = { bubbles: true, cancelable: true }
          for (let i = 0; i <= hoverSteps; i++) {
            const t = i / hoverSteps
            const cx = hoverFromX + (targetX - hoverFromX) * t
            const cy = hoverFromY + (targetY - hoverFromY) * t
            const mx = (targetX - hoverFromX) / hoverSteps
            const my = (targetY - hoverFromY) / hoverSteps
            el.dispatchEvent(new PointerEvent("pointermove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }))
            el.dispatchEvent(new MouseEvent("mousemove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }))
          }
          el.dispatchEvent(new PointerEvent("pointerover", { ...baseOpts, clientX: targetX, clientY: targetY }))
          el.dispatchEvent(new MouseEvent("mouseover", { ...baseOpts, clientX: targetX, clientY: targetY }))
        } else {
          dispatchHoverSequence(el)
        }
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
        if (!domDirty && lastSnapshot.length > 0) {
          return { success: true, data: { changes: 0, added: [], removed: [], changed: [] } }
        }
        const diffResult = computeSnapshotDiff()
        if (diffResult.success && typeof diffResult.data === "string") {
          const lines = diffResult.data === "no changes" ? [] : (diffResult.data as string).split("\n")
          const added = lines.filter(l => l.startsWith("+ "))
          const removed = lines.filter(l => l.startsWith("- "))
          const changed = lines.filter(l => l.startsWith("~ "))
          return { success: true, data: { changes: lines.length, added, removed, changed, total: lines.length } }
        }
        return diffResult
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

      case "modals": {
        const modals: Array<{ ref: string; role: string; name: string; rect: { top: number; left: number; width: number; height: number }; children: number }> = []
        const dialogEls = document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]')
        dialogEls.forEach(el => {
          if (!isVisible(el)) return
          const ref = getOrAssignRef(el)
          const rect = el.getBoundingClientRect()
          const interactiveChildren = el.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"]').length
          modals.push({
            ref,
            role: getEffectiveRole(el) || "dialog",
            name: getAccessibleName(el),
            rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
            children: interactiveChildren
          })
        })
        const vw = window.innerWidth
        const vh = window.innerHeight
        const overlays = document.querySelectorAll("*")
        overlays.forEach(el => {
          if (el.matches('dialog[open], [role="dialog"], [aria-modal="true"]')) return
          const style = getComputedStyle(el)
          if (style.position !== "fixed" && style.position !== "absolute") return
          const z = parseInt(style.zIndex)
          if (isNaN(z) || z < 100) return
          const rect = el.getBoundingClientRect()
          if (rect.width * rect.height > vw * vh * 0.25) {
            const ref = getOrAssignRef(el)
            modals.push({
              ref,
              role: "overlay",
              name: getAccessibleName(el) || el.tagName.toLowerCase(),
              rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
              children: el.querySelectorAll('a, button, input, select, textarea').length
            })
          }
        })
        return { success: true, data: { modals } }
      }

      case "panels": {
        const panels: Array<{ ref: string; role: string; name: string; expanded: boolean; contentRef?: string }> = []
        const expandedEls = document.querySelectorAll('[aria-expanded="true"]')
        expandedEls.forEach(el => {
          if (!isVisible(el)) return
          const ref = getOrAssignRef(el)
          const controls = el.getAttribute("aria-controls")
          let contentRef: string | undefined
          if (controls) {
            const controlledEl = document.getElementById(controls)
            if (controlledEl) contentRef = getOrAssignRef(controlledEl)
          }
          panels.push({
            ref,
            role: getEffectiveRole(el) || el.tagName.toLowerCase(),
            name: getAccessibleName(el),
            expanded: true,
            contentRef
          })
        })
        return { success: true, data: { panels } }
      }

      case "click_at": {
        const cx = action.x as number
        const cy = action.y as number
        const targetEl = document.elementFromPoint(cx, cy)
        if (!targetEl) return { success: false, error: `no element at viewport coordinates (${cx}, ${cy})` }
        const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }
        targetEl.dispatchEvent(new PointerEvent("pointerover", opts))
        targetEl.dispatchEvent(new MouseEvent("mouseover", opts))
        targetEl.dispatchEvent(new PointerEvent("pointerdown", opts))
        targetEl.dispatchEvent(new MouseEvent("mousedown", opts))
        if ((targetEl as HTMLElement).focus) (targetEl as HTMLElement).focus()
        targetEl.dispatchEvent(new PointerEvent("pointerup", opts))
        targetEl.dispatchEvent(new MouseEvent("mouseup", opts))
        targetEl.dispatchEvent(new MouseEvent("click", opts))
        const targetRef = getOrAssignRef(targetEl)
        return { success: true, data: { clicked: targetRef, tag: targetEl.tagName.toLowerCase(), at: { x: cx, y: cy } } }
      }

      case "what_at": {
        const wx = action.x as number
        const wy = action.y as number
        const whatEl = document.elementFromPoint(wx, wy)
        if (!whatEl) return { success: true, data: { element: null, at: { x: wx, y: wy } } }
        const whatRef = getOrAssignRef(whatEl)
        const whatRect = whatEl.getBoundingClientRect()
        return {
          success: true,
          data: {
            ref: whatRef,
            tag: whatEl.tagName.toLowerCase(),
            role: getEffectiveRole(whatEl),
            name: getAccessibleName(whatEl),
            rect: { top: whatRect.top, left: whatRect.left, width: whatRect.width, height: whatRect.height }
          }
        }
      }

      case "regions": {
        const regionElements = getInteractiveElements()
        const regions = regionElements.map(e => {
          const rect = e.element.getBoundingClientRect()
          return {
            ref: e.refId,
            role: getEffectiveRole(e.element) || e.tag,
            name: e.text,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
          }
        })
        regions.sort((a, b) => a.y === b.y ? a.x - b.x : a.y - b.y)
        return { success: true, data: regions }
      }

      case "get_focus": {
        const active = document.activeElement as HTMLElement | null
        if (!active || active === document.body || active === document.documentElement) {
          return { success: true, data: { focused: null } }
        }
        const focusRef = getOrAssignRef(active)
        const focusRole = getEffectiveRole(active)
        const focusName = getAccessibleName(active)
        const isEditable = active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable || active.getAttribute("role") === "textbox"
        return {
          success: true,
          data: {
            focused: {
              ref: focusRef,
              tag: active.tagName.toLowerCase(),
              role: focusRole,
              name: focusName,
              type: (active as HTMLInputElement).type || undefined,
              editable: isEditable
            }
          }
        }
      }

      case "semantic_resolve": {
        const match = findBestMatch(action.name as string, action.role as string)
        if (!match) return { success: false, error: `no element matching ${action.role}:${action.name}` }
        return { success: true, data: { ref: match.refId, role: match.role, name: match.name, score: match.score } }
      }

      case "find_and_click": {
        const match = findBestMatch(action.name as string | undefined, action.role as string | undefined, action.text as string | undefined)
        if (!match) return { success: false, error: "no matching element found (score < 30)" }
        scrollIntoViewIfNeeded(match.element)
        dispatchClickSequence(match.element, action.x as number | undefined, action.y as number | undefined)
        return { success: true, data: { matched: { ref: match.refId, role: match.role, name: match.name, score: match.score }, actionResult: `clicked [${match.refId}]` } }
      }

      case "find_and_type": {
        const match = findBestMatch(action.name as string | undefined, action.role as string | undefined, action.text as string | undefined)
        if (!match) return { success: false, error: "no matching element found (score < 30)" }
        const typeResult = await executeAction({ type: "input_text", ref: match.refId, text: action.inputText as string, clear: action.clear })
        return { success: true, data: { matched: { ref: match.refId, role: match.role, name: match.name, score: match.score }, actionResult: typeResult } }
      }

      case "find_and_check": {
        const match = findBestMatch(action.name as string | undefined, action.role as string | undefined, action.text as string | undefined)
        if (!match) return { success: false, error: "no matching element found (score < 30)" }
        const checkResult = await executeAction({ type: "check", ref: match.refId, checked: action.checked })
        return { success: true, data: { matched: { ref: match.refId, role: match.role, name: match.name, score: match.score }, actionResult: checkResult } }
      }

      case "linkedin_event_dom":
        return { success: true, data: await extractLinkedInEventDom(waitForDomStable, dispatchClickSequence) }

      case "linkedin_attendees_open":
        return { success: true, data: { opened: await openManageAttendeesModal(waitForDomStable, dispatchClickSequence) } }

      case "linkedin_attendees_snapshot":
        return { success: true, data: extractManageAttendeesModal() }

      case "linkedin_attendees_show_more":
        return { success: true, data: { clicked: clickManageAttendeesShowMore(dispatchClickSequence) } }

      case "wait_stable": {
        const debounceMs = (action.ms as number) || 200
        const timeoutMs = (action.timeout as number) || 5000
        const stableResult = await waitForDomStable(debounceMs, timeoutMs)
        return { success: true, data: stableResult }
      }

      case "batch": {
        const actions = action.actions as Array<{ type: string; [key: string]: unknown }>
        if (!actions || !Array.isArray(actions)) return { success: false, error: "batch requires actions array" }
        if (actions.length > 100) return { success: false, error: "batch limited to 100 sub-actions" }
        const stopOnError = !!(action.stopOnError)
        const batchTimeout = (action.timeout as number) || 30000
        const batchStart = Date.now()
        const results: Array<{ action: string; success: boolean; data?: unknown; error?: string; warning?: string }> = []

        for (const subAction of actions) {
          if (Date.now() - batchStart > batchTimeout) {
            results.push({ action: subAction.type, success: false, error: "batch timeout exceeded" })
            break
          }
          try {
            const subResult = await executeAction(subAction)
            results.push({
              action: subAction.type,
              success: subResult.success,
              data: subResult.data,
              error: subResult.error,
              warning: subResult.warning
            })
            if (!subResult.success && stopOnError) break
          } catch (err) {
            results.push({ action: subAction.type, success: false, error: (err as Error).message })
            if (stopOnError) break
          }
        }

        return { success: true, data: { results, elapsed: Date.now() - batchStart } }
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

function dispatchClickSequence(el: Element, atX?: number, atY?: number) {
  const rect = el.getBoundingClientRect()
  const x = atX !== undefined ? rect.left + atX : rect.left + rect.width / 2
  const y = atY !== undefined ? rect.top + atY : rect.top + rect.height / 2
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

function findBestMatch(name?: string, role?: string, text?: string): { refId: string; role: string; name: string; score: number; element: Element } | null {
  const query = (name || text || "").toLowerCase()
  const targetRole = (role || "").toLowerCase()
  let best: { refId: string; role: string; name: string; score: number; element: Element } | null = null

  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref()
    if (!el || !el.isConnected || !isVisible(el)) continue

    const elRole = getEffectiveRole(el).toLowerCase()
    const elName = getAccessibleName(el).toLowerCase()
    let score = 0

    if (targetRole && elRole !== targetRole) continue
    if (targetRole && elRole === targetRole) score += 50

    if (query) {
      if (elName === query) score += 100
      else if (elName.includes(query)) score += 60
      const id = el.getAttribute("id")?.toLowerCase()
      if (id?.includes(query)) score += 50
      const placeholder = el.getAttribute("placeholder")?.toLowerCase()
      if (placeholder?.includes(query)) score += 40
    }

    if (score >= 30 && (!best || score > best.score)) {
      best = { refId, role: getEffectiveRole(el), name: getAccessibleName(el), score, element: el }
    }
  }

  return best
}

function getVisibleText(el: Element | null | undefined): string {
  if (!el || !isVisible(el)) return ""
  return ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim()
}

function isLinkedInNoiseText(text: string): boolean {
  return /Close your conversation|Reply to conversation|Page inboxes|Compose message|Messaging overlay|Open GIF Keyboard|Open Emoji Keyboard|Search\s*$|Skip to main content|About Accessibility Help Center Privacy & Terms/i.test(text)
}

function findLinkedInEventRoot(title: string): Element | null {
  const heading = Array.from(document.querySelectorAll("h1")).find(el => getVisibleText(el) === title)
  if (!heading) return document.querySelector("main")
  let current: Element | null = heading
  let best: { element: Element; score: number } | null = null
  while (current && current !== document.body) {
    const text = getVisibleText(current)
    if (text) {
      let score = 0
      if (text.includes(title)) score += 40
      if (/Event by/i.test(text)) score += 20
      if (/attendees?/i.test(text)) score += 15
      if (/Add to calendar/i.test(text)) score += 10
      if (/Close your conversation|Reply to conversation|Page inboxes/i.test(text)) score -= 80
      if (!best || score > best.score) best = { element: current, score }
    }
    current = current.parentElement
  }
  return best?.element || document.querySelector("main")
}

function extractEventByName(lines: string[]): string | null {
  const eventByIndex = lines.findIndex(line => /^event by$/i.test(line) || /^event by\s+/i.test(line))
  if (eventByIndex !== -1) {
    const sameLine = lines[eventByIndex].replace(/^event by\s*/i, "").trim()
    if (sameLine && !/^event by$/i.test(sameLine)) return sameLine
    if (lines[eventByIndex + 1]) return lines[eventByIndex + 1]
  }
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^event by$/i.test(lines[i]) && lines[i + 1]) return lines[i + 1]
  }
  const labeled = lines.find(line => /^hosted by\s+/i.test(line) || /^by\s+[A-Z]/.test(line))
  if (labeled) return labeled.replace(/^(hosted by|by)\s+/i, "").trim()
  return null
}

function extractDisplayedDate(lines: string[]): string | null {
  const line = lines.find(item => /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/.test(item))
  if (line) return line
  const timeEl = document.querySelector("time")
  const timeText = getVisibleText(timeEl)
  if (timeText) return timeText
  return null
}

function buildIsoWithOffset(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? "+" : "-"
  const abs = Math.abs(offsetMinutes)
  const offsetHours = pad(Math.floor(abs / 60))
  const offsetRemainder = pad(abs % 60)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${offsetHours}:${offsetRemainder}`
}

function parseDisplayedDateRangeToIso(displayedDateText: string | null): { startTimeIso: string | null; endTimeIso: string | null; timeZone: string | null } {
  if (!displayedDateText) return { startTimeIso: null, endTimeIso: null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null }
  const match = displayedDateText.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)/i)
  if (!match) return { startTimeIso: null, endTimeIso: null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null }
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
  const monthIndex = months.indexOf(match[1].toLowerCase())
  if (monthIndex === -1) return { startTimeIso: null, endTimeIso: null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null }
  const year = parseInt(match[3], 10)
  const day = parseInt(match[2], 10)
  const toDate = (timeText: string) => {
    const [, hoursText, minutesText, period] = timeText.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i) || []
    if (!hoursText || !minutesText || !period) return null
    let hours = parseInt(hoursText, 10)
    const minutes = parseInt(minutesText, 10)
    const upperPeriod = period.toUpperCase()
    if (upperPeriod === "PM" && hours !== 12) hours += 12
    if (upperPeriod === "AM" && hours === 12) hours = 0
    return new Date(year, monthIndex, day, hours, minutes, 0)
  }
  const startDate = toDate(match[4])
  const endDate = toDate(match[5])
  return {
    startTimeIso: startDate ? buildIsoWithOffset(startDate) : null,
    endTimeIso: endDate ? buildIsoWithOffset(endDate) : null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null
  }
}

function extractAttendeeSummary(lines: string[]): { text: string | null; totalCount: number | null; names: string[] } {
  const summary = lines.find(line => /attendees?/i.test(line) && (/other attendees?/i.test(line) || /^[A-Z].*attendees?/i.test(line))) || null
  if (!summary) return { text: null, totalCount: null, names: [] }
  const otherMatch = summary.match(/and\s+(\d[\d,]*)\s+other attendees?/i)
  const prefix = summary.split(/\sand\s+\d[\d,]*\s+other attendees?/i)[0] || ""
  const names = prefix.split(/,| and /).map(part => part.trim()).filter(part => /^[A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){0,3}$/.test(part))
  const otherCount = otherMatch ? parseInt(otherMatch[1].replace(/,/g, ""), 10) : 0
  const totalCount = otherMatch ? otherCount + names.length : null
  return { text: summary, totalCount, names }
}

function extractEngagementCounts(text: string): { likes: number | null; reposts: number | null; comments: number | null; threadedComments: number | null } {
  const lines = text.split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean)
  const numberFor = (pattern: RegExp): number | null => {
    const match = text.replace(/\s+/g, " ").match(pattern)
    return match ? parseInt(match[1].replace(/,/g, ""), 10) : null
  }
  let likes = numberFor(/(\d[\d,]*)\s+(?:likes?|reactions?)/i)
  if (!likes) {
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d+$/.test(lines[i]) && /others|reactions?/i.test(lines[i + 1])) {
        likes = parseInt(lines[i], 10)
        break
      }
    }
  }
  const comments = numberFor(/(\d[\d,]*)\s+comments?/i)
  return {
    likes,
    reposts: numberFor(/(\d[\d,]*)\s+(?:reposts?|shares?)/i),
    comments,
    threadedComments: comments
  }
}

function isMeaningfulImage(img: HTMLImageElement): boolean {
  const src = img.currentSrc || img.src || ""
  if (!src) return false
  if (/^data:image\/gif;base64,R0lGODlhAQABA/i.test(src)) return false
  if (/transparent|spacer|pixel/i.test(src)) return false
  const rect = img.getBoundingClientRect()
  return rect.width >= 40 && rect.height >= 40
}

function extractMeaningfulThumbnail(root: Element | null): string | null {
  const direct = document.querySelector("#ember33")
  if (direct instanceof HTMLImageElement && isMeaningfulImage(direct)) return direct.currentSrc || direct.src || null
  const scope = root || document.body
  const images = Array.from(scope.querySelectorAll("img"))
    .filter(img => isVisible(img) && isMeaningfulImage(img as HTMLImageElement)) as HTMLImageElement[]
  images.sort((a, b) => {
    const ra = a.getBoundingClientRect()
    const rb = b.getBoundingClientRect()
    return (rb.width * rb.height) - (ra.width * ra.height)
  })
  return images[0] ? (images[0].currentSrc || images[0].src || null) : null
}

function extractPostTextFromLines(lines: string[], eventTitle: string, organizerName: string | null): string | null {
  const startIndex = lines.findIndex(line => line.length > 25 && line !== eventTitle && !/followers?|Visible to anyone|week|weeks|day|days|hour|hours|minute|minutes/i.test(line))
  if (startIndex === -1) return null
  const parts: string[] = []
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]
    if (/^\d+$/.test(line) || /^\d+\s+repost/i.test(line) || /^Reactions?$/i.test(line) || /^Like$/i.test(line) || /^Comment$/i.test(line) || /^Repost$/i.test(line) || /^Send$/i.test(line) || /^Add a comment/i.test(line) || /^Other events for you$/i.test(line) || isLinkedInNoiseText(line)) break
    if (organizerName && line === organizerName && parts.length) continue
    parts.push(line)
  }
  const text = parts.join(" ").replace(/\s+/g, " ").trim()
  return text || null
}

function extractLinkedInPostCard(eventTitle: string, organizerName: string | null, root: Element | null): { text: string | null; posterName: string | null; followerCountText: string | null; engagement: { likes: number | null; reposts: number | null; comments: number | null; threadedComments: number | null } } {
  const containers = Array.from((root || document.body).querySelectorAll("article, [role='article'], section, div"))
    .filter(el => isVisible(el))
    .map(el => {
      const text = getVisibleText(el)
      let score = 0
      if (isLinkedInNoiseText(text)) score -= 200
      if (organizerName && text.includes(organizerName)) score += 40
      if (text.includes(eventTitle)) score += 20
      if (/followers?/i.test(text)) score += 25
      if (/Like|Comment|Repost|Send|repost|reactions?/i.test(text)) score += 25
      if (/Visible to anyone/i.test(text)) score += 20
      if (text.length > 200) score += 10
      return { el, text, score }
    })
    .filter(item => item.score > 20)
    .sort((a, b) => b.score - a.score)

  const best = containers[0]
  if (!best) {
    return { text: null, posterName: organizerName, followerCountText: null, engagement: { likes: null, reposts: null, comments: null, threadedComments: null } }
  }

  const lines = best.text.split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean)
  const followerCountText = lines.find(line => /followers?/i.test(line)) || null
  const postText = extractPostTextFromLines(lines, eventTitle, organizerName)
  const posterName = organizerName || lines.find(line => /^[A-Z][A-Za-z0-9&.'’\-]+(?:\s+[A-Z][A-Za-z0-9&.'’\-]+){0,4}$/.test(line) && line !== eventTitle && !/followers?/i.test(line)) || null

  return {
    text: postText,
    posterName,
    followerCountText,
    engagement: extractEngagementCounts(best.text)
  }
}

function extractDetailsText(root: Element | null, eventTitle: string): string | null {
  const text = getVisibleText(root || document.body)
  const lines = text.split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean)
  const start = lines.findIndex(line => line === eventTitle)
  const end = lines.findIndex(line => /^Other events for you$/i.test(line))
  const slice = lines.slice(start >= 0 ? start + 1 : 0, end >= 0 ? end : lines.length)
    .filter(line => !/^Add to calendar$/i.test(line))
    .filter(line => !/^Attendee profile images$/i.test(line))
    .filter(line => !/^Boost$/i.test(line))
    .filter(line => !/^(Details|Comments|Networking|Analytics)$/i.test(line))
    .filter(line => !isLinkedInNoiseText(line))
  const joined = slice.join(" ").replace(/\s+/g, " ").trim()
  return joined || null
}

function waitForDomStable(debounceMs = 200, timeoutMs = 5000): Promise<{ stable: boolean; elapsed: number; mutations: number }> {
  return new Promise((resolve) => {
    const start = Date.now()
    let mutationCount = 0
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const hardTimeout = setTimeout(() => {
      observer.disconnect()
      if (debounceTimer) clearTimeout(debounceTimer)
      resolve({ stable: false, elapsed: Date.now() - start, mutations: mutationCount })
    }, timeoutMs)

    const observer = new MutationObserver(() => {
      mutationCount++
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        observer.disconnect()
        clearTimeout(hardTimeout)
        resolve({ stable: true, elapsed: Date.now() - start, mutations: mutationCount })
      }, debounceMs)
    })

    observer.observe(document.body, { childList: true, subtree: true, attributes: true })

    debounceTimer = setTimeout(() => {
      observer.disconnect()
      clearTimeout(hardTimeout)
      resolve({ stable: true, elapsed: Date.now() - start, mutations: mutationCount })
    }, debounceMs)
  })
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

function waitForMutation(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false
    const observer = new MutationObserver(() => {
      if (!resolved) {
        resolved = true
        observer.disconnect()
        resolve(true)
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        observer.disconnect()
        resolve(false)
      }
    }, timeoutMs)
  })
}
