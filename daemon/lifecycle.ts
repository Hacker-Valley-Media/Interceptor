import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"

export type PidState =
  | { status: "missing"; pid: null }
  | { status: "invalid"; pid: null }
  | { status: "current"; pid: number }
  | { status: "alive"; pid: number }
  | { status: "stale"; pid: number }

export type StartupDecision =
  | { action: "continue" }
  | { action: "exit"; pid: number }
  | { action: "relay"; pid: number }
  | { action: "spawn" }
  | { action: "clear-and-continue"; reason: string }
  | { action: "clear-and-spawn"; reason: string }
  | { action: "error-duplicate"; pid: number; startedAt: string }

export type LockFileData = {
  pid: number
  version: string
  execPath: string
  startedAt: string
  socketPath: string
  wsPort: number
  mode: "standalone" | "relay"
}

export function readLockFile(lockPath: string): LockFileData | null {
  try {
    return JSON.parse(readFileSync(lockPath, "utf-8")) as LockFileData
  } catch {
    return null
  }
}

export function writeLockFile(lockPath: string, data: LockFileData): void {
  try {
    writeFileSync(lockPath, JSON.stringify(data, null, 2), "utf-8")
  } catch {}
}

export function clearLockFile(lockPath: string): void {
  try { unlinkSync(lockPath) } catch {}
}

type SpawnedProcess = { unref(): void }

export type LifecycleDeps = {
  existsSync: (path: string) => boolean
  readFileSync: (path: string, encoding: BufferEncoding) => string
  unlinkSync: (path: string) => void
  kill: (pid: number, signal?: NodeJS.Signals | 0) => void
  spawn: (command: string, args: string[], options: { detached: true; stdio: "ignore" }) => SpawnedProcess
  sleep: (ms: number) => Promise<unknown>
  currentPid: number
  execPath: string
  argv: string[]
  pidPath: string
  lockPath: string
  socketPath: string
  isWin: boolean
  log: (msg: string) => void
}

export function defaultLifecycleDeps(paths: { pidPath: string; lockPath: string; socketPath: string; isWin: boolean }): LifecycleDeps {
  return {
    existsSync,
    readFileSync,
    unlinkSync,
    kill: process.kill.bind(process),
    spawn: (command, args, options) => spawn(command, args, options),
    sleep: (ms) => Bun.sleep(ms),
    currentPid: process.pid,
    execPath: process.execPath,
    argv: process.argv,
    pidPath: paths.pidPath,
    lockPath: paths.lockPath,
    socketPath: paths.socketPath,
    isWin: paths.isWin,
    log: () => {},
  }
}

