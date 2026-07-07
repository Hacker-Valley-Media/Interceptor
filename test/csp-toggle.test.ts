/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

// csp toggle — browser-global extension handler.
//
// handleCspActions installs/removes ONE declarativeNetRequest session rule (id
// 900000, no tabIds) that strips CSP response headers on every tab, and by
// default reloads every open http/https tab so the change is live now. These
// tests drive it against a stateful chrome.declarativeNetRequest + chrome.tabs
// mock. `callLog` records the relative order of DNR writes vs tab reloads so the
// "rule installed before reload" invariant can be asserted.

const GLOBAL_RULE_ID = 900_000

type SessionRule = {
  id: number
  action: { responseHeaders: Array<{ header: string; operation: string }> }
  condition: { tabIds?: number[]; resourceTypes?: string[] }
  [k: string]: unknown
}
type UpdateCall = { removeRuleIds?: number[]; addRules?: SessionRule[] }

let sessionRules: SessionRule[]
let reloadCalls: Array<{ id: number; opts: { bypassCache?: boolean } }>
let callLog: string[]
let tabsFixture: Array<{ id?: number; url?: string; pendingUrl?: string }>
let originalChrome: unknown

beforeEach(() => {
  sessionRules = []
  reloadCalls = []
  callLog = []
  tabsFixture = [
    { id: 1, url: "https://a.example/" },
    { id: 2, url: "https://b.example/" },
    { id: 3, url: "http://c.example/" },
    { id: 4, url: "chrome://extensions/" }, // skipped — not http/https
    { id: 5, url: "about:blank" },          // skipped
    { url: "https://no-id.example/" },       // skipped — no tab id
  ]
  originalChrome = (globalThis as { chrome?: unknown }).chrome
  ;(globalThis as { chrome: unknown }).chrome = {
    declarativeNetRequest: {
      updateSessionRules: async ({ removeRuleIds = [], addRules = [] }: UpdateCall) => {
        sessionRules = sessionRules.filter((r) => !removeRuleIds.includes(r.id))
        sessionRules.push(...(addRules as SessionRule[]))
        callLog.push(addRules.length ? "rules:add" : "rules:remove")
      },
      getSessionRules: async () => sessionRules.slice(),
    },
    tabs: {
      query: async () => tabsFixture.slice(),
      reload: async (id: number, opts: { bypassCache?: boolean }) => {
        reloadCalls.push({ id, opts })
        callLog.push("reload:" + id)
      },
    },
  }
})

afterEach(() => {
  ;(globalThis as { chrome?: unknown }).chrome = originalChrome
})

async function load() {
  return await import("../extension/src/background/capabilities/csp")
}

const reloadedIds = () => reloadCalls.map((c) => c.id).sort((a, b) => a - b)
const globalRule = () => sessionRules.find((r) => r.id === GLOBAL_RULE_ID)
const isStripped = () => sessionRules.some((r) => r.id === GLOBAL_RULE_ID)
const dataOf = (res: { data?: unknown }) =>
  res.data as { scope?: string; cspStripped?: boolean; tabsReloaded?: number }

