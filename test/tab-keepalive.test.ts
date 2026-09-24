import { afterEach, describe, expect, test } from "bun:test"
import { parseTabsCommand } from "../cli/commands/tabs"
import { IK_KEEPALIVE } from "../extension/src/inject-keys"

// `tab keepalive <id>`: CLI parse, background handler, and the
// listeners that re-apply the flag after navigation and forget closed tabs.

type Listener = (...args: any[]) => unknown

interface FakeChromeOptions {
  scripting?: boolean
  executeResult?: unknown
}

function installFakeChrome(opts: FakeChromeOptions = {}) {
  const store = new Map<string, unknown>()
  const executeCalls: unknown[] = []
  const removed: Listener[] = []
  const committed: Listener[] = []
  const original = (globalThis as { chrome?: unknown }).chrome
  const area = {
    get: async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key]
      const out: Record<string, unknown> = {}
      for (const k of keys) if (store.has(k)) out[k] = store.get(k)
      return out
    },
    set: async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) store.set(k, v) },
    remove: async (key: string | string[]) => { for (const k of Array.isArray(key) ? key : [key]) store.delete(k) },
  }
  const chrome: Record<string, unknown> = {
    storage: { session: area, local: area },
    tabs: { onRemoved: { addListener: (fn: Listener) => removed.push(fn) } },
    webNavigation: { onCommitted: { addListener: (fn: Listener) => committed.push(fn) } },
  }
  if (opts.scripting !== false) {
    chrome.scripting = {
      executeScript: async (injection: unknown) => {
        executeCalls.push(injection)
        return opts.executeResult ?? [{ frameId: 0, result: true }]
      },
    }
  }
  ;(globalThis as { chrome?: unknown }).chrome = chrome
  return { store, executeCalls, removed, committed, restore: () => { (globalThis as { chrome?: unknown }).chrome = original } }
}

let restore: (() => void) | undefined
afterEach(() => { restore?.(); restore = undefined })

async function mod() {
  return import("../extension/src/background/tab-keepalive")
}

describe("tab keepalive — CLI parse", () => {
  test("tab keepalive <id> → enabled", async () => {
    expect(await parseTabsCommand(["tab", "keepalive", "12"])).toEqual({ type: "tab_keepalive", tabId: 12, enabled: true })
  })
  test("--off clears, in either position", async () => {
    expect(await parseTabsCommand(["tab", "keepalive", "12", "--off"])).toEqual({ type: "tab_keepalive", tabId: 12, enabled: false })
    expect(await parseTabsCommand(["tab", "keepalive", "--off", "12"])).toEqual({ type: "tab_keepalive", tabId: 12, enabled: false })
  })
})

describe("tab keepalive — handler", () => {
  test("on: flips the page state in every frame and stores the flag", async () => {
    const fake = installFakeChrome(); restore = fake.restore
    const { setKeepalive } = await mod()
    const result = await setKeepalive(7, true)
    expect(result.success).toBe(true)
    const call = fake.executeCalls[0] as { target: unknown; world: string; injectImmediately: boolean; args: unknown[] }
    expect(call.target).toEqual({ tabId: 7, allFrames: true })
    expect(call.world).toBe("MAIN")
    expect(call.injectImmediately).toBe(true)
    expect(call.args).toEqual([IK_KEEPALIVE, true])
    expect(fake.store.get("keepalive:7")).toBe(true)
    const data = result.data as { keepalive: boolean; note: string }
    expect(data.keepalive).toBe(true)
    expect(data.note).toContain("IntersectionObserver")
  })

  test("off: clears the flag", async () => {
    const fake = installFakeChrome(); restore = fake.restore
    fake.store.set("keepalive:7", true)
    const { setKeepalive } = await mod()
    const result = await setKeepalive(7, false)
    expect(result.success).toBe(true)
    expect(fake.store.has("keepalive:7")).toBe(false)
    expect((result.data as { keepalive: boolean }).keepalive).toBe(false)
  })

  test("hooks absent in the main frame: honest error, no flag", async () => {
    const fake = installFakeChrome({ executeResult: [{ frameId: 0, result: false }, { frameId: 3, result: true }] }); restore = fake.restore
    const { setKeepalive } = await mod()
    const result = await setKeepalive(7, true)
    expect(result.success).toBe(false)
    expect(result.error).toContain("reload the tab")
    expect(fake.store.has("keepalive:7")).toBe(false)
  })

  test("no chrome.scripting (MV2): names the missing API", async () => {
    const fake = installFakeChrome({ scripting: false }); restore = fake.restore
    const { setKeepalive } = await mod()
    const result = await setKeepalive(7, true)
    expect(result.success).toBe(false)
    expect(result.error).toContain("chrome.scripting")
  })

  test("listeners: onRemoved forgets the tab; onCommitted re-applies only flagged main frames", async () => {
    const fake = installFakeChrome(); restore = fake.restore
    const { registerKeepaliveListeners } = await mod()
    registerKeepaliveListeners()
    expect(fake.removed.length).toBe(1)
    expect(fake.committed.length).toBe(1)
    fake.store.set("keepalive:7", true)
    await fake.committed[0]({ tabId: 7, frameId: 1 })
    expect(fake.executeCalls.length).toBe(0)
    await fake.committed[0]({ tabId: 8, frameId: 0 })
    expect(fake.executeCalls.length).toBe(0)
    await fake.committed[0]({ tabId: 7, frameId: 0 })
    expect(fake.executeCalls.length).toBe(1)
    expect((fake.executeCalls[0] as { args: unknown[] }).args).toEqual([IK_KEEPALIVE, true])
    fake.removed[0](7)
    await new Promise(r => setTimeout(r, 0))
    expect(fake.store.has("keepalive:7")).toBe(false)
  })
})
