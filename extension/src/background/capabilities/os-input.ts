import { sendToContentScript } from "../content-bridge"
import { debuggerAttached } from "../cdp"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleOsInputActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "os_click": {
      const win = await chrome.windows.getCurrent()
      const windowBounds = {
        left: win.left || 0, top: win.top || 0,
        width: win.width || 0, height: win.height || 0
      }
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

    case "os_key":
      return { success: true, data: { method: "os_event", key: action.key, modifiers: action.modifiers || [] } }

    case "os_type": {
      if (action.index !== undefined || action.ref) {
        await sendToContentScript(tabId, { type: "focus", index: action.index, ref: action.ref })
        await new Promise(r => setTimeout(r, 50))
      }
      return { success: true, data: { method: "os_event", text: action.text } }
    }

    case "os_move": {
      const win = await chrome.windows.getCurrent()
      const windowBounds = {
        left: win.left || 0, top: win.top || 0,
        width: win.width || 0, height: win.height || 0
      }
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
