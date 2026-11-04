/** Validated arguments shared by the CLI and native iOS runner dispatch. */
export const IOS_AUTOMATION_OPS = new Set(["capabilities", "element", "key", "device", "audit", "authorization", "voiceover"])
export const IOS_PERMISSION_RESOURCES = ["contacts", "calendar", "reminders", "photos", "microphone", "camera", "media-library", "homekit", "focus", "local-network", "bluetooth", "location", "health", "tracking"] as const
export type IosNativeTarget = { bundleId: string; identifier: string; label: string; type: number; rect?: { x: number; y: number; width: number; height: number } }

export function validateIosAutomation(a: Record<string, unknown>): string | undefined {
  const op = a.op
  if (typeof op !== "string" || !IOS_AUTOMATION_OPS.has(op)) return "unknown native iOS operation"
  const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
  if (a.bundleId !== undefined && !text(a.bundleId)) return "--app requires a bundle identifier"
  if (op === "element") {
    if (!text(a.ref)) return "element requires a ref from ios tree"
    if (!["tap", "double-tap", "two-finger-tap", "swipe", "pinch", "rotate", "reveal", "slider", "picker"].includes(String(a.action))) return "element action must be tap|double-tap|two-finger-tap|swipe|pinch|rotate|reveal|slider|picker"
    if (a.action === "swipe" && !["up", "down", "left", "right"].includes(String(a.value))) return "swipe requires up|down|left|right (finger direction)"
    if (["swipe", "pinch", "rotate"].includes(String(a.action)) && (!finite(a.velocity) || a.velocity <= 0 || a.velocity > 10000)) return "velocity must be greater than 0 and at most 10000"
    if (a.action === "pinch" && (!finite(a.value) || a.value <= 0 || a.value > 10)) return "pinch scale must be greater than 0 and at most 10"
    if (a.action === "rotate" && (!finite(a.value) || Math.abs(a.value) > Math.PI * 4)) return "rotation must be finite radians between -4pi and 4pi"
    if (a.action === "slider" && (!finite(a.value) || a.value < 0 || a.value > 1)) return "slider position must be 0 to 1"
    if (a.action === "picker" && !text(a.value)) return "picker requires an exact value"
  }
  if (op === "key") {
    if (!text(a.key) || !(/^.$/u.test(a.key) || ["enter", "return", "tab", "delete", "backspace", "escape", "up", "down", "left", "right", "home", "end", "space"].includes(a.key.toLowerCase()))) return "key requires one character or Enter|Tab|Delete|Escape|Up|Down|Left|Right|Home|End|Space"
    if (!Array.isArray(a.modifiers) || a.modifiers.some(m => !["command", "shift", "control", "option"].includes(m))) return "modifiers must be command,shift,control,option"
  }
  if (op === "device") {
    if (!["open", "appearance", "orientation", "location", "siri", "present"].includes(String(a.action))) return "device requires open|appearance|orientation|location|siri|present"
    if (a.action === "open") {
      if (!text(a.value) || /[\s\x00-\x1f]/.test(a.value)) return "open requires an absolute URL"
      try { if (!new URL(a.value).protocol) return "open requires an absolute URL" } catch { return "open requires an absolute URL" }
    }
    if (a.action === "appearance" && !["light", "dark", "unspecified"].includes(String(a.value))) return "appearance requires light|dark|unspecified"
    if (a.action === "orientation" && !["portrait", "portrait-upside-down", "landscape-left", "landscape-right"].includes(String(a.value))) return "orientation requires portrait|portrait-upside-down|landscape-left|landscape-right"
    if (a.action === "siri" && !text(a.value)) return "siri requires recognition text"
    if (a.action === "location" && a.value !== "clear" && (!finite(a.lat) || Math.abs(a.lat) > 90 || !finite(a.lon) || Math.abs(a.lon) > 180)) return "location requires latitude -90..90 and longitude -180..180, or clear"
  }
  if (op === "authorization" && (a.action !== "reset" || !text(a.bundleId) || !(IOS_PERMISSION_RESOURCES as readonly unknown[]).includes(a.value))) return `authorization reset requires an app bundle and resource: ${IOS_PERMISSION_RESOURCES.join("|")}`
  if (op === "voiceover" && !["status", "enable", "disable", "next", "previous", "in", "out", "speech"].includes(String(a.action))) return "voiceover requires status|enable|disable|next|previous|in|out|speech"
}
