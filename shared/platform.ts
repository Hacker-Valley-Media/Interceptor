export type PlatformName = "win32" | "darwin" | string

export type PlatformConfig = {
  isWin: boolean
  temp: string
  sep: string
  socketPath: string
  ipcPort: number
  wsPort: number
  pidPath: string
  logPath: string
  eventsPath: string
  monitorSessionsDir: string
  transportLabel: string
}

export function resolvePlatformConfig(platform: PlatformName = process.platform, tempOverride = process.env.TEMP): PlatformConfig {
  const isWin = platform === "win32"
  const explicitTemp = process.env.INTERCEPTOR_TEMP
  const temp = explicitTemp || (isWin ? (tempOverride || "C:\\Temp") : "/tmp")
  const sep = isWin ? "\\" : "/"
  const socketPath = process.env.INTERCEPTOR_SOCKET_PATH || `${temp}${sep}interceptor.sock`
  const ipcPort = parseInt(process.env.INTERCEPTOR_IPC_PORT || "19221")
  const wsPort = parseInt(process.env.INTERCEPTOR_WS_PORT || "19222")
  const pidPath = process.env.INTERCEPTOR_PID_PATH || `${temp}${sep}interceptor.pid`
  const logPath = process.env.INTERCEPTOR_LOG_PATH || `${temp}${sep}interceptor.log`
  const eventsPath = process.env.INTERCEPTOR_EVENTS_PATH || `${temp}${sep}interceptor-events.jsonl`
  const monitorSessionsDir = process.env.INTERCEPTOR_MONITOR_SESSIONS_DIR || `${temp}${sep}interceptor-monitor-sessions`
  const transportLabel = isWin ? `tcp:127.0.0.1:${ipcPort}` : `unix:${socketPath}`
  return { isWin, temp, sep, socketPath, ipcPort, wsPort, pidPath, logPath, eventsPath, monitorSessionsDir, transportLabel }
}

const current = resolvePlatformConfig()

export const IS_WIN = current.isWin
export const TEMP = current.temp
export const SEP = current.sep
export const SOCKET_PATH = current.socketPath
export const IPC_PORT = current.ipcPort
export const WS_PORT = current.wsPort
export const PID_PATH = current.pidPath
export const LOG_PATH = current.logPath
export const EVENTS_PATH = current.eventsPath
export const MONITOR_SESSIONS_DIR = current.monitorSessionsDir
export const EVENTS_MAX_SIZE = 10 * 1024 * 1024

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
