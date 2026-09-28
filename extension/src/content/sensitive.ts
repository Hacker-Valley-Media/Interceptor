/** Password and credential-marked controls share one DOM-output masking policy. */

// Like the ref registry, survive repeat injections into the same isolated world.
const globals = globalThis as unknown as { __interceptor_sensitiveElements?: WeakSet<Element> }
const sensitiveElements = globals.__interceptor_sensitiveElements ??= new WeakSet<Element>()

export function markSensitive(el: Element): void {
  sensitiveElements.add(el)
}

export function isSensitive(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement || (node.getRootNode() as ShadowRoot).host || null) {
    if (node.tagName === "INPUT" && (node as HTMLInputElement).type === "password") markSensitive(node)
    if (sensitiveElements.has(node)) return true
  }
  return false
}

export const SECURE_MASK = "***SECURE***"

/** Mask before truncation, including snapshots that may outlive the value. */
export function safeValue(el: Element): string {
  const value = (el as HTMLInputElement).value || ""
  const sensitive = isSensitive(el)
  return value && sensitive ? SECURE_MASK : value
}

/** Preserve rendered spacing while removing text-backed credential contents. */
export function redactSensitiveText(text: string, root: Element): string {
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (!isSensitive(el)) continue
    // Input.value is not rendered text. Replacing it here would corrupt ordinary
    // page text for short passwords; value reads are masked by safeValue instead.
    for (const value of [el.textContent, (el as HTMLElement).innerText]) {
      if (value) text = text.replaceAll(value, SECURE_MASK)
    }
  }
  return text
}

// `innerText` is layout-dependent, and a tab that has never been rendered
// (a container's only state) can answer "" for a body full of text, so
// `text`, `find`, and `state` reported an empty page. `??` did not catch this:
// the value is an empty string, not null.
//
// The fallback is not raw `textContent`, which would hand back stylesheet
// rules, script source, and hidden text that no reader sees. It walks text
// nodes the way a renderer would show them: non-rendered tags are skipped,
// elements hidden by computed style are skipped, and whitespace is collapsed.
// `innerText` still wins whenever it has content, so nothing changes where
// layout exists.
const NON_RENDERED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"])

function hiddenByStyle(el: Element): boolean {
  const style = getComputedStyle(el)
  return style.display === "none" || style.visibility === "hidden"
}

/** Text nodes in document order, minus what a renderer would not show. */
export function walkRenderedText(root: Element): string {
  const parts: string[] = []
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent ?? ""); return }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as Element
    if (NON_RENDERED_TAGS.has(el.tagName) || hiddenByStyle(el)) return
    for (const child of Array.from(el.childNodes)) walk(child)
  }
  walk(root)
  // ponytail: one collapse rule for every element; per-element white-space
  // handling (pre, nowrap) only matters if this fallback ever runs on a
  // page where innerText also works, and it cannot.
  return parts.join(" ").replace(/\s+/g, " ").trim()
}

function renderedText(el: Element): string {
  const rendered = (el as HTMLElement).innerText
  if (rendered && rendered.trim()) return rendered
  return walkRenderedText(el)
}

export function safeText(el: Element, rendered = false): string {
  const text = rendered ? renderedText(el) : el.textContent || ""
  if (isSensitive(el)) return text ? SECURE_MASK : ""
  return redactSensitiveText(text, el)
}

/** Clone only for serialization; never blank a field in the live page. */
export function safeHtml(el: Element): string {
  const clone = el.cloneNode(true) as Element
  const originals = [el, ...Array.from(el.querySelectorAll("*"))]
  const copies = [clone, ...Array.from(clone.querySelectorAll("*"))]
  for (let i = 0; i < originals.length; i++) {
    const original = originals[i], copy = copies[i]
    if (!isSensitive(original)) continue
    if (copy.hasAttribute("value")) copy.setAttribute("value", copy.getAttribute("value") ? SECURE_MASK : "")
    if (original.tagName !== "INPUT" && (original.textContent || (original as HTMLTextAreaElement).value)) copy.textContent = SECURE_MASK
  }
  return clone.outerHTML
}
