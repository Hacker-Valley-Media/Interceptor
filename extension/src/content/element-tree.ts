import { getEffectiveRole } from "./a11y-tree"
import type { IndexedElement } from "./element-discovery"

export function buildSelector(el: Element): string {
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

export function getRelevantAttrs(el: Element): string {
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

export function buildElementTree(elements: IndexedElement[]): string {
  return elements.map(e => {
    const role = getEffectiveRole(e.element)
    const name = e.text ? ` "${e.text}"` : ""
    const attrStr = e.attrs ? ` ${e.attrs}` : ""
    return `[${e.refId}] ${role || e.tag}${name}${attrStr}`
  }).join("\n")
}
