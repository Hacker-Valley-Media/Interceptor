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
  transportLabel: string
}

export function resolvePlatformConfig(platform: PlatformName = process.platform, tempOverride = process.env.TEMP): PlatformConfig {
  const isWin = platform === "win32"
  const temp = isWin ? (tempOverride || "C:\\Temp") : "/tmp"
  const sep = isWin ? "\\" : "/"
  const socketPath = `${temp}${sep}slop-browser.sock`
  const ipcPort = parseInt(process.env.SLOP_IPC_PORT || "19221")
  const wsPort = parseInt(process.env.SLOP_WS_PORT || "19222")
  const pidPath = `${temp}${sep}slop-browser.pid`
  const logPath = `${temp}${sep}slop-browser.log`
  const eventsPath = `${temp}${sep}slop-browser-events.jsonl`
  const transportLabel = isWin ? `tcp:127.0.0.1:${ipcPort}` : `unix:${socketPath}`
  return { isWin, temp, sep, socketPath, ipcPort, wsPort, pidPath, logPath, eventsPath, transportLabel }
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
