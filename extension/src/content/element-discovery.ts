import { getOrAssignRef, refMetadata, pruneStaleRefs } from "./ref-registry"
import { getEffectiveRole, getAccessibleName } from "./a11y-tree"
import { getRelevantAttrs, buildSelector, hasOwnPointerCursor } from "./element-tree"

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

export function isVisible(el: Element, style: CSSStyleDeclaration = getComputedStyle(el)): boolean {
  if (style.visibility === "hidden" || style.display === "none") return false
  const pos = style.position
  if (pos !== "fixed" && pos !== "sticky") {
    if (!(el as HTMLElement).offsetParent && el.tagName !== "BODY") return false
  }
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  return true
}

export function isInteractive(
  el: Element,
  tags: Set<string>,
  roles: Set<string>,
  style: CSSStyleDeclaration = getComputedStyle(el)
): boolean {
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
    if (style.cursor === "pointer") return true
  }
  // Custom-widget fallback: a plain DIV/SPAN driven entirely by an
  // addEventListener click handler (no onclick attribute, no role, no
  // tabindex — common in Stimulus/React/Vue-built dropdown replacements for
  // native <select>) is otherwise invisible to every check above. cursor:
  // pointer is the one CSS signal such widgets almost always carry (real
  // "this is clickable" affordance styling), so treat it the same way the
  // SVG branch already does, rather than only SVG icons getting this signal.
  // See hasOwnPointerCursor for why this is guarded against inheritance.
  //
  // Check the element's OWN cursor before touching the parent: this runs for
  // every element of a full DOM walk, and the parent getComputedStyle is only
  // needed for the (rare) pointer-cursor elements — reading it first would
  // double style resolution across the whole page for a test that is almost
  // always false.
  if (style.cursor === "pointer" && el.tagName !== "BODY" && el.tagName !== "HTML") {
    const parent = el.parentElement
    const parentCursor = parent ? getComputedStyle(parent).cursor : null
    if (hasOwnPointerCursor(style.cursor, parentCursor)) return true
  }
  return false
}

export function getInteractiveElements(): IndexedElement[] {
  selectorMap.clear()
  nextIndex = 0
  pruneStaleRefs()

  const results: IndexedElement[] = []

  walkWithShadow(document.body, (el) => {
    const style = getComputedStyle(el)
    if (isInteractive(el, INTERACTIVE_TAGS, INTERACTIVE_ROLES, style) && isVisible(el, style)) {
      const idx = nextIndex++
      const selector = buildSelector(el)
      selectorMap.set(idx, selector)
      const refId = getOrAssignRef(el)

      const tag = el.tagName.toLowerCase()
      const text = getAccessibleName(el)
      const attrs = getRelevantAttrs(el)

      refMetadata.set(refId, { role: getEffectiveRole(el, style), name: text, tag, value: ((el as HTMLInputElement).value || "").slice(0, 40) })

      results.push({ index: idx, refId, element: el, selector, tag, text, attrs })
    }
  })

  return results
}
