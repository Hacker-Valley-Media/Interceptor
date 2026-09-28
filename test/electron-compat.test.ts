import { describe, expect, test } from "bun:test"
import { installElectronCompat } from "../extension/src/background/electron-compat"

// A callback-only chrome like Electron's MV2 host: promise calls throw, lastError
// carries failures, and the background page shows up as a tab.
function fakeElectron(opts: { hasQuery: boolean; extraTabIds?: number[] }) {
  const tabs = new Map<number, { id: number; url: string; active: boolean; groupId: number }>([
    [1, { id: 1, url: "file:///app/index.html", active: false, groupId: 0 }],
    [2, { id: 2, url: "chrome-extension://abc/_generated_background_page.html", active: false, groupId: 0 }],
    [3, { id: 3, url: "file:///app/prefs.html", active: false, groupId: 0 }],
  ])
  for (const id of opts.extraTabIds ?? []) tabs.set(id, { id, url: `file:///app/window-${id}.html`, active: false, groupId: 0 })
  const runtime: { lastError?: { message: string }; getURL: (p: string) => string } = {
    getURL: (p: string) => `chrome-extension://abc/${p}`,
  }
  const cbOnly = (fn: (...a: any[]) => void) => (...args: any[]) => {
    if (typeof args[args.length - 1] !== "function") {
      throw new Error("Error in invocation: No matching signature.")
    }
    fn(...args)
  }
  const fail = (cb: (v?: unknown) => void, message: string) => {
    runtime.lastError = { message }
    cb(undefined)
    runtime.lastError = undefined
  }
  const executed: unknown[] = []
  const chrome: any = {
    runtime,
    storage: { local: { get: cbOnly((_k, cb) => cb({ contextId: "app:x" })), set: cbOnly((_v, cb) => cb()) } },
    tabs: {
      get: cbOnly((id, cb) => (tabs.has(id) ? cb({ ...tabs.get(id) }) : fail(cb, `No tab with id: ${id}.`))),
      executeScript: cbOnly((tabId, details, cb) => { executed.push({ tabId, ...details }); cb([42]) }),
      sendMessage: cbOnly((_id, _msg, _o, cb) => cb({ success: true })),
    },
  }
  if (opts.hasQuery) chrome.tabs.query = cbOnly((_q, cb) => cb([...tabs.values()].map((t) => ({ ...t }))))
  installElectronCompat(chrome)
  return { chrome, executed }
}

for (const hasQuery of [true, false]) {
  describe(`electron compat (${hasQuery ? "Electron 27, callback tabs.query" : "Electron 18, no tabs.query"})`, () => {
    test("tabs.query works in promise form, hides the background page, and names an active tab", async () => {
      const { chrome } = fakeElectron({ hasQuery })
      const all = await chrome.tabs.query({})
      expect(all.map((t: { id: number }) => t.id)).toEqual([1, 3])
      expect(all.every((t: { groupId: number }) => t.groupId === -1)).toBe(true)
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
      expect(active.id).toBe(1)
      expect(await chrome.tabs.query({ groupId: 7 })).toEqual([])
    })

    test("tabs.get resolves known tabs and rejects the rest", async () => {
      const { chrome } = fakeElectron({ hasQuery })
      expect((await chrome.tabs.get(3)).url).toBe("file:///app/prefs.html")
      await expect(chrome.tabs.get(2)).rejects.toThrow("No tab with id: 2.")
    })
  })
}

