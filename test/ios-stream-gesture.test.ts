import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IosManager, validateGestureFingers, jpegSize, writeFileAtomic } from "../daemon/ios/manager"
import { RunnerChannel } from "../daemon/ios/channel"
import { IosRefRegistry } from "../daemon/ios/tree"
import { IOS_RUNNER_OPS, IOS_VERB_TYPES } from "../shared/ios-device"
import { parseGestureFinger, buildIosGestureAction, buildIosStreamAction } from "../cli/commands/ios"

// The runner pushes JPEG frames as binary WebSocket messages and plays one
// multi-touch record per `gesture` call. The daemon keeps the newest frame,
// writes --out atomically, and refuses a bad gesture before any runner round trip.

/** Smallest valid JPEG header: SOI + SOF0 declaring `w` x `h`. */
function fakeJpeg(w: number, h: number, pad = 0): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(pad, 0x5a)])
}

function harness() {
  const manager = new IosManager({ emit() {}, wsPort: 0 }) as any
  manager.canonicalContextId = () => "ios:test"
  const ws = { send() {} }
  const channel = new RunnerChannel(ws) as any
  const sent: Array<{ op: string; args: Record<string, unknown> }> = []
  channel.gesture = async (fingers: unknown) => { sent.push({ op: "gesture", args: { fingers } }); return { fingers: (fingers as unknown[]).length, durationMs: 600, elapsedMs: 640 } }
  channel.stream = async (action: string, opts: Record<string, unknown> = {}) => { sent.push({ op: "stream", args: { action, ...opts } }); return { running: action !== "stop", frames: 3, lastCaptureMs: 40 } }
  manager.contexts.set("ios:test", { channel, registry: new IosRefRegistry(), descriptor: { contextId: "ios:test", udid: "test" } })
  manager.runnerByWs.set(ws, { udid: "test", channel })
  const run = (action: Record<string, unknown>) => manager.executeVerb("ios:test", action)
  return { manager, ws, run, sent }
}

describe("verb and op tables", () => {
  test("the three verbs and two runner ops are registered", () => {
    for (const v of ["ios_gesture", "ios_stream", "ios_frame"]) expect(IOS_VERB_TYPES.has(v)).toBe(true)
    expect(IOS_RUNNER_OPS.gesture).toBe("gesture")
    expect(IOS_RUNNER_OPS.stream).toBe("stream")
  })
})

describe("gesture finger syntax", () => {
  test("a lone x,y presses at 0 and lifts at --hold", () => {
    expect(parseGestureFinger("120,650", 600)).toEqual([{ x: 120, y: 650, t: 0 }, { x: 120, y: 650, t: 600 }])
  })
  test("a timeline keeps every sample", () => {
    expect(parseGestureFinger("10,20@0>30,40@150>30,40@300", 100)).toEqual([{ x: 10, y: 20, t: 0 }, { x: 30, y: 40, t: 150 }, { x: 30, y: 40, t: 300 }])
  })
  test("fractions and a leading offset are accepted", () => {
    expect(parseGestureFinger("10.5,20@100", 50)).toEqual([{ x: 10.5, y: 20, t: 100 }, { x: 10.5, y: 20, t: 150 }])
  })
  test("malformed samples and a later sample without @ms are errors", () => {
    expect(parseGestureFinger("10;20", 100)).toEqual({ error: "'10;20' is not x,y or x,y@ms" })
    expect(parseGestureFinger("10,20>30,40", 100)).toMatchObject({ error: expect.stringContaining("needs a time offset") })
  })
  test("buildIosGestureAction turns every positional into a finger", () => {
    const a = buildIosGestureAction(["ios", "gesture", "380,700@0>380,700@600", "120,650", "--hold", "300", "--on", "phone"])
    expect(a).toEqual({ type: "ios_gesture", fingers: [
      [{ x: 380, y: 700, t: 0 }, { x: 380, y: 700, t: 600 }],
      [{ x: 120, y: 650, t: 0 }, { x: 120, y: 650, t: 300 }],
    ] })
  })
})