export function parseDaemonPidFile(content: string): number | null {
  const firstLine = content.trim().split("\n")[0]
  const pid = parseInt(firstLine, 10)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

export function readPidState(deps: Pick<LifecycleDeps, "existsSync" | "readFileSync" | "kill" | "currentPid" | "pidPath">): PidState {
  if (!deps.existsSync(deps.pidPath)) return { status: "missing", pid: null }

  let pid: number | null = null
  try {
    pid = parseDaemonPidFile(deps.readFileSync(deps.pidPath, "utf-8"))
  } catch {
    return { status: "invalid", pid: null }
  }

  if (!pid) return { status: "invalid", pid: null }
  if (pid === deps.currentPid) return { status: "current", pid }

  try {
    deps.kill(pid, 0)
    return { status: "alive", pid }
  } catch {
    return { status: "stale", pid }
  }
}

export function clearDaemonRuntimeFiles(deps: Pick<LifecycleDeps, "unlinkSync" | "pidPath" | "lockPath" | "socketPath" | "isWin" | "log">, reason: string): void {
  deps.log(`clearing daemon runtime files: ${reason}`)
  if (!deps.isWin) {
    try { deps.unlinkSync(deps.socketPath) } catch {}
  }
  try { deps.unlinkSync(deps.pidPath) } catch {}
  try { deps.unlinkSync(deps.lockPath) } catch {}
}

export function checkLockFileDuplicate(
  lockPath: string,
  currentPid: number,
  kill: (pid: number, signal: 0) => void,
): { action: "error-duplicate"; pid: number; startedAt: string } | null {
  const lock = readLockFile(lockPath)
  if (!lock || lock.pid === currentPid) return null
  try {
    kill(lock.pid, 0)
    // process is alive and is not us — duplicate
    return { action: "error-duplicate", pid: lock.pid, startedAt: lock.startedAt }
  } catch {
    return null
  }
}

export function decideDaemonStartupRole(standalone: boolean, state: PidState): StartupDecision {
  if (state.status === "alive") {
    return standalone ? { action: "exit", pid: state.pid } : { action: "relay", pid: state.pid }
  }

  if (state.status === "stale") {
    const reason = `stale pid ${state.pid}`
    return standalone ? { action: "clear-and-continue", reason } : { action: "clear-and-spawn", reason }
  }

  if (state.status === "invalid") {
    return standalone ? { action: "clear-and-continue", reason: "invalid pid file" } : { action: "clear-and-spawn", reason: "invalid pid file" }
  }

  if (state.status === "missing") {
    return standalone ? { action: "continue" } : { action: "spawn" }
  }

  return { action: "continue" }
}

export type SingletonGateDecision = {
  action: "serve" | "exit"
  reason: string
  exitCode: number
}

// The pid-file election (decideDaemonStartupRole) is advisory and racy. The authoritative
// singleton token is the WebSocket port: the OS lets exactly one process bind it. A daemon
// that reaches the singleton code path must acquire that port BEFORE claiming the CLI socket;
// if it can't, another singleton already owns it, so this process must never proceed — doing
// so would split-brain the system (one daemon owning the CLI socket, another the extension
// channel). Exiting cleanly lets the existing daemon serve everyone; a native parent will
// simply re-resolve its relay to the surviving singleton.
export function decideSingletonGate(input: { wsPortAcquired: boolean; standalone: boolean }): SingletonGateDecision {
  if (input.wsPortAcquired) {
    return { action: "serve", reason: "acquired the singleton port", exitCode: 0 }
  }
  return {
    action: "exit",
    reason: input.standalone
      ? "another singleton is already running; exiting this duplicate"
      : "another singleton owns the port; exiting so the existing daemon serves everyone",
    exitCode: 0,
  }
}

export function resolveStandaloneSpawnSpec(execPath: string, argv: string[]): { command: string; args: string[] } {
  const scriptArg = argv.find((arg, idx) => idx > 0 && /(?:^|[\\/])daemon[\\/]index\.ts$/.test(arg))
  const bunLike = /(?:^|[\\/])bun(?:\.exe)?$/.test(execPath)
  if (scriptArg && bunLike) return { command: execPath, args: [scriptArg, "--standalone"] }
  return { command: execPath, args: ["--standalone"] }
}

export async function waitForDaemonReady(
  deps: Pick<LifecycleDeps, "existsSync" | "readFileSync" | "kill" | "currentPid" | "pidPath" | "socketPath" | "isWin" | "sleep">,
  timeoutMs: number,
  intervalMs = 100,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = readPidState(deps)
    const transportReady = deps.isWin ? state.status === "alive" : deps.existsSync(deps.socketPath)
    if (state.status === "alive" && transportReady) return state.pid
    await deps.sleep(intervalMs)
  }

  const state = readPidState(deps)
  const transportReady = deps.isWin ? state.status === "alive" : deps.existsSync(deps.socketPath)
  return state.status === "alive" && transportReady ? state.pid : null
}

export async function spawnDetachedStandaloneDaemon(
  deps: LifecycleDeps,
  timeoutMs: number,
): Promise<number | null> {
  const spec = resolveStandaloneSpawnSpec(deps.execPath, deps.argv)
  deps.log(`spawning detached standalone daemon: ${spec.command} ${spec.args.join(" ")}`)
  const child = deps.spawn(spec.command, spec.args, { detached: true, stdio: "ignore" })
  child.unref()
  const pid = await waitForDaemonReady(deps, timeoutMs)
  if (pid) deps.log(`detached standalone daemon ready (pid ${pid})`)
  else deps.log("detached standalone daemon did not become ready before timeout")
  return pid
}
