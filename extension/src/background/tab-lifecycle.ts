/**
 * extension/src/background/tab-lifecycle.ts — runtime tab lifecycle policy.
 *
 * Two knobs, resolved at RUNTIME from chrome.storage key "tabLifecycle" with precedence
 * `managed` > `local` > built-in default `{ reuse: true, idleCloseMinutes: 10 }`,
 * mirroring the brand-tab-group.ts pattern. The popup is the only writer.
 *
 *   reuse            `open --group <label>` navigates that group's most-recent tab
 *                    instead of creating one. Applies to NAMED groups only — in the
 *                    shared default group "most recent tab" can be a sibling agent's,
 *                    so the policy never engages there (explicit --reuse still works).
 *   idleCloseMinutes Close a managed group no command has touched for N minutes.
 *                    0 = off. Swept via a 1-minute chrome.alarms tick (30s-floor
 *                    alarms need Chrome 120; manifest floor is 116).
 *
 * This module is module-load SIDE-EFFECT-FREE. It is transitively bundled into the MV2
 * `background-electron.js` (via capabilities/tabs.ts), so it must NOT touch `chrome.*`
 * at import time. ALL chrome access happens inside registerTabLifecycle() / the
 * accessors, and registerTabLifecycle() is called ONLY from the MV3 background.ts entry.
 */

import { hasTabGroupApi, ensureInterceptorGroup, hydrateNamedGroups, namedGroups } from "./tab-group"

export type TabLifecycle = { reuse: boolean; idleCloseMinutes: number }
export type TabLifecycleSource = "managed" | "local" | "default"

export const DEFAULT_TAB_LIFECYCLE: TabLifecycle = { reuse: true, idleCloseMinutes: 10 }

const STORAGE_KEY = "tabLifecycle"
const SWEEP_ALARM = "tabLifecycleSweep"
const SWEEP_LOG_KEY = "tabLifecycleSweepLog"
const SWEEP_LOG_CAP = 50
// Liveness stamps live in storage.session: same lifetime as tab/group ids (both die
// with the browser), so a stamp can never describe ids that no longer exist.
const GROUP_LAST_SEEN_PREFIX = "groupLastSeen:"

/** Validate/clamp a raw stored value into a complete policy. Never throws. */
export function normalizeTabLifecycle(raw: unknown): TabLifecycle {
  const obj = raw && typeof raw === "object" ? (raw as { reuse?: unknown; idleCloseMinutes?: unknown }) : {}
  const reuse = typeof obj.reuse === "boolean" ? obj.reuse : DEFAULT_TAB_LIFECYCLE.reuse
  let idle = DEFAULT_TAB_LIFECYCLE.idleCloseMinutes
  if (typeof obj.idleCloseMinutes === "number" && Number.isFinite(obj.idleCloseMinutes)) {
    idle = Math.max(0, Math.round(obj.idleCloseMinutes))
  }
  return { reuse, idleCloseMinutes: idle }
}

/**
 * True when a tab_create is reuse-undecided AND the policy is allowed to decide:
 * the CLI marked it `reusePolicy` (only `open` does) AND a named group is set.
 * Explicit --reuse/--no-reuse (action.reuse boolean) always wins; the shared
 * default group never gets policy reuse (a sibling agent's tab could be "most
 * recent" there).
 */
export function policyMayDecideReuse(action: Record<string, unknown>): boolean {
  return action.reuse === undefined
    && action.reusePolicy === true
    && typeof action.group === "string"
    && action.group.length > 0
}

/** Defensive read of one storage area; miss/absent-API/throw all yield undefined. */
async function readArea(area: "managed" | "local"): Promise<TabLifecycle | undefined> {
  try {
    const storageArea = (chrome.storage as unknown as Record<string, chrome.storage.StorageArea | undefined>)[area]
    if (!storageArea || typeof storageArea.get !== "function") return undefined
    const stored = (await storageArea.get(STORAGE_KEY)) as Record<string, unknown>
    const raw = stored?.[STORAGE_KEY]
    if (raw === undefined || raw === null) return undefined
    return normalizeTabLifecycle(raw)
  } catch {
    return undefined
  }
}

/** Resolve policy + which tier supplied it, precedence managed > local > default. */
export async function resolveTabLifecycle(): Promise<{ policy: TabLifecycle; source: TabLifecycleSource }> {
  const managed = await readArea("managed")
  if (managed) return { policy: managed, source: "managed" }
  const local = await readArea("local")
  if (local) return { policy: local, source: "local" }
  return { policy: { ...DEFAULT_TAB_LIFECYCLE }, source: "default" }
}

function sessionArea(): chrome.storage.StorageArea {
  const storage = chrome.storage as typeof chrome.storage & { session?: chrome.storage.StorageArea }
  return storage.session ?? chrome.storage.local
}

function stampKey(label: string): string {
  return `${GROUP_LAST_SEEN_PREFIX}${label}`
}

/**
 * Liveness stamp: called on every group-resolving dispatch ("" = the default
 * group). Two agents sharing a group both refresh the same stamp, so a shared
 * group stays alive while either is working. Fire-and-forget.
 */
