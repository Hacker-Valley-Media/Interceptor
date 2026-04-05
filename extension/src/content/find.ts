import { findBestMatch } from "./semantic-match"
import { refRegistry } from "./ref-registry"
import { isVisible } from "./element-discovery"
import { getEffectiveRole, getAccessibleName } from "./a11y-tree"
import { scrollIntoViewIfNeeded, dispatchClickSequence } from "./input-simulation"
import { handleInputText, handleCheck } from "./actions/type"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleFindElement(action: Action): Promise<ActionResult> {
  const query = (action.query as string || "").toLowerCase()
  const targetRole = (action.role as string || "").toLowerCase()
  const limit = (action.limit as number) || 10
  const results: { refId: string; role: string; name: string; score: number }[] = []

  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref()
    if (!el || !el.isConnected || !isVisible(el)) continue

    const role = getEffectiveRole(el).toLowerCase()
    const name = getAccessibleName(el).toLowerCase()
    let score = 0

    if (targetRole && role !== targetRole) continue
    if (targetRole && role === targetRole) score += 50

    if (query) {
      if (name === query) score += 100
      else if (name.includes(query)) score += 60
      const id = el.getAttribute("id")?.toLowerCase()
      if (id?.includes(query)) score += 50
      const placeholder = el.getAttribute("placeholder")?.toLowerCase()
      if (placeholder?.includes(query)) score += 40
      const value = ((el as HTMLInputElement).value || "").toLowerCase()
      if (value.includes(query)) score += 30
    }

    if (score > 0) results.push({ refId, role: getEffectiveRole(el), name: getAccessibleName(el), score })
  }

  results.sort((a, b) => b.score - a.score)
  return { success: true, data: results.slice(0, limit) }
}

export async function handleSemanticResolve(action: Action): Promise<ActionResult> {
  const match = findBestMatch(action.name as string, action.role as string)
  if (!match) return { success: false, error: `no element matching ${action.role}:${action.name}` }
  return { success: true, data: { ref: match.refId, role: match.role, name: match.name, score: match.score } }
}

export async function handleFindAndClick(action: Action): Promise<ActionResult> {
  const match = findBestMatch(action.name as string | undefined, action.role as string | undefined, action.text as string | undefined)
  if (!match) return { success: false, error: "no matching element found (score < 30)" }
  scrollIntoViewIfNeeded(match.element)
  dispatchClickSequence(match.element, action.x as number | undefined, action.y as number | undefined)
  return { success: true, data: { matched: { ref: match.refId, role: match.role, name: match.name, score: match.score }, actionResult: `clicked [${match.refId}]` } }
}

export async function handleFindAndType(action: Action): Promise<ActionResult> {
  const match = findBestMatch(action.name as string | undefined, action.role as string | undefined, action.text as string | undefined)
  if (!match) return { success: false, error: "no matching element found (score < 30)" }
  const typeResult = await handleInputText({ type: "input_text", ref: match.refId, text: action.inputText as string, clear: action.clear })
  return { success: true, data: { matched: { ref: match.refId, role: match.role, name: match.name, score: match.score }, actionResult: typeResult } }
}

export async function handleFindAndCheck(action: Action): Promise<ActionResult> {
  const match = findBestMatch(action.name as string | undefined, action.role as string | undefined, action.text as string | undefined)
  if (!match) return { success: false, error: "no matching element found (score < 30)" }
  const checkResult = await handleCheck({ type: "check", ref: match.refId, checked: action.checked })
  return { success: true, data: { matched: { ref: match.refId, role: match.role, name: match.name, score: match.score }, actionResult: checkResult } }
}