describe("stream flag parsing", () => {
  test("start carries only the flags given, with --out made absolute", () => {
    expect(buildIosStreamAction(["ios", "stream", "start"], "/w")).toEqual({ type: "ios_stream", op: "start" })
    expect(buildIosStreamAction(["ios", "stream", "start", "--fps", "12", "--scale", "0.4", "--quality", "0.5", "--out", "f.jpg"], "/w"))
      .toEqual({ type: "ios_stream", op: "start", fps: 12, scale: 0.4, quality: 0.5, out: "/w/f.jpg" })
  })
  test("stop and status take no options", () => {
    expect(buildIosStreamAction(["ios", "stream", "stop", "--fps", "99"], "/w")).toEqual({ type: "ios_stream", op: "stop" })
    expect(buildIosStreamAction(["ios", "stream", "status"], "/w")).toEqual({ type: "ios_stream", op: "status" })
  })
})

describe("gesture validation", () => {
  const ok = [[{ x: 1, y: 2, t: 0 }, { x: 1, y: 2, t: 600 }]]
  test("accepts a well-formed request", () => expect(validateGestureFingers(ok)).toBeUndefined())
  test("refuses empty, too many, missing samples, non-numbers, negative, decreasing, and too long", () => {
    expect(validateGestureFingers([])).toContain("at least one finger")
    expect(validateGestureFingers(Array.from({ length: 11 }, () => ok[0]))).toContain("at most 10")
    expect(validateGestureFingers([[]])).toContain("finger 1 has no samples")
    expect(validateGestureFingers([[{ x: 1, y: "2", t: 0 }]])).toContain("numeric x, y, t")
    expect(validateGestureFingers([[{ x: 1, y: 2, t: -1 }]])).toContain("negative")
    expect(validateGestureFingers([[{ x: 1, y: 2, t: 500 }, { x: 1, y: 2, t: 400 }]])).toContain("must not decrease")
    expect(validateGestureFingers([[{ x: 1, y: 2, t: 0 }, { x: 1, y: 2, t: 55_001 }]])).toContain("at most 55000")
  })
  test("the manager refuses before the runner is asked, and forwards a good one", async () => {
    const { run, sent } = harness()
    const bad = await run({ type: "ios_gesture", fingers: [[{ x: 1, y: 2, t: 9 }, { x: 1, y: 2, t: 1 }]] })
    expect(bad.success).toBe(false)
    expect(sent).toEqual([])
    const good = await run({ type: "ios_gesture", fingers: ok })
    expect(good).toMatchObject({ success: true, data: { fingers: 1, durationMs: 600 } })
    expect(sent).toEqual([{ op: "gesture", args: { fingers: ok } }])
  })
})

