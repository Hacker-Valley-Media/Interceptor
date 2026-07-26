import {
  addTabToInterceptorGroup, ensureInterceptorGroup, interceptorGroupId,
  GROUP_LABEL_RE, ensureNamedGroup, addTabToNamedGroup, labelForGroupId,
  namedGroups, hydrateNamedGroups, groupTitleFor
} from "../tab-group"
import { waitForTabLoad } from "../content-bridge"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

// per-group auto-target key (mirrors message-dispatch's activeTabKey).
function activeTabKey(group?: string): string {
  return group ? `activeTabId:${group}` : "activeTabId"
}

// storage.session is MV3-only (Chrome 102+); the MV2 Electron package shares
// this handler, so fall back to storage.local exactly like message-dispatch.
function sessionArea(): chrome.storage.StorageArea {
  const storage = chrome.storage as typeof chrome.storage & { session?: chrome.storage.StorageArea }
  return storage.session ?? chrome.storage.local
}

// Resolve a normal (groupable) window to birth a new tab in: the focused normal
// window, else the first normal window, else create one. Without an explicit
// windowId, chrome.tabs.create opens in whatever window last had focus — which
// may be a popup, devtools, or app window, and tabs there can't be grouped
// (chrome.tabs.group rejects with "Tabs can only be moved to and from normal
// windows"). Returns undefined when chrome.windows is unavailable (MV2/Electron)
// so the caller falls back to chrome.tabs.create's default placement.
export async function resolveNormalWindowId(focusNew: boolean): Promise<number | undefined> {
  if (!chrome.windows || typeof chrome.windows.getAll !== "function") return undefined
  try {
    const normal = await chrome.windows.getAll({ windowTypes: ["normal"] })
    const existing = normal.find(w => w.focused)?.id ?? normal[0]?.id
    if (existing !== undefined) return existing
    if (typeof chrome.windows.create === "function") {
      const created = await chrome.windows.create({ focused: focusNew })
      return created?.id
    }
  } catch {
    // fall through — let chrome.tabs.create pick a window
  }
  return undefined
}

