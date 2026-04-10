import { addTabToSlopGroup, ensureSlopGroup, slopGroupId } from "../tab-group"
import { waitForTabLoad } from "../content-bridge"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleTabActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "tab_create": {
      const newTab = await chrome.tabs.create({ url: (action.url as string) || "about:blank" })
      if (newTab.id) {
        const groupId = await addTabToSlopGroup(newTab.id)
        return { success: true, data: { tabId: newTab.id, url: newTab.url, groupId } }
      }
      return { success: true, data: { tabId: newTab.id, url: newTab.url } }
    }

    case "tab_close":
      await chrome.tabs.remove((action.tabId as number) || tabId)
      return { success: true }

    case "tab_switch":
      await chrome.tabs.update(action.tabId as number, { active: true })
      return { success: true }

    case "tab_list": {
      const tabs = await chrome.tabs.query({})
      await ensureSlopGroup()
      const tabData = tabs.map(t => ({
        id: t.id, url: t.url, title: t.title, active: t.active,
        windowId: t.windowId, muted: t.mutedInfo?.muted, pinned: t.pinned,
        groupId: t.groupId,
        managed: slopGroupId !== null && t.groupId === slopGroupId
      }))
      return { success: true, data: tabData }
    }

    case "tab_duplicate": {
      const dup = await chrome.tabs.duplicate(tabId)
      return { success: true, data: { tabId: dup?.id } }
    }

    case "tab_reload":
      await chrome.tabs.reload(tabId, { bypassCache: !!action.bypassCache })
      await waitForTabLoad(tabId)
      return { success: true }

    case "tab_mute":
      await chrome.tabs.update(tabId, { muted: !!(action.muted ?? true) })
      return { success: true }

    case "tab_pin":
      await chrome.tabs.update(tabId, { pinned: !!(action.pinned ?? true) })
      return { success: true }

    case "tab_zoom_get": {
      const zoom = await chrome.tabs.getZoom(tabId)
      return { success: true, data: { zoom } }
    }

    case "tab_zoom_set":
      await chrome.tabs.setZoom(tabId, action.zoom as number)
      return { success: true }

    case "tab_group": {
      const groupId = await chrome.tabs.group({
        tabIds: tabId,
        groupId: action.groupId as number | undefined
      })
      if (action.title || action.color) {
        await chrome.tabGroups.update(groupId, {
          title: action.title as string | undefined,
          color: action.color as chrome.tabGroups.UpdateProperties["color"]
        })
      }
      return { success: true, data: { groupId } }
    }

    case "tab_ungroup":
      await chrome.tabs.ungroup(tabId)
      return { success: true }

    case "tab_move":
      await chrome.tabs.move(tabId, {
        windowId: action.windowId as number | undefined,
        index: (action.index as number) ?? -1
      })
      return { success: true }

    case "tab_discard":
      await chrome.tabs.discard(tabId)
      return { success: true }
  }
  return { success: false, error: `unknown tab action: ${action.type}` }
}