export function recordGroupActivity(label: string | undefined): void {
  try {
    void sessionArea().set({ [stampKey(label ?? "")]: Date.now() }).catch(() => {})
  } catch {}
}

// --- sweep decision (pure — unit-testable without Chrome) --------------------

export type SweepTab = {
  id: number
  windowId: number
  active: boolean
  pinned: boolean
  audible: boolean
}

export type SweepContext = {
  // null = focus unknown → treat every window as focused (skip all active tabs).
  focusedWindowId: number | null
  // total tab count per window (all tabs, not just this group's)
  windowTabCounts: Map<number, number>
}

/**
 * Guards G2–G5 over one idle group's tabs (G1 — managed-group-only — is upstream:
 * callers only ever pass tabs queried by a managed groupId). Returns the tab ids
 * safe to close:
 *   G2 never the active tab of the focused window (focus unknown → any active tab)
 *   G3 never a pinned tab
 *   G4 never an audible tab
 *   G5 never the last tab of a window (tabs.remove on it closes the window)
 */
export function selectSweepCandidates(tabs: SweepTab[], ctx: SweepContext): number[] {
  const candidates = tabs.filter((t) => {
    if (t.pinned || t.audible) return false
    if (t.active && (ctx.focusedWindowId === null || t.windowId === ctx.focusedWindowId)) return false
    return true
  })
  // G5: leave at least one tab per window. Keep the highest id (most recent) so
  // the survivor is the tab the agent's auto-target most likely points at.
  const byWindow = new Map<number, SweepTab[]>()
  for (const t of candidates) {
    const list = byWindow.get(t.windowId) ?? []
    list.push(t)
    byWindow.set(t.windowId, list)
  }
  const out: number[] = []
  for (const [windowId, list] of byWindow) {
    const total = ctx.windowTabCounts.get(windowId) ?? Number.POSITIVE_INFINITY
    let removable = list
    if (list.length >= total) {
      removable = [...list].sort((a, b) => a.id - b.id).slice(0, -1)
    }
    for (const t of removable) out.push(t.id)
  }
  return out
}

// --- G9: dirty-form guard -----------------------------------------------------
// Verified live (2026-08-07): chrome.tabs.remove BYPASSES beforeunload — the
// handler never runs, no dialog appears, the tab closes silently. So the sweep
// must detect unsaved user state itself. A tab is "dirty" when any form control
// differs from its default, or the page registered window.onbeforeunload
// (addEventListener-registered handlers are undetectable — accepted gap).
// Injection failure = not dirty (an unreachable page holds no typed state we
// can preserve). Conservative by design: a skipped-but-closable tab lingers
// until `group close`; a closed-but-dirty tab is silent data loss.

function pageHasDirtyState(): boolean {
  try {
    const w = window as Window & { onbeforeunload?: unknown }
    if (typeof w.onbeforeunload === "function") return true
    for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) {
      if (el instanceof HTMLTextAreaElement) {
        if (el.value !== el.defaultValue) return true
      } else if (el instanceof HTMLInputElement) {
        if (el.type === "checkbox" || el.type === "radio") {
          if (el.checked !== el.defaultChecked) return true
        } else if (el.type !== "hidden" && el.value !== el.defaultValue) {
          return true
        }
      } else if (el instanceof HTMLSelectElement) {
        for (const o of Array.from(el.options)) {
          if (o.selected !== o.defaultSelected) return true
        }
      }
    }
  } catch {}
  return false
}

async function isTabDirty(tabId: number): Promise<boolean> {
  try {
    const scripting = (chrome as unknown as { scripting?: typeof chrome.scripting }).scripting
    if (typeof scripting?.executeScript !== "function") return false
    const results = await scripting.executeScript({
      target: { tabId, allFrames: true },
      func: pageHasDirtyState,
    })
    return results.some((r) => r?.result === true)
  } catch {
    return false
  }
}

// --- sweeper -----------------------------------------------------------------

async function readStamp(label: string): Promise<number | undefined> {
  try {
    const key = stampKey(label)
    const stored = (await sessionArea().get(key)) as Record<string, unknown>
    const v = stored?.[key]
    return typeof v === "number" ? v : undefined
  } catch {
    return undefined
  }
}

async function appendSweepLog(entry: Record<string, unknown>): Promise<void> {
  // G7: every sweep records what it closed (url + group + idle age). The
  // extension has no unsolicited event lane to the daemon, so the log lives in
  // storage.local (survives restarts) and is also mirrored to the SW console.
  try {
    const stored = (await chrome.storage.local.get(SWEEP_LOG_KEY)) as Record<string, unknown>
    const log = Array.isArray(stored?.[SWEEP_LOG_KEY]) ? (stored[SWEEP_LOG_KEY] as unknown[]) : []
    log.push(entry)
    await chrome.storage.local.set({ [SWEEP_LOG_KEY]: log.slice(-SWEEP_LOG_CAP) })
  } catch {}
}

