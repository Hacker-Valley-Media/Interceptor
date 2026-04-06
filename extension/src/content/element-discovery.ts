import { getOrAssignRef, refMetadata, pruneStaleRefs } from "./ref-registry"
import { getEffectiveRole, getAccessibleName } from "./a11y-tree"
import { getRelevantAttrs, buildSelector } from "./element-tree"

export interface IndexedElement {
  index: number
  refId: string
  element: Element
  selector: string
  tag: string
  text: string
  attrs: string
}

export const selectorMap = new Map<number, string>()
export let nextIndex = 0

export const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "DETAILS", "SUMMARY"])
export const INTERACTIVE_ROLES = new Set(["button", "link", "tab", "menuitem", "checkbox", "radio", "switch", "textbox", "combobox", "listbox", "option", "slider"])

export function getShadowRoot(el: Element): ShadowRoot | null {
  if ((el as HTMLElement).shadowRoot) return (el as HTMLElement).shadowRoot
  try {
    if (typeof chrome !== "undefined" && chrome.dom?.openOrClosedShadowRoot) {
      return chrome.dom.openOrClosedShadowRoot(el as HTMLElement) as ShadowRoot | null
    }
  } catch {}
  return null
}

export function walkWithShadow(root: Node, callback: (el: Element) => void) {
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

export function isVisible(el: Element): boolean {
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

export function isInteractive(el: Element, tags: Set<string>, roles: Set<string>): boolean {
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

export function getInteractiveElements(): IndexedElement[] {
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
