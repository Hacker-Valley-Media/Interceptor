import { describe, expect, test } from "bun:test"
import inventory from "../scripts/desktop-parity/inventory.json"
import { coverageGaps, type Row } from "../scripts/desktop-parity/coverage"
import { families, exclusions } from "../scripts/desktop-parity/cases/index"
import { judge, expectationFor, ok, refuse, macOnly, type Res, type Family } from "../scripts/desktop-parity/types"

const res = (exit: number, json: any): Res => ({ exit, json, stdout: JSON.stringify(json), stderr: "", ms: 1, timedOut: false })

describe("desktop parity coverage gate", () => {
  test("every inventory subcommand and flag has a case or a recorded exclusion", () => {
    expect(coverageGaps((inventory as { rows: Row[] }).rows, families, exclusions)).toEqual([])
  })
  test("a missing flag and a missing subcommand are reported", () => {
    const rows: Row[] = [{ family: "f", sub: "a", flags: ["--x", "--on|--off"] }, { family: "f", sub: "b", flags: [] }]
    const fams: Family[] = [{ family: "f", cases: [{ id: "f.a", sub: "a", args: ["f", "a", "--on"] }] }]
    expect(coverageGaps(rows, fams, [])).toEqual(["f a: flag --x not exercised", "f a: flag --off not exercised", "f b: no case"])
    expect(coverageGaps(rows, fams, [{ family: "f", sub: "a", flag: "--x", reason: "r" }, { family: "f", sub: "b", reason: "r" }])).toEqual(["f a: flag --off not exercised"])
  })
  test("case ids are unique", () => {
    const ids = families.flatMap(f => f.cases.map(c => c.id))
    expect(ids.length).toBe(new Set(ids).size)
  })
})

describe("desktop parity expectations", () => {
  test("ok needs exit 0 and no success:false", () => {
    expect(judge(ok, res(0, { a: 1 }))).toBeUndefined()
    expect(judge(ok, res(1, { success: false, error: "no" }))).toContain("expected success")
  })
  test("refuse checks the code and error text when given", () => {
    expect(judge(refuse("unsupported_operation"), res(1, { success: false, code: "unsupported_operation" }))).toBeUndefined()
    expect(judge(refuse("unsupported_operation"), res(1, { success: false, code: "invalid_request" }))).toContain("expected code")
    expect(judge(refuse(undefined, /whisper/), res(1, { success: false, error: "engine bundle unavailable" }))).toContain("does not match")
    expect(judge(refuse(), res(0, {}))).toBe("expected a refusal, got success")
  })
  test("macOnly refuses on Windows and Linux and passes on the Mac", () => {
    const c = { id: "x", sub: "-", args: [], expect: macOnly() }
    expect("refuse" in expectationFor(c, "win32")).toBe(true)
    expect("refuse" in expectationFor(c, "linux")).toBe(true)
    expect(expectationFor(c, "darwin")).toEqual(ok)
  })
})
