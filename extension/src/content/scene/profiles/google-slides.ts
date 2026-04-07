import type { SceneProfile, SceneObject, SceneSelection, SceneSlideInfo, SceneRenderResult } from "../types"
import { boundingBox, clickAtViewport } from "../ops"

const FILMSTRIP_ID = /^filmstrip-slide-(\d+)-(gd[a-z0-9_-]+)$/i

function gatherSlides(): SceneSlideInfo[] {
  const all = Array.from(document.querySelectorAll<SVGGElement>('g[id^="filmstrip-slide-"]'))
  const byIndex = new Map<number, SceneSlideInfo>()
  // Build page-id → index map from punch-filmstrip-thumbnail wrappers so we can
  // tag the `current` slide by the URL hash's pageId.
  for (const g of all) {
    if (g.id.endsWith("-bg")) continue
    const m = g.id.match(FILMSTRIP_ID)
    if (!m) continue
    const index = parseInt(m[1], 10)
    if (byIndex.has(index)) continue
    const rect = boundingBox(g as unknown as Element)
    const img = g.querySelector("image") as SVGImageElement | null
    const blob = img ? (img.getAttribute("xlink:href") || img.getAttribute("href") || undefined) : undefined
    const wrapper = g.closest("g.punch-filmstrip-thumbnail") as SVGGElement | null
    const pageId = wrapper?.getAttribute("data-slide-page-id") || undefined
    byIndex.set(index, { index, id: g.id, rect, blobUrl: blob, pageId } as SceneSlideInfo & { pageId?: string })
  }
  const out = Array.from(byIndex.values()).sort((a, b) => a.index - b.index)
  const current = currentSlideId()
  if (current) {
    for (const s of out) {
      const sWithPage = s as SceneSlideInfo & { pageId?: string }
      if (sWithPage.pageId === current) s.current = true
    }
  }
  return out
}

function currentSlideId(): string | null {
  // Primary source: URL fragment `#slide=id.<pageId>`
  try {
    const h = window.location.hash
    const m = h.match(/slide=id\.([A-Za-z0-9_]+)/)
    if (m) {
      const pageId = m[1]
      if (pageId === "p") {
        // Shortcut for slide 0: find the first thumbnail
        const firstThumb = document.querySelector("g.punch-filmstrip-thumbnail") as SVGGElement | null
        return firstThumb?.getAttribute("data-slide-page-id") || null
      }
      return pageId
    }
  } catch {}
  // Fallback: active editor child
  const main = document.querySelector('#editor-p') as SVGGElement | null
  if (!main) return null
  for (const child of Array.from(main.children)) {
    const id = (child as Element).id || ""
    if (id.startsWith("editor-gd")) return id.replace(/^editor-/, "")
  }
  return null
}

export const googleSlidesProfile: SceneProfile = {
  name: "google-slides",

  detect(): boolean {
    try {
      return location.host === "docs.google.com" && location.pathname.startsWith("/presentation/")
    } catch {
      return false
    }
  },

  list(): SceneObject[] {
    const slides = gatherSlides()
    return slides.map((s) => ({
      id: s.id,
      type: "slide",
      rect: s.rect,
      text: s.blobUrl ? `[blob: ${s.blobUrl.slice(0, 40)}]` : undefined,
      extras: { slideIndex: s.index, current: !!s.current, blobUrl: s.blobUrl }
    }))
  },

  resolve(id: string): Element | null {
    return document.getElementById(id)
  },

  selected(): SceneSelection {
    const app = document.querySelector('[role=application]') as HTMLElement | null
    const label = app?.getAttribute("aria-label") || undefined
    const current = currentSlideId()
    return { has: !!label || !!current, label, id: current || undefined }
  },

  slides(): SceneSlideInfo[] {
    return gatherSlides()
  },

  slideCurrent(): SceneSlideInfo | null {
    const slides = gatherSlides()
    return slides.find((s) => s.current) || slides[0] || null
  },

  slideGoto(index: number): { success: boolean; error?: string } {
    const slides = gatherSlides()
    if (index < 0 || index >= slides.length) return { success: false, error: `slide index ${index} out of range (0..${slides.length - 1})` }
    const target = slides[index]
    const filmstripGroup = document.getElementById(target.id)
    if (!filmstripGroup) return { success: false, error: `slide ${target.id} not in DOM` }
    const thumbWrapper = filmstripGroup.closest("g.punch-filmstrip-thumbnail") as SVGGElement | null
    if (!thumbWrapper) return { success: false, error: "no punch-filmstrip-thumbnail ancestor" }
    // The real slide page ID is carried on `data-slide-page-id` on the
    // .punch-filmstrip-thumbnail wrapper. Use that to build the URL fragment.
    const pageId = thumbWrapper.getAttribute("data-slide-page-id")
    if (!pageId) return { success: false, error: "no data-slide-page-id on thumbnail" }
    // Google Slides' hash format is `#slide=id.<pageId>` where pageId is what we
    // see on data-slide-page-id (e.g. `gd02e148143_0_12`). For the very first
    // slide the shortcut `#slide=id.p` is also accepted.
    const newHash = `#slide=id.${pageId}`
    try {
      window.location.hash = newHash
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  },

  notes(slideIndex?: number): string | null {
    const paragraphs = Array.from(document.querySelectorAll('[id^="speakernotes-i"][id*="paragraph"]'))
    if (paragraphs.length === 0) {
      const notesContainer = document.getElementById("speakernotes") || document.getElementById("speakernotes-workspace")
      if (notesContainer) return (notesContainer.textContent || "").trim() || null
      return null
    }
    const text = paragraphs.map((p) => (p.textContent || "").trim()).filter(Boolean).join("\n")
    void slideIndex
    return text || null
  },

  text(): { text: string; html?: string; length: number } | null {
    const iframe = document.querySelector<HTMLIFrameElement>(".docs-texteventtarget-iframe")
    if (!iframe) return null
    try {
      const doc = iframe.contentDocument
      if (!doc) return null
      const textbox = doc.querySelector<HTMLElement>('[role=textbox]') || doc.querySelector<HTMLElement>('[contenteditable]')
      if (!textbox) return null
      const text = (textbox.textContent || "").trim()
      return { text, length: text.length }
    } catch {
      return null
    }
  },

  async render(id: string): Promise<SceneRenderResult | null> {
    const slide = document.getElementById(id) as SVGGElement | null
    if (!slide) return null
    const img = slide.querySelector("image") as SVGImageElement | null
    if (!img) return null
    const href = img.getAttribute("xlink:href") || img.getAttribute("href")
    if (!href) return null
    try {
      const resp = await fetch(href)
      const blob = await resp.blob()
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement("canvas")
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext("2d")
      if (!ctx) return null
      ctx.drawImage(bitmap, 0, 0)
      const dataUrl = canvas.toDataURL("image/png")
      return { id, width: bitmap.width, height: bitmap.height, dataUrl, format: "png" }
    } catch {
      return null
    }
  }
}
