import { addTabToInterceptorGroup, addTabToNamedGroup, GROUP_LABEL_RE } from "../tab-group"
import { boundedTabTitle } from "./tabs"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

// chrome.windows.* calls can hang indefinitely in a long-lived MV3 service worker.
// Observed in the field: window_focus / window_resize wedged (never resolved) while
// window_list and tab operations kept working — the daemon/CLI then just timed out at
// 15s with no structured error, looking like a dead tool. A hung `await` never throws,
// so the dispatcher's try/catch can't save it. The fix is two-layered:
//   1. Bound every windows API call with a timeout (turns a hang into a fast reject).
//   2. Wrap the whole handler so it ALWAYS returns a structured ActionResult —
//      a timeout or a throw becomes an honest { success:false, error } the CLI can see.
const WINDOW_OP_TIMEOUT_MS = 8000

export class WindowOperationTimeoutError extends Error {
  constructor(public readonly operation: string, public readonly timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms (service worker may be wedged)`)
    this.name = "WindowOperationTimeoutError"
  }
}

export function withWindowTimeout<T>(
  op: string,
  p: Promise<T>,
  ms = WINDOW_OP_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WindowOperationTimeoutError(op, ms)), ms)
    p.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

function windowIdFromAction(action: { [key: string]: unknown }): number | undefined {
  return typeof action.windowId === "number" && Number.isFinite(action.windowId)
    ? action.windowId
    : undefined
}

function windowUpdateInfoFromAction(action: { [key: string]: unknown }): chrome.windows.UpdateInfo {
  const info: chrome.windows.UpdateInfo = {}
  if (typeof action.width === "number") info.width = action.width
  if (typeof action.height === "number") info.height = action.height
  if (typeof action.left === "number") info.left = action.left
  if (typeof action.top === "number") info.top = action.top
  if (typeof action.state === "string") info.state = action.state as chrome.windows.UpdateInfo["state"]
  return info
}

export async function handleWindowActions(
  action: { type: string; [key: string]: unknown },
  _tabId: number
): Promise<ActionResult> {
  try {
    switch (action.type) {
      case "window_create": {
        const win = await withWindowTimeout(
          "window_create",
          chrome.windows.create({
            url: action.url as string | undefined,
            type: (action.windowType as chrome.windows.CreateData["type"]) || "normal",
            width: action.width as number | undefined,
            height: action.height as number | undefined,
            left: action.left as number | undefined,
            top: action.top as number | undefined,
            incognito: !!action.incognito,
            focused: action.focused !== false,
          })
        )
        if (!win) return { success: false, error: "window creation returned no window" }
        const firstTab = win.tabs?.[0]
        let groupId: number | undefined
        if (firstTab?.id && !action.incognito) {
          // honor the caller's named group; default group otherwise.
          const group = typeof action.group === "string" && GROUP_LABEL_RE.test(action.group)
            ? action.group
            : undefined
          groupId = group
            ? await addTabToNamedGroup(firstTab.id, group, action.groupColor)
            : await addTabToInterceptorGroup(firstTab.id)
        }
        return {
          success: true,
          data: { windowId: win.id, groupId, tabs: win.tabs?.map(t => ({ id: t.id, url: t.url })) },
        }
      }

      case "window_close": {
        const windowId = windowIdFromAction(action)
        if (windowId === undefined) return { success: false, error: "window_close requires a window id" }
        await withWindowTimeout("window_close", chrome.windows.remove(windowId))
        return { success: true }
      }

      case "window_focus": {
        const windowId = windowIdFromAction(action)
        if (windowId === undefined) return { success: false, error: "window_focus requires a window id" }
        await withWindowTimeout(
          "window_focus",
          chrome.windows.update(windowId, { focused: true })
        )
        return { success: true }
      }

      case "window_resize": {
        const targetId =
          windowIdFromAction(action) ??
          (await withWindowTimeout("window_getCurrent", chrome.windows.getCurrent())).id
        if (targetId === undefined) return { success: false, error: "no target window id available" }
        await withWindowTimeout(
          "window_resize",
          chrome.windows.update(targetId, windowUpdateInfoFromAction(action))
        )
        return { success: true }
      }

      case "window_list":
      case "window_get_all": {
        const windows = await withWindowTimeout("window_list", chrome.windows.getAll({ populate: true }))
        return {
          success: true,
          data: windows.map(w => ({
            id: w.id,
            type: w.type,
            state: w.state,
            focused: w.focused,
            width: w.width,
            height: w.height,
            left: w.left,
            top: w.top,
            incognito: w.incognito,
            tabs: w.tabs?.map(t => ({ id: t.id, url: t.url, title: boundedTabTitle(t.title), active: t.active })),
          })),
        }
      }
    }
    return { success: false, error: `unknown window action: ${action.type}` }
  } catch (err) {
    // Never let a hang or throw escape as a non-response — the wedge bug this guards
    // against is exactly "the handler never returned." Always answer with an error.
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
