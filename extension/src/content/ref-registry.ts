import { isVisible } from "./element-discovery"
import { findBestMatch } from "./semantic-match"

export const refRegistry = new Map<string, WeakRef<Element>>()
export const elementToRef = new WeakMap<Element, string>()
export const refMetadata = new Map<string, { role: string; name: string; tag: string; value: string }>()
let nextRefId = 1
let staleWarning: string | null = null

export function getStaleWarning(): string | null { return staleWarning }
export function clearStaleWarning() { staleWarning = null }

export function getOrAssignRef(el: Element): string {
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

export function resolveRef(refId: string): Element | null {
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

export function pruneStaleRefs() {
  for (const [id, ref] of refRegistry) {
    const el = ref.deref()
    if (!el || !el.isConnected) refRegistry.delete(id)
  }
}
