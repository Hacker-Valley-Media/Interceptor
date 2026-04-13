/**
 * cli/daemon-spawn.ts — findDaemonBinary and ensureDaemon auto-start logic
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { IS_WIN, SOCKET_PATH, PID_PATH } from "../shared/platform"

const DAEMON_BINARY = IS_WIN ? "interceptor-daemon.exe" : "interceptor-daemon"

export function findDaemonBinary(): string | null {
  const candidates: string[] = []
  const exePath = resolve(process.execPath || process.argv[0] || "")
  const exeDir = dirname(exePath)
  candidates.push(join(exeDir, "..", "daemon", DAEMON_BINARY))
  candidates.push(join(exeDir, DAEMON_BINARY))
  candidates.push(join(exeDir, "daemon", DAEMON_BINARY))
  candidates.push(resolve("daemon", DAEMON_BINARY))
  candidates.push(resolve("daemon", "interceptor-daemon"))
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * Ensure the daemon is running, spawning it if needed.
 * Call only when a daemon connection is required (i.e. not for "status", "help", "events", "session").
 */
export async function ensureDaemon(): Promise<void> {
  let daemonAlive = false

  if (existsSync(PID_PATH)) {
    try {
      const pidContent = readFileSync(PID_PATH, "utf-8").trim()
      const pid = parseInt(pidContent.split("\n")[0])
      if (!isNaN(pid)) {
        try { process.kill(pid, 0); daemonAlive = true } catch { daemonAlive = false }
      }
    } catch {}
  }

  if (!daemonAlive) {
    if (!IS_WIN) { try { unlinkSync(SOCKET_PATH) } catch {} }
    try { unlinkSync(PID_PATH) } catch {}

    const resolvedDaemon = findDaemonBinary()

    if (resolvedDaemon) {
      process.stderr.write("daemon not running — spawning...\n")
      const child = Bun.spawn([resolvedDaemon, "--standalone"], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      })
      child.unref()

      for (let i = 0; i < 20; i++) {
        await Bun.sleep(250)
        if (existsSync(SOCKET_PATH) || (IS_WIN && existsSync(PID_PATH))) break
      }

      if (!IS_WIN && !existsSync(SOCKET_PATH)) {
        console.error("error: daemon failed to start. Check /tmp/interceptor.log")
        process.exit(1)
      }
    } else {
      console.error("error: daemon not running and interceptor-daemon binary not found. Open Chrome with the Interceptor extension loaded, or build the daemon.")
      process.exit(1)
    }
  }
}
