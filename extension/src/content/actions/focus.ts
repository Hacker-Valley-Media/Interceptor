import { resolveElement, staleElementError } from "../input-simulation"
import { getOrAssignRef } from "../ref-registry"
import { getEffectiveRole, getAccessibleName } from "../a11y-tree"
import { markSensitive } from "../sensitive"
import { getShadowRoot } from "../element-discovery"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleFocus(action: Action): Promise<ActionResult> {
  const focusedSensitive = action.focused === true && action.sensitive === true
  const el = (focusedSensitive
    ? document.activeElement
    : resolveElement(action.index as number | undefined, action.ref as string | undefined)) as HTMLElement | null
  if (!el) return staleElementError(action, "focused")
  if (action.sensitive === true) {
    if (el === document.body || el === document.documentElement) return { success: false, error: "no focused credential field" }
  }
  if (!focusedSensitive) el.focus()
  if (action.sensitive === true) {
    let active = document.activeElement
    let focused = active === el
    while (active && getShadowRoot(active)?.activeElement) {
      active = getShadowRoot(active)!.activeElement
      focused ||= active === el
    }
    if (!focused) return { success: false, error: "credential target did not receive focus; nothing typed" }
    markSensitive(focusedSensitive ? active! : el)
  }
  return { success: true }
}

export async function handleBlur(_action: Action): Promise<ActionResult> {
  (document.activeElement as HTMLElement)?.blur()
  return { success: true }
}

export async function handleGetFocus(_action: Action): Promise<ActionResult> {
  const active = document.activeElement as HTMLElement | null
  if (!active || active === document.body || active === document.documentElement) {
    return { success: true, data: { focused: null } }
  }
  const focusRef = getOrAssignRef(active)
  const focusRole = getEffectiveRole(active)
  const focusName = getAccessibleName(active)
  const isEditable = active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable || active.getAttribute("role") === "textbox"
  return {
    success: true,
    data: {
      focused: {
        ref: focusRef,
        tag: active.tagName.toLowerCase(),
        role: focusRole,
        name: focusName,
        type: (active as HTMLInputElement).type || undefined,
        editable: isEditable
      }
    }
  }
}
