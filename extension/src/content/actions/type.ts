import { resolveElement } from "../input-simulation"
import { getShadowRoot } from "../element-discovery"
import { getOrAssignRef } from "../ref-registry"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleInputText(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) as HTMLElement | null
  if (!el) return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` }
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
      return handleInputText({ type: "input_text", ref: getOrAssignRef(innerInput), text, clear: action.clear })
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
  if (!el) return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` }
  el.value = action.value as string
  el.dispatchEvent(new Event("change", { bubbles: true }))
  return { success: true }
}

export async function handleCheck(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) as HTMLInputElement | null
  if (!el) return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` }
  const target = action.checked !== undefined ? !!(action.checked) : !el.checked
  if (el.checked !== target) {
    el.checked = target
    el.dispatchEvent(new Event("change", { bubbles: true }))
    el.dispatchEvent(new Event("input", { bubbles: true }))
  }
  return { success: true, data: { checked: el.checked } }
}
