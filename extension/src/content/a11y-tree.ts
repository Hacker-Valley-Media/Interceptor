import { isVisible, isInteractive, INTERACTIVE_TAGS, INTERACTIVE_ROLES, getShadowRoot } from "./element-discovery"
import { getOrAssignRef } from "./ref-registry"
import { getRelevantAttrs } from "./element-tree"

export const LANDMARK_ROLES = new Set(["banner", "navigation", "main", "complementary", "contentinfo", "search", "form", "region"])
export const LANDMARK_TAGS = new Set(["NAV", "MAIN", "ASIDE", "HEADER", "FOOTER", "FORM", "SECTION"])

export function getEffectiveRole(el: Element): string {
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

export function getAccessibleName(el: Element): string {
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

export function buildA11yTree(root: Element, depth: number, maxDepth: number, filter: string): string {
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
