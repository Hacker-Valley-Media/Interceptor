import { resolveElement } from "../input-simulation"
import { getOrAssignRef } from "../ref-registry"
import { getEffectiveRole, getAccessibleName } from "../a11y-tree"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleFocus(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) as HTMLElement | null
  if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
  el.focus()
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
