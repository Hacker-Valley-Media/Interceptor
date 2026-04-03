import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "bun"
import { existsSync, unlinkSync, readFileSync } from "node:fs"
import { IPC_PORT, IS_WIN, PID_PATH, SOCKET_PATH, transportLabel, resolvePlatformConfig } from "../shared/platform"
import * as osInput from "../daemon/os-input-loader"

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
      if (existsSync(PID_PATH) && (IS_WIN || existsSync(SOCKET_PATH))) break
      await new Promise(r => setTimeout(r, 100))
    }

    if (!existsSync(PID_PATH)) throw new Error("daemon pid file never appeared")
    if (!IS_WIN && !existsSync(SOCKET_PATH)) throw new Error("daemon socket never appeared")
  })

  afterAll(() => {
    daemonProc?.kill()
    try { unlinkSync(SOCKET_PATH) } catch {}
    try { unlinkSync(PID_PATH) } catch {}
  })

  test("PID file is written", () => {
    expect(existsSync(PID_PATH)).toBe(true)
    const content = readFileSync(PID_PATH, "utf-8")
    expect(content).toContain(transportLabel())
  })

  test("transport endpoint is available on current platform", () => {
    if (IS_WIN) {
      expect(existsSync(PID_PATH)).toBe(true)
      return
    }
    expect(existsSync(SOCKET_PATH)).toBe(true)
  })

  test("CLI connects and gets timeout (no extension to respond)", async () => {
    const cli = spawn({
      cmd: ["bun", "run", "cli/index.ts", "status", "--json"],
      stdout: "pipe",
      stderr: "pipe",
    })

    const deadline = setTimeout(() => cli.kill(), 35000)

    await cli.exited
    clearTimeout(deadline)

    const stdout = await new Response(cli.stdout).text()
    const stderr = await new Response(cli.stderr).text()

    expect(stdout + stderr).not.toContain("daemon not running")

    const combined = (stdout + stderr).trim()
    expect(combined.length).toBeGreaterThan(0)
    expect(combined).not.toContain("daemon not running")
  }, 40000)

  test("os-input-loader exposes OS input functions", () => {
    expect(typeof osInput.osClick).toBe("function")
    expect(typeof osInput.osKey).toBe("function")
    expect(typeof osInput.osType).toBe("function")
    expect(typeof osInput.osMove).toBe("function")
    expect(typeof osInput.translateCoords).toBe("function")
    expect(typeof osInput.generateBezierPath).toBe("function")
  })

  test("platform constants resolve correctly", () => {
    const win = resolvePlatformConfig("win32", "C:\\Temp")
    expect(win.isWin).toBe(true)
    expect(win.ipcPort).toBe(IPC_PORT)
    expect(win.transportLabel).toBe(`tcp:127.0.0.1:${IPC_PORT}`)
    expect(win.pidPath).toContain("slop-browser.pid")

    const mac = resolvePlatformConfig("darwin")
    expect(mac.isWin).toBe(false)
    expect(mac.socketPath).toBe("/tmp/slop-browser.sock")
    expect(mac.transportLabel).toBe("unix:/tmp/slop-browser.sock")
    expect(mac.pidPath).toBe("/tmp/slop-browser.pid")
  })
})