/** One sweep tick. Exposed for tests/diagnostics; normally driven by the alarm. */
export async function runTabLifecycleSweep(now = Date.now()): Promise<void> {
  if (!hasTabGroupApi()) return
  const { policy } = await resolveTabLifecycle()
  if (policy.idleCloseMinutes <= 0) return
  const cutoffMs = policy.idleCloseMinutes * 60_000

  // Candidate groups: the default brand group ("") + every registered named group.
  await hydrateNamedGroups()
  const groups: Array<{ label: string; groupId: number }> = []
  const defaultGid = await ensureInterceptorGroup()
  if (defaultGid !== -1) groups.push({ label: "", groupId: defaultGid })
  for (const [label, gid] of namedGroups) groups.push({ label, groupId: gid })
  if (groups.length === 0) return

  // Shared context for the guards, resolved once per tick.
  let focusedWindowId: number | null = null
  try {
    const win = await chrome.windows.getLastFocused()
    focusedWindowId = win?.focused && win.id !== undefined ? win.id : null
  } catch {}
  const allTabs = await chrome.tabs.query({})
  const windowTabCounts = new Map<number, number>()
  for (const t of allTabs) {
    if (t.windowId === undefined) continue
    windowTabCounts.set(t.windowId, (windowTabCounts.get(t.windowId) ?? 0) + 1)
  }

  for (const { label, groupId } of groups) {
    const stamp = await readStamp(label)
    if (stamp === undefined) {
      // No stamp (pre-existing group, or stamps lost with the session): grace-stamp
      // now so the group gets one full idle window before it is ever a candidate.
      recordGroupActivity(label)
      continue
    }
    const idleMs = now - stamp
    if (idleMs < cutoffMs) continue

    let groupTabs: chrome.tabs.Tab[] = []
    try {
      groupTabs = await chrome.tabs.query({ groupId })
    } catch {
      continue
    }
    if (groupTabs.length === 0) continue

    const sweepTabs: SweepTab[] = groupTabs
      .filter((t): t is chrome.tabs.Tab & { id: number; windowId: number } =>
        typeof t.id === "number" && typeof t.windowId === "number")
      .map((t) => ({
        id: t.id,
        windowId: t.windowId,
        active: t.active === true,
        pinned: t.pinned === true,
        audible: t.audible === true,
      }))
    let closeIds = selectSweepCandidates(sweepTabs, { focusedWindowId, windowTabCounts })
    if (closeIds.length === 0) continue

    // G9: tabs.remove bypasses beforeunload (T5-proven), so screen for unsaved
    // user state ourselves and keep any dirty tab.
    const dirtyChecks = await Promise.all(closeIds.map(async (id) => ({ id, dirty: await isTabDirty(id) })))
    const keptDirty = dirtyChecks.filter((c) => c.dirty).map((c) => c.id)
    closeIds = dirtyChecks.filter((c) => !c.dirty).map((c) => c.id)
    if (keptDirty.length > 0) {
      console.log(`tab-lifecycle sweep: keeping ${keptDirty.length} dirty tab(s) in '${label || "(default)"}':`, keptDirty)
    }
    if (closeIds.length === 0) {
      // Everything idle-eligible is dirty — re-stamp so the group isn't re-scanned
      // every tick, and leave it for the agent's own `group close`.
      recordGroupActivity(label)
      continue
    }

    const closedUrls = groupTabs
      .filter((t) => typeof t.id === "number" && closeIds.includes(t.id))
      .map((t) => t.url ?? "")
    try {
      await chrome.tabs.remove(closeIds)
    } catch (err) {
      console.warn(`tab-lifecycle sweep: remove failed for group '${label || "(default)"}':`, err)
      continue
    }
    // Survivors (guard-vetoed tabs) get a fresh idle window rather than a
    // re-attack on every subsequent tick. A fully swept group's stamp is moot —
    // the group is gone and tabGroups.onRemoved purges its registry entry.
    recordGroupActivity(label)
    const summary = {
      at: new Date(now).toISOString(),
      group: label || "(default)",
      idleMinutes: Math.round(idleMs / 60_000),
      closed: closeIds.length,
      kept: sweepTabs.length - closeIds.length,
      urls: closedUrls,
    }
    console.log("tab-lifecycle sweep:", JSON.stringify(summary))
    await appendSweepLog(summary)
  }
}

/**
 * Seed + arm. Called ONLY from the MV3 background.ts entry. Alarms "may be
 * cleared when the browser is restarted" (alarms docs), so existence is checked
 * on every SW startup exactly like the docs' own checkAlarmState sample.
 */
export function registerTabLifecycle(): void {
  const alarms = (chrome as unknown as { alarms?: typeof chrome.alarms }).alarms
  if (typeof alarms?.create === "function" && alarms.onAlarm?.addListener) {
    void (async () => {
      try {
        const existing = await alarms.get(SWEEP_ALARM)
        if (!existing) await alarms.create(SWEEP_ALARM, { periodInMinutes: 1 })
      } catch (err) {
        console.warn("tab-lifecycle sweep alarm unavailable:", err)
      }
    })()
    alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== SWEEP_ALARM) return
      void runTabLifecycleSweep().catch((err) => console.warn("tab-lifecycle sweep failed:", err))
    })
  }
}