describe("jpeg helpers", () => {
  test("jpegSize reads the SOF marker and rejects non-JPEG bytes", () => {
    expect(jpegSize(fakeJpeg(660, 1434))).toEqual({ width: 660, height: 1434 })
    expect(jpegSize(Buffer.from("not a jpeg"))).toBeUndefined()
  })
  test("writeFileAtomic leaves no temp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "ios-stream-"))
    try {
      writeFileAtomic(join(dir, "f.jpg"), Buffer.from("abc"))
      expect(readFileSync(join(dir, "f.jpg"), "utf8")).toBe("abc")
      expect(readdirSync(dir)).toEqual(["f.jpg"])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe("stream lifecycle in the manager", () => {
  test("start validates ranges and an absolute --out before the runner is asked", async () => {
    const { run, sent } = harness()
    expect((await run({ type: "ios_stream", op: "start", fps: 31 })).error).toContain("--fps")
    expect((await run({ type: "ios_stream", op: "start", scale: 0.01 })).error).toContain("--scale")
    expect((await run({ type: "ios_stream", op: "start", quality: 2 })).error).toContain("--quality")
    expect((await run({ type: "ios_stream", op: "start", out: "relative.jpg" })).error).toContain("absolute")
    expect(sent).toEqual([])
  })

  test("frames update seq, size, and the --out file; frame serves the newest; stop keeps it readable", async () => {
    const { manager, ws, run, sent } = harness()
    const dir = mkdtempSync(join(tmpdir(), "ios-stream-"))
    const out = join(dir, "phone.jpg")
    try {
      const noFrame = await run({ type: "ios_frame", out: join(dir, "x.jpg") })
      expect(noFrame.success).toBe(false)
      expect(noFrame.error).toContain("stream start")

      const started = await run({ type: "ios_stream", op: "start", fps: 10, out })
      expect(started).toMatchObject({ success: true, data: { started: true, running: true, frames: 0, outPath: out } })
      expect(sent[0]).toEqual({ op: "stream", args: { action: "start", fps: 10, scale: 0.5, quality: 0.3 } })

      expect(manager.handleRunnerFrame(ws, fakeJpeg(660, 1434, 10))).toBe(true)
      expect(manager.handleRunnerFrame(ws, fakeJpeg(660, 1434, 20))).toBe(true)
      expect(readFileSync(out).length).toBe(fakeJpeg(660, 1434, 20).length)
      expect(readdirSync(dir)).toEqual(["phone.jpg"])

      const status = await run({ type: "ios_stream", op: "status" })
      expect(status).toMatchObject({ success: true, data: { running: true, frames: 2, lastSeq: 2, width: 660, height: 1434, writeErrors: 0, runner: { frames: 3 } } })
      expect((status.data as { ageMs: number }).ageMs).toBeLessThan(1000)

      const frame = await run({ type: "ios_frame", out: join(dir, "grab.jpg") })
      expect(frame).toMatchObject({ success: true, data: { path: join(dir, "grab.jpg"), seq: 2, width: 660, height: 1434, running: true } })
      expect(readFileSync(join(dir, "grab.jpg")).length).toBe(fakeJpeg(660, 1434, 20).length)

      const stopped = await run({ type: "ios_stream", op: "stop" })
      expect(stopped).toMatchObject({ success: true, data: { stopped: true, running: false, frames: 2 } })
      expect(sent[sent.length - 1]).toEqual({ op: "stream", args: { action: "stop" } })
      const after = await run({ type: "ios_stream", op: "status" })
      expect(after).toMatchObject({ success: true, data: { running: false, frames: 2 } })
      expect(sent.filter((s) => s.op === "stream").map((s) => s.args.action)).toEqual(["start", "status", "stop"]) // status after stop asks nothing
      expect((await run({ type: "ios_frame", out: join(dir, "late.jpg") })).success).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("a frame from a socket that is not a runner, or with no stream, is ignored", () => {
    const { manager, ws } = harness()
    expect(manager.handleRunnerFrame({ send() {} }, fakeJpeg(1, 1))).toBe(false)
    expect(manager.handleRunnerFrame(ws, fakeJpeg(1, 1))).toBe(true)
    expect(manager.contexts.get("ios:test").stream).toBeUndefined()
  })

  test("a straggler frame after stop does not move the count", async () => {
    const { manager, ws, run } = harness()
    await run({ type: "ios_stream", op: "start" })
    manager.handleRunnerFrame(ws, fakeJpeg(2, 2))
    await run({ type: "ios_stream", op: "stop" })
    manager.handleRunnerFrame(ws, fakeJpeg(3, 3))
    expect(await run({ type: "ios_stream", op: "status" })).toMatchObject({ success: true, data: { running: false, frames: 1, lastSeq: 1, width: 2 } })
  })

  test("a runner JSON reply still routes to the channel", () => {
    const { manager, ws } = harness()
    expect(manager.handleRunnerMessage(ws, { id: "r1", result: { success: true } })).toBe(true)
    expect(manager.handleRunnerMessage({ send() {} }, { id: "r1", result: { success: true } })).toBe(false)
  })
})
