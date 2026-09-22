import { describe, expect, spyOn, test } from "bun:test"
import { IosManager } from "../daemon/ios/manager"
import { RunnerChannel } from "../daemon/ios/channel"
import { IosRefRegistry } from "../daemon/ios/tree"
import { buildIosDragAction, buildIosScrollAction } from "../cli/commands/ios"

// `ios drag` and `ios scroll` take screen coordinates as well as refs, for apps
// (games, canvases) with no usable element tree. A gesture the caller did not
// ask for must never be sent: every unresolvable origin is an error.

type Drag = [number, number, number, number, number]

function harness() {
  const manager = new IosManager({ emit() {}, wsPort: 0 }) as any
  manager.canonicalContextId = () => "ios:test"
  const channel = new RunnerChannel({ send() {} }) as any
  const drags: Drag[] = []
  channel.drag = async (...a: Drag) => { drags.push(a) }
  channel.windowSize = async () => ({ x: 0, y: 0, width: 400, height: 800 })
  const registry = new IosRefRegistry()
  // e1 centers on 100,100; e2 centers on 300,500.
  registry.register({ type: "Button", label: "A", frame: { x: 50, y: 50, width: 100, height: 100 } } as any)
  registry.register({ type: "Button", label: "B", frame: { x: 250, y: 450, width: 100, height: 100 } } as any)
  manager.contexts.set("ios:test", { channel, registry })
  const run = (action: Record<string, unknown>) => manager.executeVerb("ios:test", action)
  return { run, drags }
}

describe("ios drag endpoints", () => {
  test("point to point", async () => {
    const { run, drags } = harness()
    const r = await run({ type: "ios_drag", from: "120.5,330", to: "120,600", duration: 1 })
    expect(r).toMatchObject({ success: true, data: { from: { x: 120.5, y: 330 }, to: { x: 120, y: 600 } } })
    expect(drags).toEqual([[120.5, 330, 120, 600, 1]])
  })

  test("ref to ref still drags center to center with the default duration", async () => {
    const { run, drags } = harness()
    expect((await run({ type: "ios_drag", from: "e1", to: "e2" })).success).toBe(true)
    expect(drags).toEqual([[100, 100, 300, 500, 0.6]])
  })

  test("a point and a ref can be mixed, in either order", async () => {
    const { run, drags } = harness()
    expect((await run({ type: "ios_drag", from: "10,20", to: "e2" })).success).toBe(true)
    expect((await run({ type: "ios_drag", from: "e1", to: "30,40" })).success).toBe(true)
    expect(drags).toEqual([[10, 20, 300, 500, 0.6], [100, 100, 30, 40, 0.6]])
  })

  test("the same point twice with a duration is a long press", async () => {
    const { run, drags } = harness()
    expect((await run({ type: "ios_drag", from: "200,400", to: "200,400", duration: 2 })).success).toBe(true)
    expect(drags).toEqual([[200, 400, 200, 400, 2]])
  })

  test("an endpoint that is neither a point nor a live ref names itself and sends nothing", async () => {
    const { run, drags } = harness()
    const stale = await run({ type: "ios_drag", from: "120,330", to: "e99" })
    expect(stale.success).toBe(false)
    expect(stale.error).toContain("'e99'")
    const malformed = await run({ type: "ios_drag", from: "120;330", to: "e1" })
    expect(malformed.success).toBe(false)
    expect(malformed.error).toContain("'120;330'")
    expect(drags).toEqual([])
  })
})

describe("ios scroll origin", () => {
  test("--x/--y swipes from that point", async () => {
    const { run, drags } = harness()
    const r = await run({ type: "ios_scroll", x: 200, y: 500, dir: "down" })
    expect(r).toMatchObject({ success: true, data: { scrolled: "down", from: { x: 200, y: 500 } } })
    expect(drags).toEqual([[200, 500, 200, 250, 0.4]])
  })

  test("a ref swipes from its center", async () => {
    const { run, drags } = harness()
    expect((await run({ type: "ios_scroll", ref: "e2", dir: "up" })).success).toBe(true)
    expect(drags).toEqual([[300, 500, 300, 750, 0.4]])
  })

  test("a bare scroll still swipes from the screen center", async () => {
    const { run, drags } = harness()
    expect((await run({ type: "ios_scroll", dir: "left" })).success).toBe(true)
    expect(drags).toEqual([[200, 400, 450, 400, 0.4]])
  })

  test("a stale ref is an error and sends no gesture", async () => {
    const { run, drags } = harness()
    const r = await run({ type: "ios_scroll", ref: "e99", dir: "down" })
    expect(r.success).toBe(false)
    expect(r.error).toContain("e99")
    expect(drags).toEqual([])
  })

  test("half a coordinate pair is an error and sends no gesture", async () => {
    const { run, drags } = harness()
    expect((await run({ type: "ios_scroll", x: 200, dir: "down" })).success).toBe(false)
    expect(drags).toEqual([])
  })
})

