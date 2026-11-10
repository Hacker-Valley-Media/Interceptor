import { dlopen, FFIType } from "bun:ffi"
import type { DesktopHello } from "../shared/desktop-contract"
import { darwinOsInputSupport, nativeOsInputSupport, unavailableOsInput, type OsInputSupport } from "../shared/browser-os-input"
import { callDesktopProvider } from "./desktop-provider"

const cg = process.platform === "darwin" ? dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
  CGPreflightPostEventAccess: { args: [], returns: FFIType.bool },
}) : undefined

export async function darwinOsInputWithTrust(foreground: boolean, trust?: Promise<{ success: boolean; data?: unknown }>): Promise<OsInputSupport> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = trust ? await Promise.race([
    trust.catch(() => undefined),
    new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 600) }),
  ]).finally(() => clearTimeout(timer)) : undefined
  return darwinOsInputSupport(foreground, result?.success === true && (result.data as { accessibility?: string })?.accessibility === "granted")
}

export async function browserOsInputSupport(full: boolean, bridge: (action: Record<string, unknown>) => Promise<{ success: boolean; data?: unknown }>): Promise<OsInputSupport> {
  if (process.platform !== "darwin") {
    if (!full) return unavailableOsInput("Trusted browser input requires a Full install and its native provider")
    const result = await callDesktopProvider({ type: "desktop_capabilities" }, 1000)
    return nativeOsInputSupport(process.platform, result.success ? result.data as DesktopHello : undefined, result.error)
  }
  const foreground = cg?.symbols.CGPreflightPostEventAccess() === true
  return darwinOsInputWithTrust(foreground, full ? bridge({ type: "macos_trust", noPrompt: true }) : undefined)
}
