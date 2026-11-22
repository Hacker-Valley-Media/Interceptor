import { safeText, safeValue } from "./sensitive"
import { isVisible, isInteractive, INTERACTIVE_TAGS, INTERACTIVE_ROLES, getShadowRoot } from "./element-discovery"
import { getOrAssignRef } from "./ref-registry"
import { getRelevantAttrs, getStyleBundle } from "./element-tree"

export const LANDMARK_ROLES = new Set(["banner", "navigation", "main", "complementary", "contentinfo", "search", "form", "region"])
export const LANDMARK_TAGS = new Set(["NAV", "MAIN", "ASIDE", "HEADER", "FOOTER", "FORM", "SECTION"])

// An element is an upload target if it IS a file input or shallowly wraps one.
// The depth bound keeps the hint high-signal — a dropzone root
// renders its hidden <input type=file> as a near child, whereas a big modal /
// <body> that merely contains one far below is not flagged. Surfacing this in
// the a11y tree steers agents to `interceptor upload <ref> <path>` instead of
// clicking (which opens a native OS panel the browser surface can't drive).
export function isUploadTarget(el: Element, maxDepth = 3): boolean {
  if (el instanceof HTMLInputElement && el.type === "file") return true
  let frontier: Element[] = [el]
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next: Element[] = []
    for (const node of frontier) {
      for (const child of Array.from(node.children)) {
        if (child instanceof HTMLInputElement && child.type === "file") return true
        next.push(child)
      }
    }
    frontier = next
  }
  return false
}

// An invisible element's rect is otherwise pruned wholesale (its subtree
// never visited). Two shapes must still be descended into instead, because
// the element's own zero-area rect doesn't reflect its descendants: an
// out-of-flow shrink-to-fit portal/popper (`absolute`/`fixed`), or an inline
// (`display: inline`) grouping/target wrapper — e.g. a bare
// `<span data-controller-target="...">` some JS component wraps fields in
// purely as a hook, with no box of its own even though its block/flex
// children render normally. Other in-flow boxes (`static`/`relative`/
// `sticky` block-level, `block`/`flex`/`grid` display) are pruned as before,
// so genuinely collapsed/empty in-flow content doesn't leak in — only
// `inline` gets this exception, since block-level containers with real
// content don't collapse to 0×0 unless they're actually empty.
export function shouldDescendDespiteZeroArea(display: string, position: string): boolean {
  return position === "fixed" || position === "absolute" || display === "inline"
}

// `style` is optional and only consulted on the SVG branch — pass the
// already-computed style from full-DOM walks (a11y tree, element discovery)
// so those stay at one computed-style read per element. No default-param
// getComputedStyle here: a default expression evaluates on every call that
// omits the arg, which would ADD a style read for the many callers that
// never reach the SVG branch.
export function getEffectiveRole(el: Element, style?: CSSStyleDeclaration): string {
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
    if (el.hasAttribute("onclick") || (style ?? getComputedStyle(el)).cursor === "pointer") return "button"
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

/** One tree line per element, whatever the name holds. */
export function lineName(name: string): string {
  return name.replace(/\s+/g, " ").trim()
}

const BUTTON_INPUT_TYPES = new Set(["submit", "button", "reset", "image"])

/**
 * How a tree line shows an element. A button-like <input> prints as a button
 * named by its value; getEffectiveRole still answers
 * "textbox" for it, so semantic matching, monitor recordings and replays keep
 * today's roles.
 */
export function displayRoleName(el: Element, role: string, name: string): { role: string; name: string } {
  if (el.tagName === "INPUT") {
    const type = (el.getAttribute("type") || "").toLowerCase()
    if (BUTTON_INPUT_TYPES.has(type)) {
      const fallback = type === "reset" ? "Reset" : type === "button" ? "" : "Submit"
      return { role: "button", name: lineName(name || safeValue(el) || el.getAttribute("alt") || fallback) }
    }
  }
  return { role, name: lineName(name) }
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

  return safeText(el).trim().slice(0, 80)
}

// Convert `getRelevantAttrs` output like `type="submit" href="/x"` into compact
// pipe-form clauses: `|type=submit|href=/x`. Strips the surrounding quotes from
// each value so the compact line stays single-tokenish.
function compactAttrClause(attrs: string): string {
  if (!attrs) return ""
  const matches = attrs.matchAll(/(\S+?)="([^"]*)"/g)
  let out = ""
  for (const m of matches) out += `|${m[1]}=${m[2]}`
  return out
}

