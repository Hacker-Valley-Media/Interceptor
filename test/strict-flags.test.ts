/**
 * test/strict-flags.test.ts
 *
 * Issue #212: unknown CLI flags exited 0 and looked like success
 * (`screenshot --out <path>` wrote nothing). normalizeArgsSplit now rejects
 * flags outside the per-family inventory. The table-driven block walks the
 * ENTIRE inventory so a flag added to a command module but not to the map
 * fails CI here instead of regressing into a strict-mode rejection.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { normalizeArgs, normalizeArgsSplit, FLAG_INVENTORY } from "../cli/normalize"

let exitCode: number | undefined
let errors: string[] = []
const realExit = process.exit
const realConsoleError = console.error

beforeEach(() => {
  exitCode = undefined
  errors = []
  process.exit = ((code?: number) => {
    exitCode = code
    throw new Error(`__exit_${code}`)
  }) as never
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")) }
  delete process.env.INTERCEPTOR_LAX_FLAGS
})

afterEach(() => {
  process.exit = realExit
  console.error = realConsoleError
  delete process.env.INTERCEPTOR_LAX_FLAGS
})

describe("strict unknown-flag rejection (#212)", () => {
  test("a typo'd flag exits 1 naming the flag and the command", () => {
    expect(() => normalizeArgs(["screenshot", "--zzz-nonsense-flag", "foo"])).toThrow("__exit_1")
    expect(exitCode).toBe(1)
    expect(errors.join("\n")).toContain("unknown flag '--zzz-nonsense-flag' for 'screenshot'")
  })

  test("the issue's sharpest trap: screenshot --out points at --save", () => {
    expect(() => normalizeArgs(["screenshot", "--out", "/tmp/shot.png"])).toThrow("__exit_1")
    expect(errors.join("\n")).toContain("'screenshot --save' writes the image to disk")
  })

  test("--flag=value form validates the name before '='", () => {
    expect(() => normalizeArgs(["open", "--bogus=1", "https://example.com"])).toThrow("__exit_1")
    expect(errors.join("\n")).toContain("unknown flag '--bogus=1' for 'open'")
  })

  test("INTERCEPTOR_LAX_FLAGS=1 downgrades to a warning and keeps going", () => {
    process.env.INTERCEPTOR_LAX_FLAGS = "1"
    const argv = normalizeArgs(["screenshot", "--zzz-lax-flag"])
    expect(exitCode).toBeUndefined()
    expect(argv).toEqual(["screenshot", "--zzz-lax-flag"])
  })

  test("single-dash tokens stay positionals (negative scroll amounts)", () => {
    expect(normalizeArgs(["scroll", "-100"])).toEqual(["scroll", "-100"])
    expect(exitCode).toBeUndefined()
  })

  test("'--' terminator admits flag-looking positionals", () => {
    const norm = normalizeArgsSplit(["type", "e1", "--", "--whatever"])
    expect(norm.argv).toEqual(["type", "e1", "--whatever"])
    expect(norm.positionalCount).toBe(2)
    expect(exitCode).toBeUndefined()
  })

  test("un-normalized surfaces (macos/ios/mcp/update) are untouched", () => {
    expect(normalizeArgs(["macos", "tree", "--zzz"])).toEqual(["macos", "tree", "--zzz"])
    expect(exitCode).toBeUndefined()
  })
})

describe("the whole inventory is accepted (table-driven)", () => {
  for (const [cmd, valueFlags] of Object.entries(FLAG_INVENTORY.value)) {
    test(`every declared flag parses for '${cmd}'`, () => {
      for (const flag of valueFlags) {
        normalizeArgsSplit([cmd, flag, "x"])
      }
      for (const flag of FLAG_INVENTORY.boolean[cmd] || []) {
        normalizeArgsSplit([cmd, flag])
      }
      for (const flag of FLAG_INVENTORY.globalValue) {
        normalizeArgsSplit([cmd, flag, "x"])
      }
      for (const flag of FLAG_INVENTORY.globalBoolean) {
        if (flag.startsWith("--")) normalizeArgsSplit([cmd, flag])
      }
      expect(exitCode).toBeUndefined()
    })
  }
})
