import { safeText, safeHtml } from "../sensitive"
import { resolveElement } from "../input-simulation"
import { renderMarkdown } from "./markdown-extract"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

// Truncation discipline: large caps + an explicit marker when capped.
// A silent cap forces the agent to escape to raw-markup URLs to recover the
// missing text. Surfacing the cap and showing how to scope or widen keeps
// the agent on the rendered-text path it should already be on.
const DEFAULT_TEXT_MAX_CHARS = 200_000
const DEFAULT_HTML_MAX_CHARS = 200_000
const ELEMENT_MAX_CHARS = 50_000

function withTruncationMarker(text: string, cap: number): string {
  if (text.length <= cap) return text
  const totalLen = text.length
  return text.slice(0, cap) +
    `\n... (truncated: showed ${cap} of ${totalLen} chars. To see more: scope with 'read e<ref> --text-only', search with 'find "<term>"', or pass 'maxChars=<n>' in raw action. Do NOT fetch ?action=raw or view-source — raw markup is harder to parse than rendered text.)`
}

export async function handleExtractText(action: Action): Promise<ActionResult> {
  const maxChars = typeof action.maxChars === "number" && action.maxChars > 0
    ? action.maxChars
    : DEFAULT_TEXT_MAX_CHARS
  if (action.index !== undefined || action.ref !== undefined) {
    const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
    if (!el) {
      const label = String(action.ref ?? action.index ?? "unknown")
      return { success: false, error: `stale element [${label}] — run interceptor state to refresh` }
    }
    const raw = safeText(el).trim()
    return { success: true, data: withTruncationMarker(raw, Math.min(maxChars, ELEMENT_MAX_CHARS)) }
  }
  return { success: true, data: withTruncationMarker(safeText(document.body, true), maxChars) }
}

export async function handleExtractMarkdown(action: Action): Promise<ActionResult> {
  const maxChars = typeof action.maxChars === "number" && action.maxChars > 0
    ? action.maxChars
    : DEFAULT_TEXT_MAX_CHARS
  if (action.index !== undefined || action.ref !== undefined) {
    const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
    if (!el) {
      const label = String(action.ref ?? action.index ?? "unknown")
      return { success: false, error: `stale element [${label}] — run interceptor state to refresh` }
    }
    return { success: true, data: withTruncationMarker(renderMarkdown(el), Math.min(maxChars, ELEMENT_MAX_CHARS)) }
  }
  return { success: true, data: withTruncationMarker(renderMarkdown(document.body), maxChars) }
}

export async function handleExtractHtml(action: Action): Promise<ActionResult> {
  const maxChars = typeof action.maxChars === "number" && action.maxChars > 0
    ? action.maxChars
    : DEFAULT_HTML_MAX_CHARS
  if (action.index !== undefined || action.ref !== undefined) {
    const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
    if (!el) {
      const label = String(action.ref ?? action.index ?? "unknown")
      return { success: false, error: `stale element [${label}] — run interceptor state to refresh` }
    }
    return { success: true, data: withTruncationMarker(safeHtml(el), Math.min(maxChars, ELEMENT_MAX_CHARS)) }
  }
  return { success: true, data: withTruncationMarker(safeHtml(document.documentElement), maxChars) }
}
