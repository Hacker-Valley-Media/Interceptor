import { expect, test } from "bun:test"
import { join } from "node:path"

test("CDP connections keep the right endpoint across collisions and reconnects", () => {
  // DOM suites replace the process-wide fetch, Response and WebSocket constructors.
  const child = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "cdp-connect.check.ts")], { timeout: 30_000 })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
}, 35_000)
