import { describe, expect, test, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadDesignatedTab, saveDesignatedTab, clearDesignatedTab } from "../cli/commands/session-tab"

describe("session-tab — designated working tab state", () => {
  let home: string

  function freshHome(): string {
    home = mkdtempSync(join(tmpdir(), "interceptor-session-tab-"))
    return home
  }

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true })
  })

  test("returns undefined when nothing has been designated", () => {
    expect(loadDesignatedTab(freshHome())).toBeUndefined()
  })

  test("round-trips a designated tab id", () => {
    const h = freshHome()
    saveDesignatedTab(592791482, h)
    expect(loadDesignatedTab(h)).toBe(592791482)
  })

  test("re-designating overwrites the previous tab id", () => {
    const h = freshHome()
    saveDesignatedTab(111, h)
    saveDesignatedTab(222, h)
    expect(loadDesignatedTab(h)).toBe(222)
  })

  test("clearDesignatedTab removes the designation", () => {
    const h = freshHome()
    saveDesignatedTab(333, h)
    clearDesignatedTab(h)
    expect(loadDesignatedTab(h)).toBeUndefined()
  })

  test("survives a corrupt state file by returning undefined", async () => {
    const h = freshHome()
    saveDesignatedTab(444, h)
    await Bun.write(join(h, ".interceptor", "session-tab.json"), "not json")
    expect(loadDesignatedTab(h)).toBeUndefined()
  })
})
