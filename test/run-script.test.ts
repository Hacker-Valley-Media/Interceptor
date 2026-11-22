// Interceptor run parses one command per line.
import { describe, expect, test } from "bun:test"
import { splitLine, parseScript, globalFlags, formatStep, STEP_OUTPUT_CHARS } from "../cli/commands/run"

describe("splitLine", () => {
  test("quotes and escapes", () => {
    expect(splitLine(`act e5 "hello world" --submit`)).toEqual(["act", "e5", "hello world", "--submit"])
    expect(splitLine(`find 'a b' c`)).toEqual(["find", "a b", "c"])
    expect(splitLine(`find it\\ is`)).toEqual(["find", "it is"])
    expect(splitLine(`type e1 "say \\"hi\\""`)).toEqual(["type", "e1", `say "hi"`])
    expect(splitLine(`act '[e5]'`)).toEqual(["act", "[e5]"])
    expect(splitLine(`eval ""`)).toEqual(["eval", ""])
    expect(() => splitLine(`find "open`)).toThrow("unterminated")
  })
})

describe("parseScript", () => {
  test("comments, blanks, an interceptor prefix and expect", () => {
    const steps = parseScript(`# login\n\ninterceptor open https://example.com\nact e5 "x" --submit\nexpect --text "Results"\n`)
    expect(steps.map(s => s.argv)).toEqual([["open", "https://example.com"], ["act", "e5", "x", "--submit"], ["verify", "--text", "Results"]])
    expect(steps.map(s => s.line)).toEqual([3, 4, 5])
  })
  test("no nested run", () => {
    expect(() => parseScript("run other.txt")).toThrow("run cannot run another run")
  })
})

test("globalFlags forwards the run's own scope", () => {
  expect(globalFlags(["--context", "main", "run", "-", "--group", "x", "--any-tab", "--keep-going"])).toEqual(["--context", "main", "--group", "x", "--any-tab"])
  expect(globalFlags(["run", "--tab=12", "-", "--", "--context", "z"])).toEqual(["--tab=12"])
})

test("non-final step output is capped; the last is whole", () => {
  const long = "x".repeat(STEP_OUTPUT_CHARS + 100)
  const r = { line: 1, command: "read", code: 0, ms: 5, stdout: long, stderr: "" }
  expect(formatStep(r, 0, 2, false, false)).toContain("step output cut")
  expect(formatStep(r, 1, 2, false, true)).not.toContain("step output cut")
  expect(formatStep({ ...r, code: 1, stdout: "error: nope" }, 0, 2, false, false).split("\n")[0]).toBe("[1/2] read  (failed, exit 1, 5 ms)")
})
