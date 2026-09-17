import { existsSync, readFileSync } from "node:fs"
import { userTempDir } from "./bridge-paths"

export type PlatformName = "win32" | "darwin" | string

export type PlatformConfig = {
  isWin: boolean
  temp: string
  sep: string
  socketPath: string
  ipcPort: number
  wsPort: number
  pidPath: string
  lockPath: string
  logPath: string
  eventsPath: string
  monitorSessionsDir: string
  maintenanceGuardPath: string
  transportLabel: string
}

export type PlatformResolveOptions = {
  env?: Record<string, string | undefined>
  /** OS uid; undefined on Windows (slot 0). */
  uid?: number
  /** `kill(pid, 0)` seam for the legacy-daemon check. */
  kill?: (pid: number, signal: 0) => void
}

// One daemon per OS user needs one port pair per OS user, and every consumer
// (CLI, daemon, native host, bridge, runtime agent, Safari appex) must agree
// without a discovery file, so the pair is arithmetic on the uid. uid 501 (the
// first account on every Mac) keeps the published 19221/19222; uid 504 gets
// 19227/19228; root lands on 20219/20220. Windows has no uid and stays on slot
// 0. The Swift copies live in Platform.swift (bridge), AgentClient.swift, and
// SafariWebExtensionHandler.swift; test/platform-runtime.test.ts and
// PlatformPortTests.swift pin the same values.
// ponytail: 500 slots, uid 1001 wraps onto 501's; widen the modulus before a
// machine ever has that many interactive accounts.
export const WS_PORT_BASE = 19222
export const PORT_SLOTS = 500
export function derivePorts(uid: number | undefined): { ipcPort: number; wsPort: number } {
  const slot = uid === undefined ? 0 : (((uid - 501) % PORT_SLOTS) + PORT_SLOTS) % PORT_SLOTS
  const wsPort = WS_PORT_BASE + 2 * slot
  return { ipcPort: wsPort - 1, wsPort }
}

export const LEGACY_DAEMON_TEMP = "/tmp"

// A daemon from a release before 1.0.3 keeps its files under /tmp. Follow it
// only while the per-user socket is absent and the /tmp pid is alive and ours
// (`kill(pid, 0)` throws EPERM for another user's process and ESRCH for a dead
// one), so a dev build still finds and stops an older running daemon and
// nothing new is ever created under /tmp.
export function legacyDaemonTemp(perUserSocket: string, kill: (pid: number, signal: 0) => void = process.kill): string | null {
  if (existsSync(perUserSocket)) return null
  try {
    const pid = parseInt(readFileSync(`${LEGACY_DAEMON_TEMP}/interceptor.pid`, "utf-8").split("\n")[0], 10)
    if (!Number.isInteger(pid) || pid <= 0) return null
    kill(pid, 0)
    return LEGACY_DAEMON_TEMP
  } catch {
    return null
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined
}

export function resolvePlatformConfig(platform: PlatformName = process.platform, tempOverride = process.env.TEMP, options: PlatformResolveOptions = {}): PlatformConfig {
  const env = options.env ?? process.env
  const isWin = platform === "win32"
  const sep = isWin ? "\\" : "/"
  const explicitTemp = env.INTERCEPTOR_TEMP
  let temp = explicitTemp || (isWin ? (tempOverride || "C:\\Temp") : userTempDir(env, platform))
  if (!explicitTemp && !isWin) temp = legacyDaemonTemp(env.INTERCEPTOR_SOCKET_PATH || `${temp}/interceptor.sock`, options.kill) ?? temp
  const ports = derivePorts(isWin ? undefined : (options.uid ?? currentUid()))
  const socketPath = env.INTERCEPTOR_SOCKET_PATH || `${temp}${sep}interceptor.sock`
  const ipcPort = parseInt(env.INTERCEPTOR_IPC_PORT || String(ports.ipcPort))
  const wsPort = parseInt(env.INTERCEPTOR_WS_PORT || String(ports.wsPort))
  const pidPath = env.INTERCEPTOR_PID_PATH || `${temp}${sep}interceptor.pid`
  const lockPath = env.INTERCEPTOR_LOCK_PATH || `${temp}${sep}interceptor.lock`
  const logPath = env.INTERCEPTOR_LOG_PATH || `${temp}${sep}interceptor.log`
  const eventsPath = env.INTERCEPTOR_EVENTS_PATH || `${temp}${sep}interceptor-events.jsonl`
  const monitorSessionsDir = env.INTERCEPTOR_MONITOR_SESSIONS_DIR || `${temp}${sep}interceptor-monitor-sessions`
  const maintenanceGuardPath = env.INTERCEPTOR_INSTALL_MAINTENANCE_PATH || `${temp}${sep}interceptor.installing`
  const transportLabel = isWin ? `tcp:127.0.0.1:${ipcPort}` : `unix:${socketPath}`
  return { isWin, temp, sep, socketPath, ipcPort, wsPort, pidPath, lockPath, logPath, eventsPath, monitorSessionsDir, maintenanceGuardPath, transportLabel }
}

const current = resolvePlatformConfig()

export const IS_WIN = current.isWin
export const TEMP = current.temp
export const SEP = current.sep
export const SOCKET_PATH = current.socketPath
export const IPC_PORT = current.ipcPort
export const WS_PORT = current.wsPort
export const PID_PATH = current.pidPath
export const LOCK_PATH = current.lockPath
export const LOG_PATH = current.logPath
export const EVENTS_PATH = current.eventsPath
export const MONITOR_SESSIONS_DIR = current.monitorSessionsDir
export const MAINTENANCE_GUARD_PATH = current.maintenanceGuardPath
export const EVENTS_MAX_SIZE = 10 * 1024 * 1024

// File-upload transport sizing. The `upload` verb ships file bytes
// base64-encoded inside the command JSON. Three limits gate the path:
//  - MAX_UPLOAD_FRAME_BYTES: the largest single length-prefixed frame the
//    CLI<->daemon Unix socket will accept. Raised from the historical 1 MiB
//    (which silently discarded any file > ~768 KiB) to 64 MiB so a single-shot
//    upload can ride the WS daemon<->extension transport up to the
//    tabs.sendMessage ceiling.
//  - UPLOAD_CHUNK_B64_BYTES: base64 length above which the CLI splits the file
//    into sequential `file_upload_chunk` actions. Kept well under Chrome's hard
//    1 MiB native-messaging host->extension limit so chunked uploads work on
//    EVERY daemon<->extension transport (ws / native / relay), not just WS.
//  - MAX_UPLOAD_FILE_BYTES: raw-file preflight ceiling. Above this the CLI
//    fails fast with an honest error instead of a silent timeout.
export const MAX_UPLOAD_FRAME_BYTES = 64 * 1024 * 1024
export const UPLOAD_CHUNK_B64_BYTES = 512 * 1024
export const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024

export function listenOptions(socketHandlers: Record<string, unknown>) {
  if (IS_WIN) {
    return { hostname: "127.0.0.1", port: IPC_PORT, socket: socketHandlers }
  }
  return { unix: SOCKET_PATH, socket: socketHandlers }
}

export function connectOptions(socketHandlers: Record<string, unknown>) {
  if (IS_WIN) {
    return { hostname: "127.0.0.1", port: IPC_PORT, socket: socketHandlers }
  }
  return { unix: SOCKET_PATH, socket: socketHandlers }
}

export function transportLabel(): string {
  return current.transportLabel
}
