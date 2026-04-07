import type { SceneProfile, SceneObject, SceneSelection } from "../types"
import { boundingBox } from "../ops"

export const genericProfile: SceneProfile = {
  name: "generic",

  detect(): boolean {
    return true
  },

  list(): SceneObject[] {
    const out: SceneObject[] = []
    const selectors = [
      { sel: "[role=application]", type: "group" as const },
      { sel: "[role=main]", type: "page" as const },
      { sel: "[role=document]", type: "page" as const }
    ]
    for (const { sel, type } of selectors) {
      const els = Array.from(document.querySelectorAll(sel))
      for (const el of els) {
        const rect = el.getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2) continue
        const id = el.id || `${sel.replace(/[[\]=]/g, "")}-${out.length}`
        const text = (el.getAttribute("aria-label") || "").slice(0, 80)
        out.push({
          id,
          type,
          rect: boundingBox(el),
          text: text || undefined
        })
      }
    }
    return out
  },

  resolve(id: string): Element | null {
    if (!id) return null
    try {
      return document.getElementById(id) || document.querySelector(`[id="${CSS.escape(id)}"]`)
    } catch {
      return null
    }
  },

  selected(): SceneSelection {
    const app = document.querySelector("[role=application]")
    const label = app?.getAttribute("aria-label") || undefined
    return {
      has: !!label,
      label
    }
  }
}
