import { describe, expect, test } from "bun:test"
import { constantTimeTokenEquals, type LockFileData } from "../daemon/lifecycle"
import { parseDaemonStopArgs, validateDaemonStopAcknowledgement } from "../cli/commands/daemon"

const TOKEN = "a".repeat(64)
const LOCK: LockFileData = {
  pid: 321,
  version: "1.2.3",
  execPath: "C:\\Program Files\\Interceptor\\daemon\\interceptor-daemon.exe",
  startedAt: "2026-08-01T12:00:00.000Z",
  socketPath: "C:\\Temp\\interceptor.sock",
  wsPort: 19222,
  mode: "standalone",
  shutdownProtocolVersion: 1,
  shutdownToken: TOKEN,
}

describe("authenticated daemon stop", () => {
  test("parses the exact installer command without spawning", () => {
    expect(parseDaemonStopArgs(["daemon", "stop", "--reason", "installer", "--timeout", "10000"]))
      .toEqual({ reason: "installer", timeoutMs: 10_000 })
  })

  test("accepts normalized flag order and equals syntax", () => {
    expect(parseDaemonStopArgs(["daemon", "stop", "--timeout=250", "--reason=manual"]))
      .toEqual({ reason: "manual", timeoutMs: 250 })
  })

  test("rejects unknown subcommands, flags, and unsafe bounds", () => {
    expect(() => parseDaemonStopArgs(["daemon"])).toThrow("usage")
    expect(() => parseDaemonStopArgs(["daemon", "kill"])).toThrow("usage")
    expect(() => parseDaemonStopArgs(["daemon", "stop", "--force"])).toThrow("unknown")
    expect(() => parseDaemonStopArgs(["daemon", "stop", "--timeout", "1"])).toThrow("between")
  })

  test("uses a fixed-width token comparison and rejects malformed values", () => {
    expect(constantTimeTokenEquals(TOKEN, TOKEN)).toBe(true)
    expect(constantTimeTokenEquals("b".repeat(64), TOKEN)).toBe(false)
    expect(constantTimeTokenEquals("short", TOKEN)).toBe(false)
    expect(constantTimeTokenEquals(undefined, TOKEN)).toBe(false)
  })

  test("requires acknowledgement identity to match the lock", () => {
    const acknowledgement = {
      accepted: true,
      protocolVersion: 1,
      pid: LOCK.pid,
      execPath: LOCK.execPath,
      startedAt: LOCK.startedAt,
    }
    expect(() => validateDaemonStopAcknowledgement(LOCK, acknowledgement)).not.toThrow()
    expect(() => validateDaemonStopAcknowledgement(LOCK, { ...acknowledgement, pid: 999 })).toThrow("does not match")
    expect(() => validateDaemonStopAcknowledgement(LOCK, { ...acknowledgement, accepted: false })).toThrow("rejected")
  })
})
