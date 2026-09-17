// Per-user daemon runtime files and ports (shared/platform.ts). Two logged-in
// macOS accounts used to share /tmp/interceptor.{sock,pid,lock} and port 19222;
// the second account's CLI got EPERM on the first one's pid and EACCES on its
// socket. Now each account resolves its own temp dir and its own port pair.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { derivePorts, legacyDaemonTemp, resolvePlatformConfig } from "../shared/platform"
import { userTempDir } from "../shared/bridge-paths"

const noKill = () => { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }) }

describe("derivePorts", () => {
  test("the primary account keeps the published pair", () => {
    expect(derivePorts(501)).toEqual({ ipcPort: 19221, wsPort: 19222 })
  })
  test("other accounts get their own pair; root lands on the last slot", () => {
    expect(derivePorts(504)).toEqual({ ipcPort: 19227, wsPort: 19228 })
    expect(derivePorts(0)).toEqual({ ipcPort: 20219, wsPort: 20220 })
  })
  test("no uid (Windows) is slot 0; slots wrap after 500 accounts", () => {
    expect(derivePorts(undefined)).toEqual({ ipcPort: 19221, wsPort: 19222 })
    expect(derivePorts(1001)).toEqual({ ipcPort: 19221, wsPort: 19222 })
  })
})

describe("userTempDir rungs", () => {
  test("$TMPDIR first, trailing slash stripped", () => {
    expect(userTempDir({ TMPDIR: "/var/folders/ab/T/" }, "darwin")).toBe("/var/folders/ab/T")
  })
  test("Linux falls back to XDG_RUNTIME_DIR, then /tmp", () => {
    expect(userTempDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux")).toBe("/run/user/1000")
    expect(userTempDir({}, "linux")).toBe("/tmp")
  })
})

describe("resolvePlatformConfig", () => {
  test("darwin: every runtime file lives in the user's temp dir and the ports follow the uid", () => {
    const c = resolvePlatformConfig("darwin", undefined, { env: { TMPDIR: "/var/folders/xy/T/" }, uid: 504, kill: noKill })
    expect(c.temp).toBe("/var/folders/xy/T")
    expect(c.socketPath).toBe("/var/folders/xy/T/interceptor.sock")
    expect(c.pidPath).toBe("/var/folders/xy/T/interceptor.pid")
    expect(c.lockPath).toBe("/var/folders/xy/T/interceptor.lock")
    expect(c.logPath).toBe("/var/folders/xy/T/interceptor.log")
    expect(c.eventsPath).toBe("/var/folders/xy/T/interceptor-events.jsonl")
    expect(c.monitorSessionsDir).toBe("/var/folders/xy/T/interceptor-monitor-sessions")
    expect(c.maintenanceGuardPath).toBe("/var/folders/xy/T/interceptor.installing")
    expect(c.wsPort).toBe(19228)
    expect(c.ipcPort).toBe(19227)
    expect(c.transportLabel).toBe("unix:/var/folders/xy/T/interceptor.sock")
  })
  test("env overrides win over both the temp dir and the uid mapping", () => {
    const c = resolvePlatformConfig("darwin", undefined, { env: { TMPDIR: "/var/folders/xy/T", INTERCEPTOR_TEMP: "/scratch", INTERCEPTOR_WS_PORT: "19322", INTERCEPTOR_IPC_PORT: "19321" }, uid: 504, kill: noKill })
    expect(c.socketPath).toBe("/scratch/interceptor.sock")
    expect(c.wsPort).toBe(19322)
    expect(c.ipcPort).toBe(19321)
  })
  test("win32: per-user %TEMP% and slot-0 ports", () => {
    const c = resolvePlatformConfig("win32", "C:\\Users\\me\\Temp", { env: {}, uid: 504 })
    expect(c.pidPath).toBe("C:\\Users\\me\\Temp\\interceptor.pid")
    expect(c.wsPort).toBe(19222)
    expect(c.ipcPort).toBe(19221)
  })
  test("nothing resolves under /tmp when no legacy daemon is alive", () => {
    const c = resolvePlatformConfig("darwin", undefined, { env: { TMPDIR: "/var/folders/xy/T" }, uid: 501, kill: noKill })
    expect(c.temp).not.toBe("/tmp")
  })
})

describe("legacyDaemonTemp", () => {
  test("a live, signalable /tmp pid with no per-user socket → follow /tmp; otherwise stay per-user", () => {
    const scratch = mkdtempSync(join(tmpdir(), "platform-runtime-"))
    try {
      const perUserSocket = join(scratch, "interceptor.sock")
      const legacyPidFileExists = (() => { try { return require("node:fs").existsSync("/tmp/interceptor.pid") } catch { return false } })()
      // Ours and alive: kill(pid, 0) returns.
      const own = legacyDaemonTemp(perUserSocket, () => {})
      expect(own).toBe(legacyPidFileExists ? "/tmp" : null)
      // Another user's: EPERM. Dead: ESRCH. Either way, per-user paths stay in force.
      expect(legacyDaemonTemp(perUserSocket, () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }) })).toBe(null)
      expect(legacyDaemonTemp(perUserSocket, noKill)).toBe(null)
      // The per-user socket wins whenever it exists.
      writeFileSync(perUserSocket, "")
      expect(legacyDaemonTemp(perUserSocket, () => {})).toBe(null)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
