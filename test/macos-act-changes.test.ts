// Macos act prints changes; --tree, --app and --per-char never become typed text.
import { describe, expect, test } from "bun:test"
import { formatMacosAct, parseMacosCommand } from "../cli/commands/macos"

describe("macos act parse", () => {
  test("--app is a flag, not text (2.1.14 typed '--app' into the target)", () => {
    expect(parseMacosCommand(["macos", "act", "e865", "--app", "Fixture"])).toMatchObject({ type: "macos_compound", sub: "act", ref: "e865", text: undefined, app: "Fixture" })
  })
  test("--tree is an output flag", () => {
    expect(parseMacosCommand(["macos", "act", "e865", "--tree"])).toMatchObject({ ref: "e865", text: undefined })
  })
  test("text still types", () => {
    expect(parseMacosCommand(["macos", "act", "e864", "hello", "--app", "Fixture"])).toMatchObject({ ref: "e864", text: "hello" })
  })
  test("act --per-char is forwarded, not typed", () => {
    expect(parseMacosCommand(["macos", "act", "e1", "--per-char"])).toMatchObject({ ref: "e1", text: undefined })
    expect(parseMacosCommand(["macos", "act", "e1", "hi", "--per-char"])).toMatchObject({ ref: "e1", text: "hi", perChar: true })
  })
  test("--app or --pid without a value, or a non-numeric pid, is refused instead of clicking", () => {
    expect(() => parseMacosCommand(["macos", "act", "e1", "--app"])).toThrow("--app requires a value")
    expect(() => parseMacosCommand(["macos", "act", "e1", "--pid", "--tree"])).toThrow("--pid requires a value")
    expect(() => parseMacosCommand(["macos", "act", "e1", "--pid", "Notes"])).toThrow("process id")
  })
  test("text equal to a flag value is still the text", () => {
    expect(parseMacosCommand(["macos", "act", "e1", "--app", "Notes", "Notes"])).toMatchObject({ ref: "e1", text: "Notes", app: "Notes" })
  })
  test("macos type --per-char keeps one character per event and is not typed", () => {
    expect(parseMacosCommand(["macos", "type", "hello", "--app", "Fixture", "--per-char"])).toMatchObject({ type: "macos_type", text: "hello", perChar: true })
  })
})

describe("macos act output", () => {
  const tree = "[e1] button \"Save\"\n[e2] checkbox \"Agree\" value=\"1\""
  test("changes and no tree when there was an earlier read", () => {
    const out = formatMacosAct({ action: "clicked", ref: "e2", tree, settledMs: 104, changes: { added: [], removed: [], changed: ["[e2] checkbox \"Agree\" value=\"0\" → [e2] checkbox \"Agree\" value=\"1\""] } }, false)
    expect(out.split("\n")[0]).toBe("clicked e2 (settled in 104 ms)")
    expect(out).toContain("~ [e2] checkbox")
    expect(out).not.toContain("[e1] button")
  })
  test("tree with --tree, or as the baseline when there was no earlier read", () => {
    expect(formatMacosAct({ action: "clicked", ref: "e2", tree, changes: { added: [], removed: [], changed: [] } }, true)).toContain("[e1] button")
    const first = formatMacosAct({ action: "clicked", ref: "e2", tree, changes: null }, false)
    expect(first).toContain("[e1] button")
    expect(first).toContain("baseline")
  })
})
