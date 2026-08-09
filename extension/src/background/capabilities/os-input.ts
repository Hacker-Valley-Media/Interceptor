import { sendToContentScript } from "../content-bridge"
import { debuggerAttached } from "../cdp"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

type WindowBounds = { left: number; top: number; width: number; height: number }

const FOREGROUND_HINT =
  "trusted OS input needs the target tab visible in the OS-focused window — " +
  "`interceptor tab switch <id>` foregrounds it (explicit focus-moving opt-in), " +
  "or drop --trusted for background-safe synthetic input"

// Trusted OS events are posted to the global HID tap, which macOS routes by
// screen position and window z-order — not by tab. Delivery is only correct
// when the target tab is the visible tab of the OS-focused window; anything
// else lands the event in whatever is frontmost (issue #166: coordinates were
// also derived from chrome.windows.getCurrent(), i.e. the last-focused window,
// not the window owning tabId). Chromium itself swallows the first click on an
// inactive window to activate it (RenderWidgetHostViewCocoa acceptsFirstMouse:
// defaults to kWhenInActiveWindow), so background delivery cannot work —
// refuse loudly instead of writing into the wrong app.
async function requireForegroundTab(tabId: number): Promise<
  { ok: true; windowBounds: WindowBounds } | { ok: false; result: ActionResult }
> {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab) {
    return { ok: false, result: { success: false, error: `tab ${tabId} not found` } }
  }
  const win = await chrome.windows.get(tab.windowId).catch(() => null)
  if (!win) {
    return { ok: false, result: { success: false, error: `window ${tab.windowId} not found for tab ${tabId}` } }
  }
  if (win.state === "minimized") {
    return { ok: false, result: {
      success: false,
      error: `window ${tab.windowId} is minimized — trusted OS input needs on-screen pixels to hit`,
      data: { hint: FOREGROUND_HINT, windowState: win.state }
    } }
  }
  if (!tab.active) {
    return { ok: false, result: {
      success: false,
      error: `tab ${tabId} is not the active tab of window ${tab.windowId} — a trusted OS event would hit the window's visible tab instead`,
      data: { hint: FOREGROUND_HINT }
    } }
  }
  if (!win.focused) {
    return { ok: false, result: {
      success: false,
      error: `window ${tab.windowId} is not the OS-focused window — trusted OS events are routed by the OS to whatever is frontmost, not to the target tab`,
      data: { hint: FOREGROUND_HINT }
    } }
  }
  return { ok: true, windowBounds: {
    left: win.left || 0, top: win.top || 0,
    width: win.width || 0, height: win.height || 0
  } }
}

export async function handleOsInputActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "os_click": {
      const fg = await requireForegroundTab(tabId)
      if (!fg.ok) return fg.result
      const windowBounds = fg.windowBounds
      let pageX = action.x as number | undefined
      let pageY = action.y as number | undefined

      if ((action.index !== undefined || action.ref) && (pageX === undefined || pageY === undefined)) {
        const rectResult = await sendToContentScript(tabId, {
          type: "rect", index: action.index, ref: action.ref
        }) as { success: boolean; data?: { left: number; top: number; width: number; height: number } }
        if (!rectResult.success || !rectResult.data) {
          return { success: false, error: "failed to get element coordinates for os_click" }
        }
        const rect = rectResult.data
        pageX = rect.left + rect.width / 2
        pageY = rect.top + rect.height / 2
      }

      if (pageX === undefined || pageY === undefined) {
        return { success: false, error: "os_click requires element target or x,y coordinates" }
      }

      const chromeUiHeight = (action.chromeUiHeight as number) ||
        (88 + (debuggerAttached.has(tabId) ? 35 : 0))
      return {
        success: true,
        data: {
          method: "os_event",
          screenTarget: { pageX, pageY },
          windowBounds,
          button: action.button || "left",
          clickCount: action.clickCount || 1,
          chromeUiHeight
        }
      }
    }

    case "os_key": {
      // Keyboard CGEvents go to the focused app's key window; if the target
      // tab isn't foreground the combo leaks into another app (issue #166).
      const fg = await requireForegroundTab(tabId)
      if (!fg.ok) return fg.result
      return { success: true, data: { method: "os_event", key: action.key, modifiers: action.modifiers || [] } }
    }

    case "os_type": {
      const fg = await requireForegroundTab(tabId)
      if (!fg.ok) return fg.result
      if (action.index !== undefined || action.ref) {
        await sendToContentScript(tabId, { type: "focus", index: action.index, ref: action.ref })
        await new Promise(r => setTimeout(r, 50))
      }
      return { success: true, data: { method: "os_event", text: action.text } }
    }

    case "os_move": {
      const fg = await requireForegroundTab(tabId)
      if (!fg.ok) return fg.result
      const windowBounds = fg.windowBounds
      const chromeUiHeight = (action.chromeUiHeight as number) ||
        (88 + (debuggerAttached.has(tabId) ? 35 : 0))
      return {
        success: true,
        data: {
          method: "os_event",
          path: action.path,
          windowBounds,
          duration: action.duration || 100,
          chromeUiHeight
        }
      }
    }
  }
  return { success: false, error: `unknown os_input action: ${action.type}` }
}
