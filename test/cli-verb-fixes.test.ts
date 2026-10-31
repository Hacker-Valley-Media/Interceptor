// CLI verb fixes: tab list, bare net, flag bundles.
import { describe, expect, test } from "bun:test"
import { parseTabsCommand } from "../cli/commands/tabs"

describe("tab list runs tabs", () => {
  test("list and ls map to tab_list", async () => {
    expect(await parseTabsCommand(["tab", "list"])).toEqual({ type: "tab_list" })
    expect(await parseTabsCommand(["tab", "ls"])).toEqual({ type: "tab_list" })
    expect(await parseTabsCommand(["tabs"])).toEqual({ type: "tab_list" })
  })
})

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseScreenshotCommand } from "../cli/commands/screenshot"

describe("screenshot --out", () => {
  const dir = mkdtempSync(join(tmpdir(), "ic-shot-"))

  test("--out sets save, the absolute path and the format from the extension", () => {
    expect(parseScreenshotCommand(["screenshot", "--out", join(dir, "a.png")])).toMatchObject({ type: "screenshot", save: true, out: join(dir, "a.png"), format: "png" })
    expect(parseScreenshotCommand(["screenshot", "--out", join(dir, "a.JPG")])).toMatchObject({ format: "jpeg" })
    expect(parseScreenshotCommand(["screenshot", "--out", join(dir, "a.webp"), "--format", "webp"])).toMatchObject({ format: "webp" })
  })

  test("a relative path resolves against the current directory", () => {
    expect(parseScreenshotCommand(["screenshot", "--out", "x.png"])).toMatchObject({ out: join(process.cwd(), "x.png") })
  })

  test("bad extension, conflicting --format and a missing folder are errors", () => {
    expect(() => parseScreenshotCommand(["screenshot", "--out", join(dir, "a.gif")])).toThrow("must end in .png, .jpg, .jpeg or .webp")
    expect(() => parseScreenshotCommand(["screenshot", "--out", join(dir, "a.png"), "--format", "jpeg"])).toThrow("is a png file but --format is 'jpeg'")
    expect(() => parseScreenshotCommand(["screenshot", "--out", join(dir, "nope", "a.png")])).toThrow("does not exist")
  })

  test("--background honors --out and --save", () => {
    expect(parseScreenshotCommand(["screenshot", "--background", "--out", join(dir, "b.png")])).toMatchObject({ type: "screenshot_background", save: true, format: "png" })
    expect(parseScreenshotCommand(["screenshot", "--background", "--save"])).toMatchObject({ type: "screenshot_background", save: true })
  })

  test("--save keeps today's action", () => {
    expect(parseScreenshotCommand(["screenshot", "--save"])).toEqual({ type: "screenshot", save: true })
  })
})

import { normalizeArgs } from "../cli/normalize"
import { readFileSync as readSrc } from "node:fs"

describe("act --submit and --keys target", () => {
  const compound = readSrc(join(import.meta.dir, "../cli/commands/compound.ts"), "utf-8")
  const content = readSrc(join(import.meta.dir, "../extension/src/content.ts"), "utf-8")

  test("--submit is an act flag only", () => {
    expect(normalizeArgs(["act", "e4", "Turing", "--submit"])).toEqual(["act", "e4", "Turing", "--submit"])
    expect(() => normalizeArgs(["read", "--submit"])).toThrow("unknown flag '--submit'")
  })

  test("act sends submit_form after typing, and keys carry the ref", () => {
    expect(compound).toContain('actionResult = await send({ type: "submit_form", ...target }')
    expect(compound).toContain('send({ type: "send_keys", keys, ...target }')
    expect(content).toContain('case "submit_form":         return handleSubmitForm(action)')
  })
})

import { parseNetworkCommand } from "../cli/commands/network"

describe("bare net is net log", () => {
  test("no subcommand, or only flags, runs net log", () => {
    expect(parseNetworkCommand(["net"])).toMatchObject({ type: "net_log" })
    expect(parseNetworkCommand(["net", "--limit", "5"])).toMatchObject({ type: "net_log", limit: 5 })
    expect(parseNetworkCommand(["net", "log", "--limit", "5"])).toMatchObject({ type: "net_log", limit: 5 })
    expect(parseNetworkCommand(["net", "headers"])).toMatchObject({ type: "net_headers" })
  })
})

import { traceEnabled, withRequestId } from "../cli/transport"

describe("trace lines only for a terminal or INTERCEPTOR_DEBUG=1", () => {
  test("piped stderr (isTTY false or undefined) hides them", () => {
    expect(traceEnabled({ isTTY: undefined }, {})).toBe(false)
    expect(traceEnabled({ isTTY: false }, {})).toBe(false)
    expect(traceEnabled({ isTTY: true }, {})).toBe(true)
    expect(traceEnabled({}, { INTERCEPTOR_DEBUG: "1" })).toBe(true)
    expect(traceEnabled({}, { INTERCEPTOR_DEBUG: "0" })).toBe(false)
  })

  test("timeouts name the request id", () => {
    expect(withRequestId("timeout: no response for 'tab_list' after 15s.", "ab12cd34")).toContain("(request ab12cd34")
  })
})

import { flagBundleHint } from "../cli/normalize"

describe("flag bundles explain zsh", () => {
  test("a word with several flags gets the hint; ordinary words do not", () => {
    expect(flagBundleHint("--context main --group x")).toContain("${=VAR}")
    expect(flagBundleHint("--context main --group x")).toContain("shell function")
    expect(flagBundleHint("--context")).toBe("")
    expect(flagBundleHint("tabs")).toBe("")
  })

  test("the unknown-flag error carries it", () => {
    expect(() => normalizeArgs(["tabs", "--context main --group x"])).toThrow("${=VAR}")
  })
})
