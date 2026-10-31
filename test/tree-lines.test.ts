// Honest tree lines and an honest isolated-save error.
import { beforeEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* shared test DOM already registered */ }

import { getRelevantAttrs, TREE_HREF_CHARS } from "../extension/src/content/element-tree"
import { displayRoleName, lineName, getEffectiveRole } from "../extension/src/content/a11y-tree"
import { ISOLATED_SAVE_UNAVAILABLE } from "../extension/src/background/capabilities/binary-sink"
import { rewriteCspEvalError } from "../cli/format"

beforeEach(() => { document.body.innerHTML = "" })

describe("hrefs", () => {
  test("whole up to 300 characters, as written; longer ends in an ellipsis", () => {
    const mid = "https://example.com/" + "a".repeat(100) + ".pdf"
    const long = "https://example.com/" + "b".repeat(400)
    document.body.innerHTML = `<a id="m" href="${mid}">m</a><a id="l" href="${long}">l</a><a id="r" href="/output-lab/?page=2#relative">r</a>`
    expect(getRelevantAttrs(document.getElementById("m")!)).toBe(`href="${mid}"`)
    expect(getRelevantAttrs(document.getElementById("l")!)).toBe(`href="${long.slice(0, TREE_HREF_CHARS)}…"`)
    expect(getRelevantAttrs(document.getElementById("r")!)).toBe(`href="/output-lab/?page=2#relative"`)
  })
})

describe("names and button inputs", () => {
  test("a name with line breaks prints on one line", () => {
    expect(lineName("Search by keyword,\n      term, or phrase")).toBe("Search by keyword, term, or phrase")
  })

  test("button-like inputs print as buttons named by their value", () => {
    document.body.innerHTML = `<input id="s" type="submit" value="Apply"><input id="r" type="reset"><input id="t" type="text">`
    const s = document.getElementById("s")!
    expect(displayRoleName(s, getEffectiveRole(s), "")).toEqual({ role: "button", name: "Apply" })
    const r = document.getElementById("r")!
    expect(displayRoleName(r, getEffectiveRole(r), "")).toEqual({ role: "button", name: "Reset" })
    const t = document.getElementById("t")!
    expect(displayRoleName(t, getEffectiveRole(t), "Query")).toEqual({ role: "textbox", name: "Query" })
    // The role that semantic matching and recordings use is unchanged.
    expect(getEffectiveRole(s)).toBe("textbox")
  })
})

describe("isolated save", () => {
  test("the message is not relabelled as a page CSP error", () => {
    expect(rewriteCspEvalError(ISOLATED_SAVE_UNAVAILABLE)).toBe(ISOLATED_SAVE_UNAVAILABLE)
    expect(ISOLATED_SAVE_UNAVAILABLE).toContain("without --isolated")
  })
})
