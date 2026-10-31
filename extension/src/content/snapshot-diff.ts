import { safeText, safeValue } from "./sensitive"
import { refRegistry } from "./ref-registry"
import { getEffectiveRole, getAccessibleName } from "./a11y-tree"
import { getRelevantAttrs } from "./element-tree"

export interface SnapshotEntry {
  refId: string
  role: string
  name: string
  value: string
  states: string
}

export let lastSnapshot: SnapshotEntry[] = []
// The page's visible text lines at the last read, so
// `act` can say what text a click revealed or removed.
export let lastTextLines: string[] | null = null

const TEXT_LINE_CAP = 4000
const TEXT_LINE_CHARS = 200
const TEXT_DIFF_CAP = 200

/** Visible text as trimmed, non-empty lines (masked like `text`). */
export function visibleTextLines(): string[] {
  if (!document.body) return []
  const lines: string[] = []
  for (const raw of safeText(document.body, true).split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim()
    if (!line) continue
    lines.push(line.length > TEXT_LINE_CHARS ? `${line.slice(0, TEXT_LINE_CHARS)}…` : line)
    if (lines.length >= TEXT_LINE_CAP) break
  }
  return lines
}

/** Lines that appeared or disappeared since the last read (multiset), or null with no baseline. */
export function computeTextDiff(): { textAdded: string[]; textRemoved: string[]; textAddedTotal: number; textRemovedTotal: number } | null {
  if (lastTextLines === null) return null
  const current = visibleTextLines()
  const count = new Map<string, number>()
  for (const line of lastTextLines) count.set(line, (count.get(line) ?? 0) + 1)
  const added: string[] = []
  for (const line of current) {
    const n = count.get(line) ?? 0
    if (n > 0) count.set(line, n - 1)
    else added.push(line)
  }
  const removed: string[] = []
  for (const [line, n] of count) for (let i = 0; i < n; i++) removed.push(line)
  lastTextLines = current
  return { textAdded: added.slice(0, TEXT_DIFF_CAP), textRemoved: removed.slice(0, TEXT_DIFF_CAP), textAddedTotal: added.length, textRemovedTotal: removed.length }
}

export function cacheSnapshot() {
  const entries: SnapshotEntry[] = []
  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref()
    if (!el || !el.isConnected) continue
    entries.push({
      refId,
      role: getEffectiveRole(el),
      name: getAccessibleName(el),
      value: safeValue(el).slice(0, 40),
      states: getRelevantAttrs(el)
    })
  }
  lastSnapshot = entries
  lastTextLines = visibleTextLines()
}

export function computeSnapshotDiff(): { success: boolean; error?: string; data?: unknown } {
  if (lastSnapshot.length === 0) {
    return { success: false, error: "no previous snapshot — run 'interceptor tree' first" }
  }

  const oldMap = new Map(lastSnapshot.map(e => [e.refId, e]))
  const current: SnapshotEntry[] = []
  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref()
    if (!el || !el.isConnected) continue
    current.push({
      refId,
      role: getEffectiveRole(el),
      name: getAccessibleName(el),
      value: safeValue(el).slice(0, 40),
      states: getRelevantAttrs(el)
    })
  }
  const newMap = new Map(current.map(e => [e.refId, e]))

  const changes: string[] = []
  for (const [id] of oldMap) {
    if (!newMap.has(id)) changes.push(`- ${id} (removed)`)
  }
  for (const [id, cur] of newMap) {
    const old = oldMap.get(id)
    if (!old) {
      changes.push(`+ ${id} ${cur.role} "${cur.name}" (new)`)
    } else {
      if (old.value !== cur.value) changes.push(`~ ${id} value: "${old.value}" → "${cur.value}"`)
      if (old.states !== cur.states) changes.push(`~ ${id} states: ${old.states} → ${cur.states}`)
      if (old.name !== cur.name) changes.push(`~ ${id} name: "${old.name}" → "${cur.name}"`)
    }
  }

  lastSnapshot = current
  return { success: true, data: changes.length ? changes.join("\n") : "no changes" }
}
