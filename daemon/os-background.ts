// Trusted browser input for a window that is not OS-focused.
//
// The HID tap (os-input.ts) reaches only the frontmost window. When the
// extension's gate reports an active tab in an unfocused window it returns a
// `background` target; this module turns the action into the bridge's
// window-addressed `macos_click` / `macos_type` / `macos_keys`, which name the
// window by its frame and tab title. When the bridge cannot deliver, the
// caller gets the gate's original refusal and hint back.

import { translateCoords } from "./os-input-loader"

export type BackgroundTarget = { title: string; error: string; hint: string; pageHidden?: boolean }

type OsAction = { type?: string; [key: string]: unknown }
type Result = { success: boolean; error?: string; data?: unknown; warning?: string }
type WindowBounds = { left: number; top: number; width: number; height: number }

/** Action types the extension may answer with a `background` target. */
export const BACKGROUND_OS_ACTIONS = new Set(["os_click", "os_type", "os_key"])

const HIDDEN_PAGE_WARNING =
  "the page reports hidden (the browser pauses a window that is fully covered); " +
  "if nothing happened, uncover part of the window and retry"

/** The bridge action for a background os_* action, or null when it lacks what delivery needs. */
export function bridgeActionFor(action: OsAction): Record<string, unknown> | null {
  const target = action.background as BackgroundTarget | undefined
  const windowBounds = action.windowBounds as WindowBounds | undefined
  if (!target || !windowBounds) return null
  const window = { windowTitle: target.title, windowBounds }
  switch (action.type) {
    case "os_click": {
      const pageX = action.pageX as number | undefined
      const pageY = action.pageY as number | undefined
      if (pageX === undefined || pageY === undefined) return null
      const { screenX, screenY } = translateCoords(pageX, pageY, windowBounds, (action.chromeUiHeight as number) || 88)
      return {
        type: "macos_click", coords: `${screenX},${screenY}`,
        right: action.button === "right", double: action.clickCount === 2, ...window,
      }
    }
    case "os_type":
      return typeof action.text === "string" && action.text ? { type: "macos_type", text: action.text, ...window } : null
    case "os_key": {
      if (typeof action.key !== "string" || !action.key) return null
      const modifiers = Array.isArray(action.modifiers) ? action.modifiers as string[] : []
      return { type: "macos_keys", keys: [...modifiers, action.key].join("+"), ...window }
    }
    default:
      return null
  }
}

export async function deliverInBackground(
  action: OsAction,
  bridgeCall: (action: Record<string, unknown>) => Promise<Result>
): Promise<Result> {
  const target = action.background as BackgroundTarget
  const refuse = (reason?: string): Result => ({
    success: false,
    error: reason ? `${target.error} (background delivery was not possible: ${reason})` : target.error,
    data: { hint: target.hint },
  })
  const bridgeAction = bridgeActionFor(action)
  if (!bridgeAction) return refuse()
  const result = await bridgeCall(bridgeAction)
  if (!result.success) return refuse(result.error)
  return {
    success: true,
    data: `delivered in the background, focus unchanged: ${typeof result.data === "string" ? result.data : "ok"}`,
    ...(target.pageHidden ? { warning: HIDDEN_PAGE_WARNING } : {}),
  }
}
