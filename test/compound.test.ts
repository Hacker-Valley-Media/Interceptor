import { describe, expect, test } from "bun:test"
import { actValue, buildReadTreeAction, buildTabCreateAction } from "../cli/commands/compound"
import { normalizeArgsSplit } from "../cli/normalize"
import { parseElementTarget } from "../cli/parse"

describe("buildReadTreeAction", () => {
  test("passes subtree targeting into get_a11y_tree for regular reads", () => {
    const target = parseElementTarget("e7")
    const action = buildReadTreeAction({
      target,
      filterMode: "interactive",
      includeStyle: true,
      includeFrames: false
    })

    expect(action).toMatchObject({
      type: "get_a11y_tree",
      ref: "e7",
      includeStyle: true,
      filter: "interactive"
    })
  })

  test("passes frame and ref targeting into frames_read_tree", () => {
    const target = parseElementTarget("e9_2")
    const action = buildReadTreeAction({
      target,
      filterMode: "interactive",
      includeStyle: false,
      includeFrames: true
    })

    expect(action).toMatchObject({
      type: "frames_read_tree",
      frameId: 9,
      ref: "e2",
      includeStyle: false,
      filter: "interactive"
    })
  })
})

describe("buildTabCreateAction", () => {
  test("omits reuse field by default — preserves existing create-new-tab semantics", () => {
    const action = buildTabCreateAction(["open", "https://example.com"], "https://example.com")
    expect(action).toEqual({ type: "tab_create", url: "https://example.com" })
    expect("reuse" in action).toBe(false)
  })

  test("sets reuse: true when --reuse is present in filtered args", () => {
    const action = buildTabCreateAction(
      ["open", "https://example.com", "--reuse"],
      "https://example.com"
    )
    expect(action).toEqual({ type: "tab_create", url: "https://example.com", reuse: true })
  })

  test("does NOT set reuse when other open flags are present without --reuse", () => {
    const action = buildTabCreateAction(
      ["open", "https://example.com", "--full", "--tree-only"],
      "https://example.com"
    )
    expect(action.reuse).toBeUndefined()
  })
})

describe("actValue", () => {
  // `act` runs on the normalized argv [cmd, ...positionals, ...flags], so the
  // value is the positional span after the ref. Global booleans live in the
  // flag span and must never be mistaken for text to type.
  const normalized = (cmd: string) => normalizeArgsSplit(cmd.split(" "))

  test("no value is a click", () => {
    const { argv, positionalCount } = normalized("act e1")
    expect(actValue(argv, positionalCount)).toBeUndefined()
  })

  test("positional after the ref is the text to type", () => {
    const { argv, positionalCount } = normalizeArgsSplit(["act", "e1", "hello world"])
    expect(actValue(argv, positionalCount)).toBe("hello world")
  })

  test("unquoted multi-word text is rejoined", () => {
    const { argv, positionalCount } = normalized("act e1 hello world")
    expect(actValue(argv, positionalCount)).toBe("hello world")
  })

  // Regression: each of these used to fall through the hardcoded flag list and
  // become the typed text, turning a click into input_text carrying the flag.
  for (const flag of ["--json", "--no-skills-hint", "--no-research-hint", "--any-tab", "--changes"]) {
    test(`${flag} stays a click, never typed text`, () => {
      const { argv, positionalCount } = normalized(`act e1 ${flag}`)
      expect(actValue(argv, positionalCount)).toBeUndefined()
    })

    test(`${flag} is not appended to a real value`, () => {
      const { argv, positionalCount } = normalized(`act e1 hello ${flag}`)
      expect(actValue(argv, positionalCount)).toBe("hello")
    })
  }

  test("act-specific booleans are still excluded", () => {
    const { argv, positionalCount } = normalized("act e1 hello --append --no-read")
    expect(actValue(argv, positionalCount)).toBe("hello")
  })

  test("value flags keep their operands out of the text", () => {
    const { argv, positionalCount } = normalized("act e1 hello --timeout 5000")
    expect(actValue(argv, positionalCount)).toBe("hello")
  })

  test("fallback (no boundary) still excludes the act-specific flags", () => {
    expect(actValue(["act", "e1", "hello", "--append"])).toBe("hello")
  })
})
