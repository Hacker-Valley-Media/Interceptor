import { afterEach, describe, expect, test } from "bun:test"

// `tab switch` back to the user's tab: the tab_switch handler
// records what the window was showing; the dispatcher lets exactly that tab
// through the managed-group gate once.

function installFakeChrome(tabs: Array<{ id: number; windowId: number; active: boolean }>) {
  const store = new Map<string, unknown>()
  const original = (globalThis as { chrome?: unknown }).chrome
  const area = {
    get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
    set: async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) store.set(k, v) },
    remove: async (key: string) => { store.delete(key) },
  }
  ;(globalThis as { chrome?: unknown }).chrome = {
    storage: { session: area, local: area },
    tabs: {
      get: async (id: number) => {
        const t = tabs.find(x => x.id === id)
        if (!t) throw new Error(`no tab ${id}`)
        return t
      },
      query: async (q: { active?: boolean; windowId?: number }) =>
        tabs.filter(t => (q.active === undefined || t.active === q.active) && (q.windowId === undefined || t.windowId === q.windowId)),
    },
  }
  return { store, restore: () => { (globalThis as { chrome?: unknown }).chrome = original } }
}

let restore: (() => void) | undefined
afterEach(() => { restore?.(); restore = undefined })

async function mod() {
  return import("../extension/src/background/switch-back")
}

const unmanaged = async () => false
const managedIds = (ids: number[]) => async (id: number) => ids.includes(id)

describe("tab switch back", () => {
  test("rememberPriorActive stores the window's active tab when switching to another tab", async () => {
    const fake = installFakeChrome([{ id: 3, windowId: 5, active: true }, { id: 9, windowId: 5, active: false }]); restore = fake.restore
    const { rememberPriorActive } = await mod()
    await rememberPriorActive(9, undefined, unmanaged)
    expect((fake.store.get("priorActive:5") as { tabId: number; group: string | null })).toEqual({ tabId: 3, group: null })
  })

  test("rememberPriorActive stores nothing when the target is already showing", async () => {
    const fake = installFakeChrome([{ id: 3, windowId: 5, active: true }]); restore = fake.restore
    const { rememberPriorActive } = await mod()
    await rememberPriorActive(3, undefined, unmanaged)
    expect(fake.store.has("priorActive:5")).toBe(false)
  })

  test("a managed prior never overwrites the record of the user's tab", async () => {
    // user's tab 3 → managed 9 (records 3); 9 → managed 12 (prior 9 is managed: keep 3)
    const tabs = [{ id: 3, windowId: 5, active: true }, { id: 9, windowId: 5, active: false }, { id: 12, windowId: 5, active: false }]
    const fake = installFakeChrome(tabs); restore = fake.restore
    const { rememberPriorActive, consumeSwitchBack } = await mod()
    await rememberPriorActive(9, "a", managedIds([9, 12]))
    expect((fake.store.get("priorActive:5") as { tabId: number; group: string | null })).toEqual({ tabId: 3, group: "a" })
    tabs[0].active = false; tabs[1].active = true
    await rememberPriorActive(12, "a", managedIds([9, 12]))
    expect((fake.store.get("priorActive:5") as { tabId: number }).tabId).toBe(3)
    expect(await consumeSwitchBack(3, "b")).toBe(false) // another lane's group cannot spend it
    expect(await consumeSwitchBack(3, "a")).toBe(true)
  })

  test("consumeSwitchBack passes the recorded tab once and refuses everything else", async () => {
    const fake = installFakeChrome([{ id: 3, windowId: 5, active: false }, { id: 9, windowId: 5, active: true }, { id: 4, windowId: 6, active: true }]); restore = fake.restore
    const { consumeSwitchBack } = await mod()
    fake.store.set("priorActive:5", { tabId: 3, group: null })
    expect(await consumeSwitchBack(4, undefined)).toBe(false) // another window's tab
    expect(await consumeSwitchBack(9, undefined)).toBe(false) // the managed tab itself
    expect(await consumeSwitchBack(3, "other")).toBe(false) // a grouped lane cannot spend an ungrouped record
    expect(await consumeSwitchBack(3, undefined)).toBe(true)
    expect(fake.store.has("priorActive:5")).toBe(false)
    expect(await consumeSwitchBack(3, undefined)).toBe(false) // one-shot
  })

  test("consumeSwitchBack is false for a tab that no longer exists", async () => {
    const fake = installFakeChrome([]); restore = fake.restore
    const { consumeSwitchBack } = await mod()
    fake.store.set("priorActive:5", { tabId: 3, group: null })
    expect(await consumeSwitchBack(3, undefined)).toBe(false)
  })
})
