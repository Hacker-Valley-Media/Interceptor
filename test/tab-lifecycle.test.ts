import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  normalizeTabLifecycle,
  resolveTabLifecycle,
  policyMayDecideReuse,
  selectSweepCandidates,
  DEFAULT_TAB_LIFECYCLE,
  type SweepTab,
} from "../extension/src/background/tab-lifecycle"
import { buildTabCreateAction } from "../cli/commands/compound"
import { parseTabsCommand } from "../cli/commands/tabs"

// Tab-lifecycle unit tests. The sweep/normalize/precedence units are pure
// or storage-only, so no browser is needed; the live behaviors (beforeunload
// bypass, shared-stamp liveness, SW-restart survival, session restore) are
// verified against a real browser post-install.

// ── T1: normalizeTabLifecycle never throws, always yields a valid policy ──────

describe("normalizeTabLifecycle (T1)", () => {
  test("null/undefined/garbage yield the defaults", () => {
    expect(normalizeTabLifecycle(null)).toEqual(DEFAULT_TAB_LIFECYCLE)
    expect(normalizeTabLifecycle(undefined)).toEqual(DEFAULT_TAB_LIFECYCLE)
    expect(normalizeTabLifecycle("junk")).toEqual(DEFAULT_TAB_LIFECYCLE)
    expect(normalizeTabLifecycle(42)).toEqual(DEFAULT_TAB_LIFECYCLE)
    expect(normalizeTabLifecycle([])).toEqual(DEFAULT_TAB_LIFECYCLE)
  })

  test("partial objects keep per-field defaults", () => {
    expect(normalizeTabLifecycle({ reuse: false })).toEqual({ reuse: false, idleCloseMinutes: 10 })
    expect(normalizeTabLifecycle({ idleCloseMinutes: 0 })).toEqual({ reuse: true, idleCloseMinutes: 0 })
  })

  test("out-of-range and non-numeric idle values are clamped or defaulted", () => {
    expect(normalizeTabLifecycle({ idleCloseMinutes: -5 }).idleCloseMinutes).toBe(0)
    expect(normalizeTabLifecycle({ idleCloseMinutes: 7.6 }).idleCloseMinutes).toBe(8)
    expect(normalizeTabLifecycle({ idleCloseMinutes: NaN }).idleCloseMinutes).toBe(10)
    expect(normalizeTabLifecycle({ idleCloseMinutes: Infinity }).idleCloseMinutes).toBe(10)
    expect(normalizeTabLifecycle({ idleCloseMinutes: "30" }).idleCloseMinutes).toBe(10)
  })

  test("non-boolean reuse falls back to default true", () => {
    expect(normalizeTabLifecycle({ reuse: "yes" }).reuse).toBe(true)
    expect(normalizeTabLifecycle({ reuse: 0 }).reuse).toBe(true)
  })
})

// ── T2: resolveTabLifecycle precedence managed > local > default ─────────────

type FakeArea = { get: (key: string) => Promise<Record<string, unknown>> }

function chromeWithStorage(areas: { managed?: FakeArea; local?: FakeArea }): unknown {
  return { storage: { ...areas } }
}

describe("resolveTabLifecycle precedence (T2)", () => {
  let originalChrome: unknown

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome
  })
  afterEach(() => {
    ;(globalThis as { chrome?: unknown }).chrome = originalChrome as typeof chrome
  })

  test("managed wins over local", async () => {
    ;(globalThis as { chrome: unknown }).chrome = chromeWithStorage({
      managed: { get: async () => ({ tabLifecycle: { reuse: false, idleCloseMinutes: 99 } }) },
      local: { get: async () => ({ tabLifecycle: { reuse: true, idleCloseMinutes: 1 } }) },
    })
    const { policy, source } = await resolveTabLifecycle()
    expect(source).toBe("managed")
    expect(policy).toEqual({ reuse: false, idleCloseMinutes: 99 })
  })

  test("local used when managed has no key", async () => {
    ;(globalThis as { chrome: unknown }).chrome = chromeWithStorage({
      managed: { get: async () => ({}) },
      local: { get: async () => ({ tabLifecycle: { reuse: false, idleCloseMinutes: 30 } }) },
    })
    const { policy, source } = await resolveTabLifecycle()
    expect(source).toBe("local")
    expect(policy).toEqual({ reuse: false, idleCloseMinutes: 30 })
  })

  test("default when neither area has the key", async () => {
    ;(globalThis as { chrome: unknown }).chrome = chromeWithStorage({
      managed: { get: async () => ({}) },
      local: { get: async () => ({}) },
    })
    const { policy, source } = await resolveTabLifecycle()
    expect(source).toBe("default")
    expect(policy).toEqual(DEFAULT_TAB_LIFECYCLE)
  })

  test("managed present-but-throwing falls through to local (Chromium builds do this)", async () => {
    ;(globalThis as { chrome: unknown }).chrome = chromeWithStorage({
      managed: { get: async () => { throw new Error("managed storage unavailable") } },
      local: { get: async () => ({ tabLifecycle: { idleCloseMinutes: 5 } }) },
    })
    const { policy, source } = await resolveTabLifecycle()
    expect(source).toBe("local")
    expect(policy).toEqual({ reuse: true, idleCloseMinutes: 5 })
  })

  test("managed area entirely absent falls through to local", async () => {
    ;(globalThis as { chrome: unknown }).chrome = chromeWithStorage({
      local: { get: async () => ({ tabLifecycle: { reuse: false } }) },
    })
    const { source } = await resolveTabLifecycle()
    expect(source).toBe("local")
  })
})

// ── T3: sweep guards — each independently vetoes; stale unguarded tabs go ────

