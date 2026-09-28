import { expect, test } from "bun:test"
import { bootstrapLoadExtension, inspectPortHolder } from "../daemon/cdp/inspector"

test.skipIf(process.platform === "win32")("a busy inspector port is refused before any signal is sent", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not an inspector") })
  const port = server.port as number
  // SIGUSR1 kills `sleep` (default action), so survival proves no signal was sent.
  const target = Bun.spawn(["sleep", "30"])
  try {
    expect(inspectPortHolder(port)?.pid).toBe(process.pid)

    const result = await bootstrapLoadExtension({ pid: target.pid, extPath: "/nonexistent", inspectPort: port })
    expect(result.success).toBe(false)
    expect(result.portBusy).toBe(true)
    expect(result.error).toContain(`inspector port ${port} is held by`)
    expect(result.error).toContain(`pid ${process.pid}`)
    expect(result.error).toContain("SIGUSR1 was not sent")

    await Bun.sleep(200)
    expect(target.exitCode).toBeNull()
  } finally {
    target.kill()
    server.stop(true)
  }
})

test.skipIf(process.platform === "win32")("a free port has no holder", () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
  const port = server.port as number
  server.stop(true)
  expect(inspectPortHolder(port)).toBeUndefined()
})

test("relaunch only counts processes whose executable is inside the app bundle", async () => {
  const { pidsRunningFromBundle } = await import("../daemon/cdp/manager")
  const ps = [
    "  101 /Applications/Editor.app/Contents/MacOS/Editor",
    "  102 /Applications/Editor.app/Contents/Frameworks/Editor Helper (GPU).app/Contents/MacOS/Editor Helper (GPU)",
    "  103 /bin/zsh",
    "  104 /Applications/Team Calendar.app/Contents/MacOS/Team Calendar",
    "  105 /usr/bin/tail",
  ].join("\n")
  expect(pidsRunningFromBundle(ps, "Editor")).toEqual([101])
  expect(pidsRunningFromBundle(ps, "Team Calendar")).toEqual([104])
  expect(pidsRunningFromBundle(ps, "Team")).toEqual([])
  expect(pidsRunningFromBundle(ps, "Calendar")).toEqual([])
  expect(pidsRunningFromBundle("", "Editor")).toEqual([])
})
