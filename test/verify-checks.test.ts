// Verify answers passed, failed or unverifiable per check.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseVerifyArgs, checkFile, checkPage, checkApp, pageVerdict, overall, formatVerify, VERIFY_EXIT, STALE_EXTENSION_OBSERVED, staleHintFor, sendOrUnreadable } from "../cli/commands/verify"
import { staleExtensionHintLine } from "../cli/commands/diagnose"

describe("parse", () => {
  test("page, file and app checks", () => {
    const p = parseVerifyArgs(["--text", "Saved", "--url", "/done", "--selector", ".row", "--count", "3", "--file", "/tmp/x.csv", "--contains", "total", "--app", "TextEdit", "--ax-text", "Hello"])
    expect(p.page).toEqual([{ kind: "text", value: "Saved" }, { kind: "url", value: "/done" }, { kind: "selector", value: ".row", count: 3 }])
    expect(p.file).toMatchObject({ path: "/tmp/x.csv", contains: "total" })
    expect(p.app).toEqual({ name: "TextEdit", axText: "Hello", windowTitle: undefined })
    expect(p.timeout).toBe(0)
  })
  test("refuses empty and dangling checks", () => {
    expect(() => parseVerifyArgs([])).toThrow("at least one check")
    expect(() => parseVerifyArgs(["--contains", "x"])).toThrow("goes with --file")
    expect(() => parseVerifyArgs(["--app", "Finder"])).toThrow("--ax-text")
    expect(() => parseVerifyArgs(["--ax-text", "x"])).toThrow("go with --app")
    expect(() => parseVerifyArgs(["--count", "2"])).toThrow("--selector")
    expect(() => parseVerifyArgs(["--text"])).toThrow("requires a value")
  })
})

describe("file checks", () => {
  test("exists, size, age, contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-checks-"))
    try {
      const f = join(dir, "out.csv")
      writeFileSync(f, "a,b\ntotal,9\n")
      const ok = checkFile({ path: f, contains: "total", minBytes: 5, modifiedWithin: 60 })
      expect(ok.map(r => r.status)).toEqual(["passed", "passed", "passed", "passed"])
      const old = Date.now() / 1000 - 3600
      utimesSync(f, old, old)
      const bad = checkFile({ path: f, contains: "missing", minBytes: 999, modifiedWithin: 60 })
      expect(bad.slice(1).map(r => r.status)).toEqual(["failed", "failed", "failed"])
      expect(checkFile({ path: join(dir, "nope") })).toEqual([{ check: `file ${join(dir, "nope")}`, status: "failed", observed: "no such file" }])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe("page checks", () => {
  const c = { kind: "text" as const, value: "Saved" }
  test("met, not met, and could not look", () => {
    expect(pageVerdict(c, { success: true, data: { met: true, observed: "found" } }).status).toBe("passed")
    expect(pageVerdict(c, { success: false, error: "not met", data: { met: false, observed: "x" } }).status).toBe("failed")
    expect(pageVerdict(c, { success: false, error: "no tab", data: { met: null } }).status).toBe("unverifiable")
    expect(pageVerdict(c, { success: false, error: "no browser context connected" }).status).toBe("unverifiable")
  })
  test("sends one wait_condition per check with the plan's timeout", async () => {
    const sent: unknown[] = []
    const r = await checkPage({ page: [c, { kind: "selector", value: "#a", count: 2 }], timeout: 0 }, async (a) => { sent.push(a); return { success: true, data: { met: true } } })
    expect(sent).toEqual([{ type: "wait_condition", kind: "text", timeout: 0, text: "Saved" }, { type: "wait_condition", kind: "selector", timeout: 0, selector: "#a", count: 2 }])
    expect(r.every(x => x.status === "passed")).toBe(true)
  })
  test("an old extension is unverifiable, and the copy-specific hint is added once", async () => {
    const results = await checkPage({ page: [c, { kind: "url", value: "/done" }], timeout: 0 }, async () => ({ success: false, error: "unknown action type: wait_condition" }))
    expect(results.map(r => r.status)).toEqual(["unverifiable", "unverifiable"])
    expect(results[0].observed).toBe(STALE_EXTENSION_OBSERVED)
    let calls = 0
    const storeLine = staleExtensionHintLine("2.1.15", { contextId: "main", version: "2.1.12", installType: "normal" })
    expect(await staleHintFor(results, async () => { calls++; return storeLine })).toBe(storeLine)
    expect(calls).toBe(1)
    expect(storeLine).toContain("only changes when the store publishes")
    const unpackedLine = staleExtensionHintLine("2.1.15", { contextId: "lab", version: "2.1.14", installType: "development" })
    expect(unpackedLine).toContain("interceptor reload --context lab")
  })

  test("no hint when every page check ran", async () => {
    const results = await checkPage({ page: [c], timeout: 0 }, async () => ({ success: true, data: { met: true } }))
    expect(await staleHintFor(results, async () => "hint: x")).toBeUndefined()
  })
})

describe("app checks", () => {
  test("found, not found, app not running", async () => {
    const hit = await checkApp({ name: "F", axText: "Submit" }, async () => ({ success: true, data: [{ ref: "e1", role: "button", name: "Submit" }] }))
    expect(hit[0].status).toBe("passed")
    const miss = await checkApp({ name: "F", axText: "Submit" }, async () => ({ success: true, data: [] }))
    expect(miss[0].status).toBe("failed")
    const gone = await checkApp({ name: "F", axText: "Submit" }, async () => ({ success: false, error: "no target app found" }))
    expect(gone[0].status).toBe("unverifiable")
    const win = await checkApp({ name: "F", windowTitle: "fixture" }, async () => ({ success: true, data: [{ title: "Interceptor Parity Fixture" }] }))
    expect(win[0].status).toBe("passed")
  })
})

test("overall and exit codes", () => {
  expect(overall([{ check: "a", status: "passed", observed: "" }, { check: "b", status: "unverifiable", observed: "" }])).toBe("unverifiable")
  expect(overall([{ check: "a", status: "failed", observed: "" }, { check: "b", status: "unverifiable", observed: "" }])).toBe("failed")
  expect(VERIFY_EXIT).toEqual({ passed: 0, failed: 1, unverifiable: 2 })
  expect(formatVerify([{ check: "a", status: "passed", observed: "ok" }])).toBe("passed: a (ok)\nverify: passed (1/1 passed)")
})

test("a daemon that cannot start makes page and app checks unverifiable, not an exit 1", async () => {
  const send = sendOrUnreadable("error: daemon failed to start. Check /tmp/x.log", async () => { throw new Error("must not be called") })
  const page = await checkPage(parseVerifyArgs(["--text", "Saved"]), send)
  const app = await checkApp(parseVerifyArgs(["--app", "Notes", "--ax-text", "Hi"]).app!, send)
  for (const r of [...page, ...app]) {
    expect(r.status).toBe("unverifiable")
    expect(r.observed).toBe("the daemon is not running: daemon failed to start. Check /tmp/x.log")
  }
  expect(VERIFY_EXIT[overall([...page, ...app])]).toBe(2)
})
