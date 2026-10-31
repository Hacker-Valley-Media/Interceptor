// Every `interceptor <verb> [sub]` a shipped skill names has an
// `interceptor help` entry.
import { expect, test } from "bun:test"
import { Glob } from "bun"
import { join } from "node:path"
import { helpForCommand } from "../cli/help"

test("skill-named verbs all have help", async () => {
  const root = join(import.meta.dir, "..", ".agents", "skills")
  const seen = new Map<string, string>()
  for await (const f of new Glob("**/*.md").scan({ cwd: root, absolute: true })) {
    const txt = await Bun.file(f).text()
    for (const m of txt.matchAll(/`interceptor ((?:macos |ios |desktop )?[a-z][a-z_-]*)(?: ([a-z][a-z_-]*))?/g)) {
      const key = m[2] && !/^(e\d|--)/.test(m[2]) ? `${m[1]} ${m[2]}` : m[1]
      if (!seen.has(key)) seen.set(key, f.slice(root.length + 1))
    }
  }
  const has = (words: string[]) => helpForCommand(words[0], words[1]) !== null
  const bad: string[] = []
  for (const [verb, file] of seen) {
    const words = verb.split(" ")
    if (has(words)) continue
    const base = words.slice(0, verb.startsWith("macos ") || verb.startsWith("ios ") ? 2 : 1)
    if (!has(base)) bad.push(`${verb} (${file})`)
  }
  expect(seen.size).toBeGreaterThan(50)
  expect(bad).toEqual([])
})
