// Submit_form submits the field's form like the browser's Enter.
import { beforeEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* shared test DOM already registered */ }

import { handleSubmitForm, handleInputText } from "../extension/src/content/actions/type"
import { getOrAssignRef, refRegistry } from "../extension/src/content/ref-registry"

beforeEach(() => { document.body.innerHTML = ""; refRegistry.clear() })

describe("submit_form", () => {
  test("clicks the default button, the way Enter does", async () => {
    document.body.innerHTML = `<form id="f" action="/search"><input id="q" name="q"><input id="go" type="submit" value="Apply"></form>`
    let clicks = 0
    document.getElementById("go")!.addEventListener("click", (e) => { clicks++; e.preventDefault() })
    const r = await handleSubmitForm({ type: "submit_form", ref: getOrAssignRef(document.getElementById("q")!) })
    expect(r.success).toBe(true)
    expect(clicks).toBe(1)
    expect((r.data as { submitter: string }).submitter).toBe("Apply")
  })

  test("a disabled default button refuses, as Enter would do nothing", async () => {
    document.body.innerHTML = `<form><input id="q"><button type="submit" disabled>Pay</button></form>`
    const r = await handleSubmitForm({ type: "submit_form", ref: getOrAssignRef(document.getElementById("q")!) })
    expect(r.success).toBe(false)
    expect(r.error).toContain("disabled")
  })

  test("novalidate and formnovalidate skip the validity check, as the browser does", async () => {
    document.body.innerHTML = `<form novalidate><input id="q" required><button id="b" type="submit">Go</button></form>`
    document.getElementById("b")!.addEventListener("click", (e) => e.preventDefault())
    expect((await handleSubmitForm({ type: "submit_form", ref: getOrAssignRef(document.getElementById("q")!) })).success).toBe(true)
    document.body.innerHTML = `<form><input id="r" required><button id="c" type="submit" formnovalidate>Go</button></form>`
    document.getElementById("c")!.addEventListener("click", (e) => e.preventDefault())
    expect((await handleSubmitForm({ type: "submit_form", ref: getOrAssignRef(document.getElementById("r")!) })).success).toBe(true)
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
