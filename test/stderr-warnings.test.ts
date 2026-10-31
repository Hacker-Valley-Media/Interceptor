// Success warnings go to stderr in text mode; MCP keeps them.
import { describe, expect, test } from "bun:test"
import { printResult } from "../cli/format"
import { toResult } from "../cli/mcp/output"

function capture(fn: () => void): { out: string; err: string } {
  const out: string[] = [], err: string[] = []
  const log = console.log, error = console.error
  console.log = (...a: unknown[]) => { out.push(a.join(" ")) }
  console.error = (...a: unknown[]) => { err.push(a.join(" ")) }
  try { fn() } finally { console.log = log; console.error = error }
  return { out: out.join("\n"), err: err.join("\n") }
}

describe("printResult", () => {
  test("success: value on stdout, warning on stderr", () => {
    const r = capture(() => printResult({ success: true, data: "Editor Lab baseline text", warning: "DOM has changed since last state read" }, false))
    expect(r.out).toBe("Editor Lab baseline text")
    expect(r.err).toBe("warning: DOM has changed since last state read")
  })

  test("errors and --json are unchanged", () => {
    const e = capture(() => printResult({ success: false, error: "boom", warning: "w" }, false))
    expect(e.out).toBe("error: boom\nwarning: w")
    const j = capture(() => printResult({ success: true, data: "v", warning: "w" }, true))
    expect(JSON.parse(j.out)).toEqual({ success: true, data: "v", warning: "w" })
    expect(j.err).toBe("")
  })
})

describe("MCP keeps warnings", () => {
  test("stderr warning lines are appended to the text result", async () => {
    const r = await toResult({ surface: "browser", verb: "click", run: { stdout: "ok", stderr: "warning: DOM has changed since last state read\n", code: 0 }, fenceEnabled: false })
    expect(r.content[0]).toEqual({ type: "text", text: "ok\nwarning: DOM has changed since last state read" })
  })

  test("no warning, no change", async () => {
    const r = await toResult({ surface: "browser", verb: "click", run: { stdout: "ok", stderr: "", code: 0 }, fenceEnabled: false })
    expect(r.content[0]).toEqual({ type: "text", text: "ok" })
  })
})
