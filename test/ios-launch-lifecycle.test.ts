import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { IosManager, RUNNER_RECONNECT_GRACE_MS } from "../daemon/ios/manager"
import { RunnerChannel } from "../daemon/ios/channel"

/**
 * Launch lifecycle: identity is validated BEFORE xcodebuild is spawned, an
 * early xcodebuild exit fails the launch at once with the real reason, and a
 * dropped runner socket is held for the runner's own re-dial instead of being
 * torn down on the first close frame.
 */

// ── R2 / R3: launchRunner against faked tools (subprocess so mock.module never leaks) ──

type LaunchMode = "identity" | "exit65" | "alive"

async function launchIn(mode: LaunchMode): Promise<{ code: number; out: string; err: string }> {
  const toolsPath = resolve("daemon/ios/tools.ts")
  const managerPath = resolve("daemon/ios/manager.ts")
  const script = `
    import { mock } from "bun:test";
    const real = await import(${JSON.stringify(toolsPath)});
    let spawned = 0;
    const mode = ${JSON.stringify(mode)};
    const stderrText = "xcodebuild: error: The identity used to sign the executable is no longer valid.\\n";
    const fakeProc = mode === "exit65"
      ? { exited: Promise.resolve(65), stderr: new Response(stderrText).body, kill() {} }
      : { exited: new Promise(() => {}), stderr: new ReadableStream({ start() {} }), kill() {} };
    mock.module(${JSON.stringify(toolsPath)}, () => ({
      ...real,
      stageRunner: () => ({ dir: "/tmp/ios-launch-fixture" }),
      findRunnerApp: () => "/tmp/ios-launch-fixture/Fixture-Runner.app",
      findXctestrun: () => "/tmp/ios-launch-fixture/Fixture.xctestrun",
      prepareXctestrunWithEnv: () => "/tmp/ios-launch-fixture/Fixture-interceptor.xctestrun",
      inspectRunnerIdentity: mode === "identity"
        ? () => { throw new Error("runner is not fully code signed; run: interceptor ios setup TEST-LAUNCH") }
        : () => ({ bundleId: "com.example.runner.xctrunner", teamId: "TEAM", profilePath: "p", expiresAt: Date.now() + 1e9 }),
      spawnLongLived: () => { spawned++; return fakeProc; },
    }));
    const { IosManager } = await import(${JSON.stringify(managerPath)});
    const manager = new IosManager({ emit() {}, wsPort: 0 });
    manager.registerTimeoutMs = 400;
    manager.resolveDialBack = async () => ({ url: "ws://100.1.2.3:19222", host: "100.1.2.3", via: "vpn" });
    const descriptor = { contextId: "ios:test-launch", udid: "TEST-LAUNCH", name: "t", kind: "device", wayIn: "runner", needsTunnel: false };
    const procs = [];
    const started = Date.now();
    const r = await manager.launchRunner(descriptor, procs);
    const ms = Date.now() - started;
    console.log(JSON.stringify({ r, spawned, ms, procs: procs.length }));
  `
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, INTERCEPTOR_NO_XCODE: "", INTERCEPTOR_IOS_USE_XCODE: "1" },
    stdout: "pipe", stderr: "pipe",
  })
  const code = await child.exited
  const out = await new Response(child.stdout).text()
  const err = await new Response(child.stderr).text()
  return { code, out, err }
}

function lastJson(out: string): any {
  const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop()
  return line ? JSON.parse(line) : undefined
}

