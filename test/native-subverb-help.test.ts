// `macos <sub> --help` prints that sub-verb, not the whole macOS page.
import { expect, test } from "bun:test"
import { join } from "node:path"

const cli = join(import.meta.dir, "..", "cli", "index.ts")
const run = (...args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], { env: { ...process.env, INTERCEPTOR_ALL_SURFACES: "1" } }).stdout.toString()

test("macos click --help is the click slice", () => {
  const out = run("macos", "click", "--help")
  expect(out).toContain("interceptor macos click — usage")
  expect(out).not.toContain("interceptor macos tree")
  expect(out.length).toBeLessThan(2000)
})

test("bare macos --help still prints the whole page", () => {
  expect(run("macos", "--help").length).toBeGreaterThan(5000)
})
