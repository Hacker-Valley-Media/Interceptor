// Issue #237: `interceptor back` / `forward` printed `error:` but exited 0, so a
// scripted check read the failure as success. The defect was the CLI's
// generic-action tail, which printed the result and never mapped
// `success:false` to a non-zero exit — every generic action (navigate, scroll,
// cookies, eval, …) shared it. Runs a real daemon under an isolated temp dir
// and port pair with a fake extension answering the forwarded actions, so the
// full CLI → daemon → extension → CLI exit path is exercised.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "bun"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const TEMP = mkdtempSync(join(tmpdir(), "interceptor-exit-"))
const WS_PORT = 38232
const IPC_PORT = 38231
const CONTEXT = "exit-code-test"
const ENV = {
  ...process.env,
  INTERCEPTOR_TEMP: TEMP,
  INTERCEPTOR_WS_PORT: String(WS_PORT),
  INTERCEPTOR_IPC_PORT: String(IPC_PORT),
}
const SOCK = join(TEMP, "interceptor.sock")
const PID = join(TEMP, "interceptor.pid")
const LOG = join(TEMP, "interceptor.log")
const UNIX = process.platform !== "win32"

let daemon: ReturnType<typeof spawn> | null = null
let fakeExt: ReturnType<typeof spawn> | null = null

async function waitFor(pred: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(100)
  }
  return pred()
}
function logHas(needle: string): boolean {
  return existsSync(LOG) && readFileSync(LOG, "utf-8").includes(needle)
}
async function cli(...args: string[]) {
  const proc = spawn({ cmd: ["bun", "run", "cli/index.ts", ...args], env: ENV, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), 30_000)
  const code = await proc.exited
  clearTimeout(timer)
  return { code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() }
}

beforeAll(async () => {
  daemon = spawn({ cmd: ["bun", "run", "daemon/index.ts", "--", "--standalone"], env: ENV, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  const ready = await waitFor(() => (!UNIX || existsSync(SOCK)) && existsSync(PID))
  if (!ready) throw new Error(`isolated daemon never became ready; log:\n${existsSync(LOG) ? readFileSync(LOG, "utf-8") : "(no log)"}`)
  fakeExt = spawn({
    cmd: ["bun", "run", "test/fixtures/fake-extension.ts"],
    env: { ...ENV, FAKE_EXT_WS_PORT: String(WS_PORT), FAKE_EXT_CONTEXT: CONTEXT, FAKE_EXT_VERSION: "0.0.0-fake" },
    stdout: "ignore", stderr: "inherit",
  })
  const registered = await waitFor(() => logHas(`ws extension registered [context: ${CONTEXT}]`))
  if (!registered) throw new Error(`fake extension never registered; log:\n${readFileSync(LOG, "utf-8")}`)
})

afterAll(async () => {
  fakeExt?.kill()
  daemon?.kill("SIGTERM")
  if (daemon) await daemon.exited
  rmSync(TEMP, { recursive: true, force: true })
})

describe("CLI exit codes follow the action result (issue #237)", () => {
  test("back with no history prints Chrome's error and exits 1", async () => {
    const run = await cli("back", "--context", CONTEXT)
    expect(run.stdout).toContain("error: Cannot find a next page in history.")
    expect(run.code).toBe(1)
  })

  test("forward with no history exits 1", async () => {
    const run = await cli("forward", "--context", CONTEXT)
    expect(run.stdout).toContain("error: Cannot find a next page in history.")
    expect(run.code).toBe(1)
  })

  test("--json failure keeps the JSON envelope and still exits 1", async () => {
    const run = await cli("back", "--context", CONTEXT, "--json")
    const body = JSON.parse(run.stdout)
    expect(body.success).toBe(false)
    expect(body.error).toBe("Cannot find a next page in history.")
    expect(run.code).toBe(1)
  })

  test("a successful generic action still exits 0", async () => {
    const run = await cli("navigate", "https://example.com", "--context", CONTEXT)
    expect(run.stdout.trim()).toBe("ok")
    expect(run.code).toBe(0)
  })

  test("compound open --json exits 1 when tab creation fails", async () => {
    const run = await cli("open", "https://example.com", "--context", CONTEXT, "--json")
    const body = JSON.parse(run.stdout)
    expect(body.success).toBe(false)
    expect(run.code).toBe(1)
  })

  test("the stale-snapshot hint path exits 1 too", async () => {
    // An action the fake does not know answers "unknown action type: …", the
    // symptom of a browser still running an older extension snapshot.
    const run = await cli("scroll", "down", "--context", CONTEXT)
    expect(run.stdout).toContain("error: unknown action type: scroll")
    expect(run.stderr).toContain("older Interceptor extension snapshot")
    expect(run.code).toBe(1)
  })

  test("contexts --verbose carries the version the extension registered with (issue #241)", async () => {
    const run = await cli("diagnose", "--json", "--context", CONTEXT)
    expect(run.code).toBe(0)
    const snap = JSON.parse(run.stdout)
    const ctx = snap.contexts.find((c: { contextId: string }) => c.contextId === CONTEXT)
    expect(ctx.extension.version).toBe("0.0.0-fake")
  })

  test("diagnose names the extension/CLI version mismatch and the reload fix", async () => {
    const run = await cli("diagnose", "--context", CONTEXT)
    expect(run.code).toBe(0)
    expect(run.stdout).toContain("extension: connected  (extension 0.0.0-fake)")
    expect(run.stdout).toContain("extension snapshot 0.0.0-fake ≠ CLI")
    expect(run.stdout).toContain(`interceptor reload --context ${CONTEXT}`)
  })
})
