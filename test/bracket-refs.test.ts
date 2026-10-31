// A ref copied with its tree brackets means the bare ref.
import { beforeEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* shared test DOM already registered */ }

import { parseElementTarget, normalizeRefArg } from "../cli/parse"
import { parseScreenshotCommand } from "../cli/commands/screenshot"
import { getOrAssignRef, refRegistry, resolveRef } from "../extension/src/content/ref-registry"

beforeEach(() => { document.body.innerHTML = ""; refRegistry.clear() })

describe("CLI", () => {
  test("bracketed, piped, and whole-line forms parse as the bare ref", () => {
    for (const arg of ["[e5]", "e5]", "[e5|button|Search]", '[e5] link "Charles Babbage" href="/wiki/Charles_Babbage"']) {
      expect(parseElementTarget(arg)).toEqual({ ref: "e5" })
    }
    expect(parseElementTarget("[e2_7]")).toEqual({ ref: "e7", frameId: 2 })
    expect(parseElementTarget("e2_7")).toEqual({ ref: "e7", frameId: 2 })
  })

  test("other strings are unchanged", () => {
    expect(normalizeRefArg("[x]")).toBe("[x]")
    expect(normalizeRefArg("e5x")).toBe("e5x")
    expect(parseElementTarget("e5")).toEqual({ ref: "e5" })
    expect(parseElementTarget("button:Search")).toEqual({ semantic: { role: "button", name: "Search" } })
  })

  test("screenshot --ref and ocr take bracketed refs", () => {
    expect(parseScreenshotCommand(["screenshot", "--ref", "[e3]"])).toMatchObject({ ref: "e3" })
    expect(parseScreenshotCommand(["ocr", "[e3]"])).toMatchObject({ ref: "e3" })
    expect(parseScreenshotCommand(["ocr", ".headline"])).toMatchObject({ selector: ".headline" })
  })
})

describe("content script", () => {
  test("resolveRef unwraps a plain bracketed ref and nothing else", () => {
    document.body.innerHTML = "<button id='b'>Search</button>"
    const el = document.getElementById("b")!
    const ref = getOrAssignRef(el)
    expect(resolveRef(ref)).toBe(el)
    expect(resolveRef(`[${ref}]`)).toBe(el)
    expect(resolveRef(`[${ref}|button|Search]`)).toBe(el)
    expect(resolveRef("[x]")).toBeNull()
    expect(resolveRef(`${ref}x`)).toBeNull()
  })
})
