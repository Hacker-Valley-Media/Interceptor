import { describe, expect, test } from "bun:test"
import {
  clearDaemonRuntimeFiles,
  decideDaemonStartupRole,
  decideSingletonGate,
  parseDaemonPidFile,
  readPidState,
  resolveStandaloneSpawnSpec,
  spawnDetachedStandaloneDaemon,
  type LifecycleDeps,
} from "../daemon/lifecycle"

function makeDeps(overrides: Partial<LifecycleDeps> = {}): LifecycleDeps {
  const files = new Map<string, string>()
  const unlinked: string[] = []
  const alive = new Set<number>()

  const deps: LifecycleDeps = {
    existsSync(path) {
      return files.has(path)
    },
    readFileSync(path) {
      const value = files.get(path)
      if (value === undefined) throw new Error(`missing ${path}`)
      return value
    },
    unlinkSync(path) {
      unlinked.push(path)
      files.delete(path)
    },
    kill(pid) {
      if (!alive.has(pid)) throw new Error("ESRCH")
    },
    spawn() {
      return { unref() {} }
    },
    async sleep() {},
    currentPid: 111,
    execPath: "/Applications/Interceptor/interceptor-daemon",
    argv: ["/Applications/Interceptor/interceptor-daemon"],
    pidPath: "/tmp/interceptor.pid",
    lockPath: "/tmp/interceptor.lock",
    socketPath: "/tmp/interceptor.sock",
    isWin: false,
    log() {},
    ...overrides,
  }

  return Object.assign(deps, { files, unlinked, alive })
}

describe("daemon lifecycle helpers", () => {
  test("parses the first pid-file line", () => {
    expect(parseDaemonPidFile("123\nunix:/tmp/interceptor.sock\n")).toBe(123)
    expect(parseDaemonPidFile("not-a-pid\n")).toBeNull()
    expect(parseDaemonPidFile("0\n")).toBeNull()
  })

  test("detects stale pid files before takeover cleanup", () => {
    const deps = makeDeps() as LifecycleDeps & { files: Map<string, string> }
    deps.files.set(deps.pidPath, "222\nunix:/tmp/interceptor.sock\n")

    expect(readPidState(deps)).toEqual({ status: "stale", pid: 222 })
  })

  test("clears stale pid and socket files on non-Windows platforms", () => {
    const deps = makeDeps() as LifecycleDeps & { files: Map<string, string>; unlinked: string[] }
    deps.files.set(deps.pidPath, "222\n")
    deps.files.set(deps.socketPath, "")

    clearDaemonRuntimeFiles(deps, "stale pid 222")

    expect(deps.unlinked).toEqual([deps.socketPath, deps.pidPath])
    expect(deps.files.has(deps.pidPath)).toBe(false)
    expect(deps.files.has(deps.socketPath)).toBe(false)
  })

  test("native mode relays to an existing live singleton", () => {
    expect(decideDaemonStartupRole(false, { status: "alive", pid: 222 })).toEqual({ action: "relay", pid: 222 })
  })

  test("standalone duplicate exits when a live singleton exists", () => {
    expect(decideDaemonStartupRole(true, { status: "alive", pid: 222 })).toEqual({ action: "exit", pid: 222 })
  })

  test("native mode spawns a detached singleton when no live singleton exists", () => {
    expect(decideDaemonStartupRole(false, { status: "missing", pid: null })).toEqual({ action: "spawn" })
    expect(decideDaemonStartupRole(false, { status: "stale", pid: 222 })).toEqual({ action: "clear-and-spawn", reason: "stale pid 222" })
  })

  test("singleton gate serves when the ws port was acquired", () => {
    expect(decideSingletonGate({ wsPortAcquired: true, standalone: true })).toMatchObject({ action: "serve" })
    expect(decideSingletonGate({ wsPortAcquired: true, standalone: false })).toMatchObject({ action: "serve" })
  })

  test("singleton gate exits a standalone duplicate that loses the ws-port race", () => {
    const decision = decideSingletonGate({ wsPortAcquired: false, standalone: true })
    expect(decision.action).toBe("exit")
    expect(decision.exitCode).toBe(0)
  })

  test("singleton gate exits a native daemon that loses the ws-port race (never a second singleton)", () => {
    const decision = decideSingletonGate({ wsPortAcquired: false, standalone: false })
    expect(decision.action).toBe("exit")
    expect(decision.exitCode).toBe(0)
  })

  test("resolves compiled daemon standalone spawn command", () => {
    expect(resolveStandaloneSpawnSpec("/Library/Application Support/Interceptor/interceptor-daemon", ["/Library/Application Support/Interceptor/interceptor-daemon"]))
      .toEqual({ command: "/Library/Application Support/Interceptor/interceptor-daemon", args: ["--standalone"] })
  })

  test("resolves source daemon standalone spawn command under bun", () => {
    expect(resolveStandaloneSpawnSpec("/opt/homebrew/bin/bun", ["/opt/homebrew/bin/bun", "daemon/index.ts"]))
      .toEqual({ command: "/opt/homebrew/bin/bun", args: ["daemon/index.ts", "--standalone"] })
  })

  test("spawns detached standalone daemon and waits for ready pid", async () => {
    const deps = makeDeps({
      spawn(command, args, options) {
        expect(command).toBe("/Applications/Interceptor/interceptor-daemon")
        expect(args).toEqual(["--standalone"])
        expect(options).toEqual({ detached: true, stdio: "ignore" })
        return { unref() {} }
      },
    }) as LifecycleDeps & { files: Map<string, string>; alive: Set<number> }

    deps.sleep = async () => {
      deps.files.set(deps.pidPath, "333\nunix:/tmp/interceptor.sock\n")
      deps.files.set(deps.socketPath, "")
      deps.alive.add(333)
    }

    await expect(spawnDetachedStandaloneDaemon(deps, 500)).resolves.toBe(333)
  })
})
