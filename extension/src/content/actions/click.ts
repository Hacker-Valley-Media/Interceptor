import { resolveElement, scrollIntoViewIfNeeded, dispatchClickSequence, waitForMutation } from "../input-simulation"
import { getOrAssignRef } from "../ref-registry"
import { getEffectiveRole, getAccessibleName } from "../a11y-tree"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleClick(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
  if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
  scrollIntoViewIfNeeded(el)
  dispatchClickSequence(el, action.x as number | undefined, action.y as number | undefined)
  const clickMsg = `clicked [${action.ref || action.index}]${action.x !== undefined ? ` at (${action.x},${action.y})` : ""}`
  const mutated = await waitForMutation(200)
  if (!mutated) {
    return { success: true, data: clickMsg, warning: "no DOM change after click — if the site requires trusted events, try: slop click --os " + (action.ref || action.index) }
  }
  return { success: true, data: clickMsg }
}

export async function handleDblclick(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
  if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
  scrollIntoViewIfNeeded(el)
  dispatchClickSequence(el, action.x as number | undefined, action.y as number | undefined)
  const rect = el.getBoundingClientRect()
  const cx = action.x !== undefined ? rect.left + (action.x as number) : rect.left + rect.width / 2
  const cy = action.y !== undefined ? rect.top + (action.y as number) : rect.top + rect.height / 2
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }))
  return { success: true }
}

export async function handleRightclick(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
  if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
  scrollIntoViewIfNeeded(el)
  const rect = el.getBoundingClientRect()
  const x = action.x !== undefined ? rect.left + (action.x as number) : rect.left + rect.width / 2
  const y = action.y !== undefined ? rect.top + (action.y as number) : rect.top + rect.height / 2
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }))
  return { success: true }
}

export async function handleClickAt(action: Action): Promise<ActionResult> {
  const cx = action.x as number
  const cy = action.y as number
  const targetEl = document.elementFromPoint(cx, cy)
  if (!targetEl) return { success: false, error: `no element at viewport coordinates (${cx}, ${cy})` }
  const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }
  targetEl.dispatchEvent(new PointerEvent("pointerover", opts))
  targetEl.dispatchEvent(new MouseEvent("mouseover", opts))
  targetEl.dispatchEvent(new PointerEvent("pointerdown", opts))
  targetEl.dispatchEvent(new MouseEvent("mousedown", opts))
  if ((targetEl as HTMLElement).focus) (targetEl as HTMLElement).focus()
  targetEl.dispatchEvent(new PointerEvent("pointerup", opts))
  targetEl.dispatchEvent(new MouseEvent("mouseup", opts))
  targetEl.dispatchEvent(new MouseEvent("click", opts))
  const targetRef = getOrAssignRef(targetEl)
  return { success: true, data: { clicked: targetRef, tag: targetEl.tagName.toLowerCase(), at: { x: cx, y: cy } } }
}

export async function handleWhatAt(action: Action): Promise<ActionResult> {
  const wx = action.x as number
  const wy = action.y as number
  const whatEl = document.elementFromPoint(wx, wy)
  if (!whatEl) return { success: true, data: { element: null, at: { x: wx, y: wy } } }
  const whatRef = getOrAssignRef(whatEl)
  const whatRect = whatEl.getBoundingClientRect()
  return {
    success: true,
    data: {
      ref: whatRef,
      tag: whatEl.tagName.toLowerCase(),
      role: getEffectiveRole(whatEl),
      name: getAccessibleName(whatEl),
      rect: { top: whatRect.top, left: whatRect.left, width: whatRect.width, height: whatRect.height }
    }
  }
}