describe("ios gesture argument parsing", () => {
  function exits(fn: () => unknown): { code: number | undefined; stderr: string } {
    const lines: string[] = []
    const err = spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")) })
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit:${code}`) }) as never)
    let code: number | undefined
    try { fn() } catch (e) { code = Number(String((e as Error).message).split(":")[1]) }
    err.mockRestore(); exit.mockRestore()
    return { code, stderr: lines.join("\n") }
  }

  test("scroll carries a point, a ref, or nothing", () => {
    expect(buildIosScrollAction(["ios", "scroll", "--x", "200", "--y", "500", "--dir", "up"]))
      .toEqual({ type: "ios_scroll", ref: undefined, x: 200, y: 500, dir: "up" })
    expect(buildIosScrollAction(["ios", "scroll", "e4"])).toMatchObject({ ref: "e4", dir: "down" })
    expect(buildIosScrollAction(["ios", "scroll", "--dir", "left"])).toMatchObject({ ref: undefined, x: undefined, y: undefined })
  })

  test("scroll with one of --x/--y exits 1", () => {
    for (const args of [["--x", "200"], ["--y", "500"], ["--x", "200", "--y"]]) {
      const { code, stderr } = exits(() => buildIosScrollAction(["ios", "scroll", ...args, "--dir", "down"]))
      expect(code).toBe(1)
      expect(stderr).toContain("both --x")
    }
  })

  test("drag keeps fractional seconds", () => {
    expect(buildIosDragAction(["ios", "drag", "10,20", "10,20", "--duration", "1.5"]))
      .toEqual({ type: "ios_drag", from: "10,20", to: "10,20", duration: 1.5 })
    expect(buildIosDragAction(["ios", "drag", "e1", "e2"]).duration).toBeUndefined()
  })

  test("drag refuses a missing endpoint and a non-numeric duration", () => {
    expect(exits(() => buildIosDragAction(["ios", "drag", "10,20"])).code).toBe(1)
    expect(exits(() => buildIosDragAction(["ios", "drag", "10,20", "--duration"])).code).toBe(1)
    const bad = exits(() => buildIosDragAction(["ios", "drag", "e1", "e2", "--duration", "long"]))
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain("seconds")
  })

  test("drag refuses a hold longer than the gesture deadline can report", () => {
    expect(buildIosDragAction(["ios", "drag", "10,20", "10,20", "--duration", "55"]).duration).toBe(55)
    const tooLong = exits(() => buildIosDragAction(["ios", "drag", "10,20", "10,20", "--duration", "61"]))
    expect(tooLong.code).toBe(1)
    expect(tooLong.stderr).toContain("at most 55")
  })
})

describe("ios gesture transport deadline", () => {
  test("runner gestures get 60 s; device-service lanes keep failing fast", async () => {
    const { pickTimeoutForAction, INTERCEPTOR_TIMEOUT_MS } = await import("../cli/transport")
    for (const type of ["ios_drag", "ios_scroll", "ios_click", "ios_keys", "ios_press"]) {
      expect(pickTimeoutForAction({ type })).toBe(60_000)
    }
    // `ios top` sends three requests in a row: a blanket 60 s made a dead lane take 180 s to say so.
    for (const type of ["ios_top", "ios_gpu", "ios_status", "ios_web_status", "ios_web_click", "ios_eval"]) {
      expect(pickTimeoutForAction({ type })).toBe(INTERCEPTOR_TIMEOUT_MS)
    }
    expect(pickTimeoutForAction({ type: "ios_web_targets" })).toBe(20_000)
    expect(pickTimeoutForAction({ type: "ios_setup" })).toBe(600_000)
    expect(pickTimeoutForAction({ type: "click" })).toBe(INTERCEPTOR_TIMEOUT_MS)
  })
})
