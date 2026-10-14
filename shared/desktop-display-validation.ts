import {DESKTOP_DISPLAY_MAX_COUNT} from "./desktop-contract"

/** Shape validation precedes these display identity/geometry checks. */
export function desktopDisplayResultError(action: Record<string, unknown>, data: unknown): string | undefined {
  if (action.type !== "desktop_display_list" && action.type !== "desktop_display_info") return
  const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max
  const rows = action.type === "desktop_display_list" ? data as Record<string, unknown>[] : [data as Record<string, unknown>]
  if (rows.length > DESKTOP_DISPLAY_MAX_COUNT) return "display count exceeds its bound"
  const ids = new Set<number>()
  let main = 0
  for (const row of rows) {
    if (!integer(row.id, 1) || ids.has(Number(row.id))) return "invalid or duplicate native display identity"
    ids.add(Number(row.id)); if (row.isMain === true) main++
    if (!integer(row.width, 1, 0x7fffffff) || !integer(row.height, 1, 0x7fffffff)) return "invalid display dimensions"
    if (action.type === "desktop_display_list") {
      if (!integer(row.x, -0x80000000, 0x7fffffff) || !integer(row.y, -0x80000000, 0x7fffffff)) return "invalid display origin"
    } else {
      if (row.id !== action.id) return "display info does not match its requested identity"
      if (!integer(row.pixelWidth, 1, 0x7fffffff) || !integer(row.pixelHeight, 1, 0x7fffffff)) return "invalid display pixel dimensions"
      if (row.refreshRate !== undefined && (Number(row.refreshRate) < 0 || Number(row.refreshRate) > 1000)) return "invalid display refresh rate"
      if (row.rotation !== undefined && ![0, 90, 180, 270].includes(Number(row.rotation))) return "invalid display rotation"
    }
    const unknown = row.unknownFields as string[] | undefined
    if (unknown && (new Set(unknown).size !== unknown.length || unknown.some(key => !["isMain", "isVirtual", "isBuiltin", "rotation", "refreshRate"].includes(key) || row[key] !== undefined))) return "display unknown fields conflict with its metadata"
    for (const key of action.type === "desktop_display_list" ? ["isMain", "isVirtual"] : ["isMain"]) {
      if (row[key] === undefined && !unknown?.includes(key)) return "display classification is absent without an explicit unknown field"
    }
  }
  if (main > 1) return "multiple displays claim primary identity"
}
