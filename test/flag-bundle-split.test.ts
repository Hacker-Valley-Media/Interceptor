// A bundle of global flags passed as one word before the command is split; anything ambiguous is not.
import { expect, test } from "bun:test"
import { expandFlagBundles } from "../cli/normalize"

test("a --context/--group bundle before the command is split", () => {
  expect(expandFlagBundles(["--context main --group x", "tabs"])).toEqual({ args: ["--context", "main", "--group", "x", "tabs"], split: ["--context main --group x"] })
  expect(expandFlagBundles(["--group=x --any-tab", "read"]).args).toEqual(["--group=x", "--any-tab", "read"])
  expect(expandFlagBundles(["--json", "--context main --group x", "tabs"]).args).toEqual(["--json", "--context", "main", "--group", "x", "tabs"])
  expect(expandFlagBundles(["--tab", "12", "--context main --json", "read"]).args).toEqual(["--tab", "12", "--context", "main", "--json", "read"])
})

test("a word after the command is never split: it may be text or a flag's value", () => {
  for (const argv of [["tabs", "--context main --json"], ["type", "e5", "--context main"], ["verify", "--text", "--context main"], ["act", "e5", "--group x"]]) {
    expect(expandFlagBundles(argv)).toEqual({ args: argv, split: [] })
  }
})

test("a context name with spaces is not guessed at", () => {
  const r = expandFlagBundles(["--context work and home", "tabs"])
  expect(r.split).toEqual([])
  expect(r.args[0]).toBe("--context work and home")
})

test("verb flags, quotes, a missing value, and words after -- stay whole", () => {
  for (const word of ["--full text", "--context 'main' --json", "--group --json", "--unknown x"]) {
    expect(expandFlagBundles([word, "tabs"]).args).toContain(word)
  }
  expect(expandFlagBundles(["--", "--context main"]).args).toEqual(["--", "--context main"])
})

test("ordinary argv is untouched", () => {
  const argv = ["--context", "main", "open", "https://example.com", "--tree-format", "compact"]
  expect(expandFlagBundles(argv)).toEqual({ args: argv, split: [] })
})
