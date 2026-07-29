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

  test("a write failure prints a clean error and exits 1 instead of throwing", async () => {
    const h = freshHome()
    // Put a plain file where ~/.interceptor should be a directory, so the
    // write into it fails with ENOTDIR.
    await Bun.write(join(h, ".interceptor"), "not a directory")

    const errors: string[] = []
    const origError = console.error
    const origExit = process.exit
    console.error = (msg: string) => errors.push(msg)
    let exitCode: number | undefined
    process.exit = ((code?: number) => { exitCode = code; throw new Error("exit") }) as typeof process.exit
    try {
      expect(() => saveDesignatedTab(555, h)).toThrow("exit")
    } finally {
      console.error = origError
      process.exit = origExit
    }
    expect(exitCode).toBe(1)
    expect(errors.join("\n")).toContain("error: failed to save designated tab")
  })
})
