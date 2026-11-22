import { safeValue } from "./sensitive"
import { getEffectiveRole, displayRoleName } from "./a11y-tree"
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
    const parent: Element | null = current.parentElement
    if (parent) {
      const currentTagName = current.tagName
      const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === currentTagName)
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

// The href attribute as written, whole up to 300
// characters (a 60-character cut sent agents to broken URLs); longer ends in
// "…" so a reader knows not to open it. Not `el.href`: that resolves against
// the current URL, which an SPA changes, and would make diffs report every
// relative link as changed.
export const TREE_HREF_CHARS = 300
export const TREE_QUERY_CHARS = 80

// Query parameters that only say where a click came from. Dropped from tree
// hrefs (links and inspect keep the whole value).
const TRACKING_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi)$/i

function cleanQuery(query: string): string {
  if (!query) return ""
  const kept = query.split("&").filter((pair) => pair && !TRACKING_PARAM.test(pair.split("=", 1)[0]))
  const joined = kept.join("&")
  return joined.length > TREE_QUERY_CHARS ? `${joined.slice(0, TREE_QUERY_CHARS)}…` : joined
}

/**
 * The href as a tree line shows it. Hrefs were 50 to 67% of link
 * line bytes. A same-origin absolute link prints as its path, tracking
 * parameters go, and a query over 80 characters is cut. Relative hrefs keep
 * their written form so a diff does not report every link as changed when an
 * SPA moves to another route.
 */
export function shortHref(raw: string, origin: string): string {
  let out = raw
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")
  if (absolute) {
    let url: URL | null = null
    try { url = new URL(raw, origin) } catch {}
    if (url && (url.protocol === "http:" || url.protocol === "https:")) {
      const query = cleanQuery(url.search.slice(1))
      const tail = `${url.pathname}${query ? `?${query}` : ""}${url.hash}`
      out = url.origin === origin ? tail : `${url.origin}${tail}`
    }
  } else {
    const hashAt = raw.indexOf("#")
    const hash = hashAt === -1 ? "" : raw.slice(hashAt)
    const beforeHash = hashAt === -1 ? raw : raw.slice(0, hashAt)
    const queryAt = beforeHash.indexOf("?")
    if (queryAt !== -1) {
      const query = cleanQuery(beforeHash.slice(queryAt + 1))
      out = `${beforeHash.slice(0, queryAt)}${query ? `?${query}` : ""}${hash}`
    }
  }
  return out.length > TREE_HREF_CHARS ? `${out.slice(0, TREE_HREF_CHARS)}…` : out
}

export function getRelevantAttrs(el: Element): string {
  const attrs: string[] = []
  const tag = el.tagName.toLowerCase()

  const role = el.getAttribute("role")
  if (role) attrs.push(`role="${role}"`)

  if (tag === "a") {
    const href = el.getAttribute("href")
    if (href) attrs.push(`href="${shortHref(href, globalThis.location?.origin ?? "")}"`)
  }
  if (tag === "input") {
    const type = el.getAttribute("type")
    if (type) attrs.push(`type="${type}"`)
    const placeholder = el.getAttribute("placeholder")
    if (placeholder) attrs.push(`placeholder="${placeholder}"`)
    const value = safeValue(el)
    if (value) attrs.push(`value="${value.slice(0, 40)}"`)
    if ((el as HTMLInputElement).checked) attrs.push("checked")
    if ((el as HTMLInputElement).disabled) attrs.push("disabled")
  }
  if (tag === "select" || tag === "textarea") {
    const value = safeValue(el)
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

const STYLE_BUNDLE_PROPS = [
  "display",
  "visibility",
  "color",
  "backgroundColor",
  "fontSize",
  "fontWeight",
  "cursor",
  "opacity"
] as const

// `cursor` is an inherited CSS property: a passive descendant (a label span,
// an icon) of a `cursor: pointer` container computes the same "pointer"
// value as the container itself, purely via inheritance. Only treat pointer
// as a genuine "this element is a clickable widget" signal when it isn't
// just passed through from a `cursor: pointer` ancestor.
export function hasOwnPointerCursor(cursor: string, parentCursor: string | null): boolean {
  return cursor === "pointer" && parentCursor !== "pointer"
}

export function getStyleBundle(el: Element): string {
  const cs = getComputedStyle(el)
  const parts: string[] = []
  for (const prop of STYLE_BUNDLE_PROPS) {
    const cssName = prop === "backgroundColor" ? "background-color" : prop === "fontSize" ? "font-size" : prop === "fontWeight" ? "font-weight" : prop
    const v = cs.getPropertyValue(cssName)
    if (!v) continue
    const trimmed = (v.length > 40 ? v.slice(0, 40) : v).replace(/\s+/g, " ").trim()
    parts.push(`${prop}=${trimmed.includes(" ") ? `'${trimmed}'` : trimmed}`)
  }
  return parts.join(" ")
}

export function buildElementTree(elements: IndexedElement[]): string {
  return elements.map(e => {
    const shown = displayRoleName(e.element, getEffectiveRole(e.element) || e.tag, e.text || "")
    const name = shown.name ? ` "${shown.name}"` : ""
    const attrStr = e.attrs ? ` ${e.attrs}` : ""
    return `[${e.refId}] ${shown.role}${name}${attrStr}`
  }).join("\n")
}
