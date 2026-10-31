import { sendToContentScript } from "../content-bridge"
import { debuggerAttached } from "../cdp"
import { hasTabGroupApi } from "../tab-group"
import { detachTab, returnTab, type TabHome } from "./windows"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number; delivered?: boolean }

type WindowBounds = { left: number; top: number; width: number; height: number }

// What the daemon needs to deliver to a window that is not OS-focused, and
// what to answer when it cannot.
type BackgroundTarget = { title: string; error: string; hint: string; tabId: number }

// Leads with the background-safe paths on purpose: agents follow the first
// suggestion in a hint literally. A `tab switch` in a window the user is
// working in replaces what they are looking at, so the hint moves the agent's
// tabs into their own window before it offers one.
const FOREGROUND_HINT =
  "trusted OS input reaches a tab only when it is the active tab of a window that is not minimized. " +
  "Try synthetic input first (drop --trusted; dispatched events carry the trust marker most sites check). " +
  "If the page really needs an OS click, run `interceptor window new --tab <id>`: it gives the tab its own background window, and a full install then delivers the click there without changing the frontmost app. " +
  "`tab switch` belongs only in that window. Never switch tabs in a window the user is working in."

// Trusted OS events posted to the global HID tap are routed by macOS by
// screen position and window z-order — not by tab. That delivery is only
// correct when the target tab is the visible tab of the OS-focused window;
// anything else lands the event in whatever is frontmost (issue #166:
// coordinates were also derived from chrome.windows.getCurrent(), i.e. the
// last-focused window, not the window owning tabId).
//
// A window that is not OS-focused can still be reached, but not through the
// HID tap: Chromium swallows the first click on an inactive window to
// activate it (RenderWidgetHostViewCocoa acceptsFirstMouse: defaults to
// kWhenInActiveWindow), so the macOS bridge has to address the window by id
// and tell it it has focus first. Only a daemon that can do that sets
// `backgroundOk`; without it this gate refuses, so an older daemon never
// receives a go-ahead it would post to the HID tap.
//
// Always refused: a missing tab or window, a minimized window (no pixels to
// hit), and a tab that is not the active tab of its window (the event would
// reach the visible tab instead).
// A tab that is not showing can still get the event: `moveTabId` tells a daemon
// that can do it to give the tab a window of its own and send the action again.
// An older daemon passes this refusal on unchanged. Safari has no tab groups and
// may ignore `focused: false`, so it keeps the refusal.
async function requireForegroundTab(tabId: number, backgroundOk = false): Promise<
  { ok: true; windowBounds: WindowBounds; background?: BackgroundTarget } | { ok: false; result: ActionResult }
> {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab) {
    return { ok: false, result: { success: false, error: `tab ${tabId} not found` } }
  }
  const win = await chrome.windows.get(tab.windowId).catch(() => null)
  if (!win) {
    return { ok: false, result: { success: false, error: `window ${tab.windowId} not found for tab ${tabId}` } }
  }
  const moveTarget = backgroundOk && hasTabGroupApi() ? { moveTabId: tabId } : {}
  if (win.state === "minimized") {
    return { ok: false, result: {
      success: false,
      delivered: false,
      error: `window ${tab.windowId} is minimized — trusted OS input needs on-screen pixels to hit`,
      data: { hint: FOREGROUND_HINT, windowState: win.state, ...moveTarget }
    } }
  }
  if (!tab.active) {
    return { ok: false, result: {
      success: false,
      delivered: false,
      error: `tab ${tabId} is not the active tab of window ${tab.windowId} — a trusted OS event would hit the window's visible tab instead`,
      data: { hint: FOREGROUND_HINT, ...moveTarget }
    } }
  }
  const windowBounds = {
    left: win.left || 0, top: win.top || 0,
    width: win.width || 0, height: win.height || 0
  }
  if (!win.focused) {
    const error = `window ${tab.windowId} is not the OS-focused window — trusted OS events are routed by the OS to whatever is frontmost, not to the target tab`
    if (!backgroundOk) {
      return { ok: false, result: { success: false, delivered: false, error, data: { hint: FOREGROUND_HINT } } }
    }
    return { ok: true, windowBounds, background: { title: tab.title || "", error, hint: FOREGROUND_HINT, tabId } }
  }
  return { ok: true, windowBounds }
}

