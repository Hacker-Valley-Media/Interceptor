import { resolveElement } from "../input-simulation"
import { getInteractiveElements } from "../element-discovery"
import { getEffectiveRole } from "../a11y-tree"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleRect(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) || document.querySelector(action.selector as string)
  if (!el) return { success: false, error: "element not found" }
  const r = el.getBoundingClientRect()
  return { success: true, data: { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom, right: r.right } }
}

export async function handleRegions(_action: Action): Promise<ActionResult> {
  const regionElements = getInteractiveElements()
  const regions = regionElements.map(e => {
    const rect = e.element.getBoundingClientRect()
    return {
      ref: e.refId,
      role: getEffectiveRole(e.element) || e.tag,
      name: e.text,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height)
    }
  })
  regions.sort((a, b) => a.y === b.y ? a.x - b.x : a.y - b.y)
  return { success: true, data: regions }
}