describe("electron compat shims", () => {
  test("storage.local gets a promise form and keeps its callback form", async () => {
    const { chrome } = fakeElectron({ hasQuery: true })
    expect(await chrome.storage.local.get(null)).toEqual({ contextId: "app:x" })
    expect(await new Promise<unknown>((r) => chrome.storage.local.get(null, r))).toEqual({ contextId: "app:x" })
  })

  test("tabs.query and tabs.get refuse a callback and an unsupported filter", async () => {
    const { chrome } = fakeElectron({ hasQuery: true })
    await expect(chrome.tabs.query({}, () => {})).rejects.toThrow("takes no callback")
    await expect(chrome.tabs.get(1, () => {})).rejects.toThrow("takes no callback")
    await expect(chrome.tabs.query({ url: "file:///app/*" })).rejects.toThrow("tabs.query filter 'url'")
    expect((await chrome.tabs.query({ windowType: "normal" })).length).toBe(2)
  })

  test("Electron 18: the id scan grows past 128 and tabs.get takes any id", async () => {
    const { chrome } = fakeElectron({ hasQuery: false, extraTabIds: [120, 200, 700] })
    const ids = (await chrome.tabs.query({})).map((t: { id: number }) => t.id)
    expect(ids).toEqual([1, 3, 120, 200])
    expect((await chrome.tabs.get(700)).url).toBe("file:///app/window-700.html")
    expect((await chrome.tabs.get(1)).active).toBe(true)
    expect((await chrome.tabs.get(200)).active).toBe(false)
  })

  test("scripting.executeScript runs in every requested frame and marks unknown frame ids", async () => {
    const { chrome, executed } = fakeElectron({ hasQuery: true })
    const perFrame = await chrome.scripting.executeScript({ target: { tabId: 1, frameIds: [4, 9] }, files: ["content.js"] })
    expect(perFrame).toEqual([{ frameId: 4, result: 42 }, { frameId: 9, result: 42 }])
    expect(executed).toEqual([{ tabId: 1, frameId: 4, file: "content.js" }, { tabId: 1, frameId: 9, file: "content.js" }])
  })

  test("scripting.executeScript runs files and sync functions through tabs.executeScript", async () => {
    const { chrome, executed } = fakeElectron({ hasQuery: true })
    const res = await chrome.scripting.executeScript({ target: { tabId: 1, allFrames: true }, files: ["content.js"] })
    expect(res).toEqual([{ frameId: 0, result: 42 }])
    await chrome.scripting.executeScript({ target: { tabId: 1 }, func: (a: number) => a + 1, args: [2] })
    expect(executed).toEqual([
      { tabId: 1, allFrames: true, file: "content.js" },
      { tabId: 1, code: "((a) => a + 1)(...[2])" },
    ])
  })

  test("MAIN-world and async scripts and declarativeNetRequest point to Path A", async () => {
    const { chrome } = fakeElectron({ hasQuery: true })
    await expect(chrome.scripting.executeScript({ target: { tabId: 1 }, world: "MAIN", func: () => 1 })).rejects.toThrow("Use Path A")
    await expect(chrome.scripting.executeScript({ target: { tabId: 1 }, func: async () => 1 })).rejects.toThrow("not available on Electron Path 0")
    await expect(chrome.declarativeNetRequest.updateSessionRules({})).rejects.toThrow("Use Path A")
  })

  test("windows stub answers the dispatcher's no-active-tab path", async () => {
    const { chrome } = fakeElectron({ hasQuery: true })
    expect((await chrome.windows.getAll()).length).toBe(1)
  })
})

describe("electron compat refusals", () => {
  test("net buffer messages are answered with the Path A pointer, other messages pass through", async () => {
    const { chrome } = fakeElectron({ hasQuery: true })
    const viaCallback = await new Promise<{ success: boolean; error: string }>((r) =>
      chrome.tabs.sendMessage(1, { type: "get_net_log" }, { frameId: 0 }, r))
    expect(viaCallback.success).toBe(false)
    expect(viaCallback.error).toContain("Passive network capture")
    expect(viaCallback.error).toContain("Use Path A")
    for (const type of ["set_net_overrides", "clear_net_log", "get_sse_chunk", "get_page_comm_log", "get_captured_headers"]) {
      expect((await chrome.tabs.sendMessage(1, { type }, { frameId: 0 })).success).toBe(false)
    }
    expect(await chrome.tabs.sendMessage(1, { type: "get_state" }, { frameId: 0 })).toEqual({ success: true })
  })

  test("missing tab management calls reject with the Path A pointer", async () => {
    const { chrome } = fakeElectron({ hasQuery: true })
    await expect(chrome.tabs.create({ url: "https://example.com" })).rejects.toThrow("tabs.create (tab and window management) is not available on Electron Path 0")
    await expect(chrome.tabs.remove(1)).rejects.toThrow("Use Path A")
  })
})