// Height of the browser's own UI above the page. The page's real viewport
// height gives it exactly (Brave 81, Chrome 87); the fixed 88 is the fallback
// when the page is zoomed (innerHeight is then in zoomed CSS px), when a
// bottom-docked panel makes the difference implausible, or for x,y clicks
// that never ask the page.
async function chromeUiHeightFor(tabId: number, windowHeight: number, viewportHeight: unknown): Promise<number> {
  const fallback = 88 + (debuggerAttached.has(tabId) ? 35 : 0)
  if (typeof viewportHeight !== "number") return fallback
  let zoom = 1
  try { zoom = await chrome.tabs.getZoom(tabId) } catch { return fallback }
  const fromViewport = windowHeight - viewportHeight
  return zoom === 1 && fromViewport >= 0 && fromViewport <= 200 ? fromViewport : fallback
}

type Rect = { left: number; top: number; width: number; height: number; viewportHeight?: number; pageHidden?: boolean }

// Arms the page's receipt right before a background delivery. False when the
// page could not answer honestly (an iframe under the point, or an older
// content script), and then the result claims nothing either way.
async function armReceipt(tabId: number, frameId?: number, point?: { x: number; y: number }): Promise<boolean> {
  const armed = await sendToContentScript(tabId, { type: "input_watch", ...point }, frameId).catch(() => null) as
    { success: boolean; data?: { armed?: boolean } } | null
  return armed?.success === true && armed.data?.armed === true
}

async function rectIn(tabId: number, query: Record<string, unknown>, frameId?: number): Promise<Rect | null> {
  const result = await sendToContentScript(tabId, { type: "rect", ...query }, frameId) as { success: boolean; data?: Rect }
  return result.success && result.data ? result.data : null
}

// Where an iframe's viewport starts inside the top page. A rect or point from
// inside a frame is relative to that frame, so each ancestor iframe's content
// origin is added. The last answer comes from the top frame, whose viewport
// height and hidden state are the ones the window math needs. null means the
// frame could not be located, and the caller must not click.
async function frameOrigin(tabId: number, frameId: number): Promise<Rect | null> {
  const frames = await chrome.webNavigation?.getAllFrames({ tabId }).catch(() => null) ?? []
  let left = 0
  let top = 0
  let host: Rect | null = null
  for (let id = frameId, hops = 0; id !== 0; hops++) {
    const frame = frames.find(f => f.frameId === id)
    if (!frame || frame.parentFrameId < 0 || hops > 16) return null
    host = await rectIn(tabId, { hostOfFrame: id, hostUrl: frame.url }, frame.parentFrameId)
    if (!host) return null
    left += host.left
    top += host.top
    id = frame.parentFrameId
  }
  return host && { ...host, left, top }
}

