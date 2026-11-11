import type { OsInputSupport } from "../../shared/browser-os-input"

// A qualified peer for tests of the separate tab/window/ref gates.
export const QUALIFIED_OS_INPUT: OsInputSupport = {
  click: { available: true, foreground: true, background: true },
  key: { available: true, foreground: true, background: true },
  type: { available: true, foreground: true, background: true },
  move: { available: true, foreground: true, background: false },
}
