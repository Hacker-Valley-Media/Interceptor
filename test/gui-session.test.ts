// shared/gui-session.ts: does this account have a launchd GUI domain? Without
// one (ssh, service account) the bridge cannot exist and the bootstrap hint is
// wrong. Probe outcomes recorded on macOS 26.
import { describe, expect, test } from "bun:test"
import { classifyGuiDomainProbe, consoleUser, missingGuiSessionLines, probeGuiSession } from "../shared/gui-session"

describe("classifyGuiDomainProbe", () => {
  test("exit 0 → present", () => {
    expect(classifyGuiDomainProbe(0)).toBe("present")
  })
  test("exit 125 'Domain does not support specified action' → absent (no GUI login)", () => {
    expect(classifyGuiDomainProbe(125, "Could not print domain: 125: Domain does not support specified action")).toBe("absent")
    expect(classifyGuiDomainProbe(null, "Domain does not support specified action")).toBe("absent")
  })
  test("exit 112 'Bad request.' (nothing has run as the uid since boot) → absent", () => {
    expect(classifyGuiDomainProbe(112, "Bad request.")).toBe("absent")
    expect(classifyGuiDomainProbe(113, "Bad request.")).toBe("absent")
  })
  test("EPERM and a failed spawn stay unknown", () => {
    expect(classifyGuiDomainProbe(1, "Could not print domain: 1: Operation not permitted")).toBe("unknown")
    expect(classifyGuiDomainProbe(null, "")).toBe("unknown")
  })
})

describe("probeGuiSession / consoleUser", () => {
  test("asks launchctl for the bare gui/<uid> domain, not the service", () => {
    const calls: string[][] = []
    const r = probeGuiSession(501, "darwin", (cmd, args) => { calls.push([cmd, ...args]); return { status: 125, stderr: "Domain does not support specified action" } })
    expect(r).toBe("absent")
    expect(calls).toEqual([["launchctl", "print", "gui/501"]])
  })
  test("off macOS the answer is unknown and nothing is spawned", () => {
    expect(probeGuiSession(501, "linux", () => { throw new Error("must not run") })).toBe("unknown")
    expect(consoleUser("win32", () => { throw new Error("must not run") })).toBe(null)
  })
  test("consoleUser trims stat output and returns null on failure", () => {
    expect(consoleUser("darwin", () => ({ status: 0, stdout: "bob\n" }))).toBe("bob")
    expect(consoleUser("darwin", () => ({ status: 1, stdout: "" }))).toBe(null)
  })
})

describe("missingGuiSessionLines", () => {
  test("names the account, the missing domain, and who owns the screen", () => {
    const [cause, remedy] = missingGuiSessionLines({ user: "alice", uid: 501, consoleUser: "bob" })
    expect(cause).toBe("alice (uid 501) has no GUI login on this Mac, so launchd has no gui/501 session to run the bridge in. The screen belongs to bob.")
    expect(remedy).toContain("log alice in there")
    expect(remedy).toContain("LaunchAgent at login")
  })
  test("no console owner, root, or the same account → 'No one is logged in at the screen'", () => {
    for (const consoleUser of [null, "root", "alice"]) {
      expect(missingGuiSessionLines({ user: "alice", uid: 501, consoleUser })[0]).toContain("No one is logged in at the screen")
    }
  })
})
