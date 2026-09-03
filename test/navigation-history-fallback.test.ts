/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { historyGo } from "../extension/src/background/capabilities/navigation"

// Issue #237: chrome.tabs.goBack/goForward reject ("Cannot find a next page in
// history.") on entries Interceptor itself created, because Chromium treats
// extension-initiated navigations as renderer-initiated without a gesture and
// the history-manipulation intervention marks them skippable. The handler must
// fall back to page-side history.go() and report honestly whether the tab moved.

const CHROME_ERR = "Cannot find a next page in history."
let fakeTab: { id: number; url: string; status: string }
let goBackRejects: boolean
let executed: Array<{ tabId: number; args: unknown[] }>
let executeThrows: string | null
let executeResult: unknown
let originalChrome: unknown
const noWait = { waitForTabLoad: async () => ({ ready: true, elapsed: 0 }) }

beforeEach(() => {
  fakeTab = { id: 7, url: "https://b.example/", status: "complete" }
  goBackRejects = true
  executed = []
  executeThrows = null
  executeResult = undefined
  originalChrome = (globalThis as { chrome?: unknown }).chrome
  ;(globalThis as { chrome: unknown }).chrome = {
    tabs: {
      get: async (id: number) => { if (id !== fakeTab.id) throw new Error("No tab with id"); return { ...fakeTab } },
      goBack: async () => { if (goBackRejects) throw new Error(CHROME_ERR) },
      goForward: async () => { if (goBackRejects) throw new Error(CHROME_ERR) },
    },
    scripting: {
      executeScript: async (inj: { target: { tabId: number }; args: unknown[] }) => {
        if (executeThrows) throw new Error(executeThrows)
        executed.push({ tabId: inj.target.tabId, args: inj.args })
        return executeResult
      },
    },
  }
})
afterEach(() => { (globalThis as { chrome?: unknown }).chrome = originalChrome })

describe("historyGo (issue #237)", () => {
  test("uses the tabs API when it works and never touches the page", async () => {
    goBackRejects = false
    expect(await historyGo(7, -1, noWait)).toEqual({ success: true })
    expect(executed).toEqual([])
  })

  test("falls back to page-side history.go(-1) and succeeds once the tab moves", async () => {
    const p = historyGo(7, -1, noWait)
    await Bun.sleep(150)
    fakeTab.url = "https://a.example/" // the page-side back landed
    expect(await p).toEqual({ success: true })
    expect(executed).toEqual([{ tabId: 7, args: [-1] }])
  })

  test("forward uses +1 and a 'loading' status counts as movement", async () => {
    const p = historyGo(7, 1, noWait)
    await Bun.sleep(150)
    fakeTab.status = "loading"
    expect(await p).toEqual({ success: true })
    expect(executed).toEqual([{ tabId: 7, args: [1] }])
  })

  test("a same-document entry with the same URL counts as movement when the page acknowledges it", async () => {
    executeResult = [{ result: true }]
    const res = await historyGo(7, -1, noWait)
    expect(res.success).toBe(true)
    expect(executed).toHaveLength(1)
    expect(fakeTab.url).toBe("https://b.example/")
  })

  test("reports an honest error when the page has nothing to go back to", async () => {
    const r = await historyGo(7, -1, noWait)
    expect(r.success).toBe(false)
    expect(r.error).toContain("no back history for tab 7")
    expect(executed.length).toBe(1)
  }, 10_000)

  test("surfaces both errors when the page-side fallback cannot run (restricted page)", async () => {
    executeThrows = "Cannot access a chrome:// URL"
    const r = await historyGo(7, -1, noWait)
    expect(r.success).toBe(false)
    expect(r.error).toContain(CHROME_ERR)
    expect(r.error).toContain("Cannot access a chrome:// URL")
  })

  test("a missing tab is reported before anything else", async () => {
    expect(await historyGo(99, -1, noWait)).toEqual({ success: false, error: "tab 99 not found" })
  })
})
