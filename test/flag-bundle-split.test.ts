// A bundle of global flags passed as one word is split; anything ambiguous is not.
import { expect, test } from "bun:test"
import { expandFlagBundles } from "../cli/normalize"

test("a leading or trailing --context/--group bundle is split", () => {
  expect(expandFlagBundles(["--context main --group x", "tabs"])).toEqual({ args: ["--context", "main", "--group", "x", "tabs"], split: ["--context main --group x"] })
  expect(expandFlagBundles(["tabs", "--context main --json"]).args).toEqual(["tabs", "--context", "main", "--json"])
  expect(expandFlagBundles(["--group=x --any-tab", "read"]).args).toEqual(["--group=x", "--any-tab", "read"])
})

test("a context name with spaces is not guessed at", () => {
  const r = expandFlagBundles(["--context work and home", "tabs"])
  expect(r.split).toEqual([])
  expect(r.args[0]).toBe("--context work and home")
})

test("verb flags, quotes, a missing value, and words after -- stay whole", () => {
  for (const word of ["--full text", "--context 'main' --json", "--context", "--group --json", "--unknown x"]) {
    expect(expandFlagBundles(["act", "e5", word]).args).toContain(word)
  }
  expect(expandFlagBundles(["type", "e5", "--", "--context main"]).args).toEqual(["type", "e5", "--", "--context main"])
})

test("ordinary argv is untouched", () => {
  const argv = ["--context", "main", "open", "https://example.com", "--tree-format", "compact"]
  expect(expandFlagBundles(argv)).toEqual({ args: argv, split: [] })
})