describe("launchRunner validates identity before spawning and reports an early exit", () => {
  test("an unsigned staged runner fails at once, names setup, and spawns nothing", async () => {
    const { code, out, err } = await launchIn("identity")
    expect(code, err).toBe(0)
    const { r, spawned, ms } = lastJson(out)
    expect(r.ok).toBe(false)
    expect(r.error).toContain("run: interceptor ios setup TEST-LAUNCH")
    expect(r.error).not.toContain("did not register")
    expect(spawned).toBe(0)
    expect(ms).toBeLessThan(2000)
  })

  test("xcodebuild exiting 65 fails the launch with the exit code and stderr, not the timeout", async () => {
    const { code, out, err } = await launchIn("exit65")
    expect(code, err).toBe(0)
    const { r, spawned, ms, procs } = lastJson(out)
    expect(r.ok).toBe(false)
    expect(r.error).toContain("xcodebuild exited with code 65 before the runner registered")
    expect(r.error).toContain("identity used to sign the executable is no longer valid")
    expect(r.error).not.toContain("did not register")
    expect(spawned).toBe(1)
    expect(procs).toBe(1)
    expect(ms).toBeLessThan(2000)
  })

  test("a launch process that stays alive still hits the registration timeout with the dial-back hint", async () => {
    const { code, out, err } = await launchIn("alive")
    expect(code, err).toBe(0)
    const { r, spawned } = lastJson(out)
    expect(r.ok).toBe(false)
    expect(r.error).toContain("did not register")
    expect(r.error).toContain("ws://100.1.2.3:19222")
    expect(spawned).toBe(1)
  })
})

// ── R4: reconnect grace (in-process; no tools involved) ─────────────────────

type FakeWs = { send: (s: string) => void; close: () => void; sent: string[]; closed: number }
function fakeWs(): FakeWs {
  const ws: FakeWs = { sent: [], closed: 0, send(s) { ws.sent.push(s) }, close() { ws.closed++ } }
  return ws
}

function liveSession(graceMs = RUNNER_RECONNECT_GRACE_MS) {
  const events: Array<{ event: string; data?: Record<string, unknown> }> = []
  const manager = new IosManager({ emit(event, data) { events.push({ event, data }) }, wsPort: 0 }) as any
  manager.reconnectGraceMs = graceMs
  manager.canonicalContextId = () => "ios:test-grace"
  manager.resolveDescriptor = () => undefined
  const ws1 = fakeWs()
  const channel = new RunnerChannel(ws1, 2_000)
  let killed = 0
  const proc = { kill() { killed++ } }
  const ctx: any = {
    descriptor: { contextId: "ios:test-grace", udid: "TEST-GRACE", name: "t", kind: "device", wayIn: "runner", productVersion: "27.0" },
    channel, registry: { clear() {} }, wdaPort: 0, tunnel: "none", procs: [proc], registeredAt: 1, token: "tok-1",
  }
  manager.contexts.set("ios:test-grace", ctx)
  manager.runnerByWs.set(ws1, { udid: "TEST-GRACE", channel })
  return { manager, events, ws1, channel, ctx, killed: () => killed }
}

