import { refRegistry } from "./ref-registry"
import { isVisible } from "./element-discovery"
import { getEffectiveRole, getAccessibleName } from "./a11y-tree"

export function findBestMatch(name?: string, role?: string, text?: string): { refId: string; role: string; name: string; score: number; element: Element } | null {
  const query = (name || text || "").toLowerCase()
  const targetRole = (role || "").toLowerCase()
  let best: { refId: string; role: string; name: string; score: number; element: Element } | null = null

  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref()
    if (!el || !el.isConnected || !isVisible(el)) continue

    const elRole = getEffectiveRole(el).toLowerCase()
    const elName = getAccessibleName(el).toLowerCase()
    let score = 0

    if (targetRole && elRole !== targetRole) continue
    if (targetRole && elRole === targetRole) score += 50

    if (query) {
      if (elName === query) score += 100
      else if (elName.includes(query)) score += 60
      const id = el.getAttribute("id")?.toLowerCase()
      if (id?.includes(query)) score += 50
      const placeholder = el.getAttribute("placeholder")?.toLowerCase()
      if (placeholder?.includes(query)) score += 40
    }

    if (score >= 30 && (!best || score > best.score)) {
      best = { refId, role: getEffectiveRole(el), name: getAccessibleName(el), score, element: el }
    }
  }

  return best
}
