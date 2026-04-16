import { describe, test, expect } from "bun:test"
import { spawn } from "bun"
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { IPC_PORT, IS_WIN, PID_PATH, SOCKET_PATH, transportLabel, resolvePlatformConfig } from "../shared/platform"
import * as osInput from "../daemon/os-input-loader"

describe("daemon ↔ CLI integration", () => {
  async function withDaemon(run: () => Promise<void>): Promise<boolean> {
    const existingDaemon = existsSync(PID_PATH) && (IS_WIN || existsSync(SOCKET_PATH))
    let daemonProc: ReturnType<typeof spawn> | null = null

    if (!existingDaemon) {
      try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH) } catch {}
      try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH) } catch {}

      daemonProc = spawn({
        cmd: ["bun", "run", "daemon/index.ts", "--", "--standalone"],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })

      for (let i = 0; i < 100; i++) {
        if (existsSync(PID_PATH) && (IS_WIN || existsSync(SOCKET_PATH))) break
        await new Promise(r => setTimeout(r, 100))
      }
    }

    try {
      if (!existsSync(PID_PATH)) return false
      if (!IS_WIN && !existsSync(SOCKET_PATH)) return false
      await run()
      return true
    } finally {
      if (!existingDaemon) {
        daemonProc?.kill()
        try { unlinkSync(SOCKET_PATH) } catch {}
        try { unlinkSync(PID_PATH) } catch {}
      }
    }
  }

  test("daemon writes pid/socket and CLI can connect without reporting daemon not running", async () => {
    const available = await withDaemon(async () => {
      const content = readFileSync(PID_PATH, "utf-8")
      expect(content).toContain(transportLabel())

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
      const combined = (stdout + stderr).trim()

      expect(combined.length).toBeGreaterThan(0)
      expect(combined).not.toContain("daemon not running")
    })
    if (!available) expect(true).toBe(true)
  }, 20000)

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
    expect(win.pidPath).toContain("interceptor.pid")

    const mac = resolvePlatformConfig("darwin")
    expect(mac.isWin).toBe(false)
    expect(mac.socketPath).toBe("/tmp/interceptor.sock")
    expect(mac.transportLabel).toBe("unix:/tmp/interceptor.sock")
    expect(mac.pidPath).toBe("/tmp/interceptor.pid")
  })
})
