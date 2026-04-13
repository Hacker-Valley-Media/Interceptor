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

export function cacheSnapshot() {
  const entries: SnapshotEntry[] = []
  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref()
    if (!el || !el.isConnected) continue
    entries.push({
      refId,
      role: getEffectiveRole(el),
      name: getAccessibleName(el),
      value: ((el as HTMLInputElement).value || "").slice(0, 40),
      states: getRelevantAttrs(el)
    })
  }
  lastSnapshot = entries
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
      value: ((el as HTMLInputElement).value || "").slice(0, 40),
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
