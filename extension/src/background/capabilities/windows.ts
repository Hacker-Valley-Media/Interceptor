import { addTabToInterceptorGroup, addTabToNamedGroup, GROUP_LABEL_RE, hydrateNamedGroups, isTabInInterceptorGroup, labelForGroupId, moveNamedGroupToWindow, ungroupBeforeClose } from "../tab-group"

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
// window_close ungroups before it closes. Short, so that step plus the close
// itself still answer inside the CLI's 15 s.
export const WINDOW_CLOSE_PREP_TIMEOUT_MS = 3000

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

// Where a tab lived before detachTab, so returnTab can put it back.
export type TabHome = {
  windowId: number; index: number; active: boolean
  groupId: number; group: string | null; color?: string; managed: boolean
}

/**
 * Gives a tab a new background window of its own. On macOS a hidden tab moved
 * into a window that is already covered keeps its native view hidden, so a click
 * has nothing to land on (WebContentsImpl goes HIDDEN to OCCLUDED and never
 * shows the view). A new window is not covered yet, so the tab shows first and
 * stays hit-testable when the window is covered later. Same size as home, so
 * the page does not reflow.
 */
export async function detachTab(tabId: number): Promise<TabHome> {
  const tab = await chrome.tabs.get(tabId)
  const win = await chrome.windows.get(tab.windowId)
  await hydrateNamedGroups()
  const group = tab.groupId !== -1 ? await chrome.tabGroups.get(tab.groupId).catch(() => null) : null
  const home: TabHome = {
    windowId: tab.windowId, index: tab.index, active: tab.active,
    groupId: tab.groupId, group: labelForGroupId(tab.groupId), color: group?.color,
    managed: await isTabInInterceptorGroup(tabId),
  }
  await withWindowTimeout("os_detach", chrome.windows.create({ tabId, focused: false, width: win.width, height: win.height }))
  return home
}

/**
 * Undoes detachTab. A tab that was alone in its window has no home left and
 * stays put, regrouped. The move can fail while a person is dragging a tab, so
 * the tab keeps its group either way and the caller hears about the move.
 */
export async function returnTab(tabId: number, home: TabHome): Promise<void> {
  const homeWindow = await chrome.windows.get(home.windowId).catch(() => null)
  const moved = homeWindow
    ? await chrome.tabs.move(tabId, { windowId: home.windowId, index: home.index }).then(() => null, (err: Error) => err)
    : null
  if (home.group) await addTabToNamedGroup(tabId, home.group, home.color)
  else if (home.managed) await addTabToInterceptorGroup(tabId)
  else if (home.groupId !== -1) await chrome.tabs.group({ tabIds: [tabId], groupId: home.groupId }).catch(() => {})
  if (moved) throw moved
  if (homeWindow && home.active) await chrome.tabs.update(tabId, { active: true })
}

// A moved tab joins the caller's group only if it already was in it, so
// --any-tab cannot turn someone else's tab into the agent's.
async function adoptsMovedTab(moveTabId: unknown, group: unknown): Promise<boolean> {
  if (typeof moveTabId !== "number") return true
  const tab = await chrome.tabs.get(moveTabId).catch(() => null)
  if (!tab) return false
  await hydrateNamedGroups()
  return typeof group === "string" ? labelForGroupId(tab.groupId) === group : isTabInInterceptorGroup(moveTabId)
}

export async function handleWindowActions(
  action: { type: string; [key: string]: unknown },
  _tabId: number
): Promise<ActionResult> {
  try {
    switch (action.type) {
      case "window_create": {
        const adopts = await adoptsMovedTab(action.moveTabId, action.group)
        const win = await withWindowTimeout(
          "window_create",
          chrome.windows.create({
            tabId: action.moveTabId as number | undefined,
            url: action.url as string | undefined,
            type: (action.windowType as chrome.windows.CreateData["type"]) || "normal",
            width: action.width as number | undefined,
            height: action.height as number | undefined,
            left: action.left as number | undefined,
            top: action.top as number | undefined,
            incognito: !!action.incognito,
            // Background-first like tab_create: only an explicit `--activate`
            // (action.focused === true) takes the user's focus. Chromium's own
            // default is focused (tabs_api.cc WindowsCreateFunction), so the
            // flag has to be sent either way.
            focused: action.focused === true,
          })
        )
        if (!win) return { success: false, error: "window creation returned no window" }
        const firstTab = win.tabs?.[0]
        let groupId: number | undefined
        let groupWarning: string | undefined
        if (firstTab?.id && !action.incognito && adopts) {
          // honor the caller's named group; default group otherwise.
          const group = typeof action.group === "string" && GROUP_LABEL_RE.test(action.group)
            ? action.group
            : undefined
          // A group lives in one window: adding this tab to a group that sits
          // elsewhere pulls the tab there and leaves the new window empty. A
          // named group is the caller's own, so it moves here with its tabs.
          // The shared default group stays put, and the result says so.
          if (group && typeof win.id === "number") await moveNamedGroupToWindow(group, win.id)
          groupId = group
            ? await addTabToNamedGroup(firstTab.id, group, action.groupColor)
            : await addTabToInterceptorGroup(firstTab.id)
          try {
            const landed = await chrome.tabs.get(firstTab.id)
            if (landed.windowId !== win.id) {
              groupWarning = group
                ? `group '${group}' could not be moved, so the tab joined it in window ${landed.windowId} and has no window of its own`
                : `the tab joined the shared default group in window ${landed.windowId}, so it has no window of its own; pass --group <label> to get one`
            }
          } catch {}
        }
        return {
          success: true,
          data: {
            windowId: win.id, groupId, tabs: win.tabs?.map(t => ({ id: t.id, url: t.url })),
            ...(groupWarning ? { groupWarning } : {}),
          },
        }
      }

      case "window_close": {
        const windowId = windowIdFromAction(action)
        if (windowId === undefined) return { success: false, error: "window_close requires a window id" }
        // A window that closes with a managed group inside leaves that group
        // behind as a closed saved group (issue #301). The ungroup is bounded
        // and best effort: a hung or failed tab query must not keep the
        // window open.
        await withWindowTimeout("window_close", (async () => {
          const windowTabs = await chrome.tabs.query({ windowId })
          await ungroupBeforeClose(windowTabs.map(t => t.id).filter((id): id is number => typeof id === "number"))
        })(), WINDOW_CLOSE_PREP_TIMEOUT_MS).catch(() => {})
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
            tabs: w.tabs?.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
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
