import { getTabGroupTitle, getTabGroupColor, getCandidateTitles, normalizeColor, VALID_COLORS, type TabGroupColor } from "./brand-tab-group"

export let interceptorGroupId: number | null = null

function hasTabGroupApi(): boolean {
  return !!chrome.tabGroups && typeof chrome.tabGroups.query === "function"
}

/**
 * True when a tab lives in a normal (groupable) window. Tab groups are
 * window-scoped and chrome.tabs.group rejects with "Tabs can only be moved to
 * and from normal windows" for popup/devtools/app windows. Grouping is a UX
 * nicety, not a hard requirement — so when we can't confirm a normal window
 * (lookup throws, or chrome.windows is unavailable in MV2/Electron) we assume
 * groupable and let the guarded chrome.tabs.group call be the final arbiter.
 */
async function isTabInNormalWindow(tabId: number): Promise<boolean> {
  if (!chrome.windows || typeof chrome.windows.get !== "function") return true
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.windowId === undefined) return true
    const win = await chrome.windows.get(tab.windowId)
    return win.type === undefined || win.type === "normal"
  } catch {
    return true
  }
}

// --- Named per-agent groups ------------------------------------------------
// Registry of label -> live groupId, mirrored to chrome.storage.session
// ("namedTabGroups"). session lifetime matches tab-group-id lifetime exactly:
// both survive SW restarts and both die on browser restart, so the registry
// can never resurrect a stale-but-valid-looking id.

export const GROUP_LABEL_RE = /^[A-Za-z0-9_-]{1,32}$/
const SESSION_NAMED_GROUPS_KEY = "namedTabGroups"

export const namedGroups = new Map<string, number>()
let namedGroupsHydrated = false

function sessionArea(): chrome.storage.StorageArea | undefined {
  const storage = chrome.storage as typeof chrome.storage & { session?: chrome.storage.StorageArea }
  return storage.session
}

export async function hydrateNamedGroups(): Promise<void> {
  if (namedGroupsHydrated) return
  namedGroupsHydrated = true
  try {
    const area = sessionArea()
    if (!area) return
    const stored = (await area.get(SESSION_NAMED_GROUPS_KEY)) as Record<string, unknown>
    const raw = stored?.[SESSION_NAMED_GROUPS_KEY]
    if (raw && typeof raw === "object") {
      for (const [label, gid] of Object.entries(raw as Record<string, unknown>)) {
        if (GROUP_LABEL_RE.test(label) && typeof gid === "number") namedGroups.set(label, gid)
      }
    }
  } catch {}
}

async function persistNamedGroups(): Promise<void> {
  try {
    const area = sessionArea()
    if (!area) return
    await area.set({ [SESSION_NAMED_GROUPS_KEY]: Object.fromEntries(namedGroups) })
  } catch {}
}

/** Tab-strip title for a named group, composed with the runtime brand title. */
export function groupTitleFor(label: string): string {
  return `${getTabGroupTitle()}-${label}`
}

/**
 * Deterministic color for a label: stable across restarts so an agent's group
 * keeps its color. Plain string hash into the closed Chrome color enum.
 */
// ponytail: label-hash can collide with the brand color; acceptable — groupColor overrides
export function colorForLabel(label: string): TabGroupColor {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0
  return VALID_COLORS[h % VALID_COLORS.length]
}

async function purgeNamedGroupEntry(label: string): Promise<void> {
  namedGroups.delete(label)
  await persistNamedGroups()
  try {
    const area = sessionArea()
    if (area) await area.remove(`activeTabId:${label}`)
  } catch {}
}

/**
 * Resolve a named group's live id: registry id (validated) first, then exact-title
 * re-discovery over query({}) — NEVER query({title}) which is pattern-matching per
 * the tabGroups docs and would collide "…-ai1" with "…-ai134". Returns -1 when the
 * group does not exist (creation happens in addTabToNamedGroup — Chrome cannot
 * create an empty group).
 */
