import { beforeEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* shared test DOM already registered */ }

import {
  discoverAdaptiveSceneObjects, readFocusedWritableText, selectedAdaptiveScene, writeToFocusedWritableSurface,
} from "../extension/src/content/scene/adaptive"
import { SECURE_MASK } from "../extension/src/content/sensitive"

// Scene reads are the one DOM read that returned a focused password in clear.
// They now go through the same masking helper as read and forms; the write path
// keeps the raw value so an append still lands after the real text.

const rect = { x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 30, width: 200, height: 30, toJSON() { return this } }
beforeEach(() => {
  document.body.innerHTML = `<input id="pw" type="password" aria-label="Password"><input id="name" type="text" aria-label="Name">`
  // Distinct rects: discovery folds elements with the same signature (tag + rect) into one.
  Element.prototype.getBoundingClientRect = function (this: Element) { const top = this.id === "pw" ? 0 : 100; return { ...rect, y: top, top, bottom: top + 30 } as DOMRect }
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { get() { return document.body }, configurable: true })
  ;(document.getElementById("pw") as HTMLInputElement).value = "hunter2secret"
  ;(document.getElementById("name") as HTMLInputElement).value = "alice"
})

describe("scene reads mask credentials", () => {
  test("selected and text on a focused password field", () => {
    document.getElementById("pw")!.focus()
    expect(selectedAdaptiveScene().text).toBe(SECURE_MASK)
    expect(readFocusedWritableText()).toEqual({ text: SECURE_MASK, length: SECURE_MASK.length })
  })

  test("selected and text on a focused text field are unchanged", () => {
    document.getElementById("name")!.focus()
    expect(selectedAdaptiveScene().text).toBe("alice")
    expect(readFocusedWritableText()?.text).toBe("alice")
  })

  test("list labels the password object with the mask and the text object with its value", () => {
    const texts = discoverAdaptiveSceneObjects().map((o) => o.text)
    expect(texts).toContain(SECURE_MASK)
    expect(texts).toContain("alice")
    expect(texts).not.toContain("hunter2secret")
  })

  test("an append writes after the real value, not after the mask", () => {
    const pw = document.getElementById("pw") as HTMLInputElement
    pw.focus()
    expect(writeToFocusedWritableSurface("!").success).toBe(true)
    expect(pw.value).toBe("hunter2secret!")
  })
})

describe("Google scene profiles mask credential-marked text", () => {
  test("slides notes and a marked paragraph read as the mask", async () => {
    const { googleSlidesProfile } = await import("../extension/src/content/scene/profiles/google-slides")
    const { markSensitive } = await import("../extension/src/content/sensitive")
    document.body.innerHTML = `<div id="speakernotes"><p id="speakernotes-i1-paragraph-0">plain note</p><p id="speakernotes-i1-paragraph-1">hunter2secret</p></div>`
    markSensitive(document.getElementById("speakernotes-i1-paragraph-1")!)
    expect(googleSlidesProfile.notes!()).toBe(`plain note\n${SECURE_MASK}`)
  })
})
