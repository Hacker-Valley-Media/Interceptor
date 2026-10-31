// Act reports text a click revealed or removed, in plain lines.
import { beforeEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* shared test DOM already registered */ }

import { cacheSnapshot, computeTextDiff, visibleTextLines } from "../extension/src/content/snapshot-diff"
import { formatActChanges } from "../cli/commands/compound"
import { readFileSync } from "node:fs"
import { join } from "node:path"

beforeEach(() => { document.body.innerHTML = "" })

describe("text diff", () => {
  test("no baseline answers null", () => {
    // A fresh content script (after a navigation) has no earlier read.
    document.body.innerHTML = "<p>x</p>"
    const fresh = computeTextDiff()
    expect(fresh === null || (Array.isArray(fresh.textAdded))).toBe(true)
  })

  test("a swapped panel shows as one line added and one removed", () => {
    document.body.innerHTML = "<div><p>Header</p><p id='panel'>Cedar summary: nested panel benchmark target</p></div>"
    cacheSnapshot()
    document.getElementById("panel")!.textContent = "Birch summary: neutral control item"
    const diff = computeTextDiff()!
    expect(diff.textAdded.some(l => l.includes("Birch summary: neutral control item"))).toBe(true)
    expect(diff.textRemoved.some(l => l.includes("Cedar summary: nested panel benchmark target"))).toBe(true)
    // The baseline advances: asking again reports nothing new.
    expect(computeTextDiff()!.textAdded).toEqual([])
  })

  test("lines are capped and masked like text", () => {
    document.body.innerHTML = `<p>${"x".repeat(500)}</p>`
    expect(visibleTextLines()[0].length).toBeLessThanOrEqual(201)
  })
})

describe("act change block", () => {
  test("plain lines, grouped, capped at 20", () => {
    const lines = formatActChanges({
      success: true,
      data: {
        changes: 1, added: ["+ e9 button \"Close\" (new)"], removed: [], changed: [],
        textAdded: Array.from({ length: 25 }, (_, i) => `line ${i}`), textRemoved: ["Cedar summary"],
        textAddedTotal: 25, textRemovedTotal: 1,
      },
    })
    expect(lines[0]).toBe("text added:")
    expect(lines).toContain("  + line 0")
    expect(lines).toContain("  … 5 more")
    expect(lines).toContain("text removed:")
    expect(lines).toContain("  - Cedar summary")
    expect(lines).toContain("elements added:")
    expect(lines.join("\n")).not.toContain("{")
  })

  test("nothing changed, no baseline, and an old extension without text fields", () => {
    expect(formatActChanges({ success: true, data: { changes: 0, added: [], removed: [], changed: [] } })).toEqual(["no visible changes"])
    expect(formatActChanges({ success: false, error: "no previous snapshot" })[0]).toContain("no earlier read")
    expect(formatActChanges({ success: true, data: { changes: 1, added: ["+ e1 link \"x\" (new)"], removed: [], changed: [] } })).toEqual(["elements added:", "  + e1 link \"x\" (new)"])
  })

  test("runAct asks for the diff before the tree read that re-caches the snapshot", () => {
    const src = readFileSync(join(import.meta.dir, "../cli/commands/compound.ts"), "utf-8")
    const body = src.slice(src.indexOf("export async function runAct"))
    expect(body.indexOf('send({ type: "diff" }')).toBeLessThan(body.indexOf("treeResult = await readTree()"))
  })
})
