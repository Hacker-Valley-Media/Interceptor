import { afterEach, expect, test } from "bun:test"
import { addTabToNamedGroup, anyManagedGroupKnown, ensureNamedGroup, moveNamedGroupToWindow, namedGroups, readoptNamedGroups, registerTabGroupListeners, transferringTabOwner } from "../extension/src/background/tab-group"
import { managedTabGateError } from "../extension/src/background/message-dispatch"

const saved = globalThis.chrome
afterEach(() => { globalThis.chrome = saved; namedGroups.clear() })

function fixture(fail?: string, removal: "during" | "after" = "during") {
  const calls: string[] = []
  const stored: Record<string, unknown> = { "activeTabId:transfer": 2 }
  const tabs = new Map([1, 2, 9, 77].map(id => [id, { id, groupId: id < 3 ? 40 : -1, windowId: id < 3 ? 1 : 3, index: id === 1 ? 1 : 0 }]))
  const groups = new Map<number, any>([[40, { id: 40, title: "interceptor-transfer", color: "purple", collapsed: true, windowId: 1 }]])
  let onRemoved: (group: any) => Promise<void> = async () => {}
  let tabRemoved: (id: number) => Promise<void> = async () => {}
  const step = (name: string) => { calls.push(name); if (fail === name) { fail = undefined; throw Error(`injected ${name}`) } }
  globalThis.chrome = {
    storage: { session: {
      get: async () => stored,
      set: async (value: object) => Object.assign(stored, value),
      remove: async (key: string) => { delete stored[key] },
    } },
    windows: { get: async () => ({ type: "normal" }) },
    tabGroups: {
      query: async () => [...groups.values()],
      get: async (id: number) => { if (!groups.has(id)) throw Error("no group"); return groups.get(id) },
      move: async () => { throw Error("native group move is forbidden") },
      update: async (id: number, update: object) => { step("update"); Object.assign(groups.get(id), update) },
      onRemoved: { addListener: (fn: typeof onRemoved) => { onRemoved = fn } },
    },
    tabs: {
      onRemoved: { addListener: (fn: typeof tabRemoved) => { tabRemoved = fn } },
      query: async ({ groupId }: { groupId: number }) => { step("query"); return [...tabs.values()].filter(t => t.groupId === groupId) },
      get: async (id: number) => tabs.get(id),
      ungroup: async (ids: number[]) => {
        step("ungroup"); for (const id of ids) tabs.get(id)!.groupId = -1
        groups.delete(40)
        if (removal === "during") await onRemoved({ id: 40 })
      },
      move: async (ids: number[], to: { windowId: number }) => {
        step("move"); for (const [index, id] of ids.entries()) Object.assign(tabs.get(id)!, { windowId: to.windowId, index })
      },
      group: async ({ tabIds, groupId, createProperties }: any) => {
        step("group")
        const id = groupId ?? Math.max(40, ...groups.keys()) + 1
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        if (!groups.has(id)) groups.set(id, { id, windowId: createProperties.windowId })
        for (const tab of ids) Object.assign(tabs.get(tab)!, { groupId: id, windowId: groups.get(id).windowId })
        return id
      },
      remove: async () => { throw Error("no transfer may close tabs") },
    },
  } as unknown as typeof chrome
  namedGroups.set("transfer", 40)
  registerTabGroupListeners()
  return { calls, stored, tabs, groups, removed: (id: number) => onRemoved({ id }), tabRemoved: (id: number) => tabRemoved(id) }
}

for (const removal of ["during", "after"] as const) test(`transfer preserves order, metadata and auto-target with ${removal} removal`, async () => {
  const f = fixture(undefined, removal)
  await moveNamedGroupToWindow("transfer", 3)
  await f.removed(40)
  expect(f.calls).toEqual(["query", "ungroup", "move", "group", "update"])
  expect(f.groups.get(41)).toMatchObject({ title: "interceptor-transfer", color: "purple", collapsed: true, windowId: 3 })
  expect(f.tabs.get(2)!.index).toBe(0)
  expect(f.tabs.get(1)!.index).toBe(1)
  expect(f.tabs.get(9)!.groupId).toBe(-1)
  expect(namedGroups.get("transfer")).toBe(41)
  expect(f.stored["activeTabId:transfer"]).toBe(2)
  await f.removed(41)
  expect(namedGroups.has("transfer")).toBe(false)
  expect(f.stored["activeTabId:transfer"]).toBeUndefined()
})

for (const failure of ["query", "ungroup", "move", "group", "update"]) test(`failed ${failure} keeps tabs and the queue usable`, async () => {
  const f = fixture(failure)
  await expect(moveNamedGroupToWindow("transfer", 3)).rejects.toThrow(`injected ${failure}`)
  expect(f.tabs.size).toBe(4)
  expect(f.stored["activeTabId:transfer"]).toBe(2)
  if (["move", "group"].includes(failure)) {
    const managed = namedGroups.get("transfer")!
    expect(managed).toBeGreaterThan(0)
    expect(f.tabs.get(1)!.groupId).toBe(managed)
    expect(f.tabs.get(2)!.groupId).toBe(managed)
    expect(f.groups.get(managed)).toMatchObject({ title: "interceptor-transfer", color: "purple", collapsed: true })
  }
  const next = fixture()
  await moveNamedGroupToWindow("transfer", 3)
  expect(next.tabs.get(1)!.windowId).toBe(3)
})

