/**
 * shared/bridge-paths.ts — where the macOS bridge keeps its runtime files.
 *
 * The bridge used /tmp/interceptor-bridge.{sock,pid,lock,log}: one set of
 * files for every logged-in account. The second account's LaunchAgent then died
 * with `posix_spawn ... error 0xd - Permission denied` on files the first one
 * owned (agent session log, 2026-08-31). The bridge now uses the current user's
 * temporary directory: Swift asks NSTemporaryDirectory(), which is
 * confstr(_CS_DARWIN_USER_TEMP_DIR) for the uid; every launchd-spawned user
 * process carries the same path in $TMPDIR, and `getconf` answers when the
 * environment is bare (a cron or ssh shell). Both sides must agree, so this is
 * the only place the TypeScript side derives it.
 */
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"

export function userRuntimeDir(env: Record<string, string | undefined> = process.env): string {
  let dir = env.INTERCEPTOR_BRIDGE_RUNTIME_DIR || env.TMPDIR
  if (!dir && process.platform === "darwin") {
    try {
      dir = spawnSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).stdout.trim()
    } catch {}
  }
  return (dir || "/tmp").replace(/\/+$/, "")
}

export const BRIDGE_RUNTIME_FILES = [
  "interceptor-bridge.sock",
  "interceptor-bridge.pid",
  "interceptor-bridge.lock",
  "interceptor-bridge.log",
  "interceptor-bridge-events.jsonl",
] as const

export function bridgeSocketPath(env?: Record<string, string | undefined>): string {
  return `${userRuntimeDir(env)}/interceptor-bridge.sock`
}

export function bridgePidPath(env?: Record<string, string | undefined>): string {
  return `${userRuntimeDir(env)}/interceptor-bridge.pid`
}

/** Paths a bridge from a release before the per-user move still uses. */
export const LEGACY_BRIDGE_SOCKET_PATH = "/tmp/interceptor-bridge.sock"
export const LEGACY_BRIDGE_PID_PATH = "/tmp/interceptor-bridge.pid"

/**
 * Detection only (status, surfaces, preflight, daemon connect): prefer the
 * per-user path; when it is absent and the legacy /tmp file exists, report
 * that one so an older running bridge is still found instead of declared
 * missing. New files are never created under /tmp.
 */
export function bridgeSocketPathForDetection(env?: Record<string, string | undefined>): string {
  const current = bridgeSocketPath(env)
  if (existsSync(current)) return current
  return existsSync(LEGACY_BRIDGE_SOCKET_PATH) ? LEGACY_BRIDGE_SOCKET_PATH : current
}

export function bridgePidPathForDetection(env?: Record<string, string | undefined>): string {
  const current = bridgePidPath(env)
  if (existsSync(current)) return current
  return existsSync(LEGACY_BRIDGE_PID_PATH) ? LEGACY_BRIDGE_PID_PATH : current
}
