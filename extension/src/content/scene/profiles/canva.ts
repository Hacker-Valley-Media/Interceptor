import type { SceneProfile, SceneObject, SceneObjectType, SceneSelection } from "../types"
import { boundingBox, parseTranslate } from "../ops"

const LB_ID = /^LB[A-Za-z0-9_-]{14}$/

function classify(el: Element): SceneObjectType {
  if (el.querySelector("img")) return "image"
  if (el.querySelector("svg")) return "shape"
  const text = (el.textContent || "").trim()
  if (text.length > 0) return "text"
  return "unknown"
}

export const canvaProfile: SceneProfile = {
  name: "canva",

  detect(): boolean {
    try {
      return location.host.endsWith("canva.com") && location.pathname.includes("/design/")
    } catch {
      return false
    }
  },

  list(opts?: { type?: string }): SceneObject[] {
    const all = Array.from(document.querySelectorAll('[id^="LB"]'))
    const out: SceneObject[] = []
    for (const el of all) {
      if (!LB_ID.test(el.id)) continue
      const rect = el.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) continue
      const style = (el as HTMLElement).style
      const translate = parseTranslate(style.transform || "")
      const dw = parseFloat(style.width || "0")
      const dh = parseFloat(style.height || "0")
      const type = classify(el)
      if (opts?.type && opts.type !== type) continue
      const textContent = type === "text" ? (el.textContent || "").trim().slice(0, 80) : undefined
      out.push({
        id: el.id,
        type,
        rect: boundingBox(el),
        doc: translate && dw && dh ? { x: translate.x, y: translate.y, w: dw, h: dh } : undefined,
        text: textContent
      })
    }
    return out
  },

  resolve(id: string): Element | null {
    if (!LB_ID.test(id)) return null
    return document.getElementById(id)
  },

  selected(): SceneSelection {
    const app = document.querySelector('[role="application"]')
    const label = app?.getAttribute("aria-label") || undefined
    if (!label) return { has: false }
    return { has: true, label }
  },

  zoom(): number {
    const all = Array.from(document.querySelectorAll('[style*="scale"]')) as HTMLElement[]
    for (const el of all) {
      const m = (el.style.transform || "").match(/scale\(([\d.]+)\)/)
      if (m) {
        const s = parseFloat(m[1])
        if (s > 0 && s < 10) return s
      }
    }
    return 1
  },

  hitTest(x: number, y: number): SceneObject | null {
    const list = canvaProfile.list!() as SceneObject[]
    let best: SceneObject | null = null
    let bestArea = Infinity
    for (const o of list) {
      if (x >= o.rect.x && x <= o.rect.x + o.rect.w && y >= o.rect.y && y <= o.rect.y + o.rect.h) {
        const area = o.rect.w * o.rect.h
        if (area < bestArea) {
          bestArea = area
          best = o
        }
      }
    }
    return best
  }
}
