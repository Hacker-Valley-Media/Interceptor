/**
 * cli/daemon-spawn.ts — findDaemonBinary and ensureDaemon auto-start logic
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { IS_WIN, SOCKET_PATH, PID_PATH, LOCK_PATH, LOG_PATH, WS_PORT } from "../shared/platform"
import { readLockFile } from "../daemon/lifecycle"
import { assertNoInstallMaintenance } from "../shared/install-maintenance"
export const MACOS_PKG_DAEMON_PATH = "/Library/Application Support/Interceptor/interceptor-daemon"

export type DaemonBinaryCandidateOptions = {
  platform?: string
  execPath?: string
  argv0?: string
  cwd?: string
}

export type FindDaemonBinaryOptions = DaemonBinaryCandidateOptions & {
  candidates?: string[]
  exists?: (path: string) => boolean
}

function daemonBinaryName(platform: string = process.platform): string {
  return platform === "win32" ? "interceptor-daemon.exe" : "interceptor-daemon"
}

function resolveFrom(cwd: string, path: string): string {
  return resolve(cwd, path)
}

export function daemonBinaryCandidates(options: DaemonBinaryCandidateOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const binary = daemonBinaryName(platform)
  const cwd = options.cwd ?? process.cwd()
  const exePath = resolveFrom(cwd, options.execPath || options.argv0 || process.execPath || process.argv[0] || "")
  const exeDir = dirname(exePath)
  const candidates: string[] = []
  candidates.push(join(exeDir, "..", "daemon", binary))
  candidates.push(join(exeDir, binary))
  candidates.push(join(exeDir, "daemon", binary))
  candidates.push(resolveFrom(cwd, "daemon/" + binary))
  candidates.push(resolveFrom(cwd, "daemon/interceptor-daemon"))
  if (platform === "darwin") {
    candidates.push(MACOS_PKG_DAEMON_PATH)
  }
  return [...new Set(candidates)]
}

export function findDaemonBinary(options: FindDaemonBinaryOptions = {}): string | null {
  const candidates = options.candidates ?? daemonBinaryCandidates(options)
  const pathExists = options.exists ?? existsSync
  for (const c of candidates) {
    if (pathExists(c)) return c
  }
  return null
}

export function formatMissingDaemonBinaryError(
  candidates = daemonBinaryCandidates(),
  platform = process.platform,
): string {
  const checked = candidates.map((candidate) => `  - ${candidate}`).join("\n")
  const lines = [
    "error: daemon not running and interceptor-daemon binary not found.",
  ]

  if (platform === "darwin") {
    lines.push(`expected package daemon: ${MACOS_PKG_DAEMON_PATH}`)
  }

  lines.push("checked:", checked)

  if (platform === "darwin") {
    lines.push("This is the browser daemon binary, not the macOS bridge. Reinstall Interceptor or rebuild from source.")
  } else {
    lines.push("Reinstall Interceptor or rebuild from source.")
  }

  return lines.join("\n")
}

/**
 * Ensure the daemon is running, spawning it if needed.
 * Call only when a daemon connection is required (i.e. not for "status", "help", "events", "session").
 */
export async function ensureDaemon(): Promise<void> {
  assertNoInstallMaintenance()
  let daemonAlive = false
  let observedLivePid: number | null = null

  if (existsSync(PID_PATH)) {
    try {
      const pidContent = readFileSync(PID_PATH, "utf-8").trim()
      const pid = parseInt(pidContent.split("\n")[0])
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0)
          observedLivePid = pid
          if (IS_WIN) {
            const lock = readLockFile(LOCK_PATH)
            daemonAlive = !!lock && lock.pid === pid && lock.wsPort === WS_PORT && lock.shutdownProtocolVersion === 1
          } else {
            daemonAlive = true
          }
        } catch { daemonAlive = false }
      }
    } catch {}
  }

  if (IS_WIN && observedLivePid && !daemonAlive) {
    throw new Error(`daemon pid ${observedLivePid} is alive but its authenticated lock/readiness record is missing or inconsistent; run 'interceptor diagnose'`)
  }

  if (!daemonAlive) {
    if (!IS_WIN) { try { unlinkSync(SOCKET_PATH) } catch {} }
    try { unlinkSync(PID_PATH) } catch {}

    const candidates = daemonBinaryCandidates()
    const resolvedDaemon = findDaemonBinary({ candidates })

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
        if (IS_WIN) {
          const lock = readLockFile(LOCK_PATH)
          if (lock?.shutdownProtocolVersion === 1 && lock.wsPort === WS_PORT) {
            try {
              process.kill(lock.pid, 0)
              daemonAlive = true
              break
            } catch {}
          }
        } else if (existsSync(SOCKET_PATH)) {
          daemonAlive = true
          break
        }
      }

      if (!daemonAlive) {
        console.error(`error: daemon failed to start. Check ${LOG_PATH}`)
        process.exit(1)
      }
    } else {
      console.error(formatMissingDaemonBinaryError(candidates))
      process.exit(1)
    }
  }
}
