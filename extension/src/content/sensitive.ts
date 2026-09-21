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

// `innerText` is layout-dependent, and Chrome does not run layout for a tab
// that has never been foregrounded. In a background tab — the default for
// `interceptor open`, and the only state a container ever has — `innerText`
// returns "" for a body that is full of text, so `text`, `find` and `state`
// all reported an empty page while `textContent` held every word. `??` did not
// catch this: the value is an empty string, not null.
//
// Falling back only when the rendered read came back blank keeps `innerText`'s
// advantages (it honours display:none and collapses whitespace the way a reader
// sees it) everywhere they are actually available, and degrades to raw text
// only where the alternative is nothing at all.
function renderedText(el: Element): string {
  const rendered = (el as HTMLElement).innerText
  if (rendered && rendered.trim()) return rendered
  const raw = el.textContent ?? ""
  return raw.trim() ? raw : rendered ?? raw
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
