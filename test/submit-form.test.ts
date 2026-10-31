// Submit_form submits the field's form like the browser's Enter.
import { beforeEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* shared test DOM already registered */ }

import { handleSubmitForm, handleInputText } from "../extension/src/content/actions/type"
import { getOrAssignRef, refRegistry } from "../extension/src/content/ref-registry"

beforeEach(() => { document.body.innerHTML = ""; refRegistry.clear() })

describe("submit_form", () => {
  test("submits through requestSubmit with the default button", async () => {
    document.body.innerHTML = `<form id="f" action="/search"><input id="q" name="q"><input type="submit" value="Apply"></form>`
    const form = document.getElementById("f") as HTMLFormElement
    let submitter: unknown = "none"
    form.addEventListener("submit", (e) => { submitter = (e as SubmitEvent).submitter; e.preventDefault() })
    const ref = getOrAssignRef(document.getElementById("q")!)
    const r = await handleSubmitForm({ type: "submit_form", ref })
    expect(r.success).toBe(true)
    expect((submitter as HTMLInputElement | null)?.value).toBe("Apply")
  })

  test("refuses outside a form and on invalid forms", async () => {
    document.body.innerHTML = `<input id="loose"><form><input id="req" required></form>`
    const loose = await handleSubmitForm({ type: "submit_form", ref: getOrAssignRef(document.getElementById("loose")!) })
    expect(loose.success).toBe(false)
    expect(loose.error).toContain("not inside a form")
    const invalid = await handleSubmitForm({ type: "submit_form", ref: getOrAssignRef(document.getElementById("req")!) })
    expect(invalid.success).toBe(false)
    expect(invalid.error).toContain("did not pass its own validation")
  })
})

describe("type --append on a contenteditable appends", () => {
  test("text goes at the end, not at the caret's start position", async () => {
    document.body.innerHTML = `<div id="ed" contenteditable="true">Editor Lab baseline text</div>`
    const el = document.getElementById("ed")!
    const ref = getOrAssignRef(el)
    // happy-dom has no editing commands: stand in for insertText, which
    // inserts at the live selection exactly as the browser does.
    const doc = document as unknown as { execCommand?: (cmd: string, ui: boolean, value?: string) => boolean }
    const saved = doc.execCommand
    doc.execCommand = (cmd, _ui, value) => {
      if (cmd !== "insertText") return false
      const range = window.getSelection()!.getRangeAt(0)
      range.insertNode(document.createTextNode(value ?? ""))
      return true
    }
    // Start with the caret at the beginning, where focus() leaves it.
    const start = document.createRange()
    start.setStart(el.firstChild!, 0)
    start.collapse(true)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(start)
    try {
      const r = await handleInputText({ type: "input_text", ref, text: " + x", clear: false })
      expect(r.success).toBe(true)
      expect(el.textContent).toBe("Editor Lab baseline text + x")
    } finally {
      doc.execCommand = saved
    }
  })
})
