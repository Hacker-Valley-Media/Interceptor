import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { normalizeArgs } from "../cli/normalize"
import { parseActionsCommand } from "../cli/commands/actions"
import { parseElementTarget } from "../cli/parse"

// In-process on purpose: spawning the CLI would hit the daemon preflight
// first on machines without an installed daemon (CI), masking the parse
// guards under test. Intercepting process.exit exercises the exact
// normalizeArgs → parseActionsCommand path the binary runs after preflight.

class ExitSignal extends Error {
  constructor(public code: number) { super(`exit ${code}`) }
}

let realExit: typeof process.exit
let realError: typeof console.error
let stderrLines: string[]

beforeEach(() => {
  realExit = process.exit
  realError = console.error
  stderrLines = []
  process.exit = ((code?: number) => { throw new ExitSignal(code ?? 0) }) as typeof process.exit
  console.error = (...args: unknown[]) => { stderrLines.push(args.join(" ")) }
})

afterEach(() => {
  process.exit = realExit
  console.error = realError
})

function runParse(argv: string[]): { code: number; stderr: string } {
  try {
    parseActionsCommand(normalizeArgs(argv))
  } catch (e) {
    if (e instanceof ExitSignal) return { code: e.code, stderr: stderrLines.join("\n") }
    throw e
  }
  throw new Error("expected the parser to exit")
}

describe("bare element-target verbs exit with usage, not a TypeError", () => {
  for (const verb of ["click", "type", "select", "hover", "dblclick", "rightclick", "check"]) {
    test(`${verb} with no target`, () => {
      const { code, stderr } = runParse([verb])
      expect(code).toBe(1)
      expect(stderr).toContain("requires an element target")
    })
  }

  test("parseElementTarget guards undefined directly (covers attr/style in meta)", () => {
    try {
      parseElementTarget(undefined as unknown as string)
      throw new Error("expected exit")
    } catch (e) {
      expect(e).toBeInstanceOf(ExitSignal)
      expect((e as ExitSignal).code).toBe(1)
    }
    expect(stderrLines.join("\n")).toContain("requires an element target")
  })
})

describe("click --selector argument validation", () => {
  test("--selector with no value errors instead of becoming a bogus ref", () => {
    const { code, stderr } = runParse(["click", "--selector"])
    expect(code).toBe(1)
    expect(stderr).toContain("--selector requires a CSS selector value")
  })

  test("--nth without --selector", () => {
    const { code, stderr } = runParse(["click", "--nth", "4"])
    expect(code).toBe(1)
    expect(stderr).toContain("--nth requires --selector")
  })

  test("--nth rejects a non-integer", () => {
    const { code, stderr } = runParse(["click", "--selector", "button", "--nth", "abc"])
    expect(code).toBe(1)
    expect(stderr).toContain("non-negative integer")
  })

  test("--nth rejects a negative index", () => {
    const { code, stderr } = runParse(["click", "--selector", "button", "--nth", "-2"])
    expect(code).toBe(1)
    expect(stderr).toContain("non-negative integer")
  })

  test("a valid selector + nth parses into a click_selector action", () => {
    const action = parseActionsCommand(normalizeArgs(["click", "--selector", "button span", "--nth", "4"]))
    expect(action).toEqual({ type: "click_selector", selector: "button span", nth: 4 })
  })
})
