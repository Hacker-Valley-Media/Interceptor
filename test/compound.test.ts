import { describe, expect, test, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildReadTreeAction, buildTabCreateAction, resolveReadTargetTabId } from "../cli/commands/compound"
import { saveDesignatedTab } from "../cli/commands/session-tab"
import { parseElementTarget } from "../cli/parse"

describe("resolveReadTargetTabId — read's designated-tab fallback", () => {
  let home: string

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true })
  })

  test("an explicit --tab wins over any designation", () => {
    home = mkdtempSync(join(tmpdir(), "interceptor-read-fallback-"))
    saveDesignatedTab(999, home)
    expect(resolveReadTargetTabId(123, home)).toBe(123)
  })

  test("falls back to the designated tab when no --tab is given", () => {
    home = mkdtempSync(join(tmpdir(), "interceptor-read-fallback-"))
    saveDesignatedTab(592791482, home)
    expect(resolveReadTargetTabId(undefined, home)).toBe(592791482)
  })

  test("resolves to undefined (daemon's active-tab default) when nothing is designated", () => {
    home = mkdtempSync(join(tmpdir(), "interceptor-read-fallback-"))
    expect(resolveReadTargetTabId(undefined, home)).toBeUndefined()
  })
})

describe("buildReadTreeAction", () => {
  test("passes subtree targeting into get_a11y_tree for regular reads", () => {
    const target = parseElementTarget("e7")
    const action = buildReadTreeAction({
      target,
      filterMode: "interactive",
      includeStyle: true,
      includeFrames: false
    })

    expect(action).toMatchObject({
      type: "get_a11y_tree",
      ref: "e7",
      includeStyle: true,
      filter: "interactive"
    })
  })

  test("passes frame and ref targeting into frames_read_tree", () => {
    const target = parseElementTarget("e9_2")
    const action = buildReadTreeAction({
      target,
      filterMode: "interactive",
      includeStyle: false,
      includeFrames: true
    })

    expect(action).toMatchObject({
      type: "frames_read_tree",
      frameId: 9,
      ref: "e2",
      includeStyle: false,
      filter: "interactive"
    })
  })
})

describe("buildTabCreateAction", () => {
  test("omits reuse field by default — preserves existing create-new-tab semantics", () => {
    const action = buildTabCreateAction(["open", "https://example.com"], "https://example.com")
    expect(action).toEqual({ type: "tab_create", url: "https://example.com" })
    expect("reuse" in action).toBe(false)
  })

  test("sets reuse: true when --reuse is present in filtered args", () => {
    const action = buildTabCreateAction(
      ["open", "https://example.com", "--reuse"],
      "https://example.com"
    )
    expect(action).toEqual({ type: "tab_create", url: "https://example.com", reuse: true })
  })

  test("does NOT set reuse when other open flags are present without --reuse", () => {
    const action = buildTabCreateAction(
      ["open", "https://example.com", "--full", "--tree-only"],
      "https://example.com"
    )
    expect(action.reuse).toBeUndefined()
  })
})
