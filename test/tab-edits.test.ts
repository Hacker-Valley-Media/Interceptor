import { afterEach, expect, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { handleCheck, handleInputText, handleSelectOption } from "../extension/src/content/actions/type"
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
