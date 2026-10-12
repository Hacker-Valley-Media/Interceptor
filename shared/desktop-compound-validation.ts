/** Generated shape checks run before these operation/identity comparisons. */
export function desktopCompoundResultError(action: Record<string, unknown>, data: unknown): string | undefined {
  if (!["desktop_read", "desktop_act", "desktop_inspect_app", "desktop_open"].includes(String(action.type))) return
  const result = data as Record<string, unknown>
  if (action.type === "desktop_act") {
    if (result.ref !== action.ref || result.action !== (action.text === undefined ? "clicked" : "typed")) return "compound action result does not match its request"
    return
  }
  const single = action.type === "desktop_read" || action.type === "desktop_open"
  const identity = single ? { pid: result.pid, name: result.app } : result.target as Record<string, unknown>
  const front = single ? null : result.frontmost as Record<string, unknown> | null
  if (front && (!Number.isSafeInteger(front.pid) || Number(front.pid) < 1 || Number(front.pid) > 0x7fffffff)) return "invalid compound frontmost identity"
  const rows = single ? [identity] : [identity, ...result.apps as Record<string, unknown>[]]
  const seen = new Set<number>()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!Number.isSafeInteger(row.pid) || Number(row.pid) < 1 || Number(row.pid) > 0x7fffffff) return "invalid compound process identity"
    if (i > 0 && seen.has(Number(row.pid))) return "duplicate compound application identity"
    if (i > 0) seen.add(Number(row.pid))
    const unknown = row.unknownFields as string[] | undefined
    if (unknown && (new Set(unknown).size !== unknown.length || unknown.some(key => !["bundleId", "isActive", "isHidden"].includes(key) || row[key] !== undefined))) return "compound unknown fields conflict with its metadata"
  }
  if (action.pid !== undefined && identity.pid !== action.pid) return "compound result does not match its requested process"
  if (action.type === "desktop_open") {
    const ids = new Set<string>()
    for (const window of result.windows as Record<string, unknown>[]) {
      if (window.windowId !== undefined) {
        const id = String(window.windowId)
        if (!/^[1-9]\d{0,19}$/.test(id) || BigInt(id) > 0xffffffffffffffffn || ids.has(id)) return "invalid or duplicate compound window identity"
        ids.add(id)
      }
      if (window.ref !== undefined && !/^e\d{1,63}$/.test(String(window.ref))) return "invalid compound window reference"
      if ((window.referenceError === undefined) !== (window.referenceErrorCode === undefined) || (window.ref !== undefined && window.referenceError !== undefined)) return "compound window reference failure conflicts with its reference"
      if (window.frame !== undefined) {
        const frame = window.frame as Record<string, number>
        if (Object.values(frame).some(value => !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) || frame.width < 0 || frame.height < 0) return "invalid compound window frame"
      }
    }
  }
}
