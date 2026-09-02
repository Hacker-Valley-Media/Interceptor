import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { handleTabActions } from "../extension/src/background/capabilities/tabs"
import { namedGroups } from "../extension/src/background/tab-group"

const savedChrome = globalThis.chrome

beforeEach(() => namedGroups.clear())
afterEach(() => {
  globalThis.chrome = savedChrome
  namedGroups.clear()
})

function installChromeMock() {
  const calls: string[] = []
  const update = mock(async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
    calls.push(`activate:${tabId}:${String(properties.active)}`)
    return { id: tabId, url: "https://example.com", active: properties.active } as chrome.tabs.Tab
  })
  globalThis.chrome = {
    windows: {
      getAll: async () => [{ id: 9, focused: true, type: "normal" }],
      get: async () => ({ id: 9, type: "normal" }),
    },
    tabs: {
      create: async () => {
        calls.push("create")
        return { id: 77, url: "https://example.com", active: true, windowId: 9 } as chrome.tabs.Tab
      },
      get: async (tabId: number) => ({ id: tabId, windowId: 9, groupId: 42 }) as chrome.tabs.Tab,
      group: async () => {
        calls.push("group")
        return 42
      },
      query: async () => [],
      update,
    },
    tabGroups: {
      get: async () => { throw new Error("no existing group") },
      query: async () => [],
      update: async () => {
        calls.push("group-title")
        return { id: 42 }
      },
    },
    storage: {
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
  } as unknown as typeof chrome
  return { calls, update }
}

describe("tab_create grouped activation", () => {
  test("explicit activation is restored after Chrome group placement", async () => {
    const { calls, update } = installChromeMock()

    const result = await handleTabActions({
      type: "tab_create",
      url: "https://example.com",
      group: "activation",
      active: true,
    }, 0)

    expect(result.success).toBe(true)
    expect(update).toHaveBeenCalledWith(77, { active: true })
    expect(calls.indexOf("group")).toBeGreaterThan(-1)
    expect(calls.indexOf("activate:77:true")).toBeGreaterThan(calls.indexOf("group"))
  })

  test("background creation never performs a post-group activation", async () => {
    const { update } = installChromeMock()

    const result = await handleTabActions({
      type: "tab_create",
      url: "https://example.com",
      group: "background",
    }, 0)

    expect(result.success).toBe(true)
    expect(update).not.toHaveBeenCalled()
  })
})
