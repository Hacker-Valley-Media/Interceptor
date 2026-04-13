import { resolveElement, dispatchHoverSequence } from "../input-simulation"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleHover(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
  if (!el) return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` }
  const hoverFromX = action.fromX as number | undefined
  const hoverFromY = action.fromY as number | undefined
  if (hoverFromX !== undefined && hoverFromY !== undefined) {
    const rect = el.getBoundingClientRect()
    const targetX = rect.left + rect.width / 2
    const targetY = rect.top + rect.height / 2
    const hoverSteps = (action.steps as number) || 5
    const baseOpts = { bubbles: true, cancelable: true }
    for (let i = 0; i <= hoverSteps; i++) {
      const t = i / hoverSteps
      const cx = hoverFromX + (targetX - hoverFromX) * t
      const cy = hoverFromY + (targetY - hoverFromY) * t
      const mx = (targetX - hoverFromX) / hoverSteps
      const my = (targetY - hoverFromY) / hoverSteps
      el.dispatchEvent(new PointerEvent("pointermove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }))
      el.dispatchEvent(new MouseEvent("mousemove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }))
    }
    el.dispatchEvent(new PointerEvent("pointerover", { ...baseOpts, clientX: targetX, clientY: targetY }))
    el.dispatchEvent(new MouseEvent("mouseover", { ...baseOpts, clientX: targetX, clientY: targetY }))
  } else {
    dispatchHoverSequence(el)
  }
  return { success: true }
}