export async function handleTabActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "tab_create": {
      const targetUrl = (action.url as string) || "about:blank"
      const group = typeof action.group === "string" && action.group.length > 0
        ? action.group
        : undefined
      if (group && !GROUP_LABEL_RE.test(group)) {
        return { success: false, error: `invalid group label '${group}' — must match [A-Za-z0-9_-]{1,32}` }
      }
      // When `reuse` is set, navigate the most recently created tab inside
      // the caller's group (the named group when action.group is set, the
      // default Interceptor group otherwise) instead of opening a new one.
      // Long-running automations would otherwise leave a dead tab behind on
      // every call (dora-cc#5). Group-scoping the candidate query is what
      // keeps one agent's --reuse from hijacking another agent's tab
      // (per-agent isolation). Falls back to creating a new tab if the group is empty
      // or the candidate tab disappeared between query and update.
      if (action.reuse) {
        const groupId = group ? await ensureNamedGroup(group) : await ensureInterceptorGroup()
        if (groupId !== -1) {
          const groupTabs = await chrome.tabs.query({ groupId })
          if (groupTabs.length > 0) {
            const sorted = groupTabs
              .filter(t => typeof t.id === "number")
              .sort((a, b) => (b.id as number) - (a.id as number))
            const candidate = sorted[0]
            if (candidate?.id !== undefined) {
              try {
                // Reuse path: preserve the candidate tab's current
                // active/inactive state by default — navigating a background
                // tab keeps it in the background, a foreground tab stays
                // foreground. Only pass `active: true` when the caller
                // explicitly asked for activation via `action.active`, so
                // `interceptor open <url> --reuse --activate` foregrounds
                // the reused tab on demand without disturbing the user's
                // focus on every routine reuse call.
                const reuseActivate = (action.active as boolean | undefined) === true
                const updateProps: chrome.tabs.UpdateProperties = { url: targetUrl }
                if (reuseActivate) updateProps.active = true
                const updated = await chrome.tabs.update(candidate.id, updateProps)
                await waitForTabLoad(candidate.id)
                // Pin the reused tab as the auto-target for subsequent commands.
                // Mirrors the new-tab path below: every successful tab_create
                // — whether new or reused — must update the (per-group)
                // activeTabId so a fresh CLI invocation (no --tab) routes here
                // instead of a stale id or the user's foreground tab.
                await sessionArea().set({ [activeTabKey(group)]: candidate.id })
                return {
                  success: true,
                  data: { tabId: candidate.id, url: updated?.url ?? targetUrl, groupId, group, reused: true }
                }
              } catch {
                // Tab vanished between query and update — fall through to create.
              }
            }
          }
        }
      }
      // Background-by-default: chrome.tabs.create defaults `active` to true,
      // which steals focus from the user's current tab. Interceptor's surface
      // contract is background-first (mirrors the macOS surface: `open
      // --activate` is the explicit opt-in). Callers pass `action.active:
      // true` only when the new tab is genuinely meant to be foregrounded.
      const shouldActivate = (action.active as boolean | undefined) === true
      // Pin creation to a normal window so the tab is groupable (see
      // resolveNormalWindowId). undefined windowId → chrome.tabs.create's default.
      const targetWindowId = await resolveNormalWindowId(shouldActivate)
      const newTab = await chrome.tabs.create({
        url: targetUrl,
        active: shouldActivate,
        ...(targetWindowId !== undefined ? { windowId: targetWindowId } : {})
      })
      if (newTab.id) {
        const groupId = group
          ? await addTabToNamedGroup(newTab.id, group, action.groupColor)
          : await addTabToInterceptorGroup(newTab.id)
        // Pin the newly-created tab as the auto-target for subsequent commands
        // so a fresh CLI invocation (no --tab) routes to this tab instead of a
        // stale activeTabId or whatever Chrome reports as "active in currentWindow"
        // (which may be the user's foreground tab, not the one we just opened).
        await sessionArea().set({ [activeTabKey(group)]: newTab.id })
        return { success: true, data: { tabId: newTab.id, url: newTab.url, groupId, group, reused: false } }
      }
      return { success: true, data: { tabId: newTab.id, url: newTab.url, reused: false } }
    }

    case "tab_close": {
      const closedId = (action.tabId as number) || tabId
      await chrome.tabs.remove(closedId)
      // If the closed tab was the auto-target, clear it so the next call
      // re-resolves via chrome.tabs.query rather than targeting a dead tab.
      // Checks the caller's per-group key too.
      const keys = ["activeTabId", typeof action.group === "string" ? activeTabKey(action.group) : null]
        .filter((k): k is string => !!k)
      const stored = await sessionArea().get(keys) as Record<string, number | undefined>
      for (const key of keys) {
        if (stored[key] === closedId) await sessionArea().remove(key)
      }
      return { success: true }
    }

    case "tab_switch": {
      // No auto-target write here: the dispatcher's post-gate persist already
      // stored the switch target under the caller's (per-group or global) key;
      // a handler-side global write would clobber the ungrouped key on
      // grouped switches.
      await chrome.tabs.update(action.tabId as number, { active: true })
      return { success: true }
    }

    case "tab_list": {
      const tabs = await chrome.tabs.query({})
      await ensureInterceptorGroup()
      // Hydrate the named-group registry so labelForGroupId can attribute tabs.
      await hydrateNamedGroups()
      const namedIds = new Set(namedGroups.values())
      const tabData = tabs.map(t => ({
        id: t.id, url: t.url, title: t.title, active: t.active,
        windowId: t.windowId, muted: t.mutedInfo?.muted, pinned: t.pinned,
        groupId: t.groupId,
        // managed = default group OR any named group; `group` names the owner.
        managed: (interceptorGroupId !== null && t.groupId === interceptorGroupId) || namedIds.has(t.groupId),
        group: labelForGroupId(t.groupId)
      }))
      return { success: true, data: tabData }
    }

    case "group_list": {
      if (!chrome.tabGroups || typeof chrome.tabGroups.query !== "function") {
        return { success: true, data: [] }
      }
      await ensureInterceptorGroup()
      await hydrateNamedGroups()
      const live = await chrome.tabGroups.query({})
      // Re-adopt named groups the registry lost (e.g. browser restart restored
      // the window): exact match on the brand-composed `<brand>-<label>` title.
      // ponytail: current brand prefix only; a pre-rebrand title is re-adopted on the next brand change
      const prefix = `${groupTitleFor("")}`
      for (const g of live) {
        if (typeof g.title !== "string" || !g.title.startsWith(prefix)) continue
        const label = g.title.slice(prefix.length)
        if (GROUP_LABEL_RE.test(label) && labelForGroupId(g.id) === null && g.id !== interceptorGroupId) {
          await ensureNamedGroup(label)
        }
      }
      const data = await Promise.all(live.map(async g => {
        const groupTabs = await chrome.tabs.query({ groupId: g.id })
        return {
          groupId: g.id,
          title: g.title,
          color: g.color,
          tabCount: groupTabs.length,
          label: labelForGroupId(g.id),
          default: interceptorGroupId !== null && g.id === interceptorGroupId,
          managed: (interceptorGroupId !== null && g.id === interceptorGroupId) || labelForGroupId(g.id) !== null
        }
      }))
      return { success: true, data }
    }

    case "group_close": {
      const label = action.label as string | undefined
      if (!label || !GROUP_LABEL_RE.test(label)) {
        return { success: false, error: `group_close requires a valid label (got '${label ?? ""}')` }
      }
      const groupId = await ensureNamedGroup(label)
      if (groupId === -1) {
        return { success: false, error: `group '${label}' not found` }
      }
      const groupTabs = await chrome.tabs.query({ groupId })
      const ids = groupTabs.map(t => t.id).filter((id): id is number => typeof id === "number")
      // Atomic: ONE tabs.remove over exactly this group's tab ids — the group
      // object auto-deletes at zero tabs, and the tabGroups.onRemoved listener
      // purges the registry entry + per-group auto-target. Nothing outside this
      // id list is touched (issue #124's "3a" isolation guarantee).
      if (ids.length > 0) await chrome.tabs.remove(ids)
      return { success: true, data: { label, groupId, closedTabs: ids.length } }
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
