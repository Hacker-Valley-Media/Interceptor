import { findBestMatch } from "./semantic-match"
import { refRegistry } from "./ref-registry"
import { isVisible } from "./element-discovery"
import { getEffectiveRole, getAccessibleName } from "./a11y-tree"
import { scrollIntoViewIfNeeded, dispatchClickSequence } from "./input-simulation"
import { handleInputText, handleCheck } from "./actions/type"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export type TextFindMatch = {
  start: number
  end: number
  matchedText: string
  snippet: string
}

export type TextFindResult = {
  total: number
  returned: number
  truncated: boolean
  scannedCharacters: number
  scanTruncated: false
  matches: TextFindMatch[]
}

export type ElementFindMatch = {
  refId: string
  role: string
  name: string
  score: number
}

export type ElementFindResult = {
  total: number
  returned: number
  truncated: boolean
  matches: ElementFindMatch[]
}

/**
 * Literal, case-insensitive rendered-text matcher. It intentionally scans the
 * complete supplied snapshot; `limit` only caps emitted matches, never the
 * examined page text. Keeping this helper DOM-free makes the contract directly
 * testable with Bun.
 */
export function findRenderedText(
  renderedText: string,
  rawQuery: string,
  limit = 10,
  contextChars = 80
): TextFindResult {
  const query = rawQuery.trim()
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 10
  const matches: TextFindMatch[] = []
  let total = 0

  if (query.length > 0) {
    const haystack = renderedText.toLowerCase()
    const needle = query.toLowerCase()
    let from = 0
    while (from <= haystack.length - needle.length) {
      const start = haystack.indexOf(needle, from)
      if (start === -1) break
      const end = start + query.length
      total++
      if (matches.length < boundedLimit) {
        const snippetStart = Math.max(0, start - contextChars)
        const snippetEnd = Math.min(renderedText.length, end + contextChars)
        const prefix = snippetStart > 0 ? "…" : ""
        const suffix = snippetEnd < renderedText.length ? "…" : ""
        matches.push({
          start,
          end,
          matchedText: renderedText.slice(start, end),
          snippet: `${prefix}${renderedText.slice(snippetStart, snippetEnd).replace(/\s+/g, " ").trim()}${suffix}`
        })
      }
      // Browser find advances past the current literal occurrence. This also
      // guarantees progress for all non-empty queries.
      from = end
    }
  }

  return {
    total,
    returned: matches.length,
    truncated: total > matches.length,
    scannedCharacters: renderedText.length,
    scanTruncated: false,
    matches
  }
}

export function findAccessibleElements(rawQuery: string, rawRole: string, limit = 10): ElementFindResult {
  const query = rawQuery.trim().toLowerCase()
  const targetRole = rawRole.trim().toLowerCase()
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 10
  const results: ElementFindMatch[] = []

  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref()
    if (!el || !el.isConnected || !isVisible(el)) continue

    const effectiveRole = getEffectiveRole(el)
    const accessibleName = getAccessibleName(el)
    const role = effectiveRole.toLowerCase()
    const name = accessibleName.toLowerCase()
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

    if (score > 0) results.push({ refId, role: effectiveRole, name: accessibleName, score })
  }

  results.sort((a, b) => b.score - a.score)
  const matches = results.slice(0, boundedLimit)
  return { total: results.length, returned: matches.length, truncated: results.length > matches.length, matches }
}

export async function handleFindElement(action: Action): Promise<ActionResult> {
  const query = String(action.query || "").trim()
  if (!query) return { success: false, error: "find requires a non-empty query" }

  const role = String(action.role || "")
  const limit = typeof action.limit === "number" ? action.limit : 10
  const requestedMode = action.mode === "text" || action.mode === "elements" ? action.mode : "hybrid"
  // A role filter is meaningful only for accessible elements and deliberately
  // preserves the historical `find --role` behavior.
  const mode = role ? "elements" : requestedMode
  const data: Record<string, unknown> = { query, mode }

  if (mode !== "elements") {
    data.text = findRenderedText(document.body?.innerText || "", query, limit)
  }
  if (mode !== "text") {
    data.elements = findAccessibleElements(query, role, limit)
  }

  return { success: true, data }
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
  const typeResult = await handleInputText({ type: "input_text", ref: match.refId, text: action.inputText as string, clear: action.clear, sensitive: action.sensitive })
  return { success: true, data: { matched: { ref: match.refId, role: match.role, name: match.name, score: match.score }, actionResult: typeResult } }
}

export async function handleFindAndCheck(action: Action): Promise<ActionResult> {
  const match = findBestMatch(action.name as string | undefined, action.role as string | undefined, action.text as string | undefined)
  if (!match) return { success: false, error: "no matching element found (score < 30)" }
  const checkResult = await handleCheck({ type: "check", ref: match.refId, checked: action.checked })
  return { success: true, data: { matched: { ref: match.refId, role: match.role, name: match.name, score: match.score }, actionResult: checkResult } }
}