export function buildA11yTree(
  root: Element,
  depth: number,
  maxDepth: number,
  filter: string,
  includeStyle = false,
  format: "verbose" | "compact" = "verbose",
  opts: { viewport?: boolean } = {}
): string {
  if (depth > maxDepth) return ""
  const lines: string[] = []
  const compact = format === "compact"
  // --viewport: only what is on screen now, plus a count of the
  // refs scrolled out of view, so an agent reading a long page gets the part
  // it can act on instead of the document head.
  const viewH = globalThis.innerHeight || document.documentElement.clientHeight || 0
  const viewW = globalThis.innerWidth || document.documentElement.clientWidth || 0
  let above = 0, below = 0, aside = 0
  type Clip = { top: number; bottom: number; left: number; right: number }
  const screen: Clip = { top: 0, bottom: viewH, left: 0, right: viewW }
  const placement = (el: Element, clip: Clip): "in" | "above" | "below" | "aside" => {
    if (!opts.viewport) return "in"
    const r = el.getBoundingClientRect()
    if (r.bottom <= clip.top) return "above"
    if (r.top >= clip.bottom) return "below"
    if (r.right <= clip.left || r.left >= clip.right) return "aside"
    // A clipping box that is itself off screen leaves no visible area.
    if (clip.bottom <= clip.top || clip.right <= clip.left) return r.top >= viewH ? "below" : r.bottom <= 0 ? "above" : "aside"
    return "in"
  }
  // A scrolling or clipping box hides what lies outside it, even when that
  // part is inside the browser window.
  const innerClip = (el: Element, style: CSSStyleDeclaration | null, clip: Clip): Clip => {
    if (!opts.viewport || !style) return clip
    const clipsY = !!style.overflowY && style.overflowY !== "visible", clipsX = !!style.overflowX && style.overflowX !== "visible"
    if (!clipsX && !clipsY) return clip
    const r = el.getBoundingClientRect()
    return {
      top: clipsY ? Math.max(clip.top, r.top) : clip.top,
      bottom: clipsY ? Math.min(clip.bottom, r.bottom) : clip.bottom,
      left: clipsX ? Math.max(clip.left, r.left) : clip.left,
      right: clipsX ? Math.min(clip.right, r.right) : clip.right,
    }
  }

  // `absClip` is the clip at the nearest positioned ancestor: an absolutely
  // positioned box escapes overflow on ancestors between it and its
  // containing block. ponytail: transform-created containing blocks are not
  // tracked; a fixed box inside a transformed ancestor is placed against the screen.
  function walk(el: Element, d: number, clip: Clip = screen, absClip: Clip = screen) {
    if (d > maxDepth) return

    // Visibility disposition. `display:none` / `visibility:hidden` hide the
    // whole subtree, so we stop. An invisible element that's only zero-area
    // (see shouldDescendDespiteZeroArea) must still be descended into: its
    // descendants are visibility-checked individually. The element itself is
    // only emitted when it is actually visible.
    //
    // One computed-style read per element, shared between the visibility test
    // and the disposition below: isVisible() reads computed style too, so we
    // pass it in to avoid a second forced style resolution on this hot path.
    const style = el.tagName === "BODY" ? null : getComputedStyle(el)
    const selfVisible = el.tagName === "BODY" || isVisible(el, style!)
    if (!selfVisible) {
      if (style!.display === "none" || style!.visibility === "hidden") return
      if (!shouldDescendDespiteZeroArea(style!.display, style!.position)) return
    }

    const role = getEffectiveRole(el, style ?? undefined)
    const tag = el.tagName.toLowerCase()
    const isLandmark = LANDMARK_ROLES.has(role) || LANDMARK_TAGS.has(el.tagName)
    const isHeading = /^h[1-6]$/.test(tag) || role === "heading"
    const isInteractiveEl = isInteractive(el, INTERACTIVE_TAGS, INTERACTIVE_ROLES, style ?? undefined)
    const prefix = compact ? ">".repeat(d) : "  ".repeat(d)

    // A fixed box escapes its ancestors' clipping.
    const own = !opts.viewport ? clip : style?.position === "fixed" ? screen : style?.position === "absolute" ? absClip : clip
    if (selfVisible && isLandmark && !isInteractiveEl && placement(el, own) === "in") {
      const rawName = getAccessibleName(el)
      const hasName = !!rawName && rawName !== (el.textContent || "").trim().slice(0, 80)
      const name = lineName(rawName)
      if (compact) {
        lines.push(`${prefix}${role || tag}${hasName ? `|${name}` : ""}`)
      } else {
        const nameStr = hasName ? ` "${name}"` : ""
        lines.push(`${prefix}${role || tag}${nameStr}`)
      }
    }

    const where = selfVisible && isInteractiveEl ? placement(el, own) : "in"
    if (where === "above") above++
    else if (where === "below") below++
    else if (where === "aside") aside++

    if (selfVisible && isHeading && filter === "all" && placement(el, own) === "in") {
      const name = lineName(getAccessibleName(el))
      if (compact) {
        lines.push(`${prefix}heading|${name}`)
      } else {
        lines.push(`${prefix}heading "${name}"`)
      }
    }

    if (selfVisible && isInteractiveEl && where === "in") {
      const refId = getOrAssignRef(el)
      const shown = displayRoleName(el, role || tag, getAccessibleName(el))
      const name = shown.name
      const attrs = getRelevantAttrs(el)
      const styleBundle = includeStyle ? getStyleBundle(el) : ""
      const uploadable = isUploadTarget(el)
      if (compact) {
        const nameClause = name ? `|${name}` : ""
        const attrClause = compactAttrClause(attrs)
        const styleClause = styleBundle ? `|style={${styleBundle}}` : ""
        const uploadClause = uploadable ? "|upload" : ""
        lines.push(`${prefix}[${refId}|${shown.role}${nameClause}${attrClause}${styleClause}${uploadClause}]`)
      } else {
        const nameStr = name ? ` "${name}"` : ""
        const attrStr = attrs ? ` ${attrs}` : ""
        const styleStr = styleBundle ? ` style="${styleBundle}"` : ""
        const uploadStr = uploadable ? ` upload="interceptor upload ${refId} <path>"` : ""
        lines.push(`${prefix}[${refId}] ${shown.role}${nameStr}${attrStr}${styleStr}${uploadStr}`)
      }
    }

    const inner = innerClip(el, style, own)
    const innerAbs = style?.position && style.position !== "static" ? inner : absClip
    const shadow = getShadowRoot(el)
    if (shadow) {
      const shadowPrefix = compact ? ">".repeat(d + 1) : `${prefix}  `
      lines.push(`${shadowPrefix}shadow-root`)
      for (const child of Array.from(shadow.children)) {
        walk(child, d + 2, inner, innerAbs)
      }
    }

    for (const child of Array.from(el.children)) {
      walk(child, isLandmark && selfVisible ? d + 1 : d, inner, innerAbs)
    }
  }

  walk(root, depth)
  if (opts.viewport) lines.push(viewportNote(above, below, aside))
  return lines.join("\n")
}

export function viewportNote(above: number, below: number, aside: number): string {
  const parts = [`${above} above`, `${below} below`]
  if (aside) parts.push(`${aside} beside`)
  return `(viewport only: ${parts.join(", ")} the visible area; scroll, or drop --viewport for the whole page)`
}