test("same-label adds wait for transfer; unrelated labels do not wait", async () => {
  const f = fixture()
  let release!: () => void
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  const move = chrome.tabs.move
  chrome.tabs.move = (async (...args: any[]) => {
    started(); await wait
    return (move as any)(...args)
  }) as typeof move
  const transfer = moveNamedGroupToWindow("transfer", 3)
  const add = addTabToNamedGroup(77, "transfer")
  await entered
  await expect(ensureNamedGroup("transfer")).rejects.toThrow("transfer in progress; retry")
  expect(f.groups.size).toBe(0)
  expect(anyManagedGroupKnown()).toBe(true)
  expect(transferringTabOwner(1)).toBe("transfer")
  for (const label of [undefined, "other", "transfer"]) expect(await managedTabGateError(1, label, label === "transfer")).toContain("transfer in progress; retry")
  expect(await managedTabGateError(9, undefined, false)).toContain("not in the interceptor group")
  f.groups.set(99, { id: 99, title: "interceptor-other", windowId: 3 })
  namedGroups.set("other", 99)
  await addTabToNamedGroup(9, "other")
  expect(f.tabs.get(9)!.groupId).toBe(99)
  release()
  await Promise.all([transfer, add])
  expect(transferringTabOwner(1)).toBeUndefined()
  expect(await managedTabGateError(1, "transfer", true)).toBeNull()
  expect(f.tabs.get(77)!.groupId).toBe(namedGroups.get("transfer")!)
  expect(f.calls.indexOf("update")).toBeLessThan(f.calls.lastIndexOf("group"))
})

test("partial move failures regroup all survivors under the same label", async () => {
  const f = fixture()
  chrome.tabs.move = (async () => { f.tabs.get(1)!.windowId = 3; throw Error("partial move") }) as typeof chrome.tabs.move
  await expect(moveNamedGroupToWindow("transfer", 3)).rejects.toThrow("1:window 3")
  expect(f.tabs.get(2)!.windowId).toBe(3)
  expect(f.tabs.size).toBe(4)
  expect(f.tabs.get(2)!.groupId).toBe(namedGroups.get("transfer")!)
  expect([...namedGroups.keys()]).toEqual(["transfer"])
  expect(f.tabs.get(1)!.groupId).toBe(namedGroups.get("transfer")!)
})

test("a failed recovery reports ungrouped survivors without losing the auto-target", async () => {
  const f = fixture()
  chrome.tabs.group = (async () => { throw Error("group unavailable") }) as typeof chrome.tabs.group
  await expect(moveNamedGroupToWindow("transfer", 3)).rejects.toThrow("regroup failed")
  expect(f.tabs.size).toBe(4)
  expect(f.tabs.get(1)!.groupId).toBe(-1)
  expect(f.stored["activeTabId:transfer"]).toBe(2)
  expect(namedGroups.has("transfer")).toBe(false)
  try {
    expect(transferringTabOwner(1)).toBe("transfer")
    expect(f.stored.failedTransferTabs).toEqual({1:"transfer",2:"transfer"})
    for (const label of [undefined, "s-0123456789abcdef"]) {
      expect(await managedTabGateError(1, label, false)).toContain("transfer in progress; retry")
    }
    expect(anyManagedGroupKnown()).toBe(true)
  } finally {
    await f.tabRemoved(1)
    await f.tabRemoved(2)
  }
  expect(transferringTabOwner(1)).toBeUndefined()
  expect(f.stored.failedTransferTabs).toEqual({})
})

test("readoption skips an in-progress transfer and still registers an unrelated label", async () => {
  const f = fixture()
  let release!: () => void
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  const ungroup = chrome.tabs.ungroup
  chrome.tabs.ungroup = (async (...args: any[]) => { started(); await wait; return (ungroup as any)(...args) }) as typeof ungroup
  const transfer = moveNamedGroupToWindow("transfer", 3)
  await entered
  f.groups.set(99, { id: 99, title: "interceptor-other", windowId: 3 })
  try {
    await readoptNamedGroups()
    expect(namedGroups.get("other")).toBe(99)
    expect(namedGroups.has("transfer")).toBe(false)
  } finally { release(); await transfer }
  expect(namedGroups.get("transfer")).toBe(100)
})

for (const absent of ["tabGroups", "query", "uncallable-query", "ungroup", "move", "group"]) test(`missing ${absent} is a no-op`, async () => {
  const f = fixture()
  const c = chrome as any
  if (absent === "tabGroups") delete c.tabGroups
  else if (absent === "query") delete c.tabGroups.query
  else if (absent === "uncallable-query") c.tabGroups.query = true
  else delete c.tabs[absent]
  await moveNamedGroupToWindow("transfer", 3)
  expect(f.calls).toEqual([])
  expect(f.tabs.get(1)!.windowId).toBe(1)
})