export async function handleOsInputActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  const backgroundOk = action.backgroundOk === true
  switch (action.type) {
    case "os_receipt":
      return sendToContentScript(tabId, { type: "input_watch_read" }, action.frameId as number | undefined) as Promise<ActionResult>

    case "os_detach":
      try { return { success: true, data: await detachTab(tabId) } }
      catch (err) { return { success: false, error: (err as Error).message } }

    case "os_return":
      try { await returnTab(tabId, action.home as TabHome); return { success: true } }
      catch (err) { return { success: false, error: (err as Error).message } }

    case "os_click": {
      const fg = await requireForegroundTab(tabId, backgroundOk)
      if (!fg.ok) return fg.result
      const windowBounds = fg.windowBounds
      let pageX = action.x as number | undefined
      let pageY = action.y as number | undefined
      let viewportHeight: unknown
      let pageHidden = false

      // A framed ref (e<frame>_<n>) resolves inside its own iframe. Asking the
      // top frame for it returned a different element with the same number.
      const frameId = typeof action.frameId === "number" ? action.frameId : 0
      const origin = frameId !== 0 ? await frameOrigin(tabId, frameId) : null
      if (frameId !== 0 && !origin) {
        return {
          success: false,
          error: `could not locate iframe ${frameId} in the page, so nothing was clicked. ` +
            "Click by screen point instead: 'interceptor macos click X,Y --app <browser> --window <id>'"
        }
      }

      if ((action.index !== undefined || action.ref) && (pageX === undefined || pageY === undefined)) {
        const rect = await rectIn(tabId, { index: action.index, ref: action.ref }, frameId || undefined)
        if (!rect) {
          return { success: false, error: "failed to get element coordinates for os_click" }
        }
        pageX = rect.left + rect.width / 2
        pageY = rect.top + rect.height / 2
        viewportHeight = rect.viewportHeight
        pageHidden = rect.pageHidden === true
      }

      if (pageX === undefined || pageY === undefined) {
        return { success: false, error: "os_click requires element target or x,y coordinates" }
      }
      if (origin) {
        pageX += origin.left
        pageY += origin.top
        viewportHeight = origin.viewportHeight
        pageHidden = origin.pageHidden === true
      }

      const chromeUiHeight = (action.chromeUiHeight as number) ||
        await chromeUiHeightFor(tabId, windowBounds.height, viewportHeight)
      // Inside its own frame the event needs no point check: the ref already
      // named the document that will hear it.
      const watching = fg.background
        ? await armReceipt(tabId, frameId || undefined, origin ? undefined : { x: pageX, y: pageY })
        : false
      return {
        success: true,
        data: {
          method: "os_event",
          screenTarget: { pageX, pageY },
          windowBounds,
          button: action.button || "left",
          clickCount: action.clickCount || 1,
          chromeUiHeight,
          ...(fg.background ? { background: { ...fg.background, pageHidden, watching, frameId } } : {})
        }
      }
    }

    case "os_key": {
      // Keyboard CGEvents go to the focused app's key window; if the target
      // tab isn't foreground the combo leaks into another app (issue #166)
      // unless the bridge addresses the window.
      const fg = await requireForegroundTab(tabId, backgroundOk)
      if (!fg.ok) return fg.result
      // The browser keeps its own shortcuts (⌘T, ⌘W) from the page, so silence
      // proves nothing for a chord and the action must not be sent twice.
      const chord = ((action.modifiers as string[] | undefined) ?? []).some(m => /^(cmd|command|meta|ctrl|control)$/i.test(m))
      const watching = fg.background && !chord ? await armReceipt(tabId) : false
      return { success: true, data: {
        method: "os_event", key: action.key, modifiers: action.modifiers || [],
        ...(fg.background ? { background: { ...fg.background, watching }, windowBounds: fg.windowBounds } : {})
      } }
    }

    case "os_type": {
      const fg = await requireForegroundTab(tabId, backgroundOk)
      if (!fg.ok) return fg.result
      // A framed target lives in its own frame; the top frame has a different
      // element under the same ref or index.
      const frameId = (action.ref || action.index !== undefined) && typeof action.frameId === "number" ? action.frameId : undefined
      if (action.index !== undefined || action.ref || action.sensitive === true) {
        const focused = await sendToContentScript(tabId, {
          type: "focus", index: action.index, ref: action.ref,
          sensitive: action.sensitive, focused: action.index === undefined && !action.ref
        }, frameId) as ActionResult
        if (!focused.success) return focused
        await new Promise(r => setTimeout(r, 50))
      }
      const watching = fg.background ? await armReceipt(tabId, frameId) : false
      return { success: true, data: {
        method: "os_event", text: action.text,
        ...(fg.background ? { background: { ...fg.background, watching, frameId }, windowBounds: fg.windowBounds } : {})
      } }
    }

    case "os_move": {
      // Pointer paths stay foreground-only: the bridge has no addressed
      // equivalent for a free-running move.
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
