/**
 * test/type-frame-positionals.test.ts
 *
 * Issue #217: `type <ref> <text> --frame <id>` typed the flag AND its value
 * into the field ("999 --frame 4897" → digits-only inputs showed "9994897").
 * The typed text must be exactly the positional span after the target, which
 * normalizeArgsSplit now reports. Also covers the sibling value-flag map gaps
 * proven alongside: window resize geometry, brand tab-group, keepawake.
 */

import { describe, expect, test } from "bun:test"
import { normalizeArgs, normalizeArgsSplit } from "../cli/normalize"
import { parseActionsCommand } from "../cli/commands/actions"
import { parseBrandCommand } from "../cli/commands/brand"
import { buildWindowResizeAction } from "../cli/commands/tabs"

function parseWithBoundary(argv: string[]) {
  const norm = normalizeArgsSplit(argv)
  return parseActionsCommand(norm.argv, norm.positionalCount)
}

describe("type text stops at the positional boundary (#217)", () => {
  test("the reported repro: type e1 999 --frame 4897 types exactly '999'", () => {
    expect(parseWithBoundary(["type", "e1", "999", "--frame", "4897"]))
      .toMatchObject({ type: "input_text", ref: "e1", text: "999", clear: true })
  })

  test("empty text with --frame types exactly ''", () => {
    expect(parseWithBoundary(["type", "e5", "", "--frame", "4719"]))
      .toMatchObject({ type: "input_text", ref: "e5", text: "" })
  })

  test("multi-word text still joins, flags still excluded", () => {
    expect(parseWithBoundary(["type", "e1", "hello", "world", "--append", "--frame", "2"]))
      .toMatchObject({ type: "input_text", ref: "e1", text: "hello world", clear: false })
  })

  test("--trusted routes to os_type without leaking into the text", () => {
    expect(parseWithBoundary(["type", "e1", "hi", "--trusted"]))
      .toMatchObject({ type: "os_type", ref: "e1", text: "hi" })
  })

  test("'--' terminator still allows literal flag-looking text", () => {
    expect(parseWithBoundary(["type", "e1", "--", "--append"]))
      .toMatchObject({ type: "input_text", ref: "e1", text: "--append" })
  })

  test("legacy direct call without the boundary keeps the old filter behavior", () => {
    expect(parseActionsCommand(["type", "e1", "hello", "world"]))
      .toMatchObject({ type: "input_text", ref: "e1", text: "hello world" })
  })
})

describe("value-flag map gaps proven alongside #217", () => {
  test("window resize --width/--height keep their operands (were hoisted as a window id)", () => {
    const argv = normalizeArgs(["window", "resize", "--width", "800", "--height", "600"])
    expect(argv).toEqual(["window", "resize", "--width", "800", "--height", "600"])
    expect(buildWindowResizeAction(argv.slice(2))).toMatchObject({ type: "window_resize", width: 800, height: 600 })
  })

  test("brand tab-group --title/--color parse (previously 'requires --title')", () => {
    const argv = normalizeArgs(["brand", "tab-group", "--title", "Acme", "--color", "blue"])
    expect(parseBrandCommand(argv)).toEqual({ type: "brand_set_tab_group", title: "Acme", color: "blue" })
  })

  test("keepawake --interval keeps its operand order-independently", () => {
    expect(normalizeArgs(["keepawake", "--interval", "30", "on"]))
      .toEqual(["keepawake", "on", "--interval", "30"])
  })
})
