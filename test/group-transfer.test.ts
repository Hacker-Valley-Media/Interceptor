import { afterEach, expect, test } from "bun:test"
import { addTabToNamedGroup, moveNamedGroupToWindow, namedGroups, registerTabGroupListeners } from "../extension/src/background/tab-group"

const saved = globalThis.chrome
afterEach(() => { globalThis.chrome = saved; namedGroups.clear() })

function fixture(fail?: string, removal: "during" | "after" = "during") {
  const calls: string[] = []
  const stored: Record<string, unknown> = { "activeTabId:transfer": 2 }
  const tabs = new Map([1, 2, 9, 77].map(id => [id, { id, groupId: id < 3 ? 40 : -1, windowId: id < 3 ? 1 : 3, index: id === 1 ? 1 : 0 }]))
  const groups = new Map<number, any>([[40, { id: 40, title: "interceptor-transfer", color: "purple", collapsed: true, windowId: 1 }]])
  let onRemoved: (group: any) => Promise<void> = async () => {}
  const step = (name: string) => { calls.push(name); if (fail === name) throw Error(`injected ${name}`) }
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
      onRemoved: { addListener() {} },
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
        const id = groupId ?? 41
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
  return { calls, stored, tabs, groups, removed: (id: number) => onRemoved({ id }) }
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
  f.groups.set(99, { id: 99, title: "interceptor-other", windowId: 3 })
  namedGroups.set("other", 99)
  await addTabToNamedGroup(9, "other")
  expect(f.tabs.get(9)!.groupId).toBe(99)
  release()
  await Promise.all([transfer, add])
  expect(f.tabs.get(77)!.groupId).toBe(41)
  expect(f.calls.indexOf("update")).toBeLessThan(f.calls.lastIndexOf("group"))
})

test("partial move failures disclose surviving tabs in both windows", async () => {
  const f = fixture()
  chrome.tabs.move = (async () => { f.tabs.get(1)!.windowId = 3; throw Error("partial move") }) as typeof chrome.tabs.move
  await expect(moveNamedGroupToWindow("transfer", 3)).rejects.toThrow("1:window 3")
  expect(f.tabs.get(2)!.windowId).toBe(1)
  expect(f.tabs.size).toBe(4)
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
