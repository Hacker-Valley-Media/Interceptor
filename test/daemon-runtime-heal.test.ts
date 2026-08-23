// Gate for the "daemon failed to start" deadlock (PR #227): a live daemon whose
// runtime files were removed or overwritten by a pid-file guess must keep
// serving, restore its files, and never be wiped by a duplicate, a native host,
// or the CLI. Runs a real daemon under an isolated temp dir and port pair so it
// never touches the developer's own /tmp/interceptor.* or port 19222.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "bun"
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { probeDaemonHealth } from "../shared/daemon-health"

const TEMP = mkdtempSync(join(tmpdir(), "interceptor-heal-"))
const WS_PORT = 38222
const IPC_PORT = 38221
const ENV = {
  ...process.env,
  INTERCEPTOR_TEMP: TEMP,
  INTERCEPTOR_WS_PORT: String(WS_PORT),
  INTERCEPTOR_IPC_PORT: String(IPC_PORT),
}
const SOCK = join(TEMP, "interceptor.sock")
const PID = join(TEMP, "interceptor.pid")
const LOCK = join(TEMP, "interceptor.lock")
const LOG = join(TEMP, "interceptor.log")
const UNIX = process.platform !== "win32"

let daemon: ReturnType<typeof spawn> | null = null

function files() {
  return { sock: !UNIX || existsSync(SOCK), pid: existsSync(PID), lock: existsSync(LOCK) }
}
function pidOnDisk(): number | null {
  try { return parseInt(readFileSync(PID, "utf-8").split("\n")[0], 10) } catch { return null }
}
async function waitFor(pred: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(100)
  }
  return pred()
}
async function cli(...args: string[]) {
  const proc = spawn({ cmd: ["bun", "run", "cli/index.ts", ...args], env: ENV, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), 30_000)
  const code = await proc.exited
  clearTimeout(timer)
  return { code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() }
}
async function health() {
  const probe = await probeDaemonHealth(WS_PORT, 2000)
  if (probe.state !== "interceptor") throw new Error(`expected the isolated daemon on ${WS_PORT}, got ${JSON.stringify(probe)}`)
  return probe
}

beforeAll(async () => {
  daemon = spawn({ cmd: ["bun", "run", "daemon/index.ts", "--", "--standalone"], env: ENV, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  const ready = await waitFor(() => files().sock && files().pid && files().lock)
  if (!ready) throw new Error(`isolated daemon never became ready; log:\n${existsSync(LOG) ? readFileSync(LOG, "utf-8") : "(no log)"}`)
})

afterAll(async () => {
  daemon?.kill("SIGTERM")
  if (daemon) await daemon.exited
  rmSync(TEMP, { recursive: true, force: true })
})

describe("daemon runtime-file ownership and self-heal", () => {
  test("the winner restores every runtime file on a health probe and the CLI connects without spawning", async () => {
    const winner = daemon!.pid
    expect(pidOnDisk()).toBe(winner)
    if (UNIX) unlinkSync(SOCK)
    unlinkSync(PID)
    unlinkSync(LOCK)
    expect(files()).toEqual({ sock: false, pid: false, lock: false })

    const body = await health()
    expect(body.pid).toBe(winner)
    expect(body.healed.sort()).toEqual((UNIX ? ["lock", "pid", "socket"] : ["lock", "pid"]).sort())
    expect(files()).toEqual({ sock: true, pid: true, lock: true })
    expect(pidOnDisk()).toBe(winner)

    const run = await cli("contexts")
    expect(run.stderr).not.toContain("spawning")
    expect(run.stderr).not.toContain("daemon failed to start")
    expect(run.code).toBe(0)
  })

  test("a stale pid file does not make the CLI wipe or replace the live daemon", async () => {
    const winner = daemon!.pid
    writeFileSync(PID, "999999\n")
    const run = await cli("contexts")
    expect(run.stderr).not.toContain("spawning")
    expect(run.stderr).not.toContain("daemon failed to start")
    expect(run.code).toBe(0)
    expect(files()).toEqual({ sock: true, pid: true, lock: true })
    expect(pidOnDisk()).toBe(winner)
  })

  test("a proxy environment does not turn the live daemon into 'free' (probe bypasses HTTP_PROXY)", async () => {
    const winner = daemon!.pid
    writeFileSync(PID, "999999\n")
    const proc = spawn({
      cmd: ["bun", "run", "cli/index.ts", "contexts"],
      env: { ...ENV, HTTP_PROXY: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" },
      stdout: "pipe", stderr: "pipe",
    })
    const timer = setTimeout(() => proc.kill(), 30_000)
    const code = await proc.exited
    clearTimeout(timer)
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).not.toContain("spawning")
    expect(code).toBe(0)
    expect(pidOnDisk()).toBe(winner)
  })

  test("a Chrome-style native host seeing a stale pid relays instead of clearing (and exits when stdin closes)", async () => {
    const winner = daemon!.pid
    writeFileSync(PID, "999999\n")
    const host = spawn({ cmd: ["bun", "run", "daemon/index.ts"], env: ENV, stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    await Bun.sleep(1500)
    host.stdin.end()
    const timer = setTimeout(() => host.kill(), 15_000)
    const code = await host.exited
    clearTimeout(timer)
    expect(code).toBe(0)
    expect(files()).toEqual({ sock: true, pid: true, lock: true })
    expect(pidOnDisk()).toBe(winner)
    const log = readFileSync(LOG, "utf-8")
    expect(log).not.toContain("clearing daemon runtime files")
    expect(log).toContain("relay mode: bridging native messaging to singleton")
  })

  test("a standalone duplicate that loses the port gate leaves the winner's files alone", async () => {
    const winner = daemon!.pid
    const loser = spawn({
      cmd: ["bun", "run", "daemon/index.ts", "--", "--standalone"],
      env: { ...ENV, INTERCEPTOR_PID_PATH: join(TEMP, "loser.pid") },
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    })
    const timer = setTimeout(() => loser.kill(), 15_000)
    const code = await loser.exited
    clearTimeout(timer)
    expect(code).toBe(0)
    expect(files()).toEqual({ sock: true, pid: true, lock: true })
    expect(pidOnDisk()).toBe(winner)
    expect((await health()).pid).toBe(winner)
  })
})
