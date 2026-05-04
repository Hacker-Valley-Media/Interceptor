import { findBestMatch } from "./semantic-match"

// content.js can evaluate more than once in the same isolated-world context:
// the background script may inject it via `chrome.scripting.executeScript` on
// a freshly-created tab to beat `document_idle`, and then the manifest's
// `content_scripts` entry auto-injects it again at `document_idle`. Each
// re-evaluation creates fresh module-scoped Maps, which would invalidate every
// element ref the consumer has already received. Pinning the registry maps on
// globalThis lets the second evaluation re-attach to the same instances.
type RefGlobals = {
  __interceptor_refRegistry?: Map<string, WeakRef<Element>>
  __interceptor_elementToRef?: WeakMap<Element, string>
  __interceptor_refMetadata?: Map<string, { role: string; name: string; tag: string; value: string }>
  __interceptor_nextRefId?: { value: number }
}
const g = globalThis as unknown as RefGlobals
export const refRegistry: Map<string, WeakRef<Element>> =
  g.__interceptor_refRegistry ?? (g.__interceptor_refRegistry = new Map<string, WeakRef<Element>>())
export const elementToRef: WeakMap<Element, string> =
  g.__interceptor_elementToRef ?? (g.__interceptor_elementToRef = new WeakMap<Element, string>())
export const refMetadata: Map<string, { role: string; name: string; tag: string; value: string }> =
  g.__interceptor_refMetadata ?? (g.__interceptor_refMetadata = new Map<string, { role: string; name: string; tag: string; value: string }>())
const refIdCounter: { value: number } =
  g.__interceptor_nextRefId ?? (g.__interceptor_nextRefId = { value: 1 })
let staleWarning: string | null = null

export function getStaleWarning(): string | null { return staleWarning }
export function clearStaleWarning() { staleWarning = null }

export function getOrAssignRef(el: Element): string {
  const existing = elementToRef.get(el)
  if (existing) {
    // Refs are stable for the lifetime of the element. If elementToRef still
    // binds this element to a refId, that is the canonical ref — even if the
    // refRegistry entry was pruned (the WeakRef was reclaimed and cleared by
    // pruneStaleRefs). Re-link the WeakRef to the same refId rather than
    // minting a new one; otherwise every GC cycle silently renumbers refs.
    const ref = refRegistry.get(existing)
    const live = ref?.deref()
    if (live === el) return existing
    if (!live) {
      // Re-link: same element, fresh WeakRef, same refId.
      refRegistry.set(existing, new WeakRef(el))
      return existing
    }
    // Two elements somehow share the same WeakMap binding — defensive overwrite.
    refRegistry.set(existing, new WeakRef(el))
    return existing
  }
  const refId = `e${refIdCounter.value++}`
  refRegistry.set(refId, new WeakRef(el))
  elementToRef.set(el, refId)
  return refId
}

export function resolveRef(refId: string): Element | null {
  const ref = refRegistry.get(refId)
  if (ref) {
    const el = ref.deref()
    // Visibility intentionally not in this gate. A transient layout hiccup
    // (a sibling toggling display, a transition briefly removing offsetParent)
    // would otherwise invalidate refs the consumer just received. Action
    // handlers re-check visibility themselves and surface a clearer error
    // when the element exists but cannot be acted on.
    if (el && el.isConnected) return el
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

export function pruneStaleRefs() {
  for (const [id, ref] of refRegistry) {
    const el = ref.deref()
    if (!el || !el.isConnected) refRegistry.delete(id)
  }
}
