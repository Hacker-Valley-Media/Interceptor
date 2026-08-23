import { describe, expect, test } from "bun:test"
import { cleanupOwnedRuntimeFiles } from "../daemon/lifecycle"

function makeDeps(isWin = false) {
  const unlinked: string[] = []
  const deps = {
    unlinkSync: (path: string) => { unlinked.push(path) },
    pidPath: "/tmp/interceptor.pid",
    lockPath: "/tmp/interceptor.lock",
    socketPath: "/tmp/interceptor.sock",
    isWin,
  }
  return { deps, unlinked }
}

describe("cleanupOwnedRuntimeFiles", () => {
  test("a process that never won the singleton gate removes nothing", () => {
    // Regression: losing duplicates and native-messaging relays used to run
    // the unconditional exit-hook unlink and wipe the live daemon's socket,
    // pid, and lock files — the "daemon failed to start" deadlock.
    const { deps, unlinked } = makeDeps()
    cleanupOwnedRuntimeFiles(deps, false)
    expect(unlinked).toEqual([])
  })

  test("the gate winner removes socket, pid, and lock files", () => {
    const { deps, unlinked } = makeDeps()
    cleanupOwnedRuntimeFiles(deps, true)
    expect(unlinked).toEqual(["/tmp/interceptor.sock", "/tmp/interceptor.pid", "/tmp/interceptor.lock"])
  })

  test("unlink failures are swallowed in both modes", () => {
    const throwing = {
      unlinkSync: () => { throw new Error("ENOENT") },
      pidPath: "/tmp/interceptor.pid",
      lockPath: "/tmp/interceptor.lock",
      socketPath: "/tmp/interceptor.sock",
      isWin: false,
    }
    expect(() => cleanupOwnedRuntimeFiles(throwing, true)).not.toThrow()
    expect(() => cleanupOwnedRuntimeFiles(throwing, false)).not.toThrow()
  })

  test("windows skips the unix socket path", () => {
    const { deps, unlinked } = makeDeps(true)
    cleanupOwnedRuntimeFiles(deps, true)
    expect(unlinked).toEqual(["/tmp/interceptor.pid", "/tmp/interceptor.lock"])
  })
})
