// Same-page act prints changes and revealed refs, not the whole tree.
import { describe, expect, test } from "bun:test"
import { formatActOutput } from "../cli/commands/compound"

const tree = "[e1] searchbox \"Search\"\n[e2] button \"Go\"\n[e3] checkbox \"I agree\" type=\"checkbox\" checked"
const samePage = { success: true, data: { changes: 1, added: [], removed: [], changed: ["~ e3 states: type=\"checkbox\" → type=\"checkbox\" checked"], textAdded: [], textRemoved: [] } }
const newPage = { success: false, error: "no previous snapshot" }

describe("act output", () => {
  test("same page: no tree, the change, and a note that refs still work", () => {
    const out = formatActOutput({ treeData: tree, diffResult: samePage, textContent: "", submit: false, wantTree: false, treeAdded: ["[e3] checkbox \"I agree\" type=\"checkbox\" checked"] })
    expect(out).not.toContain("[e1] searchbox")
    expect(out).toContain("~ e3 states")
    // the changed element's line is not repeated as new
    expect(out).not.toContain("new on the page")
    expect(out).toContain("pass --tree for the whole tree")
  })

  test("same page: a revealed control is listed with its ref", () => {
    const quiet = { success: true, data: { changes: 0, added: [], removed: [], changed: [], textAdded: ["Menu"], textRemoved: [] } }
    const out = formatActOutput({ treeData: tree, diffResult: quiet, textContent: "", submit: false, wantTree: false, treeAdded: ["[e9] menuitem \"Delete\""] })
    expect(out).toContain("new on the page:\n  [e9] menuitem \"Delete\"")
    expect(out).toContain("+ Menu")
  })

  test("--tree restores the tree", () => {
    const out = formatActOutput({ treeData: tree, diffResult: samePage, textContent: "", submit: false, wantTree: true, treeAdded: [] })
    expect(out.startsWith("[e1] searchbox")).toBe(true)
  })

  test("after a navigation the tree and text print", () => {
    const out = formatActOutput({ treeData: tree, diffResult: newPage, textContent: "Results for x", submit: false, wantTree: false, treeAdded: undefined })
    expect(out).toContain("[e1] searchbox")
    expect(out).toContain("Results for x")
  })

  test("an older extension without treeAdded keeps the tree", () => {
    const out = formatActOutput({ treeData: tree, diffResult: samePage, textContent: "", submit: false, wantTree: false })
    expect(out).toContain("[e1] searchbox")
  })

  test("--until note is shown", () => {
    const out = formatActOutput({ treeData: tree, diffResult: samePage, textContent: "", submit: false, wantTree: false, treeAdded: [], untilNote: "\"Saved\" appeared" })
    expect(out).toContain("--- until: \"Saved\" appeared ---")
  })
})

test("when the action removed refs, act does not claim old refs still work", () => {
  const rerender = { success: true, data: { changes: 3, added: [], removed: ["- e1 (removed)", "- e2 (removed)"], changed: [], textAdded: [], textRemoved: [] } }
  const out = formatActOutput({ treeData: "x", diffResult: rerender, textContent: "", submit: false, wantTree: false, treeAdded: ["[e7] div \"Cedar\""] })
  expect(out).not.toContain("refs from your last read still work")
  expect(out).toContain("refs listed as removed are gone, use the new ones above")
  expect(out).toContain("[e7] div \"Cedar\"")
})
