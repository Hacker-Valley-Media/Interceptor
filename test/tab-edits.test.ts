import { afterEach, expect, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { handleCheck, handleInputText, handleSelectOption } from "../extension/src/content/actions/type"
import { handleFileUpload } from "../extension/src/content/actions/file"
import { writeToFocusedWritableSurface } from "../extension/src/content/scene/adaptive"
import { getOrAssignRef } from "../extension/src/content/ref-registry"

try { GlobalRegistrator.register() } catch {}
const doc = document as Document & { __interceptorEdited?: boolean }
afterEach(() => { delete doc.__interceptorEdited; doc.body.replaceChildren() })

test("document-start tracker records only trusted input and change", async () => {
  const listen = spyOn(doc, "addEventListener")
  const originalChrome = globalThis.chrome
  Object.assign(globalThis, { chrome: { runtime: { onMessage: { addListener() {} } } } })
  try {
    await import("../extension/src/net-buffer-content")
    expect(doc.__interceptorEdited).toBe(false)
    for (const type of ["input", "change"]) {
      doc.__interceptorEdited = false
      doc.dispatchEvent(new Event(type, { bubbles: true }))
      expect(doc.__interceptorEdited).toBe(false)
      const listener = listen.mock.calls.find(([name]) => name === type)?.[1] as EventListener
      listener.call(doc, { type, isTrusted: true } as Event)
      expect(doc.__interceptorEdited).toBe(true)
    }
  } finally {
    listen.mockRestore()
    Object.assign(globalThis, { chrome: originalChrome })
  }
})

test("form and scene writes protect their document, a no-op toggle does not", async () => {
  doc.body.innerHTML = '<input id="text"><input type="checkbox"><select><option>a</option><option>b</option></select>'
  const field = doc.querySelector("input")!
  const check = getOrAssignRef(doc.querySelector('[type="checkbox"]')!)
  const select = doc.querySelector("select")!
  Object.defineProperty(select, "selectedOptions", { get: () => Array.from(select.options).filter(o => o.selected) })
  for (const write of [
    () => handleInputText({ type: "input_text", ref: getOrAssignRef(field), text: "abc" }),
    () => handleCheck({ type: "check", ref: check, checked: true }),
    () => handleSelectOption({ type: "select_option", ref: getOrAssignRef(select), value: "b" }),
    () => { field.focus(); return writeToFocusedWritableSurface("def") },
  ]) {
    doc.__interceptorEdited = false
    expect((await write()).success).toBe(true)
    expect(doc.__interceptorEdited).toBe(true)
  }
  doc.__interceptorEdited = false
  await handleCheck({ type: "check", ref: check, checked: true })
  expect(doc.__interceptorEdited).toBe(false)
})

test("a page that substitutes another option retains a draft", async () => {
  doc.body.innerHTML = "<select><option>A</option><option>B</option><option>C</option></select>"
  const field = doc.querySelector("select")!
  Object.defineProperty(field, "selectedOptions", { get: () => Array.from(field.options).filter(o => o.selected) })
  field.onchange = () => { field.selectedIndex = 2 }
  doc.__interceptorEdited = false
  expect((await handleSelectOption({ type: "select_option", ref: getOrAssignRef(field), value: "B" })).success).toBe(false)
  expect(field.value).toBe("C")
  expect(doc.__interceptorEdited).toBe(true)
})

test("a normalized scene write protects the value the page kept", () => {
  doc.body.innerHTML = "<input>"
  const field = doc.querySelector("input")!
  field.oninput = () => { field.value = field.value.toUpperCase() }
  field.focus()
  doc.__interceptorEdited = false
  expect(writeToFocusedWritableSurface("mixed").success).toBe(false)
  expect(field.value).toBe("MIXED")
  expect(doc.__interceptorEdited).toBe(true)
})

test("replacing a select with its retained draft protects the document", async () => {
  doc.body.innerHTML = "<select><option>A</option><option>B</option></select>"
  const field = doc.querySelector("select")!
  Object.defineProperty(field, "selectedOptions", { get: () => Array.from(field.options).filter(o => o.selected) })
  field.onchange = () => {
    const draft = doc.createElement("div")
    draft.textContent = field.value
    field.replaceWith(draft)
  }
  doc.__interceptorEdited = false
  expect((await handleSelectOption({ type: "select_option", ref: getOrAssignRef(field), value: "B" })).success).toBe(false)
  expect(doc.body.textContent).toBe("B")
  expect(doc.__interceptorEdited).toBe(true)
})

test("a dropzone replaced by a preview protects the document without claiming a verified upload", async () => {
  const zone = doc.createElement("div")
  doc.body.append(zone)
  zone.addEventListener("__interceptor_file_drop", event => {
    zone.replaceWith("Attachment preview")
    zone.dispatchEvent(new CustomEvent("__interceptor_file_drop_ack", { detail: { id: (event as CustomEvent).detail.id, ok: true } }))
  })
  doc.__interceptorEdited = false
  const url = spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture")
  try {
    const result = await handleFileUpload({ type: "file_upload", ref: getOrAssignRef(zone), fileName: "fixture.txt", dataBase64: "QQ==" })
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ verified: false })
    expect(doc.body.textContent).toBe("Attachment preview")
    expect(doc.__interceptorEdited).toBe(true)
  } finally {
    url.mockRestore()
  }
})
