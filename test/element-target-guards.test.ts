import { describe, expect, test } from "bun:test"
import { spawn } from "bun"

// These commands fail at parse time, before any daemon contact — each spawn
// asserts the CLI dies with usage on stderr instead of a raw TypeError from
// parseElementTarget receiving undefined.
async function runCli(...args: string[]): Promise<{ code: number; stderr: string }> {
  const proc = spawn({
    cmd: ["bun", "run", "cli/index.ts", ...args],
    stdout: "pipe",
    stderr: "pipe",
  })
  const deadline = setTimeout(() => proc.kill(), 15000)
  const code = await proc.exited
  clearTimeout(deadline)
  const stderr = await new Response(proc.stderr).text()
  return { code, stderr }
}

describe("bare element-target verbs exit with usage, not a TypeError", () => {
  for (const verb of ["click", "type", "attr"]) {
    test(`interceptor ${verb} with no target`, async () => {
      const { code, stderr } = await runCli(verb)
      expect(code).toBe(1)
      expect(stderr).toContain("requires an element target")
      expect(stderr).not.toContain("TypeError")
    })
  }
})

describe("click --selector argument validation", () => {
  test("--selector with no value errors instead of becoming a bogus ref", async () => {
    const { code, stderr } = await runCli("click", "--selector")
    expect(code).toBe(1)
    expect(stderr).toContain("--selector requires a CSS selector value")
  })

  test("--nth without --selector", async () => {
    const { code, stderr } = await runCli("click", "--nth", "4")
    expect(code).toBe(1)
    expect(stderr).toContain("--nth requires --selector")
  })

  test("--nth rejects a non-integer", async () => {
    const { code, stderr } = await runCli("click", "--selector", "button", "--nth", "abc")
    expect(code).toBe(1)
    expect(stderr).toContain("non-negative integer")
  })

  test("--nth rejects a negative index", async () => {
    const { code, stderr } = await runCli("click", "--selector", "button", "--nth", "-2")
    expect(code).toBe(1)
    expect(stderr).toContain("non-negative integer")
  })
})
