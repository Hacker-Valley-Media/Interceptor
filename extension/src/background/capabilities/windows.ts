import { addTabToInterceptorGroup } from "../tab-group"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleWindowActions(
  action: { type: string; [key: string]: unknown },
  _tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "window_create": {
      const win = await chrome.windows.create({
        url: action.url as string | undefined,
        type: (action.windowType as chrome.windows.CreateData["type"]) || "normal",
        width: action.width as number | undefined,
        height: action.height as number | undefined,
        left: action.left as number | undefined,
        top: action.top as number | undefined,
        incognito: !!action.incognito,
        focused: action.focused !== false
      })
      if (!win) return { success: false, error: "window creation returned no window" }
      const firstTab = win.tabs?.[0]
      let groupId: number | undefined
      if (firstTab?.id && !action.incognito) {
        groupId = await addTabToInterceptorGroup(firstTab.id)
      }
      return {
        success: true,
        data: { windowId: win.id, groupId, tabs: win.tabs?.map(t => ({ id: t.id, url: t.url })) }
      }
    }

    case "window_close":
      await chrome.windows.remove(action.windowId as number)
      return { success: true }

    case "window_focus":
      await chrome.windows.update(action.windowId as number, { focused: true })
      return { success: true }

    case "window_resize": {
      const targetId = (action.windowId as number) || (await chrome.windows.getCurrent()).id
      if (targetId === undefined) return { success: false, error: "no target window id available" }
      await chrome.windows.update(targetId, {
        width: action.width as number | undefined,
        height: action.height as number | undefined,
        left: action.left as number | undefined,
        top: action.top as number | undefined,
        state: action.state as chrome.windows.UpdateInfo["state"]
      })
      return { success: true }
    }

    case "window_list":
    case "window_get_all": {
      const windows = await chrome.windows.getAll({ populate: true })
      return {
        success: true,
        data: windows.map(w => ({
          id: w.id, type: w.type, state: w.state, focused: w.focused,
          width: w.width, height: w.height, left: w.left, top: w.top,
          incognito: w.incognito,
          tabs: w.tabs?.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active }))
        }))
      }
    }
  }
  return { success: false, error: `unknown window action: ${action.type}` }
}
