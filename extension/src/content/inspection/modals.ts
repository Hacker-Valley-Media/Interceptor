import { isVisible } from "../element-discovery"
import { getOrAssignRef } from "../ref-registry"
import { getEffectiveRole, getAccessibleName } from "../a11y-tree"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleModals(_action: Action): Promise<ActionResult> {
  const modals: Array<{ ref: string; role: string; name: string; rect: { top: number; left: number; width: number; height: number }; children: number }> = []
  const dialogEls = document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]')
  dialogEls.forEach(el => {
    if (!isVisible(el)) return
    const ref = getOrAssignRef(el)
    const rect = el.getBoundingClientRect()
    const interactiveChildren = el.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"]').length
    modals.push({
      ref,
      role: getEffectiveRole(el) || "dialog",
      name: getAccessibleName(el),
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      children: interactiveChildren
    })
  })
  const vw = window.innerWidth
  const vh = window.innerHeight
  const overlays = document.querySelectorAll("*")
  overlays.forEach(el => {
    if (el.matches('dialog[open], [role="dialog"], [aria-modal="true"]')) return
    const style = getComputedStyle(el)
    if (style.position !== "fixed" && style.position !== "absolute") return
    const z = parseInt(style.zIndex)
    if (isNaN(z) || z < 100) return
    const rect = el.getBoundingClientRect()
    if (rect.width * rect.height > vw * vh * 0.25) {
      const ref = getOrAssignRef(el)
      modals.push({
        ref,
        role: "overlay",
        name: getAccessibleName(el) || el.tagName.toLowerCase(),
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        children: el.querySelectorAll('a, button, input, select, textarea').length
      })
    }
  })
  return { success: true, data: { modals } }
}

export async function handlePanels(_action: Action): Promise<ActionResult> {
  const panels: Array<{ ref: string; role: string; name: string; expanded: boolean; contentRef?: string }> = []
  const expandedEls = document.querySelectorAll('[aria-expanded="true"]')
  expandedEls.forEach(el => {
    if (!isVisible(el)) return
    const ref = getOrAssignRef(el)
    const controls = el.getAttribute("aria-controls")
    let contentRef: string | undefined
    if (controls) {
      const controlledEl = document.getElementById(controls)
      if (controlledEl) contentRef = getOrAssignRef(controlledEl)
    }
    panels.push({
      ref,
      role: getEffectiveRole(el) || el.tagName.toLowerCase(),
      name: getAccessibleName(el),
      expanded: true,
      contentRef
    })
  })
  return { success: true, data: { panels } }
}
