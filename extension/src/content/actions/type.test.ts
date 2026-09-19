import { afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
try { GlobalRegistrator.register() } catch {}
import { getOrAssignRef } from "../ref-registry"
import { handleInputText, handleSelectOption } from "./type"

afterEach(() => { document.body.innerHTML = "" })
function fixture(extra = "") {
  document.body.innerHTML = `<select ${extra}><option value="ca">California</option><option value="ny" selected>New York</option><option value="">None</option><option value="no" disabled>Forbidden</option><optgroup disabled label="Off"><option value="off">Off</option></optgroup></select>`
  const el = document.querySelector("select")!
  // Happy DOM 20.9 lacks option.label, inherited :disabled, and live selectedOptions.
  // Supply those platform properties on this fixture only; the installed-browser
  // acceptance matrix also checks each behavior without these shims.
  Object.defineProperty(el, "selectedOptions", { get: () => Array.from(el.options).filter(o => o.selected) })
  const matches = el.matches.bind(el)
  el.matches = selector => selector === ":disabled" ? el.disabled || !!el.closest("fieldset[disabled]") : matches(selector)
  for (const option of Array.from(el.options)) {
    Object.defineProperty(option, "label", { get: () => option.getAttribute("label") || option.text })
    const optionMatches = option.matches.bind(option)
    option.matches = selector => selector === ":disabled" ? option.disabled || !!option.closest("optgroup[disabled]") : optionMatches(selector)
  }
  const ref = getOrAssignRef(el)
  const events: string[] = []
  for (const event of ["input", "change"]) el.addEventListener(event, () => events.push(event))
  return { el, ref, events }
}

test("exact values, unique labels, empty values, and native typing use verified selection", async () => {
  for (const [value, expected] of [["ca", "ca"], ["California", "ca"], ["", ""]]) {
    const { el, ref, events } = fixture()
    expect((await handleSelectOption({ type: "select_option", ref, value })).success).toBe(true)
    expect(el.value).toBe(expected)
    expect(events).toEqual(["input", "change"])
  }
  const { el, ref } = fixture()
  expect((await handleInputText({ type: "input_text", ref, text: "California" })).success).toBe(true)
  expect(el.value).toBe("ca")
})

test("unknown, wrong-case, disabled, and ambiguous choices preserve selection without events", async () => {
  for (const value of ["Nope", "CA", "no", "off"]) {
    const { el, ref, events } = fixture()
    expect((await handleSelectOption({ type: "select_option", ref, value })).success).toBe(false)
    expect(el.value).toBe("ny")
    expect(events).toEqual([])
  }
  const { el, ref, events } = fixture()
  const duplicate = document.createElement("option")
  duplicate.text = "California"
  duplicate.value = "duplicate"
  Object.defineProperty(duplicate, "label", { value: "California" })
  el.add(duplicate)
  expect((await handleSelectOption({ type: "select_option", ref, value: "California" })).success).toBe(false)
  expect(el.value).toBe("ny")
  expect(events).toEqual([])
  expect((await handleSelectOption({ type: "select_option", ref, value: "ca" })).success).toBe(true)
})

test("disabled controls, fieldsets, custom widgets, and missing arguments fail before mutation", async () => {
  for (const mode of ["disabled", "fieldset"]) {
    const { el, ref, events } = fixture(mode === "disabled" ? "disabled" : "")
    if (mode === "fieldset") { const parent = document.createElement("fieldset"); parent.disabled = true; document.body.append(parent); parent.append(el) }
    expect((await handleSelectOption({ type: "select_option", ref, value: "ca" })).success).toBe(false)
    expect(el.value).toBe("ny")
    expect(events).toEqual([])
  }
  const div = document.createElement("div"); div.role = "combobox"; document.body.append(div)
  expect((await handleSelectOption({ type: "select_option", ref: getOrAssignRef(div), value: "ca" })).success).toBe(false)
  expect(Object.hasOwn(div, "value")).toBe(false)
  const { ref, el } = fixture()
  expect((await handleSelectOption({ type: "select_option", ref })).success).toBe(false)
  expect(el.value).toBe("ny")
})

test("implicit values and multiple replacement work, identical choice emits no events", async () => {
  const { el, ref, events } = fixture("multiple")
  el.options[0].selected = true
  expect((await handleSelectOption({ type: "select_option", ref, value: "California" })).success).toBe(true)
  expect(Array.from(el.selectedOptions).map(o => o.value)).toEqual(["ca"])
  events.length = 0
  expect((await handleSelectOption({ type: "select_option", ref, value: "ca" })).success).toBe(true)
  expect(events).toEqual([])
  const implicit = document.createElement("option")
  implicit.text = "Green"
  Object.defineProperty(implicit, "label", { value: "Green" })
  el.add(implicit)
  expect((await handleSelectOption({ type: "select_option", ref, value: "Green" })).success).toBe(true)
  expect(el.value).toBe("Green")
})

test("page rejection or replacement is not reported as success", async () => {
  const { el, ref } = fixture()
  el.addEventListener("change", () => { el.value = "ny" })
  expect((await handleSelectOption({ type: "select_option", ref, value: "ca" })).success).toBe(false)
  const next = fixture()
  next.el.addEventListener("change", () => next.el.remove())
  expect((await handleSelectOption({ type: "select_option", ref: next.ref, value: "ca" })).success).toBe(false)
})
