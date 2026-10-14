import { expect, test } from "bun:test"
import { desktopAction, macosAction, validateDesktopRequest } from "../shared/desktop-contract"
import { generateDesktopContract, outputs } from "../scripts/desktop-contract"
import { classify, gate, parseAllow } from "../cli/mcp/tiers"
import { buildFilteredArgs } from "../cli/global-flags"

test("neutral discovery maps to the existing macOS handler and type matching is exact", () => {
  for (const type of ["desktop_hello", "desktop_capabilities"]) {
    expect(macosAction({type, sub:"hello"})).toEqual({type:"macos_desktop",sub:"hello"})
  }
  expect(macosAction({type:"desktop_type",ref:"e1",text:"x"})).toEqual({type:"macos_type",ref:"e1",text:"x"})
  expect(macosAction({type:"desktop_stream",op:"start",display:29}).type).toBe("desktop_stream")
  for (const type of ["desktop_tree\n", "macos_type\r\n", "desktop_", "desktop_🙂"]) {
    expect(() => desktopAction({type})).toThrow("invalid desktop action type")
  }
})

test("desktop compatibility keeps payloads and validates the trust boundary", async () => {
  const old = { type: "macos_type", text: "a🙂", pid: 42, secret: "named-entry" }
  expect(macosAction(desktopAction(old))).toEqual(old)
  expect(validateDesktopRequest({ id: "r", action: desktopAction(old), protocolVersion: 1 })).toBe(true)
  expect(validateDesktopRequest({ id: "🙂".repeat(32), action: old })).toBe(true)
  expect(validateDesktopRequest({ id: "🙂".repeat(33), action: old })).toBe(false)
  for (const malformed of [null, [], { id: "", action: old }, { id: "r", action: [] },
    { id: "r", action: { type: "os_click" } }, { id: "r", action: old, protocolVersion: 2 }]) {
    expect(validateDesktopRequest(malformed)).toBe(false)
  }
  const generated = generateDesktopContract(await Bun.file(new URL("../shared/desktop-contract.ts", import.meta.url)).text())
  for (const lang of ["swift", "rust"] as const) expect(await Bun.file(outputs[lang]).text()).toBe(generated[lang])
  expect(() => generateDesktopContract("export interface Bad { value: () => void }")).toThrow("unsupported type")
})

test("action conversion removes only undefined wire fields and does not mutate caller data", () => {
  const nested = { value: null, optional: undefined }
  const original = Object.freeze({ type: "macos_pdf", sub: "find", path: "/fixture.pdf", query: "", page: undefined, extra: null, nested })
  const action = desktopAction(original)
  expect(action).toEqual({ type: "desktop_pdf", sub: "find", path: "/fixture.pdf", query: "", extra: null, nested })
  expect(Object.hasOwn(action, "page")).toBe(false)
  expect(Object.hasOwn(original, "page")).toBe(true)
  expect(action.nested).toBe(nested)
  expect(Object.hasOwn(nested, "optional")).toBe(true)
  expect(macosAction(action)).toEqual({ type: "macos_pdf", sub: "find", path: "/fixture.pdf", query: "", extra: null, nested })
})

test("neutral commands preserve nested payload flags and operator policy", () => {
  expect(buildFilteredArgs(["--json", "desktop", "translate", "batch", "--json", "[\"a\"]"]))
    .toEqual(["desktop", "translate", "batch", "--json", "[\"a\"]"])
  for (const [verb, args] of [["runtime", ["eval", "1"]], ["fs", ["write", "/tmp/a", "x"]], ["pdf", ["merge"]], ["share", ["send"]]] as [string, string[]][]) {
    const native = classify("macos", verb, args), desktop = classify("desktop", verb, args)
    expect(desktop.tier).toBe(native.tier)
    expect(gate(desktop, parseAllow(""), false).allowed).toBe(false)
  }
  expect(classify("desktop", "capabilities", []).tier).toBe("read")
})
