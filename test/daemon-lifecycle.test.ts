import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearDaemonRuntimeFiles,
  currentWindowsSid,
  decideDaemonStartupRole,
  decideSingletonGate,
  parseDaemonPidFile,
  readPidState,
  restrictFileToCurrentUser,
  resolveStandaloneSpawnSpec,
  spawnDetachedStandaloneDaemon,
  windowsSystem32Executable,
  writeLockFile,
  type LifecycleDeps,
  type LockFileData,
  type WindowsAclDeps,
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

function makeWindowsAclDeps(
  spawnSync: WindowsAclDeps["spawnSync"],
  env: NodeJS.ProcessEnv = { SystemRoot: "C:\\Windows" },
): WindowsAclDeps {
  return { platform: "win32", env, spawnSync }
}

const LOCK: LockFileData = {
  pid: 4242,
  version: "0.23.32",
  execPath: "C:\\Program Files\\Interceptor\\interceptor-daemon.exe",
  startedAt: "2026-08-27T00:00:00.000Z",
  socketPath: "",
  wsPort: 19222,
  mode: "standalone",
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

    expect(deps.unlinked).toEqual([deps.socketPath, deps.pidPath, deps.lockPath])
    expect(deps.files.has(deps.pidPath)).toBe(false)
    expect(deps.files.has(deps.socketPath)).toBe(false)
  })

  test("native mode relays to an existing live singleton", () => {
    expect(decideDaemonStartupRole(false, { status: "alive", pid: 222 }, true)).toEqual({ action: "relay", pid: 222 })
  })

  test("standalone duplicate exits when a live singleton exists", () => {
    expect(decideDaemonStartupRole(true, { status: "alive", pid: 222 }, true)).toEqual({ action: "exit", pid: 222 })
  })

  // The WS port is the singleton token. While it is held, the pid file cannot
  // justify clearing the owner's runtime files or spawning a rival (the
  // "daemon failed to start" deadlock: a stale pid guess wiped a live daemon).
  test("a held singleton port forbids clearing or spawning whatever the pid file says", () => {
    for (const state of [
      { status: "stale", pid: 222 },
      { status: "invalid", pid: null },
      { status: "missing", pid: null },
    ] as const) {
      expect(decideDaemonStartupRole(false, state, true)).toEqual({ action: "relay", pid: state.pid })
      expect(decideDaemonStartupRole(true, state, true)).toEqual({ action: "exit", pid: state.pid })
    }
  })

  test("a live pid with a free singleton port is not a daemon and is cleared", () => {
    expect(decideDaemonStartupRole(true, { status: "alive", pid: 222 }))
      .toEqual({ action: "clear-and-continue", reason: "pid 222 alive but the singleton port is free" })
    expect(decideDaemonStartupRole(false, { status: "alive", pid: 222 }))
      .toEqual({ action: "clear-and-spawn", reason: "pid 222 alive but the singleton port is free" })
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

describe("Windows lock-file ACL tools", () => {
  test("resolves system executables from SystemRoot, windir, then C:\\Windows", () => {
    expect(windowsSystem32Executable("whoami.exe", { SystemRoot: "D:\\WIN" }))
      .toBe("D:\\WIN\\System32\\whoami.exe")
    expect(windowsSystem32Executable("icacls.exe", { windir: "E:\\Windows" }))
      .toBe("E:\\Windows\\System32\\icacls.exe")
    expect(windowsSystem32Executable("whoami.exe", {}))
      .toBe("C:\\Windows\\System32\\whoami.exe")
  })

  test("ignores a hostile PATH and parses the SID from System32 whoami CSV output", () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const deps = makeWindowsAclDeps((command, args) => {
      calls.push({ command, args })
      return {
        status: 0,
        stdout: '"TESTBOX\\operator","S-1-5-21-111-222-333-1001"\r\n',
        stderr: "",
      }
    }, {
      SystemRoot: "C:\\WINDOWS",
      PATH: "C:\\Program Files\\Git\\usr\\bin;C:\\WINDOWS\\System32",
    })

    expect(currentWindowsSid(deps)).toBe("S-1-5-21-111-222-333-1001")
    expect(calls).toEqual([{
      command: "C:\\WINDOWS\\System32\\whoami.exe",
      args: ["/user", "/fo", "csv", "/nh"],
    }])
  })

  test("invokes absolute System32 whoami and icacls with the current SID", () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const deps = makeWindowsAclDeps((command, args) => {
      calls.push({ command, args })
      if (command.endsWith("whoami.exe")) {
        return { status: 0, stdout: '"TESTBOX\\operator","S-1-5-21-111-222-333-1001"\r\n', stderr: "" }
      }
      return { status: 0, stdout: "processed file: lock.tmp\r\n", stderr: "" }
    })

    restrictFileToCurrentUser("C:\\Temp\\lock.tmp", deps)

    expect(calls).toEqual([
      {
        command: "C:\\Windows\\System32\\whoami.exe",
        args: ["/user", "/fo", "csv", "/nh"],
      },
      {
        command: "C:\\Windows\\System32\\icacls.exe",
        args: ["C:\\Temp\\lock.tmp", "/inheritance:r", "/grant:r", "*S-1-5-21-111-222-333-1001:(F)"],
      },
    ])
  })

  test("surfaces the shadowed whoami failure detail", () => {
    const deps = makeWindowsAclDeps(() => ({
      status: 1,
      stdout: "",
      stderr: "whoami: extra operand '/user'\n",
    }))

    expect(() => currentWindowsSid(deps)).toThrow("C:\\Windows\\System32\\whoami.exe: whoami: extra operand '/user'")
  })

  test("cleans the temporary lock and surfaces icacls failure detail", () => {
    const dir = mkdtempSync(join(tmpdir(), "interceptor-win-acl-test-"))
    const lockPath = join(dir, "interceptor.lock")
    const deps = makeWindowsAclDeps((command) => {
      if (command.endsWith("whoami.exe")) {
        return { status: 0, stdout: '"TESTBOX\\operator","S-1-5-21-111-222-333-1001"\r\n', stderr: "" }
      }
      return { status: 5, stdout: "", stderr: "Access is denied.\r\n" }
    })

    try {
      expect(() => writeLockFile(lockPath, LOCK, deps))
        .toThrow("C:\\Windows\\System32\\icacls.exe: Access is denied.")
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("logs daemon lock-file setup failures before rethrowing", () => {
    const source = readFileSync(join(import.meta.dir, "../daemon/index.ts"), "utf-8")
    const callAt = source.indexOf("writeLockFile(LOCK_PATH, daemonIdentity)")
    const logAt = source.indexOf("daemon lock-file setup failed:", callAt)
    const throwAt = source.indexOf("throw error", logAt)

    expect(callAt).toBeGreaterThan(-1)
    expect(logAt).toBeGreaterThan(callAt)
    expect(throwAt).toBeGreaterThan(logAt)
  })
})
