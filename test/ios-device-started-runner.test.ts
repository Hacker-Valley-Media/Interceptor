import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { IosManager, RUNNER_DEVICE_GRACE_MS } from "../daemon/ios/manager"
import { RunnerChannel } from "../daemon/ios/channel"
import {
  getOrCreateRunnerSecret, hasRunnerSecret, runnerProof, serverProof, verifyRunnerProof, RUNNER_PROOF_WINDOW_MS,
  deviceStartReady, markDeviceStartReady,
} from "../daemon/ios/state"
import { probeDialBack, remoteDialBack, savedDialBack } from "../daemon/ios/ws-host"
import { createRunnerListener } from "../daemon/ios/runner-listener"
import { WebSocket as WsClient } from "ws"
import { isAllowedWsOrigin } from "../shared/extension-identity"
import { captureShell } from "./helpers/shell-capture"

/**
 * A runner opened on the device (no launch from this Mac) registers
 * with a proof of its device secret, the daemon answers with its own proof, and
 * the session then behaves like any other.
 */

const UDID = "00000000-0000000000000001"
let root = ""
const prior = { secrets: process.env.INTERCEPTOR_IOS_SECRETS_PATH, state: process.env.INTERCEPTOR_IOS_STATE_PATH }

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ios-device-started-"))
  process.env.INTERCEPTOR_IOS_SECRETS_PATH = join(root, "runner-secrets.json")
  process.env.INTERCEPTOR_IOS_STATE_PATH = join(root, "state.json")
})

