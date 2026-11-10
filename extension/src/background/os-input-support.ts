import { darwinOsInputSupport, osInputSupport, unavailableOsInput, type OsInputSupport } from "../../../shared/browser-os-input"

/** Store extensions can update before the installed daemon. */
export async function extensionOsInputSupport(value: unknown): Promise<OsInputSupport> {
  if (value !== undefined) return osInputSupport(value)
  const platform = await chrome.runtime.getPlatformInfo?.().catch(() => undefined)
  if (platform?.os !== "mac") return unavailableOsInput("The installed daemon predates native browser input; install the matching current Full package")
  const support = darwinOsInputSupport(true, false)
  for (const operation of Object.values(support)) operation.reason = "Legacy macOS daemon; per-operation support was not reported"
  return support
}