function mkTab(over: Partial<SweepTab> & { id: number }): SweepTab {
  return { windowId: 1, active: false, pinned: false, audible: false, ...over }
}

const ctx = (counts: Array<[number, number]>, focused: number | null = 99) => ({
  focusedWindowId: focused,
  windowTabCounts: new Map<number, number>(counts),
})

describe("selectSweepCandidates guards (T3)", () => {
  test("a stale unguarded group is fully selected", () => {
    const tabs = [mkTab({ id: 1 }), mkTab({ id: 2 }), mkTab({ id: 3 })]
    // window 1 holds other (non-group) tabs too, so G5 never bites
    expect(selectSweepCandidates(tabs, ctx([[1, 10]])).sort()).toEqual([1, 2, 3])
  })

  test("G2: active tab of the focused window is never closed", () => {
    const tabs = [mkTab({ id: 1, active: true }), mkTab({ id: 2 })]
    expect(selectSweepCandidates(tabs, ctx([[1, 10]], 1))).toEqual([2])
  })

  test("G2: active tab of an UNfocused window IS closable", () => {
    const tabs = [mkTab({ id: 1, active: true }), mkTab({ id: 2 })]
    expect(selectSweepCandidates(tabs, ctx([[1, 10]], 7)).sort()).toEqual([1, 2])
  })

  test("G2: unknown focus treats every active tab as protected", () => {
    const tabs = [mkTab({ id: 1, active: true }), mkTab({ id: 2 })]
    expect(selectSweepCandidates(tabs, ctx([[1, 10]], null))).toEqual([2])
  })

  test("G3: pinned tabs are never closed", () => {
    const tabs = [mkTab({ id: 1, pinned: true }), mkTab({ id: 2 })]
    expect(selectSweepCandidates(tabs, ctx([[1, 10]]))).toEqual([2])
  })

  test("G4: audible tabs are never closed", () => {
    const tabs = [mkTab({ id: 1, audible: true }), mkTab({ id: 2 })]
    expect(selectSweepCandidates(tabs, ctx([[1, 10]]))).toEqual([2])
  })

  test("G5: never closes the last tab of a window — keeps the most recent", () => {
    // Group tabs ARE the whole window (count 3 = group size 3): one must survive.
    const tabs = [mkTab({ id: 1 }), mkTab({ id: 2 }), mkTab({ id: 3 })]
    expect(selectSweepCandidates(tabs, ctx([[1, 3]])).sort()).toEqual([1, 2])
  })

  test("G5 applies per window when a group spans windows", () => {
    const tabs = [
      mkTab({ id: 1, windowId: 1 }),
      mkTab({ id: 2, windowId: 1 }),
      mkTab({ id: 3, windowId: 2 }),
    ]
    // window 1 is exactly the group's two tabs → keep id 2; window 2 has others → close 3
    expect(selectSweepCandidates(tabs, ctx([[1, 2], [2, 5]])).sort()).toEqual([1, 3])
  })

  test("unknown window count never triggers G5 (treated as not-last)", () => {
    const tabs = [mkTab({ id: 1, windowId: 42 })]
    expect(selectSweepCandidates(tabs, ctx([]))).toEqual([1])
  })
})

// ── T4: reuse gating — parser + policy-gate composition ──────────────────────

describe("reuse gating (T4)", () => {
  test("open without --reuse/--no-reuse marks reuse-undecided (reusePolicy)", () => {
    const a = buildTabCreateAction(["open", "https://x.com"], "https://x.com", { policyDefault: true })
    expect(a.reuse).toBeUndefined()
    expect(a.reusePolicy).toBe(true)
  })

  test("open --reuse is explicit and skips the policy marker", () => {
    const a = buildTabCreateAction(["open", "https://x.com", "--reuse"], "https://x.com", { policyDefault: true })
    expect(a.reuse).toBe(true)
    expect(a.reusePolicy).toBeUndefined()
  })

  test("open --no-reuse pins reuse off, beating any policy", () => {
    const a = buildTabCreateAction(["open", "https://x.com", "--no-reuse"], "https://x.com", { policyDefault: true })
    expect(a.reuse).toBe(false)
    expect(a.reusePolicy).toBeUndefined()
    expect(policyMayDecideReuse({ ...a, group: "ai7" })).toBe(false)
  })

  test("tab new never carries the policy marker (always creates)", async () => {
    const action = await parseTabsCommand(["tab", "new", "https://x.com"])
    expect(action).toMatchObject({ type: "tab_create", url: "https://x.com" })
    expect((action as { reusePolicy?: boolean }).reusePolicy).toBeUndefined()
    expect(policyMayDecideReuse({ ...(action as object), group: "ai7" })).toBe(false)
  })

  test("tab new --reuse now works (was silently ignored — W3)", async () => {
    const action = await parseTabsCommand(["tab", "new", "https://x.com", "--reuse"])
    expect(action).toMatchObject({ type: "tab_create", url: "https://x.com", reuse: true })
  })

  test("policy may decide ONLY for grouped, reuse-undecided open calls", () => {
    const open = buildTabCreateAction(["open", "u"], "u", { policyDefault: true })
    // grouped → policy decides
    expect(policyMayDecideReuse({ ...open, group: "ai7" })).toBe(true)
    // ungrouped (shared default group) → never
    expect(policyMayDecideReuse(open)).toBe(false)
    expect(policyMayDecideReuse({ ...open, group: "" })).toBe(false)
    // explicit decisions always win
    expect(policyMayDecideReuse({ reuse: true, reusePolicy: true, group: "ai7" })).toBe(false)
    expect(policyMayDecideReuse({ reuse: false, reusePolicy: true, group: "ai7" })).toBe(false)
  })
})
