import type { DesktopHello } from "./desktop-contract"

export type OsInputOperation = { available: boolean; foreground: boolean; background: boolean; reason?: string }
export type OsInputSupport = Record<"click" | "key" | "type" | "move", OsInputOperation>

export function unavailableOsInput(reason: string): OsInputSupport {
  return Object.fromEntries(["click", "key", "type", "move"].map(key => [key, { available: false, foreground: false, background: false, reason }])) as OsInputSupport
}

/** Missing metadata from an older daemon never admits input. */
export function osInputSupport(value: unknown): OsInputSupport {
  const result = unavailableOsInput("The daemon did not report qualified OS input support; install the matching current package")
  if (!value || typeof value !== "object") return result
  for (const key of ["click", "key", "type", "move"] as const) {
    const op = (value as OsInputSupport)[key]
    if (op && typeof op.available === "boolean" && typeof op.foreground === "boolean" && typeof op.background === "boolean") {
      result[key] = op.available && (op.foreground || op.background)
        ? { available: true, foreground: op.foreground, background: op.background }
        : { available: false, foreground: false, background: false, reason: typeof op.reason === "string" && op.reason ? op.reason : "No qualified input route" }
    }
  }
  return result
}

export function nativeOsInputSupport(platform: string, hello?: DesktopHello, failure?: string): OsInputSupport {
  const result = unavailableOsInput(failure || "The Full native input provider is unavailable")
  if (!hello || hello.host !== platform || !hello.session || ["0", "none"].includes(hello.session)) return result
  const capability = (name: string) => hello.capabilities.find(c => c.operation === name)
  const keys = capability("keys")
  const pointer = capability("scroll")
  const x11 = platform === "linux" && keys?.effective && pointer?.effective && keys.provider.startsWith("X11.")
  const hyprland = platform === "linux" && keys?.effective && pointer?.effective && keys.provider.startsWith("Hyprland.") && pointer.provider.startsWith("Hyprland/")
  for (const [op, native] of [["click", "click"], ["key", "keys"], ["type", "type"]] as const) {
    const cap = capability(native)
    const qualified = platform === "win32" || x11 || hyprland
    if (qualified && cap?.compiled && cap.present && cap.effective && ["granted", "not_applicable"].includes(cap.permission)) {
      result[op] = { available: true, foreground: true, background: true }
    } else result[op].reason = !qualified ? pointer?.reason || "No qualified native input backend for this session" : cap?.reason || result[op].reason
  }
  result.move.reason = "No safe pointer-path route in the native browser input provider"
  return result
}

export function darwinOsInputSupport(foreground: boolean, background: boolean): OsInputSupport {
  const result = unavailableOsInput("OS input permission is unavailable; check macos trust without prompting")
  for (const key of ["click", "key", "type"] as const) {
    if (foreground || background) result[key] = { available: true, foreground, background }
  }
  if (foreground) result.move = { available: true, foreground: true, background: false }
  return result
}