describe("a dropped runner socket is held for the runner's re-dial", () => {
  test("close starts a grace window: process alive, status connecting, no ios_disabled", async () => {
    const s = liveSession()
    s.manager.handleRunnerClose(s.ws1)
    expect(s.ctx.grace).toBeDefined()
    expect(s.killed()).toBe(0)
    expect(s.manager.contexts.has("ios:test-grace")).toBe(true)
    expect(s.events.map((e) => e.event)).toEqual(["ios_reconnecting"])
    const status = await s.manager.handle({ type: "ios_status" })
    const mine = (status.data as any[]).find((d) => d.contextId === "ios:test-grace")
    expect(mine.connection).toBe("connecting")
    s.manager.settleGrace(s.ctx, true) // cleanup timer
  })

  test("in-flight ops fail at once on close instead of waiting out their timeout", async () => {
    const s = liveSession()
    const pending = s.channel.status()
    s.manager.handleRunnerClose(s.ws1)
    await expect(pending).rejects.toThrow("ios runner disconnected")
    s.manager.settleGrace(s.ctx, true)
  })

  test("a token-matched re-dial inside the window rebinds the channel and keeps the session", async () => {
    const s = liveSession()
    s.manager.handleRunnerClose(s.ws1)
    const ws2 = fakeWs()
    const ack = s.manager.registerRunner(ws2, { udid: "TEST-GRACE", token: "tok-1" })
    expect(ack).toEqual({ ok: true, contextId: "ios:test-grace" })
    expect(s.ctx.grace).toBeUndefined()
    expect(s.killed()).toBe(0)
    expect(s.manager.isRunnerSocket(ws2)).toBe(true)
    expect(s.manager.isRunnerSocket(s.ws1)).toBe(false)
    // future ops travel over the new socket
    const op = s.channel.status()
    expect(ws2.sent.length).toBe(1)
    const { id } = JSON.parse(ws2.sent[0])
    s.manager.handleRunnerMessage(ws2, { id, result: { success: true, data: "pong" } })
    expect(await op).toBe("pong")
    expect(s.events.map((e) => e.event)).toEqual(["ios_reconnecting"])
  })

  test("a re-dial with the wrong token is rejected and the window keeps running", () => {
    const s = liveSession()
    s.manager.handleRunnerClose(s.ws1)
    const ack = s.manager.registerRunner(fakeWs(), { udid: "TEST-GRACE", token: "wrong" })
    expect(ack.ok).toBe(false)
    expect(ack.error).toContain("token mismatch")
    expect(s.ctx.grace).toBeDefined()
    s.manager.settleGrace(s.ctx, true)
  })

  test("a lapsed window runs the old teardown exactly once", async () => {
    const s = liveSession(60)
    s.manager.handleRunnerClose(s.ws1)
    await Bun.sleep(150)
    expect(s.killed()).toBe(1)
    expect(s.manager.contexts.has("ios:test-grace")).toBe(false)
    expect(s.events.filter((e) => e.event === "ios_disabled")).toHaveLength(1)
    expect(s.events.find((e) => e.event === "ios_disabled")?.data?.reason).toBe("runner disconnected")
    // a late re-dial is now an ordinary stranger
    const ack = s.manager.registerRunner(fakeWs(), { udid: "TEST-GRACE", token: "tok-1" })
    expect(ack.ok).toBe(false)
    expect(ack.error).toContain("no pending 'ios enable'")
  })

  test("a verb during the window waits for the re-dial and then runs on the new socket", async () => {
    const s = liveSession()
    s.manager.handleRunnerClose(s.ws1)
    const ws2 = fakeWs()
    const verb = s.manager.executeVerb("ios:test-grace", { type: "ios_press", button: "home" })
    await Bun.sleep(20)
    expect(ws2.sent.length).toBe(0)
    s.manager.registerRunner(ws2, { udid: "TEST-GRACE", token: "tok-1" })
    await Bun.sleep(20)
    expect(ws2.sent.length).toBe(1)
    const { id, op } = JSON.parse(ws2.sent[0])
    expect(op).toBe("press")
    s.manager.handleRunnerMessage(ws2, { id, result: { success: true, data: { pressed: "home" } } })
    const result = await verb
    expect(result.success).toBe(true)
    expect(s.killed()).toBe(0)
  })

  test("a verb during a window that lapses does not reuse the dead session", async () => {
    const s = liveSession(60)
    s.manager.handleRunnerClose(s.ws1)
    const result = await s.manager.executeVerb("ios:test-grace", { type: "ios_press", button: "home" })
    expect(result.success).toBe(false)
    expect(s.killed()).toBe(1)
    expect(s.manager.contexts.has("ios:test-grace")).toBe(false)
  })

  test("unlock during the window waits but never launches", async () => {
    const s = liveSession(60)
    let launches = 0
    s.manager.ensureRunner = async () => { launches++; return { ok: false, error: "must not launch" } }
    s.manager.handleRunnerClose(s.ws1)
    const result = await s.manager.executeVerb("ios:test-grace", { type: "ios_unlock", probe: true })
    expect(result.success).toBe(false)
    expect(result.error).toContain("resident runner")
    expect(launches).toBe(0)
  })

  test("explicit disable during the window tears down without a second announcement", async () => {
    const s = liveSession()
    s.manager.handleRunnerClose(s.ws1)
    const r = await s.manager.handle({ type: "ios_disable", contextId: "ios:test-grace" })
    expect(r.success).toBe(true)
    expect(s.killed()).toBe(1)
    expect(s.events.filter((e) => e.event === "ios_disabled")).toHaveLength(1)
  })
})
