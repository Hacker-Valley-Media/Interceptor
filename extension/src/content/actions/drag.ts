import { resolveElement, scrollIntoViewIfNeeded } from "../input-simulation"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleDrag(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
  if (!el) return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` }
  scrollIntoViewIfNeeded(el)
  const dragRect = el.getBoundingClientRect()
  const fromX = dragRect.left + (action.fromX as number)
  const fromY = dragRect.top + (action.fromY as number)
  const toX = dragRect.left + (action.toX as number)
  const toY = dragRect.top + (action.toY as number)
  const steps = (action.steps as number) || 10
  const duration = action.duration as number | undefined

  const baseOpts = { bubbles: true, cancelable: true, button: 0 }

  el.dispatchEvent(new PointerEvent("pointerdown", { ...baseOpts, clientX: fromX, clientY: fromY }))
  el.dispatchEvent(new MouseEvent("mousedown", { ...baseOpts, clientX: fromX, clientY: fromY }))

  if (duration) {
    await new Promise<void>((resolve) => {
      let step = 0
      function tick() {
        step++
        if (step > steps) {
          resolve()
          return
        }
        const t = step / steps
        const cx = fromX + (toX - fromX) * t
        const cy = fromY + (toY - fromY) * t
        const mx = (toX - fromX) / steps
        const my = (toY - fromY) / steps
        el!.dispatchEvent(new PointerEvent("pointermove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }))
        el!.dispatchEvent(new MouseEvent("mousemove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }))
        setTimeout(tick, duration! / steps)
      }
      tick()
    })
  } else {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const cx = fromX + (toX - fromX) * t
      const cy = fromY + (toY - fromY) * t
      const mx = (toX - fromX) / steps
      const my = (toY - fromY) / steps
      el.dispatchEvent(new PointerEvent("pointermove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }))
      el.dispatchEvent(new MouseEvent("mousemove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }))
    }
  }

  el.dispatchEvent(new PointerEvent("pointerup", { ...baseOpts, clientX: toX, clientY: toY }))
  el.dispatchEvent(new MouseEvent("mouseup", { ...baseOpts, clientX: toX, clientY: toY }))
  return { success: true, data: `dragged from (${action.fromX},${action.fromY}) to (${action.toX},${action.toY}) in ${steps} steps` }
}
