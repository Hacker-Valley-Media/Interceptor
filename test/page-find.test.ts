import { beforeEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* shared test DOM already registered */ }

import { findRenderedText, findAccessibleElements, handleFindElement } from "../extension/src/content/find"
import { getOrAssignRef, refRegistry } from "../extension/src/content/ref-registry"
import { parseStateCommand } from "../cli/commands/state"

beforeEach(() => {
  document.body.innerHTML = ""
  refRegistry.clear()
})

describe("rendered page find", () => {
  test("CLI selects hybrid, narrow, role, and frame modes truthfully", () => {
    expect(parseStateCommand(["find", "alpha"])).toMatchObject({ type: "find_element", query: "alpha", mode: "hybrid" })
    expect(parseStateCommand(["find", "alpha", "--text-only"])).toMatchObject({ mode: "text" })
    expect(parseStateCommand(["find", "alpha", "--elements-only"])).toMatchObject({ mode: "elements" })
    expect(parseStateCommand(["find", "alpha", "--role", "button"])).toMatchObject({ mode: "elements", role: "button" })
    expect(parseStateCommand(["find", "alpha", "--include-frames"])).toMatchObject({ type: "frames_find" })
  })

  test("scans beyond read's normal 8K output cap", () => {
    const text = `${"a".repeat(9000)} UNIQUE passage`
    const result = findRenderedText(text, "unique passage")
    expect(result.total).toBe(1)
    expect(result.matches[0].start).toBe(9001)
    expect(result.scannedCharacters).toBe(text.length)
    expect(result.scanTruncated).toBe(false)
  })

  test("matches case-insensitively and treats regex metacharacters literally", () => {
    const result = findRenderedText("Use A+B, not ab. A+B wins.", "a+b", 1)
    expect(result.total).toBe(2)
    expect(result.returned).toBe(1)
    expect(result.truncated).toBe(true)
    expect(result.matches[0].matchedText).toBe("A+B")
  })

  test("normalizes snippet whitespace while retaining stable source indices", () => {
    const text = "before\n\n  Exact Match\t after"
    const result = findRenderedText(text, "exact match")
    expect(result.matches[0]).toMatchObject({
      start: text.indexOf("Exact Match"),
      end: text.indexOf("Exact Match") + "Exact Match".length,
      matchedText: "Exact Match",
      snippet: "before Exact Match after"
    })
  })

  test("zero matches is a successful empty category", () => {
    expect(findRenderedText("alpha", "omega")).toMatchObject({ total: 0, returned: 0, truncated: false, matches: [] })
  })

  test("hybrid and narrow modes do not mutate, focus, or scroll the page", async () => {
    document.body.innerText = "Alpha passage and another alpha passage"
    const before = { html: document.body.innerHTML, x: window.scrollX, y: window.scrollY, active: document.activeElement }
    const hybrid = await handleFindElement({ type: "find_element", query: "alpha", limit: 1 })
    const textOnly = await handleFindElement({ type: "find_element", query: "alpha", mode: "text" })
    expect(hybrid.success).toBe(true)
    expect((hybrid.data as any).text).toMatchObject({ total: 2, returned: 1, truncated: true })
    expect((textOnly.data as any).elements).toBeUndefined()
    expect({ html: document.body.innerHTML, x: window.scrollX, y: window.scrollY, active: document.activeElement }).toEqual(before)
  })
})

describe("accessible element find compatibility", () => {
  test("preserves accessible-name scoring, refs, role filtering, and limits", () => {
    const button = document.createElement("button")
    button.textContent = "Submit order"
    document.body.append(button)
    Object.defineProperty(button, "offsetParent", { configurable: true, get: () => document.body })
    button.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20, toJSON: () => ({}) })
    const refId = getOrAssignRef(button)

    const result = findAccessibleElements("Submit order", "button", 1)

    expect(result).toMatchObject({ total: 1, returned: 1, truncated: false })
    expect(result.matches[0]).toMatchObject({ refId, role: "button", name: "Submit order", score: 150 })
  })
})