afterAll(() => {
  for (const [key, value] of [["INTERCEPTOR_IOS_SECRETS_PATH", prior.secrets], ["INTERCEPTOR_IOS_STATE_PATH", prior.state]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

type FakeWs = { send: (s: string) => void; close: () => void; sent: string[]; closed: number }
function fakeWs(): FakeWs {
  const ws: FakeWs = { sent: [], closed: 0, send(s) { ws.sent.push(s) }, close() { ws.closed++ } }
  return ws
}

function freshProof(udid = UDID, now = Date.now()) {
  const nonce = crypto.randomUUID()
  return { ts: now, nonce, proof: runnerProof(getOrCreateRunnerSecret(udid), udid, now, nonce) }
}

function manager() {
  const events: Array<{ event: string; data?: Record<string, unknown> }> = []
  const m = new IosManager({ emit(event, data) { events.push({ event, data }) }, wsPort: 19222 }) as any
  m.resolveDescriptor = async () => undefined
  m.remoteDialBackFor = () => ({ url: "ws://100.64.0.2:19222", host: "100.64.0.2", via: "vpn" })
  m.probeRemote = async () => true
  return { m, events }
}

describe("device secret store", () => {
  test("one stable secret per device, owner-only on disk", () => {
    const a = getOrCreateRunnerSecret(UDID)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(getOrCreateRunnerSecret(UDID.toLowerCase())).toBe(a)
    expect(hasRunnerSecret(UDID)).toBe(true)
    expect(hasRunnerSecret("NOT-A-DEVICE")).toBe(false)
    expect(statSync(process.env.INTERCEPTOR_IOS_SECRETS_PATH!).mode & 0o777).toBe(0o600)
  })

  test("a proof is accepted once, fresh, and only with the right secret", () => {
    const p = freshProof()
    expect(verifyRunnerProof(UDID, p)).toBe(true)
    expect(verifyRunnerProof(UDID, p)).toBe(false) // replay
    const stale = freshProof(UDID, Date.now() - RUNNER_PROOF_WINDOW_MS - 1_000)
    expect(verifyRunnerProof(UDID, stale)).toBe(false)
    expect(verifyRunnerProof(UDID, { ...freshProof(), proof: "AAAA" })).toBe(false)
    expect(verifyRunnerProof("UNKNOWN-DEVICE", freshProof())).toBe(false)
    expect(verifyRunnerProof(UDID, { ...freshProof(), nonce: "short" })).toBe(false)
    expect(verifyRunnerProof(UDID, {})).toBe(false)
  })

  test("the server proof is the HMAC the runner checks", () => {
    const secret = getOrCreateRunnerSecret(UDID)
    const expected = createHmac("sha256", secret).update(`server|${UDID}|n-1234567890abcdef`).digest("base64url")
    expect(serverProof(UDID.toLowerCase(), "n-1234567890abcdef")).toBe(expected)
    expect(serverProof("UNKNOWN-DEVICE", "n")).toBeUndefined()
  })
})

describe("registering a runner the device started", () => {
  test("is refused without a stored secret, with a wrong proof, or as a plain unsolicited registration", () => {
    const { m } = manager()
    const none = m.registerRunner(fakeWs(), { udid: "NO-SECRET-HERE", launchedBy: "device", ts: Date.now(), nonce: crypto.randomUUID(), proof: "x" })
    expect(none.ok).toBe(false)
    expect(none.error).toContain("no device secret for NO-SECRET-HERE")
    const wrong = m.registerRunner(fakeWs(), { udid: UDID, launchedBy: "device", ...freshProof(), proof: "forged" })
    expect(wrong.ok).toBe(false)
    expect(wrong.error).toContain("proof rejected")
    const plain = m.registerRunner(fakeWs(), { udid: UDID, token: "" })
    expect(plain).toEqual({ ok: false, error: `no pending 'ios enable' for udid ${UDID}` })
  })

  test("a valid proof creates a device-started context and returns the server proof", () => {
    const { m, events } = manager()
    const p = freshProof()
    const ws = fakeWs()
    const ack = m.registerRunner(ws, { udid: UDID, launchedBy: "device", kind: "device", url: "ws://100.64.0.2:19222", ...p })
    expect(ack.ok).toBe(true)
    expect(ack.serverProof).toBe(serverProof(UDID, p.nonce))
    const ctx = m.contexts.get(ack.contextId)
    expect(ctx.launchedBy).toBe("device")
    expect(ctx.procs).toEqual([])
    expect(ctx.descriptor.kind).toBe("device")
    expect(ctx.dialBack).toEqual({ url: "ws://100.64.0.2:19222", host: "100.64.0.2", via: "saved" })
    expect(m.isRunnerSocket(ws)).toBe(true)
    expect(events.some((e) => e.event === "ios_enabled" && e.data?.launchedBy === "device")).toBe(true)
  })

  test("a bare verb reaches the only live runner without asking devicectl for the phone", async () => {
    const { m } = manager()
    const ack = m.registerRunner(fakeWs(), { udid: UDID, launchedBy: "device", kind: "device", ...freshProof() })
    // Away from home devicectl cannot see the phone; the live context must still win.
    m.pickDeviceUdid = async () => { throw new Error("devicectl was asked") }
    expect(await m.canonicalContextId(undefined)).toBe(ack.contextId)
    expect(await m.canonicalContextId("")).toBe(ack.contextId)
  })

  test("it replaces an existing context for the device (only one runner process can run there)", () => {
    const { m, events } = manager()
    let killed = 0
    const oldWs = fakeWs()
    const contextId = `ios:${UDID.toLowerCase()}`
    m.contexts.set(contextId, {
      descriptor: { contextId, udid: UDID, name: "phone", kind: "device", wayIn: "dev-provisioned" },
      channel: new RunnerChannel(oldWs, 2_000), registry: { clear() {} }, wdaPort: 0, tunnel: "xcode",
      procs: [{ kill() { killed++ } }], registeredAt: 1, token: "tok",
    })
    const ack = m.registerRunner(fakeWs(), { udid: UDID, launchedBy: "device", ...freshProof() })
    expect(ack.ok).toBe(true)
    expect(killed).toBe(1)
    expect(oldWs.closed).toBe(1)
    expect(m.contexts.get(contextId).launchedBy).toBe("device")
    expect(events.some((e) => e.event === "ios_disabled" && String(e.data?.reason).includes("opened on the device"))).toBe(true)
  })

  test("a dropped device-started socket gets the longer grace and rebinds by proof, not by token", async () => {
    const { m, events } = manager()
    m.deviceGraceMs = 300
    const ws1 = fakeWs()
    const ack = m.registerRunner(ws1, { udid: UDID, launchedBy: "device", ...freshProof() })
    m.handleRunnerClose(ws1)
    const ctx = m.contexts.get(ack.contextId)
    expect(ctx.grace).toBeDefined()
    expect(events.find((e) => e.event === "ios_reconnecting")?.data?.graceMs).toBe(300)
    const forged = m.registerRunner(fakeWs(), { udid: UDID, launchedBy: "device", ...freshProof(), proof: "forged" })
    expect(forged.ok).toBe(false)
    expect(forged.error).toContain("proof rejected")
    const p = freshProof()
    const ws2 = fakeWs()
    const again = m.registerRunner(ws2, { udid: UDID, launchedBy: "device", ...p })
    expect(again).toEqual({ ok: true, contextId: ack.contextId, serverProof: serverProof(UDID, p.nonce) })
    expect(ctx.grace).toBeUndefined()
    expect(m.contexts.get(ack.contextId)).toBe(ctx)
    expect(m.isRunnerSocket(ws2)).toBe(true)
  })

  test("the device grace is 30 s by default (one full back-off step)", () => {
    expect(RUNNER_DEVICE_GRACE_MS).toBe(30_000)
  })

  test("ios disable tells a device-started runner to quit before tearing down", async () => {
    const { m } = manager()
    const ws = fakeWs()
    const ack = m.registerRunner(ws, { udid: UDID, launchedBy: "device", ...freshProof() })
    m.canonicalContextId = async () => ack.contextId
    const sent = new Promise<string>((resolve) => {
      ws.send = (s: string) => { ws.sent.push(s); const frame = JSON.parse(s); if (frame.op === "quit") { resolve(frame.id); m.handleRunnerMessage(ws, { id: frame.id, result: { success: true } }) } }
    })
    const r = await m.handle({ type: "ios_disable", device: ack.contextId })
    expect(r.success).toBe(true)
    expect(await sent).toMatch(/^r\d+$/)
    expect(m.contexts.has(ack.contextId)).toBe(false)
  })
})

describe("launch env, status, and hints", () => {
  const descriptor = { contextId: `ios:${UDID.toLowerCase()}`, udid: UDID, name: "phone", kind: "device", wayIn: "dev-provisioned", needsTunnel: true }

  test("a VPN launch passes the device secret and only loopback or VPN URLs", () => {
    const { m } = manager()
    const env = m.runnerLaunchEnv(descriptor, { url: "ws://100.64.0.2:19222", host: "100.64.0.2", via: "vpn" }, "tok")
    expect(env.INTERCEPTOR_DEVICE_SECRET).toBe(getOrCreateRunnerSecret(UDID))
    expect(env.INTERCEPTOR_WS_URLS).toBe("ws://100.64.0.2:19222")
    const sim = m.runnerLaunchEnv(descriptor, { url: "ws://127.0.0.1:19222", host: "127.0.0.1", via: "loopback" }, "tok")
    expect(sim.INTERCEPTOR_WS_URLS).toBe("ws://127.0.0.1:19222,ws://100.64.0.2:19222")
  })

  test("a LAN-only launch saves nothing, so a LAN address is never replayed elsewhere", () => {
    const { m } = manager()
    m.remoteDialBackFor = () => undefined
    const env = m.runnerLaunchEnv(descriptor, { url: "ws://192.168.1.20:19222", host: "192.168.1.20", via: "subnet" }, "tok")
    expect(env.INTERCEPTOR_WS_URL).toBe("ws://192.168.1.20:19222")
    expect(env.INTERCEPTOR_DEVICE_SECRET).toBeUndefined()
    expect(env.INTERCEPTOR_WS_URLS).toBeUndefined()
  })

  test("status reports launchedBy and the remote URL with its reachability", async () => {
    const { m } = manager()
    const ack = m.registerRunner(fakeWs(), { udid: UDID, launchedBy: "device", url: "ws://100.64.0.2:19222", ...freshProof() })
    m.probeRemote = async () => false
    const r = await m.handle({ type: "ios_status" })
    const mine = (r.data as any[]).find((d) => d.contextId === ack.contextId)
    expect(mine.launchedBy).toBe("device")
    expect(mine.dialBackVia).toBe("saved")
    expect(mine.remoteDialBack).toBe("ws://100.64.0.2:19222")
    expect(mine.remoteReachable).toBe(false)
    expect(typeof mine.deviceStartReady).toBe("boolean")
  })

  test("a Mac launch marks the device ready only when a runner that saves the connection registers", async () => {
    const { m } = manager()
    const fresh = m.awaitRunner("READY-NEW", "tok-a", 1_000, true)
    expect(m.registerRunner(fakeWs(), { udid: "READY-NEW", token: "tok-a", launchedBy: "mac" }).ok).toBe(true)
    await fresh
    expect(deviceStartReady("READY-NEW")).toBe(true)
    // An older runner sends no launchedBy and ignores the secret.
    const old = m.awaitRunner("READY-OLD", "tok-b", 1_000, true)
    expect(m.registerRunner(fakeWs(), { udid: "READY-OLD", token: "tok-b" }).ok).toBe(true)
    await old
    expect(deviceStartReady("READY-OLD")).toBe(false)
    // A LAN-only launch passed no secret, so nothing was saved.
    const lan = m.awaitRunner("READY-LAN", "tok-c", 1_000, false)
    expect(m.registerRunner(fakeWs(), { udid: "READY-LAN", token: "tok-c", launchedBy: "mac" }).ok).toBe(true)
    await lan
    expect(deviceStartReady("READY-LAN")).toBe(false)
  })

  test("a failed launch points at opening the runner on the device only once the connection was delivered", () => {
    const { m } = manager()
    getOrCreateRunnerSecret(UDID)
    expect(m.withDeviceStartHint(UDID, "boom")).toBe("boom") // a secret alone is not enough
    markDeviceStartReady(UDID)
    expect(m.withDeviceStartHint(UDID, "xcodebuild exited with code 70 before the runner registered"))
      .toBe("xcodebuild exited with code 70 before the runner registered. Away from this Mac's network? Open InterceptorRunner on the device (tap its icon); it connects back over ws://100.64.0.2:19222.")
    expect(m.withDeviceStartHint("NO-SECRET-DEVICE", "boom")).toBe("boom")
    m.remoteDialBackFor = () => undefined
    expect(m.withDeviceStartHint(UDID, "boom")).toBe("boom")
  })
})

describe("ws-host remote dial-back", () => {
  test("remoteDialBack picks the Tailscale (CGNAT utun) address", () => {
    const ifaces = [
      { name: "en0", address: "192.168.0.10", netmask: "255.255.255.0" },
      { name: "utun4", address: "100.64.0.10", netmask: "255.255.255.255" },
    ]
    expect(remoteDialBack(19222, ifaces)).toEqual({ url: "ws://100.64.0.10:19222", host: "100.64.0.10", via: "vpn" })
    expect(remoteDialBack(19222, [ifaces[0]])).toBeUndefined()
  })

  test("savedDialBack labels a URL the runner dialed from its saved connection", () => {
    expect(savedDialBack("ws://100.64.0.2:19222")).toEqual({ url: "ws://100.64.0.2:19222", host: "100.64.0.2", via: "saved" })
  })

  test("probeDialBack answers true for a listener and false for a closed port", async () => {
    const server = net.createServer((s) => s.destroy()).listen(0, "127.0.0.1")
    await new Promise((r) => server.once("listening", r))
    const port = (server.address() as net.AddressInfo).port
    expect(await probeDialBack({ url: `ws://127.0.0.1:${port}`, host: "127.0.0.1", via: "loopback" })).toBe(true)
    await new Promise((r) => server.close(r))
    expect(await probeDialBack({ url: `ws://127.0.0.1:${port}`, host: "127.0.0.1", via: "loopback" }, 500)).toBe(false)
  })
})

describe.skipIf(process.platform !== "darwin")("prepared .xctestrun", () => {
  test("is written owner-only, because it carries the token and the device secret", () => {
    const dir = mkdtempSync(join(root, "xctestrun-"))
    const src = join(dir, "Fixture.xctestrun")
    writeFileSync(src, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>InterceptorRunner</key><dict><key>TestBundlePath</key><string>x</string></dict></dict></plist>`)
    // plutil runs in a child process: Bun's macOS test runner can fail posix_spawn (see helpers/shell-capture.ts).
    const script = `const { prepareXctestrunWithEnv } = await import(${JSON.stringify(resolve("daemon/ios/tools.ts"))}); console.log(prepareXctestrunWithEnv(${JSON.stringify(src)}, { INTERCEPTOR_DEVICE_SECRET: "s3cret" }) ?? "")`
    const result = captureShell(process.execPath, ["-e", script], { timeout: 20_000 })
    const out = result.stdout.trim().split("\n").pop() ?? ""
    expect(out, result.stderr).toEndWith("InterceptorRunner-interceptor.xctestrun")
    expect(statSync(out).mode & 0o777).toBe(0o600)
    expect(readFileSync(out, "utf8")).toContain("s3cret")
  })
})

describe.skipIf(process.platform !== "darwin")("useDeviceXCTest", () => {
  test("removes Xcode's XCTest from a device runner and refuses an app with no signing identity to reuse", () => {
    const app = join(mkdtempSync(join(root, "runner-")), "Fixture-Runner.app")
    // An ad-hoc signed bundle: the frameworks go, and re-signing refuses because there is no identity to reuse.
    const script = `
      const { mkdirSync, writeFileSync, copyFileSync, existsSync, readdirSync } = await import("node:fs")
      const { EMBEDDED_XCTEST, useDeviceXCTest } = await import(${JSON.stringify(resolve("daemon/ios/tools.ts"))})
      const app = ${JSON.stringify(app)}
      mkdirSync(app + "/Frameworks/XCTest.framework", { recursive: true })
      writeFileSync(app + "/Frameworks/libXCTestSwiftSupport.dylib", "x")
      mkdirSync(app + "/Frameworks/Keep.framework")
      writeFileSync(app + "/Info.plist", '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleIdentifier</key><string>com.example.fixture</string></dict></plist>')
      copyFileSync("/usr/bin/true", app + "/Fixture")
      Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", app])
      let error = ""
      try { useDeviceXCTest(app) } catch (e) { error = e.message }
      console.log(JSON.stringify({ error, left: readdirSync(app + "/Frameworks"), xctestGone: !existsSync(app + "/Frameworks/XCTest.framework"), listed: EMBEDDED_XCTEST.length }))
    `
    const result = captureShell(process.execPath, ["-e", script], { timeout: 20_000 })
    const out = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}")
    expect(out.xctestGone, result.stderr).toBe(true)
    expect(out.left).toEqual(["Keep.framework"])
    expect(out.listed).toBe(8)
    expect(out.error).toContain("could not read the runner's signing identity")
  })
})

describe("review fixes", () => {
  test("ios disable during the re-dial window tells the runner to quit on its next registration", async () => {
    const { m } = manager()
    m.deviceGraceMs = 5_000
    const ws1 = fakeWs()
    const ack = m.registerRunner(ws1, { udid: UDID, launchedBy: "device", ...freshProof() })
    m.handleRunnerClose(ws1)
    m.canonicalContextId = async () => ack.contextId
    expect((await m.handle({ type: "ios_disable", device: ack.contextId })).success).toBe(true)
    expect(m.contexts.has(ack.contextId)).toBe(false)
    // The runner re-dials: accepted (so it trusts the quit), told to quit, given no session.
    const ws2 = fakeWs()
    const quit = new Promise<void>((resolve) => {
      ws2.send = (s: string) => { ws2.sent.push(s); const f = JSON.parse(s); if (f.op === "quit") { m.handleRunnerMessage(ws2, { id: f.id, result: { success: true } }); resolve() } }
    })
    const p = freshProof()
    expect(m.registerRunner(ws2, { udid: UDID, launchedBy: "device", ...p })).toEqual({ ok: true, contextId: ack.contextId, serverProof: serverProof(UDID, p.nonce) })
    expect(ws2.sent).toEqual([]) // the quit follows the ack the daemon sends
    await quit
    await Bun.sleep(0)
    expect(m.contexts.has(ack.contextId)).toBe(false)
    expect(m.isRunnerSocket(ws2)).toBe(false)
    expect(ws2.closed).toBe(1)
    // Spent: opening it again registers a session.
    expect(m.registerRunner(fakeWs(), { udid: UDID, launchedBy: "device", ...freshProof() }).ok).toBe(true)
    expect(m.contexts.get(ack.contextId).launchedBy).toBe("device")
  })

  test("a launch from this Mac clears a pending quit", async () => {
    const { m } = manager()
    m.quitRequested.add(UDID.toLowerCase())
    const launch = m.awaitRunner(UDID, "tok", 1_000)
    expect(m.quitRequested.size).toBe(0)
    m.registerRunner(fakeWs(), { udid: UDID, token: "tok" })
    await launch
  })

  test("a device proof cannot rebind a Mac launch's session in its re-dial window; a valid one replaces it", async () => {
    const { m } = manager()
    const contextId = `ios:${UDID.toLowerCase()}`
    const oldWs = fakeWs()
    const channel = new RunnerChannel(oldWs, 2_000)
    let killed = 0
    m.contexts.set(contextId, {
      descriptor: { contextId, udid: UDID, name: "phone", kind: "device", wayIn: "dev-provisioned" },
      channel, registry: { clear() {} }, wdaPort: 0, tunnel: "xcode",
      procs: [{ kill() { killed++ } }], registeredAt: 1, token: "mac-tok",
    })
    m.runnerByWs.set(oldWs, { udid: UDID, channel })
    m.handleRunnerClose(oldWs)
    const ctx = m.contexts.get(contextId)
    const settled = ctx.grace.settled
    const forged = m.registerRunner(fakeWs(), { udid: UDID, launchedBy: "device", ...freshProof(), proof: "forged" })
    expect(forged.error).toContain("proof rejected")
    expect(m.contexts.get(contextId)).toBe(ctx)
    const ws = fakeWs()
    expect(m.registerRunner(ws, { udid: UDID, launchedBy: "device", ...freshProof() }).ok).toBe(true)
    const now = m.contexts.get(contextId)
    expect(now).not.toBe(ctx)
    expect(now.launchedBy).toBe("device")
    expect(now.channel).not.toBe(channel)
    expect(killed).toBe(1)
    expect(await settled).toBe(true)
    expect(m.isRunnerSocket(ws)).toBe(true)
  })
})

describe("runner-only listener", () => {
  // The full suite registers happy-dom globals, which replace WebSocket, fetch and Response:
  // its WebSocket cannot take an "error" listener, and Bun.serve only accepts a native
  // Response. So dial with the ws client, request with Bun.fetch, and restore Response.
  type Ws = WsClient
  const opened = (ws: Ws) => new Promise((r) => ws.once("open", r))
  const closeCode = (ws: Ws) => new Promise<number>((r) => ws.once("close", (code: number) => r(code)))
  const dial = (url: string) => { const ws = new WsClient(url); ws.on("error", () => {}); return ws }

  test("serves only a runner registration and that runner's frames", async () => {
    const pageResponse = globalThis.Response
    globalThis.Response = (await Bun.fetch("data:,")).constructor as typeof Response
    const registered = new Set<unknown>()
    const frames: unknown[] = []
    const closes: number[] = []
    const ensure = createRunnerListener({
      port: 0, maxPayloadLength: 1 << 20, allowOrigin: isAllowedWsOrigin, registerWindowMs: 1_000,
      runnerFrame: (ws, f) => { if (!registered.has(ws)) return false; frames.push(f); return true },
      register: (ws, msg) => { const ok = msg.token === "good"; if (ok) registered.add(ws); ws.send(JSON.stringify({ type: "ios", ok })); return ok },
      close: (_ws, code) => { closes.push(code) },
      log: () => {},
    })
    const server = ensure("127.0.0.1")!
    try {
      expect(ensure("127.0.0.1")).toBe(server)
      const url = `ws://127.0.0.1:${server.port}`
      // A CLI action, an extension registration, a binary frame, or a rejected registration first: closed.
      for (const first of [JSON.stringify({ id: "1", action: { type: "macos_apps" } }), JSON.stringify({ type: "extension" }), new Uint8Array([1, 2, 3]), JSON.stringify({ type: "ios", token: "bad" })]) {
        const ws = dial(url)
        await opened(ws)
        const code = closeCode(ws)
        ws.send(first)
        expect(await code).toBe(1008)
      }
      // No registration within the window: closed.
      const idle = dial(url)
      await opened(idle)
      expect(await closeCode(idle)).toBe(1008)
      // A registered runner's text and binary frames reach the shared handlers, and it stays open.
      const runner = dial(url)
      await opened(runner)
      const ack = new Promise<string>((r) => runner.once("message", (d: unknown) => r(String(d))))
      runner.send(JSON.stringify({ type: "ios", token: "good" }))
      expect(JSON.parse(await ack).ok).toBe(true)
      runner.send(JSON.stringify({ id: "r1", result: { success: true } }))
      runner.send(new Uint8Array([0xff, 0xd8]))
      await Bun.sleep(1_200)
      expect(runner.readyState).toBe(WsClient.OPEN)
      expect(frames).toHaveLength(2)
      runner.close()
      // No HTTP routes, and no browser pages.
      expect((await Bun.fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(404)
      expect((await Bun.fetch(`http://127.0.0.1:${server.port}/`, { headers: { origin: "https://example.com" } })).status).toBe(403)
      expect(closes.length).toBeGreaterThanOrEqual(5)
    } finally { server.stop(true); globalThis.Response = pageResponse }
  })

  test("a failed bind is logged once and retried on the next call", () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
    const logs: string[] = []
    const ensure = createRunnerListener({
      port: blocker.port!, maxPayloadLength: 1 << 20, allowOrigin: isAllowedWsOrigin,
      runnerFrame: () => false, register: () => false, close: () => {}, log: (l) => logs.push(l),
    })
    try {
      expect(ensure("127.0.0.1")).toBeUndefined()
      expect(ensure("127.0.0.1")).toBeUndefined()
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain(`tailscale serve --tcp=${blocker.port} off`)
    } finally { blocker.stop(true) }
  })

  test("the manager opens it on LAN and VPN dial-back hosts only", () => {
    const hosts: string[] = []
    const m = new IosManager({ emit() {}, wsPort: 19222, listenRunner: (h) => hosts.push(h) }) as any
    m.listenOn({ url: "ws://192.168.0.10:19222", host: "192.168.0.10", via: "subnet" })
    m.listenOn({ url: "ws://100.64.0.2:19222", host: "100.64.0.2", via: "vpn" })
    m.listenOn({ url: "ws://127.0.0.1:19222", host: "127.0.0.1", via: "loopback" })
    m.listenOn({ url: "ws://example.test:9", host: "example.test", via: "override" })
    m.listenOn(undefined)
    expect(hosts).toEqual(["192.168.0.10", "100.64.0.2"])
  })
})
