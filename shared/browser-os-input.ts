import type { DesktopHello } from "./desktop-contract"

export type OsInputOperation = { available: boolean; foreground: boolean; background: boolean; reason?: string }
export type OsInputSupport = Record<"click" | "key" | "type" | "move", OsInputOperation>

export function unavailableOsInput(reason: string): OsInputSupport {
  return Object.fromEntries(["click", "key", "type", "move"].map(key => [key, { available: false, foreground: false, background: false, reason }])) as OsInputSupport
}

/** Validate explicit metadata; the extension handles older-daemon compatibility. */
export function osInputSupport(value: unknown): OsInputSupport {
  const result = unavailableOsInput("The daemon did not report qualified OS input support; install the matching current package")
  if (!value || typeof value !== "object") return result
  for (const key of ["click", "key", "type", "move"] as const) {
    const op = (value as OsInputSupport)[key]
    if (op && typeof op.available === "boolean" && typeof op.foreground === "boolean" && typeof op.background === "boolean") {
      result[key] = op.available && (op.foreground || op.background)
        ? { available: true, foreground: op.foreground, background: op.background, ...(typeof op.reason === "string" && op.reason ? { reason: op.reason } : {}) }
        : { available: false, foreground: false, background: false, reason: typeof op.reason === "string" && op.reason ? op.reason : "No qualified input route" }
    }
  }
  return result
}

export function nativeOsInputSupport(platform: string, hello?: DesktopHello, failure?: string): OsInputSupport {
  const result = unavailableOsInput(failure || "The Full native input provider is unavailable")
  if (platform === "linux") return unavailableOsInput("Linux browser OS input is unavailable in 2.1.12: native window identity was not qualified in the tested desktop session; use synthetic input")
  if (!hello || hello.host !== platform || !hello.session || ["0", "none"].includes(hello.session)) return result
  const capability = (name: string) => hello.capabilities.find(c => c.operation === name)
  for (const [op, native] of [["click", "click"], ["key", "keys"], ["type", "type"]] as const) {
    const cap = capability(native)
    const qualified = platform === "win32"
    if (qualified && cap?.compiled && cap.present && cap.effective && ["granted", "not_applicable"].includes(cap.permission)) {
      result[op] = { available: true, foreground: true, background: false, reason: "Windows browser input is qualified only in the foreground; covered-window messages produced no page events" }
    } else result[op].reason = !qualified ? "No qualified native input backend for this session" : cap?.reason || result[op].reason
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
