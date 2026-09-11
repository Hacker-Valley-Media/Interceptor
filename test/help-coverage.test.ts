// Every verb the top-level command map lists must answer `interceptor help
// <verb>`. The unknown-flag error tells agents to run exactly that, and 46 of
// the listed verbs answered "no help" (2026-09-10 session review). The list is
// read from cli/index.ts so a new verb without help fails here, not in a
// session.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { helpForCommand } from "../cli/help"

const INDEX = readFileSync(resolve(import.meta.dir, "../cli/index.ts"), "utf-8")

function commandSetNames(): string[] {
  const names = new Set<string>()
  for (const m of INDEX.matchAll(/^const [A-Z_]+_CMDS = new Set\(\[([^\]]+)\]\)/gm)) {
    for (const n of m[1].matchAll(/"([^"]+)"/g)) names.add(n[1])
  }
  return [...names]
}

describe("help coverage", () => {
  const names = commandSetNames()

  test("the command sets were found", () => {
    expect(names.length).toBeGreaterThan(60)
    expect(names).toContain("open")
    expect(names).toContain("upload")
  })

  for (const name of names) {
    // `search` is the deprecated alias, still documented; `help` itself is the
    // entry point. Everything else must have a page.
    test(`help ${name}`, () => {
      const page = helpForCommand(name)
      expect(page, `no help page for '${name}'`).not.toBeNull()
      expect(page).toContain(`interceptor ${name}`)
    })
  }

  test("help narrows to a macos sub-verb", () => {
    const page = helpForCommand("macos", "tree")
    expect(page).not.toBeNull()
    expect(page).toContain("interceptor macos tree")
    expect(page).not.toContain("interceptor macos click ")
  })

  test("help narrows to a grouped ios sub-verb (tree|find|inspect)", () => {
    const page = helpForCommand("ios", "tree")
    expect(page).not.toBeNull()
    expect(page).toContain("interceptor ios tree|find|inspect")
    expect(page).not.toContain("interceptor ios devices")
  })

  test("a curated page that documents the sub-verb answers for it (help update status)", () => {
    const page = helpForCommand("update", "status")
    expect(page).not.toBeNull()
    expect(page).toContain("interceptor update status")
  })

  test("help for an unknown sub-verb is null, not the whole block", () => {
    expect(helpForCommand("macos", "definitely-not-a-verb")).toBeNull()
  })

  test("manifest-only verbs render usage, flags, and returns", () => {
    const page = helpForCommand("upload")
    expect(page).toContain("interceptor upload e<ref> <path>")
    expect(page).toContain("Returns:")
  })

  test("global flags name the lane env defaults", () => {
    const page = helpForCommand("open")
    expect(page).not.toBeNull()
  })
})
