import { resolveElement, staleElementError } from "../input-simulation"
import { getShadowRoot } from "../element-discovery"
import { getOrAssignRef } from "../ref-registry"
import { isSensitive, markSensitive } from "../sensitive"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleInputText(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) as HTMLElement | null
  if (!el) return staleElementError(action, "typed")
  if (el.tagName === "SELECT") {
    if (action.sensitive === true) return { success: false, error: "credential delivery requires a text field" }
    return handleSelectOption({ ...action, value: action.text })
  }
  // issue #244: a vault delivery marks the field so the monitor masks its value.
  if (action.sensitive === true || isSensitive(el)) markSensitive(el)
  el.focus()
  const text = action.text as string
  const tag = el.tagName
  const isContentEditable = el.getAttribute("contenteditable") === "true" || el.isContentEditable
  const isStandardInput = tag === "INPUT" || tag === "TEXTAREA"

  if (isStandardInput) {
    const inputEl = el as HTMLInputElement | HTMLTextAreaElement
    if (action.clear) {
      inputEl.value = ""
      inputEl.dispatchEvent(new Event("input", { bubbles: true }))
    }
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value"
    )?.set
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(inputEl, (action.clear ? "" : inputEl.value) + text)
    } else {
      inputEl.value = (action.clear ? "" : inputEl.value) + text
    }
    inputEl.dispatchEvent(new Event("input", { bubbles: true }))
    inputEl.dispatchEvent(new Event("change", { bubbles: true }))
    return { success: true, data: { typed: true, elementType: "input", method: "nativeSetter" } }
  }

  if (isContentEditable) {
    if (action.clear) {
      document.execCommand("selectAll", false)
      document.execCommand("delete", false)
    }
    document.execCommand("insertText", false, text)
    el.dispatchEvent(new Event("input", { bubbles: true }))
    return { success: true, data: { typed: true, elementType: "contenteditable", method: "execCommand" } }
  }

  const shadowRoot = getShadowRoot(el)
  if (shadowRoot) {
    const innerInput = shadowRoot.querySelector("input, textarea, [contenteditable='true']") as HTMLElement | null
    if (innerInput) {
      return handleInputText({ type: "input_text", ref: getOrAssignRef(innerInput), text, clear: action.clear, sensitive: action.sensitive })
    }
  }

  const role = el.getAttribute("role")
  if (role === "textbox" || role === "combobox") {
    if (action.clear) {
      el.textContent = ""
    }
    el.textContent = (action.clear ? "" : (el.textContent || "")) + text
    el.dispatchEvent(new Event("input", { bubbles: true }))
    return { success: true, data: { typed: true, elementType: `role=${role}`, method: "textContent" } }
  }

  return { success: false, error: `element is <${tag.toLowerCase()}${isContentEditable ? " contenteditable" : ""}> — unsupported input type` }
}

export async function handleSelectOption(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) as HTMLSelectElement | null
  if (!el) return staleElementError(action, "selected")
  if (el.tagName !== "SELECT") return { success: false, error: "select requires a native <select>; use click/read for a custom dropdown" }
  if (typeof action.value !== "string") return { success: false, error: "select requires an option value or label" }
  if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") return { success: false, error: "select is disabled" }
  const options = Array.from(el.options)
  const exact = options.find(option => option.value === action.value)
  const labels = exact ? [] : options.filter(option => option.label === action.value)
  const option = exact || (labels.length === 1 ? labels[0] : undefined)
  if (!option) return {
    success: false,
    error: (labels.length > 1 ? "option label is ambiguous; use its exact value" : "no matching option; use an exact value or unique label") +
      `. Available options: ${JSON.stringify(options.slice(0, 30).map(o => ({ value: o.value.slice(0, 160), label: o.label.slice(0, 160) })))}${options.length > 30 ? " (first 30)" : ""}`,
    data: { options: options.slice(0, 30).map(o => ({ value: o.value.slice(0, 160), label: o.label.slice(0, 160), disabled: o.matches(":disabled") })), total: options.length, truncated: options.length > 30 }
  }
  if (option.matches(":disabled")) return { success: false, error: "option or its optgroup is disabled" }
  if (el.selectedOptions.length === 1 && el.selectedOptions[0] === option) {
    return { success: true, data: { value: option.value, label: option.label, changed: false } }
  }
  el.selectedIndex = options.indexOf(option)
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  await Promise.resolve()
  if (!el.isConnected || el.selectedOptions.length !== 1 || el.selectedOptions[0] !== option) {
    return { success: false, error: "page did not retain the selected option; read the dropdown before retrying" }
  }
  return { success: true, data: { value: option.value, label: option.label, changed: true } }
}

export async function handleCheck(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) as HTMLInputElement | null
  if (!el) return staleElementError(action, "toggled")
  const target = action.checked !== undefined ? !!(action.checked) : !el.checked
  if (el.checked !== target) {
    el.checked = target
    el.dispatchEvent(new Event("change", { bubbles: true }))
    el.dispatchEvent(new Event("input", { bubbles: true }))
  }
  return { success: true, data: { checked: el.checked } }
}
