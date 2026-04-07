import type {
  SceneProfile,
  SceneObject,
  SceneSelection,
  SceneText,
  SceneRenderResult
} from "../types"
import { boundingBox, clickAtViewport } from "../ops"

function findTextEventTarget(): { iframe: HTMLIFrameElement; doc: Document; textbox: HTMLElement } | null {
  const iframe = document.querySelector<HTMLIFrameElement>(".docs-texteventtarget-iframe")
  if (!iframe) return null
  try {
    const doc = iframe.contentDocument
    if (!doc) return null
    const textbox =
      doc.querySelector<HTMLElement>('[role="textbox"]') ||
      doc.querySelector<HTMLElement>("[contenteditable]")
    if (!textbox) return null
    return { iframe, doc, textbox }
  } catch {
    return null
  }
}

function kixCanvasTiles(): HTMLCanvasElement[] {
  return Array.from(document.querySelectorAll<HTMLCanvasElement>(".kix-canvas-tile-content"))
}

function kixPages(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".kix-page-paginated"))
}

function kixEmbeds(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".kix-embeddedobjectdragger, .kix-embeddedobjectdragger-embeddedentity"))
}

export const googleDocsProfile: SceneProfile = {
  name: "google-docs",

  detect(): boolean {
    try {
      return location.host === "docs.google.com" && location.pathname.startsWith("/document/")
    } catch {
      return false
    }
  },

  list(opts?: { type?: string }): SceneObject[] {
    const out: SceneObject[] = []
    if (!opts?.type || opts.type === "page") {
      const pages = kixPages()
      pages.forEach((p, i) => {
        const rect = p.getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2) return
        out.push({
          id: `page-${i}`,
          type: "page",
          rect: boundingBox(p),
          extras: { pageIndex: i }
        })
      })
    }
    if (!opts?.type || opts.type === "embed") {
      const embeds = kixEmbeds()
      embeds.forEach((e, i) => {
        const rect = e.getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2) return
        const aria = e.getAttribute("aria-label") || undefined
        out.push({
          id: `embed-${i}`,
          type: "embed",
          rect: boundingBox(e),
          text: aria,
          extras: { embedIndex: i }
        })
      })
    }
    return out
  },

  resolve(id: string): Element | null {
    const pageMatch = id.match(/^page-(\d+)$/)
    if (pageMatch) {
      const idx = parseInt(pageMatch[1])
      return kixPages()[idx] || null
    }
    const embedMatch = id.match(/^embed-(\d+)$/)
    if (embedMatch) {
      const idx = parseInt(embedMatch[1])
      return kixEmbeds()[idx] || null
    }
    return null
  },

  selected(): SceneSelection {
    const tet = findTextEventTarget()
    if (!tet) return { has: false }
    try {
      const sel = tet.iframe.contentWindow?.getSelection()
      if (!sel || sel.rangeCount === 0) return { has: false }
      const range = sel.getRangeAt(0)
      const text = range.toString()
      return {
        has: text.length > 0,
        text: text.slice(0, 200),
        label: text ? `selection(${text.length} chars)` : "caret"
      }
    } catch {
      return { has: false }
    }
  },

  text(opts?: { withHtml?: boolean }): SceneText | null {
    const tet = findTextEventTarget()
    if (!tet) return null
    const text = (tet.textbox.textContent || "").toString()
    return {
      text,
      html: opts?.withHtml ? tet.textbox.innerHTML : undefined,
      length: text.length
    }
  },

  writeAtCursor(text: string): { success: boolean; error?: string } {
    const tet = findTextEventTarget()
    if (!tet) return { success: false, error: "text event target iframe not found" }
    try {
      try { tet.iframe.focus() } catch {}
      try { tet.textbox.focus() } catch {}
      const iframeDoc = tet.doc as Document & { execCommand?: (c: string, ui: boolean, val?: string) => boolean }
      let ok = false
      try {
        ok = !!iframeDoc.execCommand && iframeDoc.execCommand("insertText", false, text)
      } catch {}
      if (!ok) {
        try {
          const ev = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text })
          tet.textbox.dispatchEvent(ev)
          const ev2 = new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text })
          tet.textbox.dispatchEvent(ev2)
          ok = true
        } catch {}
      }
      if (!ok) return { success: false, error: "both execCommand and InputEvent dispatch failed" }
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  },

  cursorTo(opts: { x: number; y: number }): { success: boolean; error?: string } {
    try {
      clickAtViewport(opts.x, opts.y)
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  },

  async render(id: string): Promise<SceneRenderResult | null> {
    const pageMatch = id.match(/^page-(\d+)$/)
    if (!pageMatch) return null
    const idx = parseInt(pageMatch[1])
    const page = kixPages()[idx]
    if (!page) return null
    const canvas = page.querySelector<HTMLCanvasElement>(".kix-canvas-tile-content")
    if (!canvas) return null
    try {
      const dataUrl = canvas.toDataURL("image/png")
      return {
        id,
        width: canvas.width,
        height: canvas.height,
        dataUrl,
        format: "png"
      }
    } catch (err) {
      throw new Error(`render failed: ${(err as Error).message}`)
    }
  }
}