describe("handleCspActions (global)", () => {
  test("csp_strip installs ONE global rule (no tabIds) removing both CSP headers", async () => {
    const { handleCspActions } = await load()
    const res = await handleCspActions({ type: "csp_strip" })

    expect(res.success).toBe(true)
    const rule = globalRule()
    expect(rule).toBeDefined()
    expect(rule!.condition.tabIds).toBeUndefined() // applies to ALL tabs, current + future
    expect(rule!.condition.resourceTypes?.slice().sort()).toEqual(["main_frame", "sub_frame"])
    const removed = rule!.action.responseHeaders
      .filter((h) => h.operation === "remove")
      .map((h) => h.header)
      .sort()
    expect(removed).toEqual(["content-security-policy", "content-security-policy-report-only"])
    expect(dataOf(res).scope).toBe("all-tabs")
    expect(dataOf(res).cspStripped).toBe(true)
  })

  test("csp_strip reloads every open http/https tab with bypassCache (skips chrome:// / about: / id-less)", async () => {
    const { handleCspActions } = await load()
    const res = await handleCspActions({ type: "csp_strip" })
    expect(reloadedIds()).toEqual([1, 2, 3])
    expect(reloadCalls.every((c) => c.opts?.bypassCache === true)).toBe(true)
    expect(dataOf(res).tabsReloaded).toBe(3)
  })

  test("the rule is installed BEFORE any tab reload fires", async () => {
    const { handleCspActions } = await load()
    await handleCspActions({ type: "csp_strip" })
    expect(callLog[0]).toBe("rules:add")
    expect(callLog.slice(1).every((e) => e.startsWith("reload:"))).toBe(true)
  })

  test("--no-reload installs the rule but reloads nothing", async () => {
    const { handleCspActions } = await load()
    const res = await handleCspActions({ type: "csp_strip", reload: false })
    expect(isStripped()).toBe(true)
    expect(reloadCalls).toEqual([])
    expect(dataOf(res).tabsReloaded).toBe(0)
  })

  test("csp_strip reloads a mid-navigation tab matched via pendingUrl", async () => {
    tabsFixture = [{ id: 9, url: "", pendingUrl: "https://loading.example/" }]
    const { handleCspActions } = await load()
    await handleCspActions({ type: "csp_strip" })
    expect(reloadedIds()).toEqual([9])
  })

  test("csp_restore removes the global rule and reloads by default", async () => {
    const { handleCspActions } = await load()
    await handleCspActions({ type: "csp_strip", reload: false })
    expect(isStripped()).toBe(true)

    const res = await handleCspActions({ type: "csp_restore" })
    expect(isStripped()).toBe(false)
    expect(dataOf(res).cspStripped).toBe(false)
    expect(reloadedIds()).toEqual([1, 2, 3])
  })

  test("csp_restore when nothing is disabled is a no-op and does NOT reload", async () => {
    const { handleCspActions } = await load()
    const res = await handleCspActions({ type: "csp_restore" }) // default reload=true
    expect(res.success).toBe(true)
    expect(dataOf(res).cspStripped).toBe(false)
    expect(dataOf(res).tabsReloaded).toBe(0)
    expect(reloadCalls).toEqual([]) // must not reload every tab for a no-op
  })

  test("csp_status reflects the global rule presence", async () => {
    const { handleCspActions } = await load()
    expect(dataOf(await handleCspActions({ type: "csp_status" })).cspStripped).toBe(false)
    await handleCspActions({ type: "csp_strip", reload: false })
    expect(dataOf(await handleCspActions({ type: "csp_status" })).cspStripped).toBe(true)
  })

  test("re-stripping does not stack duplicate global rules", async () => {
    const { handleCspActions } = await load()
    await handleCspActions({ type: "csp_strip", reload: false })
    await handleCspActions({ type: "csp_strip", reload: false })
    expect(sessionRules.filter((r) => r.id === GLOBAL_RULE_ID)).toHaveLength(1)
  })

  test("re-running csp_strip when already active is a no-op (no reinstall, no reload storm)", async () => {
    const { handleCspActions } = await load()
    await handleCspActions({ type: "csp_strip", reload: false }) // install
    callLog.length = 0
    reloadCalls.length = 0

    const res = await handleCspActions({ type: "csp_strip" }) // default reload=true
    expect(res.success).toBe(true)
    expect(dataOf(res).cspStripped).toBe(true)
    expect(dataOf(res).tabsReloaded).toBe(0)
    expect(reloadCalls).toEqual([]) // must not reload every tab when already active
    expect(callLog).toEqual([])     // must not touch updateSessionRules again
  })

  test("tabsReloaded counts successes, not attempts, and a failure never fails the toggle", async () => {
    const { handleCspActions } = await load()
    ;(globalThis as { chrome: { tabs: { reload: (id: number, opts: { bypassCache?: boolean }) => Promise<void> } } }).chrome.tabs.reload =
      async (id: number, opts: { bypassCache?: boolean }) => {
        if (id === 2) throw new Error("No tab with id 2")
        reloadCalls.push({ id, opts })
      }
    const res = await handleCspActions({ type: "csp_strip" })
    expect(res.success).toBe(true)          // the DNR install succeeded
    expect(isStripped()).toBe(true)
    expect(reloadedIds()).toEqual([1, 3])   // tab 2 threw
    expect(dataOf(res).tabsReloaded).toBe(2) // only the 2 that actually reloaded
  })

  test("a DNR install failure surfaces as an error result rather than throwing", async () => {
    const { handleCspActions } = await load()
    ;(globalThis as unknown as { chrome: { declarativeNetRequest: { updateSessionRules: (o: unknown) => Promise<void> } } })
      .chrome.declarativeNetRequest.updateSessionRules = async () => { throw new Error("DNR quota") }
    const res = await handleCspActions({ type: "csp_strip", reload: false })
    expect(res.success).toBe(false)
    expect(res.error).toContain("DNR quota")
  })

  test("csp_restore surfaces a read (getSessionRules) failure", async () => {
    const { handleCspActions } = await load()
    ;(globalThis as unknown as { chrome: { declarativeNetRequest: { getSessionRules: () => Promise<unknown> } } })
      .chrome.declarativeNetRequest.getSessionRules = async () => { throw new Error("DNR read failed") }
    const res = await handleCspActions({ type: "csp_restore" })
    expect(res.success).toBe(false)
    expect(res.error).toContain("failed to read CSP bypass state")
  })

  test("csp_restore surfaces a remove (updateSessionRules) failure", async () => {
    const { handleCspActions } = await load()
    await handleCspActions({ type: "csp_strip", reload: false }) // install so restore reaches the remove
    ;(globalThis as unknown as { chrome: { declarativeNetRequest: { updateSessionRules: (o: unknown) => Promise<void> } } })
      .chrome.declarativeNetRequest.updateSessionRules = async () => { throw new Error("remove failed") }
    const res = await handleCspActions({ type: "csp_restore", reload: false })
    expect(res.success).toBe(false)
    expect(res.error).toContain("failed to remove CSP bypass rule")
  })

  test("csp_status surfaces a getSessionRules failure as an error result", async () => {
    const { handleCspActions } = await load()
    ;(globalThis as unknown as { chrome: { declarativeNetRequest: { getSessionRules: () => Promise<unknown> } } })
      .chrome.declarativeNetRequest.getSessionRules = async () => { throw new Error("DNR read failed") }
    const res = await handleCspActions({ type: "csp_status" })
    expect(res.success).toBe(false)
    expect(res.error).toContain("DNR read failed")
  })
})
