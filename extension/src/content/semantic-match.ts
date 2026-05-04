import { refRegistry } from "./ref-registry"
import { isVisible } from "./element-discovery"
import { getEffectiveRole, getAccessibleName } from "./a11y-tree"

export function findBestMatch(name?: string, role?: string, text?: string): { refId: string; role: string; name: string; score: number; element: Element } | null {
  const query = (name || text || "").toLowerCase()
  const targetRole = (role || "").toLowerCase()
  // `text:<query>` is a textContent-search pseudo-role, not an ARIA role.
  // It bypasses the role filter and scores against the accessible name AND
  // the raw textContent so plain elements can be matched by visible text.
  const isTextPseudoRole = targetRole === "text"
  let best: { refId: string; role: string; name: string; score: number; element: Element } | null = null

  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref()
    if (!el || !el.isConnected || !isVisible(el)) continue

    const elRole = getEffectiveRole(el).toLowerCase()
    const elName = getAccessibleName(el).toLowerCase()
    let score = 0

    if (targetRole && !isTextPseudoRole && elRole !== targetRole) continue
    if (targetRole && !isTextPseudoRole && elRole === targetRole) score += 50

    if (query) {
      if (elName === query) score += 100
      else if (elName.includes(query)) score += 60
      const id = el.getAttribute("id")?.toLowerCase()
      if (id?.includes(query)) score += 50
      const placeholder = el.getAttribute("placeholder")?.toLowerCase()
      if (placeholder?.includes(query)) score += 40
      if (isTextPseudoRole) {
        const elText = (el.textContent || "").trim().toLowerCase()
        if (elText === query) score += 80
        else if (elText.includes(query)) score += 50
      }
    }

    if (score >= 30 && (!best || score > best.score)) {
      best = { refId, role: getEffectiveRole(el), name: getAccessibleName(el), score, element: el }
    }
  }

  return best
}
