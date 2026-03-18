import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "bun"
import { existsSync, unlinkSync } from "node:fs"

const SOCKET_PATH = "/tmp/slop-browser.sock"
const PID_PATH = "/tmp/slop-browser.pid"

describe("daemon ↔ CLI integration", () => {
  let daemonProc: ReturnType<typeof spawn>

  beforeAll(async () => {
    try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH) } catch {}
    try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH) } catch {}

    daemonProc = spawn({
      cmd: ["bun", "run", "daemon/index.ts"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    for (let i = 0; i < 20; i++) {
      if (existsSync(SOCKET_PATH)) break
      await new Promise(r => setTimeout(r, 100))
    }

    if (!existsSync(SOCKET_PATH)) throw new Error("daemon socket never appeared")
  })

  afterAll(() => {
    daemonProc?.kill()
    try { unlinkSync(SOCKET_PATH) } catch {}
    try { unlinkSync(PID_PATH) } catch {}
  })

  test("PID file is written", () => {
    expect(existsSync(PID_PATH)).toBe(true)
    const content = require("fs").readFileSync(PID_PATH, "utf-8")
    expect(content).toContain(SOCKET_PATH)
  })

  test("socket file exists", () => {
    expect(existsSync(SOCKET_PATH)).toBe(true)
  })

  test("CLI connects and gets timeout (no extension to respond)", async () => {
    const cli = spawn({
      cmd: ["bun", "run", "cli/index.ts", "status", "--json"],
      stdout: "pipe",
      stderr: "pipe",
    })

    const deadline = setTimeout(() => cli.kill(), 35000)

    const exitCode = await cli.exited
    clearTimeout(deadline)

    const stdout = await new Response(cli.stdout).text()
    const stderr = await new Response(cli.stderr).text()

    expect(stdout + stderr).not.toContain("daemon not running")

    const combined = (stdout + stderr).trim()
    expect(combined.length).toBeGreaterThan(0)
    expect(combined).not.toContain("daemon not running")
  }, 40000)
})
