/**
 * test/research-ledger.test.ts
 *
 * DR-8/9/11/12/13/14/16: `interceptor research` prints the playbook and manages
 * an on-disk ledger with NO daemon connection. Shells out to the CLI from source
 * (bun cli/index.ts) with an isolated --dir, so it touches no real browser, no
 * daemon, and no shared state. Mirrors test/release-modes.test.ts's shell-out style.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"

const REPO_ROOT = resolve(import.meta.dir, "..")
const CLI = resolve(REPO_ROOT, "cli/index.ts")

let DIR = ""

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const proc = spawnSync("bun", [CLI, ...args], { cwd: REPO_ROOT, encoding: "utf-8" })
  return { stdout: proc.stdout || "", stderr: proc.stderr || "", status: proc.status ?? -1 }
}

beforeAll(() => { DIR = mkdtempSync(join(tmpdir(), "interceptor-research-test-")) })
afterAll(() => { if (DIR) rmSync(DIR, { recursive: true, force: true }) })

describe("interceptor research — playbook (no daemon)", () => {
  test("prints the one-screen playbook and exits 0", () => {
    const r = run(["research"])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("INTERCEPTOR DEEP RESEARCH")
    expect(r.stdout).toContain("PLAN")
    expect(r.stdout).toContain("VERIFY")
  })

  test("--full prints the verb cookbook", () => {
    const r = run(["research", "--full"])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("INTERCEPTOR VERB COOKBOOK")
    expect(r.stdout).toContain("THE ESCALATION CHAIN")
  })
})

describe("interceptor research — ledger round-trip (no daemon)", () => {
  test("init scaffolds the ledger at the chosen --dir with the effort floor", () => {
    const r = run(["research", "init", "demo", "--dir", DIR, "--effort", "quick"])
    expect(r.status).toBe(0)
    expect(existsSync(join(DIR, "demo", "links.json"))).toBe(true)
    expect(existsSync(join(DIR, "demo", "insights.md"))).toBe(true)
    expect(existsSync(join(DIR, "demo", "sources"))).toBe(true)
    const led = JSON.parse(readFileSync(join(DIR, "demo", "links.json"), "utf-8"))
    expect(led.effort).toBe("quick")
    expect(led.floor).toBe(8)
    expect(led.leads).toEqual([])
  })

  test("add appends a lead with a parsed domain", () => {
    const r = run(["research", "add", "https://www.federalreserve.gov/releases/h15/", "--dir", DIR, "--slug", "demo", "--note", "rates"])
    expect(r.status).toBe(0)
    const led = JSON.parse(readFileSync(join(DIR, "demo", "links.json"), "utf-8"))
    expect(led.leads.length).toBe(1)
    expect(led.leads[0].domain).toBe("federalreserve.gov")
    expect(led.leads[0].note).toBe("rates")
  })

  test("note appends to insights.md", () => {
    const r = run(["research", "note", "[UNVERIFIED] inflation nowcast unclear", "--dir", DIR, "--slug", "demo"])
    expect(r.status).toBe(0)
    const insights = readFileSync(join(DIR, "demo", "insights.md"), "utf-8")
    expect(insights).toContain("[UNVERIFIED] inflation nowcast unclear")
  })

  test("status --json reports the rubric and an advisory verdict", () => {
    const r = run(["--json", "research", "status", "demo", "--dir", DIR])
    expect(r.status).toBe(0)
    const data = JSON.parse(r.stdout).data
    expect(data.floor).toBe(8)
    expect(data.leadsCount).toBe(1)
    expect(data.needsCorroboration).toBe(1) // the [UNVERIFIED] note
    expect(data.verdict).toContain("KEEP DIGGING") // 1 source < floor 8
  })

  test("status errors clearly when the slug is unknown", () => {
    const r = run(["research", "status", "nope", "--dir", DIR])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain("ledger not found")
  })
})

describe("interceptor research — current ledger memory", () => {
  let DIR2 = ""
  beforeAll(() => { DIR2 = mkdtempSync(join(tmpdir(), "interceptor-research-current-")) })
  afterAll(() => { if (DIR2) rmSync(DIR2, { recursive: true, force: true }) })

  test("the last init is the current ledger, so note/status need no slug with two ledgers", () => {
    expect(run(["research", "init", "alpha", "--dir", DIR2]).status).toBe(0)
    expect(run(["research", "init", "beta", "--dir", DIR2]).status).toBe(0)
    expect(readFileSync(join(DIR2, ".current"), "utf-8").trim()).toBe("beta")
    const note = run(["research", "note", "goes to beta", "--dir", DIR2])
    expect(note.status).toBe(0)
    expect(note.stderr).toContain("ledger: beta")
    expect(readFileSync(join(DIR2, "beta", "insights.md"), "utf-8")).toContain("goes to beta")
    expect(readFileSync(join(DIR2, "alpha", "insights.md"), "utf-8")).not.toContain("goes to beta")
    expect(run(["research", "status", "--dir", DIR2]).status).toBe(0)
  })

  test("research use switches the current ledger and refuses unknown slugs", () => {
    const bad = run(["research", "use", "nope", "--dir", DIR2])
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain("no ledger 'nope'")
    const ok = run(["research", "use", "alpha", "--dir", DIR2])
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain("current ledger: alpha")
    const note = run(["research", "note", "goes to alpha", "--dir", DIR2])
    expect(note.status).toBe(0)
    expect(readFileSync(join(DIR2, "alpha", "insights.md"), "utf-8")).toContain("goes to alpha")
  })

  test("--slug still overrides the current ledger", () => {
    const note = run(["research", "note", "explicit beta", "--slug", "beta", "--dir", DIR2])
    expect(note.status).toBe(0)
    expect(readFileSync(join(DIR2, "beta", "insights.md"), "utf-8")).toContain("explicit beta")
  })
})
