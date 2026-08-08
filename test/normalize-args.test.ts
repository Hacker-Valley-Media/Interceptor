import { describe, expect, test } from "bun:test"

import { normalizeArgs } from "../cli/normalize"

describe("normalizeArgs", () => {
  test("the original repro: open --text-only <url> puts the URL back at filtered[1]", () => {
    expect(normalizeArgs(["open", "--text-only", "https://example.com"]))
      .toEqual(["open", "https://example.com", "--text-only"])
  })

  test("flags-last invocations are unchanged", () => {
    expect(normalizeArgs(["open", "https://example.com", "--text-only", "--no-wait"]))
      .toEqual(["open", "https://example.com", "--text-only", "--no-wait"])
  })

  test("value flags keep their value adjacent when hoisted", () => {
    expect(normalizeArgs(["open", "--timeout", "8000", "https://example.com"]))
      .toEqual(["open", "https://example.com", "--timeout", "8000"])
  })

  test("interleaved flags and positionals", () => {
    expect(normalizeArgs(["act", "--no-read", "e5", "hello", "--timeout", "500", "world"]))
      .toEqual(["act", "e5", "hello", "world", "--no-read", "--timeout", "500"])
  })

  test("read --text-only e5 no longer silently ignores the ref", () => {
    expect(normalizeArgs(["read", "--text-only", "e5"]))
      .toEqual(["read", "e5", "--text-only"])
  })

  test("boolean flags do not swallow the following positional", () => {
    expect(normalizeArgs(["open", "--activate", "https://example.com"]))
      .toEqual(["open", "https://example.com", "--activate"])
  })

  test("value flag values may start with a dash (negative amounts)", () => {
    expect(normalizeArgs(["scroll", "--amount", "-100", "down"]))
      .toEqual(["scroll", "down", "--amount", "-100"])
  })

  test("single-dash tokens are positionals, not short-option groups", () => {
    expect(normalizeArgs(["wait", "-5"]))
      .toEqual(["wait", "-5"])
  })

  test("--flag=value is split into indexOf-parseable tokens", () => {
    expect(normalizeArgs(["read", "--filter=all", "e2"]))
      .toEqual(["read", "e2", "--filter", "all"])
  })

  test("-- terminator: everything after is positional verbatim", () => {
    expect(normalizeArgs(["act", "e5", "--", "--not-a-flag"]))
      .toEqual(["act", "e5", "--not-a-flag"])
  })

  test("trailing value flag with no value does not consume anything", () => {
    expect(normalizeArgs(["open", "https://example.com", "--timeout"]))
      .toEqual(["open", "https://example.com", "--timeout"])
  })

  test("optional-value flag does not swallow a following flag", () => {
    expect(normalizeArgs(["monitor", "start", "--persist-bodies", "--reload"]))
      .toEqual(["monitor", "start", "--persist-bodies", "--reload"])
  })

  test("optional-value flag consumes a plain value (stays adjacent)", () => {
    expect(normalizeArgs(["monitor", "start", "--persist-bodies", "256"]))
      .toEqual(["monitor", "start", "--persist-bodies", "256"])
  })

  test("macos and ios argv pass through untouched", () => {
    const macos = ["macos", "--app", "Safari", "read"]
    expect(normalizeArgs(macos)).toEqual(macos)
    const ios = ["ios", "click", "--on", "phone", "e3"]
    expect(normalizeArgs(ios)).toEqual(ios)
  })

  test("skills adopt with --into keeps names as positionals", () => {
    expect(normalizeArgs(["skills", "adopt", "--into", "claude,codex", "interceptor-browser"]))
      .toEqual(["skills", "adopt", "interceptor-browser", "--into", "claude,codex"])
  })

  test("network export flags stay paired", () => {
    expect(normalizeArgs(["net", "--format", "har", "--out", "/tmp/x.har", "--limit", "5"]))
      .toEqual(["net", "--format", "har", "--out", "/tmp/x.har", "--limit", "5"])
  })

  test("find keeps multi-word queries in positional order", () => {
    expect(normalizeArgs(["find", "--role", "button", "submit", "order"]))
      .toEqual(["find", "submit", "order", "--role", "button"])
  })

  test("click --selector keeps a quoted multi-token selector attached", () => {
    expect(normalizeArgs(["click", "--selector", "button span", "--nth", "4"]))
      .toEqual(["click", "--selector", "button span", "--nth", "4"])
  })

  test("click --nth value stays attached when flags precede other flags", () => {
    expect(normalizeArgs(["click", "--nth", "4", "--selector", "button span"]))
      .toEqual(["click", "--nth", "4", "--selector", "button span"])
  })
})
