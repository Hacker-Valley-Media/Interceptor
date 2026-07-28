import { describe, expect, test, afterEach, beforeEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseTabsCommand } from "../cli/commands/tabs"
import { loadDesignatedTab } from "../cli/commands/session-tab"

// `tab designate <id>` / `tab self` write to and read from ~/.interceptor —
// point HOME at a scratch dir for the duration of each test so these never
// touch (or depend on) the real machine's designated tab.
describe("tab designate / tab self", () => {
  let home: string
  let originalHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "interceptor-tab-designate-"))
    originalHome = process.env.HOME
    process.env.HOME = home
  })

  afterEach(() => {
    process.env.HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  test("tab designate <id> writes the session file and confirms", async () => {
    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)
    try {
      const result = await parseTabsCommand(["tab", "designate", "592791482"])
      expect(result).toBeNull()
    } finally {
      console.log = origLog
    }
    expect(logs.join("\n")).toContain("Designated tab 592791482 as working tab")
    expect(loadDesignatedTab()).toBe(592791482)
  })

  test("tab designate <id> --json emits structured output", async () => {
    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)
    try {
      await parseTabsCommand(["tab", "designate", "42"], true)
    } finally {
      console.log = origLog
    }
    expect(JSON.parse(logs[0])).toEqual({ tab_id: 42, designated: true })
  })

  test("tab self returns the previously designated tab", async () => {
    await parseTabsCommand(["tab", "designate", "777"])

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)
    try {
      const result = await parseTabsCommand(["tab", "self"])
      expect(result).toBeNull()
    } finally {
      console.log = origLog
    }
    expect(logs).toEqual(["777"])
  })

  test("tab self --json returns structured output", async () => {
    await parseTabsCommand(["tab", "designate", "888"])

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)
    try {
      await parseTabsCommand(["tab", "self"], true)
    } finally {
      console.log = origLog
    }
    expect(JSON.parse(logs[0])).toEqual({ tab_id: 888 })
  })

  test("tab self with nothing designated exits with an actionable error", async () => {
    const errors: string[] = []
    const origError = console.error
    const origExit = process.exit
    console.error = (msg: string) => errors.push(msg)
    let exitCode: number | undefined
    process.exit = ((code?: number) => { exitCode = code; throw new Error("exit") }) as typeof process.exit
    try {
      await parseTabsCommand(["tab", "self"])
    } catch {
      // expected: process.exit throws in this stub
    } finally {
      console.error = origError
      process.exit = origExit
    }
    expect(exitCode).toBe(1)
    expect(errors.join("\n")).toContain("No tab designated")
    expect(errors.join("\n")).toContain("interceptor tab designate")
  })

  test("tab <id> shorthand routes to tab_switch", async () => {
    const action = await parseTabsCommand(["tab", "592791482"])
    expect(action).toEqual({ type: "tab_switch", tabId: 592791482 })
  })
})
