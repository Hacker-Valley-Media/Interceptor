// --full delivers what the help says; a cut never breaks a value.
import { describe, expect, test } from "bun:test"
import { MAX_RESPONSE_CHARS, responseCapFor, truncateResponse } from "../daemon/outbound-routing"
import { evalCutMessage } from "../cli/commands/eval"
import { textCap } from "../cli/commands/compound"

describe("daemon response cap", () => {
  test("per-request caps", () => {
    expect(responseCapFor({ type: "evaluate" })).toBe(200_000)
    expect(responseCapFor({ type: "extract_text", maxChars: 200_000 })).toBe(202_000)
    expect(responseCapFor({ type: "extract_text" })).toBe(MAX_RESPONSE_CHARS)
    expect(responseCapFor({ type: "extract_html", maxChars: 1000 })).toBe(MAX_RESPONSE_CHARS)
    expect(responseCapFor(undefined)).toBe(MAX_RESPONSE_CHARS)
  })

  test("a cut says so in the text and in truncated", () => {
    const data = "x".repeat(60_000)
    const out = JSON.parse(truncateResponse(JSON.stringify({ id: "1", result: { success: true, data } })))
    expect(out.result.truncated).toEqual({ shown: 50_000, total: 60_000 })
    expect(out.result.data.endsWith("\n... (truncated: showed 50000 of 60000 chars)")).toBe(true)
  })

  test("under the cap, objects, and a raised cap pass untouched", () => {
    const small = JSON.stringify({ id: "1", result: { success: true, data: "ok" } })
    expect(truncateResponse(small)).toBe(small)
    const obj = JSON.stringify({ id: "1", result: { success: true, data: { rows: "y".repeat(60_000) } } })
    expect(truncateResponse(obj)).toBe(obj)
    const big = JSON.stringify({ id: "1", result: { success: true, data: "z".repeat(150_000) } })
    expect(truncateResponse(big, 202_000)).toBe(big)
  })
})

describe("CLI", () => {
  test("a cut eval value is an error naming save --out", () => {
    expect(evalCutMessage({ success: true, data: "x", truncated: { shown: 200_000, total: 250_000 } })).toContain("save --out")
    expect(evalCutMessage({ success: true, data: "abc\n... (truncated)" })).toContain("save --out")
    expect(evalCutMessage({ success: true, data: "abc\n... (truncated: showed 50000 of 60000 chars)" })).toContain("save --out")
    expect(evalCutMessage({ success: true, data: "a whole value" })).toBeNull()
    expect(evalCutMessage({ success: false, error: "x" } as never)).toBeNull()
  })

  test("--full asks for the extension's 200K page text", () => {
    expect(textCap(true)).toEqual({ maxChars: 200_000 })
    expect(textCap(false)).toEqual({})
  })
})