export async function ensureNamedGroup(label: string): Promise<number> {
  if (!hasTabGroupApi()) return -1
  await hydrateNamedGroups()
  const known = namedGroups.get(label)
  if (known !== undefined) {
    try {
      await chrome.tabGroups.get(known)
      return known
    } catch {
      await purgeNamedGroupEntry(label)
    }
  }
  const title = groupTitleFor(label)
  const groups = await chrome.tabGroups.query({})
  const match = groups.find((g) => g.title === title)
  if (match) {
    namedGroups.set(label, match.id)
    await persistNamedGroups()
    return match.id
  }
  return -1
}

export function addTabToNamedGroup(
  tabId: number,
  label: string,
  colorOverride?: unknown
): Promise<number> {
  return serializeGroupAdd(label, () => addTabToNamedGroupSerialized(tabId, label, colorOverride))
}

async function addTabToNamedGroupSerialized(
  tabId: number,
  label: string,
  colorOverride?: unknown
): Promise<number> {
  if (!hasTabGroupApi() || typeof chrome.tabs.group !== "function") return -1
  // Skip grouping for non-normal windows rather than let chrome.tabs.group
  // throw out of tab_create. The tab is still fully functional ungrouped.
  if (!(await isTabInNormalWindow(tabId))) return -1
  let groupId = await ensureNamedGroup(label)
  try {
    if (groupId === -1) {
      groupId = await chrome.tabs.group({ tabIds: tabId })
      const color = typeof colorOverride === "string" && (VALID_COLORS as readonly string[]).includes(colorOverride)
        ? normalizeColor(colorOverride)
        : colorForLabel(label)
      await chrome.tabGroups.update(groupId, {
        title: groupTitleFor(label),
        color: color as `${chrome.tabGroups.Color}`,
      })
      namedGroups.set(label, groupId)
      await persistNamedGroups()
    } else {
      await chrome.tabs.group({ tabIds: tabId, groupId })
    }
  } catch (err) {
    console.warn(`addTabToNamedGroup: skipping group '${label}' (tab=${tabId}):`, err)
    return -1
  }
  return groupId
}

export async function isTabInNamedGroup(tabId: number, label: string): Promise<boolean> {
  if (!hasTabGroupApi()) return true
  const groupId = await ensureNamedGroup(label)
  if (groupId === -1) return false
  const tab = await chrome.tabs.get(tabId)
  return tab.groupId === groupId
}

/** Membership in the default brand group OR any registered named group. */
export async function isTabInAnyManagedGroup(tabId: number): Promise<boolean> {
  if (!hasTabGroupApi()) return true
  const tab = await chrome.tabs.get(tabId)
  if (interceptorGroupId === null) await ensureInterceptorGroup()
  if (interceptorGroupId !== null && tab.groupId === interceptorGroupId) return true
  await hydrateNamedGroups()
  for (const gid of namedGroups.values()) {
    if (tab.groupId === gid) return true
  }
  return false
}

/** True when at least one managed group (default or named) is known to exist. */
export function anyManagedGroupKnown(): boolean {
  return interceptorGroupId !== null || namedGroups.size > 0
}

/**
 * Retitle every named group to `${newBrandTitle}-${label}` after a brand change.
 * Ids never change, so a brand retitle cannot orphan a named group.
 */
export async function retitleNamedGroupsForBrand(): Promise<void> {
  if (!hasTabGroupApi()) return
  await hydrateNamedGroups()
  for (const [label, gid] of namedGroups) {
    try {
      await chrome.tabGroups.update(gid, { title: groupTitleFor(label) })
    } catch {
      // group vanished — onRemoved listener purges it; never break the brand change.
    }
  }
}

/** Reverse lookup: the label owning a live groupId, or null (default/unmanaged). */
export function labelForGroupId(groupId: number): string | null {
  for (const [label, gid] of namedGroups) {
    if (gid === groupId) return label
  }
  return null
}

export async function ensureInterceptorGroup(): Promise<number> {
  if (!hasTabGroupApi()) return -1
  if (interceptorGroupId !== null) {
    try {
      await chrome.tabGroups.get(interceptorGroupId)
      return interceptorGroupId
    } catch {
      interceptorGroupId = null
    }
  }
  // Re-discover by the CANDIDATE TITLE SET (resolved brand + previous + default "interceptor"),
  // not a single hardcoded title, so a group created under the default or a prior brand is re-adopted
  // rather than orphaned after a retitle + SW restart.
  const candidates = await getCandidateTitles()
  const groups = await chrome.tabGroups.query({})
  const match = groups.find((g) => typeof g.title === "string" && candidates.includes(g.title))
  if (match) {
    interceptorGroupId = match.id
    return interceptorGroupId
  }
  return -1
}

