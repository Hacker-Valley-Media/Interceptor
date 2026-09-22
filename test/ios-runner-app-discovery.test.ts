import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findRunnerApp } from "../daemon/ios/tools"

// xcodebuild writes device products to Debug-iphoneos/ and simulator products to
// Debug-iphonesimulator/. The daemon used to look only at the first, so a simulator
// runner needed a symlink to be found.

const roots: string[] = []
function products(layout: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "ic-runner-"))
  roots.push(root)
  for (const p of layout) mkdirSync(join(root, p), { recursive: true })
  return root
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

describe("findRunnerApp", () => {
  test("top-level app wins", () => {
    const root = products(["X-Runner.app", "Debug-iphoneos/Y-Runner.app"])
    expect(findRunnerApp(root)).toBe(join(root, "X-Runner.app"))
  })

  test("device folder", () => {
    const root = products(["Debug-iphoneos/X-Runner.app"])
    expect(findRunnerApp(root)).toBe(join(root, "Debug-iphoneos", "X-Runner.app"))
  })

  test("simulator folder, no symlink", () => {
    const root = products(["Debug-iphonesimulator/X-Runner.app"])
    expect(findRunnerApp(root)).toBe(join(root, "Debug-iphonesimulator", "X-Runner.app"))
  })

  test("device folder before simulator folder", () => {
    const root = products(["Debug-iphonesimulator/S-Runner.app", "Debug-iphoneos/D-Runner.app"])
    expect(findRunnerApp(root)).toBe(join(root, "Debug-iphoneos", "D-Runner.app"))
  })

  test("nothing there, or no such dir", () => {
    expect(findRunnerApp(products(["Debug-iphoneos", "other/X-Runner.app"]))).toBeUndefined()
    expect(findRunnerApp(join(tmpdir(), "ic-runner-does-not-exist"))).toBeUndefined()
  })
})
