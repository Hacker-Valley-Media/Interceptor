import { describe, expect, test } from "bun:test"
import { buildIosAutomationAction } from "../cli/commands/ios"
import { validateIosAutomation } from "../shared/ios-automation"
import { IosManager } from "../daemon/ios/manager"
import { RunnerChannel } from "../daemon/ios/channel"
import { formatWdaTree, IosRefRegistry, findInTree } from "../daemon/ios/tree"
import { classify, gate, parseAllow } from "../cli/mcp/tiers"

const target = { bundleId: "com.example.fixture", identifier: "covered", label: "Covered", type: 9 }

function harness(native = true) {
  const manager = new IosManager({ emit() {}, wsPort: 0 }) as any
  manager.canonicalContextId = () => "ios:test"
  const calls: unknown[] = []
  const channel = new RunnerChannel({ send() {} }) as any
  channel.rawOp = async (...args: unknown[]) => { calls.push(args); return { via: "native" } }
  channel.tap = async (...args: unknown[]) => { calls.push(["tap", ...args]) }
  channel.sendKeys = async (...args: unknown[]) => { calls.push(["keys", ...args]) }
  const registry = new IosRefRegistry()
  registry.register({ type: "Button", label: "Covered", enabled: true, frame: { x: 10, y: 20, width: 80, height: 40 }, target: native ? target : undefined })
  manager.contexts.set("ios:test", { channel, registry })
  return { channel, calls, run: (a: Record<string, unknown>) => manager.executeVerb("ios:test", a) }
}

describe("native iOS command contract", () => {
  test("units and negative coordinates survive CLI parsing", () => {
    expect(buildIosAutomationAction(["ios", "device", "location", "12.5", "-45.25", "--on", "ipad"])).toMatchObject({ op: "device", lat: 12.5, lon: -45.25 })
    expect(buildIosAutomationAction(["ios", "element", "e1", "rotate", "-1.57", "--velocity", "0.75"])).toMatchObject({ value: -1.57, velocity: 0.75 })
    expect(buildIosAutomationAction(["ios", "key", "a", "--modifiers", "command,shift"])).toMatchObject({ key: "a", modifiers: ["command", "shift"] })
  })
  test("malformed, out-of-range, incomplete, and excess arguments fail before dispatch", () => {
    for (const args of [
      ["device", "location", "NaN", "10"], ["device", "location", "91", "0"], ["device", "location", "0"],
      ["device", "open", "example.com"], ["device", "appearance", "purple"], ["device", "orientation", "sideways"],
      ["element", "e1", "slider", "1.01"], ["element", "e1", "pinch", "0"], ["element", "e1", "rotate", "Infinity"],
      ["element", "e1", "swipe", "north"], ["element", "e1", "swipe", "up", "--velocity", "-1"],
      ["key", "hello"], ["key", "a", "--modifiers", "admin"], ["key", "a", "--modifiers"],
      ["capabilities", "extra"], ["audit", "--typo", "x"], ["voiceover", "status", "enable"],
      ["authorization", "reset", "com.example.app", "invented"],
    ]) expect(() => buildIosAutomationAction(["ios", ...args]), args.join(" ")).toThrow()
  })
  test("the daemon also rejects untrusted payloads", async () => {
    const { run, calls } = harness()
    for (const action of [{ op: "invented" }, { op: "element", ref: "e1", action: "slider", value: NaN }, { op: "device", action: "location", lat: 0, lon: 181 }]) {
      expect((await run({ type: "ios_automation", ...action })).success).toBe(false)
    }
    expect(calls).toEqual([])
    expect(validateIosAutomation({ op: "device", action: "location", value: "clear" })).toBeUndefined()
  })
  test("explicit native element action uses only the registry target", async () => {
    const { run, calls } = harness()
    expect((await run({ type: "ios_automation", op: "element", action: "slider", ref: "e1", value: 0.42, target: { bundleId: "attacker" } })).success).toBe(true)
    expect(calls).toEqual([["element", { action: "slider", ref: "e1", value: 0.42, target }]])
    expect((await run({ type: "ios_automation", op: "element", action: "tap", ref: "e99" })).success).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

describe("ref tap compatibility and uncertain outcomes", () => {
  test("ref click and ref typing choose the current element, explicit coordinates stay literal", async () => {
    const { run, calls } = harness()
    expect(await run({ type: "ios_click", ref: "e1" })).toEqual({ success: true, data: { via: "native-element", ref: "e1" } })
    expect((await run({ type: "ios_type", ref: "e1", text: "hello" })).success).toBe(true)
    expect((await run({ type: "ios_click", ref: "e1", x: 1.5, y: 2.5 })).success).toBe(true)
    expect(calls).toEqual([["element", { action: "tap", target }], ["element", { action: "tap", target }], ["keys", "hello", undefined], ["tap", 1.5, 2.5]])
  })
  test("a legacy tree still resolves to its frame center", async () => {
    const { run, calls } = harness(false)
    expect((await run({ type: "ios_click", ref: "e1" })).success).toBe(true)
    expect(calls).toEqual([["tap", 50, 40]])
  })
  test("only a definite unknown-op refusal permits the older-runner fallback", async () => {
    const { run, channel, calls } = harness()
    channel.rawOp = async () => { throw new Error("unknown op 'element'") }
    expect((await run({ type: "ios_click", ref: "e1" })).success).toBe(true)
    expect(calls).toEqual([["tap", 50, 40]])
    for (const error of ["timed out", "target is ambiguous", "target is not hittable", "runner disconnected"]) {
      calls.length = 0
      channel.rawOp = async () => { throw new Error(error) }
      expect((await run({ type: "ios_click", ref: "e1" })).success).toBe(false)
      expect(calls).toEqual([])
    }
  })
})

test("secure values never enter tree output, inspect registry, or find results", () => {
  const registry = new IosRefRegistry()
  const text = formatWdaTree({ type: "XCUIElementTypeSecureTextField", label: "Password", value: "do-not-leak", isSelected: true, hasFocus: true, placeholderValue: "Password", target }, registry)
  expect(text).toContain("(selected) (focused)")
  expect(JSON.stringify({ text, refs: registry.all(), matches: findInTree(registry, "do-not-leak") })).not.toContain("do-not-leak")
  expect(registry.resolve("e1")?.target).toEqual(target)
})

test("MCP permission reset fails closed, VoiceOver reads stay read-only", () => {
  expect(classify("ios", "authorization", ["reset", "com.example.app", "camera"]).tier).toBe("destructive")
  expect(classify("ios", "authorization", ["--on", "ipad", "reset"]).tier).toBe("destructive")
  expect(gate(classify("ios", "authorization", ["reset"]), parseAllow(undefined), true).allowed).toBe(false)
  for (const args of [[], ["status"], ["speech"]]) expect(classify("ios", "voiceover", args).tier).toBe("read")
  for (const args of [["enable"], ["next"], ["--on", "phone", "enable"]]) expect(classify("ios", "voiceover", args).tier).toBe("mutate")
})
