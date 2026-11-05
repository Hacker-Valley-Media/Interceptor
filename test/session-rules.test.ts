// Issue #317: the CSP bypass is one shared session rule, and closed tabs leave
// every session rule (on close and at service-worker start), including the
// per-tab rules 2.1.10 and earlier left behind.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { CSP_BYPASS_RULE_ID, installCspBypassForTab } from "../extension/src/background/capabilities/evaluate"
import { planSessionRulePrune, pruneClosedTab, pruneSessionRulesForClosedTabs, registerSessionRuleCleanup } from "../extension/src/background/session-rules"

type Rule = chrome.declarativeNetRequest.Rule

const g = globalThis as unknown as { chrome?: unknown }
let saved: unknown
let rules: Rule[]
let openTabs: number[]
let removedListeners: Array<(tabId: number) => void>

const stripCsp = { type: "modifyHeaders", responseHeaders: [{ header: "content-security-policy", operation: "remove" }] }
const legacyCsp = (tabId: number): Rule => ({ id: 910_000 + tabId, priority: 10, action: stripCsp, condition: { tabIds: [tabId], resourceTypes: ["main_frame"] } } as unknown as Rule)
const cors = (tabId: number): Rule => ({ id: 920_000 + tabId, priority: 10, action: { type: "modifyHeaders" }, condition: { tabIds: [tabId] } } as unknown as Rule)

function fakeChrome(overrides: Record<string, unknown> = {}) {
  return {
    declarativeNetRequest: {
      async getSessionRules() { return structuredClone(rules) },
      async updateSessionRules({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: Rule[] }) {
        rules = rules.filter(rule => !removeRuleIds.includes(rule.id))
        for (const rule of addRules) {
          if (rules.some(r => r.id === rule.id)) throw new Error(`Rule with id ${rule.id} does not have a unique ID.`)
          rules.push(structuredClone(rule))
        }
      },
    },
    tabs: {
      async query() { return openTabs.map(id => ({ id })) },
      onRemoved: { addListener(fn: (tabId: number) => void) { removedListeners.push(fn) } },
    },
    ...overrides,
  }
}

const cspRule = () => rules.find(rule => rule.id === CSP_BYPASS_RULE_ID)
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  saved = g.chrome
  rules = []
  openTabs = []
  removedListeners = []
  g.chrome = fakeChrome()
})
afterEach(() => { g.chrome = saved })

describe("shared CSP bypass rule (issue #317)", () => {
  test("every tab joins one rule, and a repeat install changes nothing", async () => {
    await installCspBypassForTab(11)
    await installCspBypassForTab(12)
    await installCspBypassForTab(11)
    expect(rules).toHaveLength(1)
    expect(cspRule()?.condition.tabIds).toEqual([11, 12])
  })

  test("concurrent installs keep every tab (the read-modify-write is serialized)", async () => {
    await Promise.all([1, 2, 3, 4, 5].map(id => installCspBypassForTab(id)))
    expect(rules).toHaveLength(1)
    expect(cspRule()?.condition.tabIds?.slice().sort()).toEqual([1, 2, 3, 4, 5])
  })

  test("closing a tab removes it, and the rule goes when no tab is left", async () => {
    await installCspBypassForTab(11)
    await installCspBypassForTab(12)
    await pruneClosedTab(11)
    expect(cspRule()?.condition.tabIds).toEqual([12])
    await pruneClosedTab(12)
    expect(rules).toEqual([])
  })
})

describe("closed-tab pruning", () => {
  test("plans per rule: drops closed ids, removes emptied rules, keeps TAB_ID_NONE and untouched rules", () => {
    const shared = { ...legacyCsp(0), id: CSP_BYPASS_RULE_ID, condition: { tabIds: [5, 6, -1] } } as unknown as Rule
    const noTabs = { id: 77, priority: 1, action: stripCsp, condition: { urlFilter: "x" } } as unknown as Rule
    const plan = planSessionRulePrune([shared, legacyCsp(7), cors(8), noTabs], id => id === 6 || id === 8)
    expect(plan.removeRuleIds).toEqual([CSP_BYPASS_RULE_ID, 910_007])
    expect(plan.addRules.map(rule => rule.condition.tabIds)).toEqual([[6, -1]])
  })

  test("the startup sweep clears per-tab rules older versions left for closed tabs and keeps open tabs' rules", async () => {
    rules = [legacyCsp(101), legacyCsp(102), cors(103), legacyCsp(104)]
    openTabs = [104]
    await pruneSessionRulesForClosedTabs()
    expect(rules.map(rule => rule.id)).toEqual([910_104])
  })

  test("the sweep leaves a screenshot CORS rule installed while it runs, for a tab newer than its tab read", async () => {
    rules = [legacyCsp(301)]
    openTabs = []
    g.chrome = fakeChrome({
      tabs: {
        async query() {
          // A new tab's screenshot installs its CORS rule during the sweep (that path does not use the queue).
          rules.push(cors(999))
          return openTabs.map(id => ({ id }))
        },
        onRemoved: { addListener() {} },
      },
    })
    await pruneSessionRulesForClosedTabs()
    expect(rules.map(rule => rule.id)).toEqual([920_999])
  })

  test("registration wires tab close and runs the sweep", async () => {
    rules = [legacyCsp(201), legacyCsp(202)]
    openTabs = [202]
    registerSessionRuleCleanup()
    await settle()
    expect(rules.map(rule => rule.id)).toEqual([910_202])
    expect(removedListeners).toHaveLength(1)
    removedListeners[0](202)
    await settle()
    expect(rules).toEqual([])
  })

  test("never throws into startup when the runtime refuses declarativeNetRequest (Electron) or lacks tabs", async () => {
    const refuse = async () => { throw new Error("declarativeNetRequest is not available on Electron Path 0") }
    g.chrome = fakeChrome({ declarativeNetRequest: { getSessionRules: refuse, updateSessionRules: refuse } })
    expect(() => registerSessionRuleCleanup()).not.toThrow()
    g.chrome = {}
    expect(() => registerSessionRuleCleanup()).not.toThrow()
    g.chrome = undefined
    expect(() => registerSessionRuleCleanup()).not.toThrow()
    await settle()
    // A failed step does not wedge the queue for the next one.
    g.chrome = fakeChrome()
    await installCspBypassForTab(9)
    expect(cspRule()?.condition.tabIds).toEqual([9])
  })
})