// Group creation is check-then-act (miss the registry -> chrome.tabs.group mints a
// NEW group): N concurrent adds for the same group each miss and create N duplicate
// groups (found by stress testing — 9 parallel opens over 3 labels produced
// 9 groups). Serialize adds per group key ("" = the default group); the first
// creates, the rest join it via the registry.
const groupAddChains = new Map<string, Promise<number>>()

export function serializeGroupAdd(key: string, op: () => Promise<number>): Promise<number> {
  const prev = groupAddChains.get(key) ?? Promise.resolve(-1)
  const next = prev.then(op, op)
  groupAddChains.set(key, next)
  void next.finally(() => {
    if (groupAddChains.get(key) === next) groupAddChains.delete(key)
  }).catch(() => {})
  return next
}

export function addTabToInterceptorGroup(tabId: number): Promise<number> {
  return serializeGroupAdd("", () => addTabToInterceptorGroupSerialized(tabId))
}

async function addTabToInterceptorGroupSerialized(tabId: number): Promise<number> {
  let groupId = await ensureInterceptorGroup()
  if (groupId === -1 && (!hasTabGroupApi() || typeof chrome.tabs.group !== "function")) return -1
  // Skip grouping for non-normal windows rather than let chrome.tabs.group
  // throw out of tab_create. The tab is still fully functional ungrouped.
  if (!(await isTabInNormalWindow(tabId))) return -1
  try {
    if (groupId === -1) {
      groupId = await chrome.tabs.group({ tabIds: tabId })
      await chrome.tabGroups.update(groupId, {
        title: getTabGroupTitle(),
        color: getTabGroupColor() as `${chrome.tabGroups.Color}`,
      })
      interceptorGroupId = groupId
    } else {
      await chrome.tabs.group({ tabIds: tabId, groupId })
    }
  } catch (err) {
    // Cross-window group mismatch or transient failure — grouping is a UX
    // nicety, so keep tab_create successful and skip the group.
    console.warn(`addTabToInterceptorGroup: skipping group (tab=${tabId}):`, err)
    return -1
  }
  return groupId
}

export async function isTabInInterceptorGroup(tabId: number): Promise<boolean> {
  if (!hasTabGroupApi()) return true
  const tab = await chrome.tabs.get(tabId)
  if (interceptorGroupId === null) await ensureInterceptorGroup()
  return interceptorGroupId !== null && tab.groupId === interceptorGroupId
}

export const SENSITIVE_ACTIONS = new Set([
  "evaluate", "cookies_get", "cookies_set", "cookies_delete",
  "storage_read", "storage_write", "storage_delete"
])

export async function verifyTabUrl(tabId: number, expectedUrl?: string): Promise<string | null> {
  if (!expectedUrl) return null
  const tab = await chrome.tabs.get(tabId)
  if (tab.url && tab.url !== expectedUrl) {
    return `tab URL changed since last state read — expected ${expectedUrl}, got ${tab.url}`
  }
  return null
}

export function registerTabGroupListeners(): void {
  if (!hasTabGroupApi()) return
  chrome.tabs.onRemoved.addListener(async (_removedTabId) => {
    if (interceptorGroupId === null) return
    try {
      const tabs = await chrome.tabs.query({ groupId: interceptorGroupId })
      if (tabs.length === 0) interceptorGroupId = null
    } catch {
      interceptorGroupId = null
    }
  })
  // A group closed in the tab strip (user-closed, or auto-closed at zero tabs)
  // must not leave a stale registry entry or per-group auto-target behind —
  // that is the "human closes a leftover group" guarantee (issue #124).
  if (chrome.tabGroups.onRemoved) {
    chrome.tabGroups.onRemoved.addListener(async (group) => {
      if (interceptorGroupId === group.id) interceptorGroupId = null
      await hydrateNamedGroups()
      const label = labelForGroupId(group.id)
      if (label !== null) await purgeNamedGroupEntry(label)
    })
  }
}
