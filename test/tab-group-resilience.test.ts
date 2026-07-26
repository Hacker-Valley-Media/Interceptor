import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  addTabToInterceptorGroup,
  addTabToNamedGroup,
} from "../extension/src/background/tab-group"

// tab_create must survive a grouping failure — grouping is a UX nicety, not a
// hard requirement. Two failure modes are covered here:
//   1. The new tab landed in a non-normal window (popup/devtools/app). Tab
//      groups are window-scoped; chrome.tabs.group would reject with "Tabs can
//      only be moved to and from normal windows". We must SKIP (return -1),
//      never throw.
//   2. chrome.tabs.group throws anyway (cross-window group mismatch, transient
//      failure). Same contract: return -1, don't propagate.
// Both the default (interceptor) group path and the named per-agent group path
// must honour this — the named path is new upstream surface our original fix
// never covered.

type WindowType = "normal" | "popup" | "app" | "devtools"

const g = globalThis as unknown as { chrome?: unknown }
let savedChrome: unknown

// Build a minimal chrome mock. `windowType` controls what chrome.windows.get
// reports for the tab's window; `groupThrows` forces chrome.tabs.group to fail.
function installChromeMock(opts: {
  windowType: WindowType
  groupThrows?: boolean
}) {
  const calls = { group: 0, update: 0 }
  ;(g as { chrome: unknown }).chrome = {
    tabs: {
      get: async (_id: number) => ({ id: _id, windowId: 1 }),
      async group() {
        calls.group++
        if (opts.groupThrows) throw new Error("Tabs can only be moved to and from normal windows")
        return 4242
      },
    },
    tabGroups: {
      query: async () => [], // no existing group -> create path
      get: async () => { throw new Error("no such group") },
      async update() { calls.update++ },
    },
    windows: {
      get: async (_id: number) => ({ id: _id, type: opts.windowType }),
    },
    storage: {}, // session area absent -> persistNamedGroups no-ops
  }
  return calls
}

beforeEach(() => { savedChrome = g.chrome })
afterEach(() => { (g as { chrome: unknown }).chrome = savedChrome })

describe("tab grouping resilience — default (interceptor) group", () => {
  test("non-normal window: skips grouping without calling chrome.tabs.group", async () => {
    const calls = installChromeMock({ windowType: "popup" })
    const result = await addTabToInterceptorGroup(101)
    expect(result).toBe(-1)
    expect(calls.group).toBe(0)
  })

  test("chrome.tabs.group throwing is swallowed to -1 (tab_create survives)", async () => {
    const calls = installChromeMock({ windowType: "normal", groupThrows: true })
    const result = await addTabToInterceptorGroup(102)
    expect(result).toBe(-1)
    expect(calls.group).toBe(1) // it tried, then swallowed the throw
  })

  test("normal window, group succeeds: returns the group id", async () => {
    installChromeMock({ windowType: "normal" })
    const result = await addTabToInterceptorGroup(103)
    expect(result).toBe(4242)
  })
})

describe("tab grouping resilience — named per-agent group", () => {
  test("non-normal window: skips grouping without calling chrome.tabs.group", async () => {
    const calls = installChromeMock({ windowType: "devtools" })
    const result = await addTabToNamedGroup(201, "ai1")
    expect(result).toBe(-1)
    expect(calls.group).toBe(0)
  })

  test("chrome.tabs.group throwing is swallowed to -1 (tab_create survives)", async () => {
    const calls = installChromeMock({ windowType: "normal", groupThrows: true })
    const result = await addTabToNamedGroup(202, "ai2")
    expect(result).toBe(-1)
    expect(calls.group).toBe(1)
  })

  test("normal window, group succeeds: returns the group id", async () => {
    installChromeMock({ windowType: "normal" })
    const result = await addTabToNamedGroup(203, "ai3")
    expect(result).toBe(4242)
  })
})
