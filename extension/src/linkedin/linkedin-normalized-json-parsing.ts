import { normalizeText } from "./linkedin-shared-types"

function stripJsonPrefix(body: string): string {
  return body
    .replace(/^for\s*\(;;\s*\);?\s*/, "")
    .replace(/^\)\]\}',?\s*/, "")
    .trim()
}

export function tryParseJsonBody(body?: string): unknown | null {
  if (!body) return null
  const cleaned = stripJsonPrefix(body)
  if (!cleaned || !["{", "["].includes(cleaned[0])) return null
  try {
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

function walkValues(value: unknown, visitor: (key: string | null, value: unknown, path: string[]) => void, path: string[] = [], seen = new WeakSet<object>()) {
  visitor(path.length ? path[path.length - 1] : null, value, path)
  if (!value || typeof value !== "object") return
  if (seen.has(value as object)) return
  seen.add(value as object)
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkValues(item, visitor, [...path, String(index)], seen))
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    walkValues(child, visitor, [...path, key], seen)
  }
}

export function collectStringCandidates(value: unknown, keyHints: string[]): Array<{ key: string | null; path: string[]; value: string }> {
  const results: Array<{ key: string | null; path: string[]; value: string }> = []
  walkValues(value, (key, current, path) => {
    if (typeof current !== "string" || !key) return
    const lowerKey = key.toLowerCase()
    if (keyHints.some(hint => lowerKey.includes(hint))) {
      const normalized = current.replace(/\s+/g, " ").trim()
      if (normalized) results.push({ key, path, value: normalized })
    }
  })
  return results
}

export function collectNumberCandidates(value: unknown, keyHints: string[]): Array<{ key: string | null; path: string[]; value: number }> {
  const results: Array<{ key: string | null; path: string[]; value: number }> = []
  walkValues(value, (key, current, path) => {
    if (!key) return
    const lowerKey = key.toLowerCase()
    if (!keyHints.some(hint => lowerKey.includes(hint))) return
    if (typeof current === "number" && Number.isFinite(current)) {
      results.push({ key, path, value: current })
      return
    }
    if (typeof current === "string" && /^\d[\d,]*$/.test(current.trim())) {
      results.push({ key, path, value: parseInt(current.replace(/,/g, ""), 10) })
    }
  })
  return results
}

export function pickBestString(candidates: Array<{ value: string }>, preferred?: string | null, fallbackContains?: string | null): string | null {
  if (!candidates.length) return null
  const preferredNormalized = normalizeText(preferred)
  if (preferredNormalized) {
    const exact = candidates.find(candidate => normalizeText(candidate.value) === preferredNormalized)
    if (exact) return exact.value
    const contains = candidates.find(candidate => normalizeText(candidate.value).includes(preferredNormalized) || preferredNormalized.includes(normalizeText(candidate.value)))
    if (contains) return contains.value
  }
  const fallbackNormalized = normalizeText(fallbackContains)
  if (fallbackNormalized) {
    const matched = candidates.find(candidate => normalizeText(candidate.value).includes(fallbackNormalized))
    if (matched) return matched.value
  }
  return candidates.slice().sort((a, b) => b.value.length - a.value.length)[0].value
}

export function pickBestNumber(candidates: Array<{ value: number }>, preferred?: number | null): number | null {
  if (!candidates.length) return null
  if (preferred !== undefined && preferred !== null) {
    const exact = candidates.find(candidate => candidate.value === preferred)
    if (exact) return exact.value
  }
  return candidates.slice().sort((a, b) => b.value - a.value)[0].value
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000
    const date = new Date(millis)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d{13}$/.test(trimmed)) return toIsoTimestamp(parseInt(trimmed, 10))
  if (/^\d{10}$/.test(trimmed)) return toIsoTimestamp(parseInt(trimmed, 10))
  const date = new Date(trimmed)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function collectIsoCandidates(value: unknown, keyHints: string[]): string[] {
  const results: string[] = []
  walkValues(value, (key, current) => {
    if (!key) return
    const lowerKey = key.toLowerCase()
    if (!keyHints.some(hint => lowerKey.includes(hint))) return
    const iso = toIsoTimestamp(current)
    if (iso) results.push(iso)
  })
  return results
}
