// dom-screenshot.ts
//
// Content-script handler for the DOM-render screenshot pipeline.
// Driven by `case "dom_screenshot":` in content.ts.
//
// Pre-conditions:
//   - The vendored html-to-image bundle must already be injected into this
//     frame's ISOLATED world via chrome.scripting.executeScript({ files:
//     ["screenshot-runner.js"], world: "ISOLATED" }). The runner sets
//     globalThis.__interceptor_h2i.
//   - The CORS DNR session rule must be active for the duration of this call
//     so that third-party <img>, font, and <video> resources fetched (or
//     re-fetched) by html-to-image come back with `Access-Control-Allow-Origin:
//     *`. The SW handler installs and removes that rule in a try/finally.

import { resolveElement } from "./input-simulation"

type ActionResult = { success: boolean; error?: string; data?: unknown }

type DomScreenshotAction = {
  type: string
  mode?: "full" | "element" | "selector" | "region"
  ref?: string
  index?: number
  selector?: string
  region?: { x: number; y: number; width: number; height: number }
  format?: "png" | "jpeg"
  quality?: number
  scale?: number
}

type H2iLib = {
  toPng: (node: HTMLElement, options?: Record<string, unknown>) => Promise<string>
  toJpeg: (node: HTMLElement, options?: Record<string, unknown>) => Promise<string>
}

function getLibrary(): H2iLib | null {
  return (globalThis as unknown as { __interceptor_h2i?: H2iLib }).__interceptor_h2i ?? null
}

async function cropDataUrl(
  dataUrl: string,
  x: number,
  y: number,
  w: number,
  h: number,
  format: "png" | "jpeg",
  quality: number
): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas")
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext("2d")
        if (!ctx) { resolve(null); return }
        ctx.drawImage(img, x, y, w, h, 0, 0, w, h)
        const out = format === "jpeg"
          ? canvas.toDataURL("image/jpeg", quality)
          : canvas.toDataURL("image/png")
        resolve(out)
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

function resolveTarget(action: DomScreenshotAction): { node: HTMLElement | null; error?: string } {
  const mode = action.mode || "full"
  switch (mode) {
    case "full":
    case "region":
      return { node: document.documentElement }
    case "element": {
      if (action.ref === undefined && action.index === undefined) {
        return { node: null, error: "element mode requires ref or index" }
      }
      const el = resolveElement(action.index, action.ref)
      if (!el) {
        const label = String(action.ref ?? action.index ?? "unknown")
        return { node: null, error: `stale element [${label}] — run interceptor state to refresh` }
      }
      if (!(el instanceof HTMLElement)) {
        return { node: null, error: `target is not an HTMLElement (got ${el.constructor.name})` }
      }
      return { node: el }
    }
    case "selector": {
      if (!action.selector) {
        return { node: null, error: "selector mode requires selector string" }
      }
      const el = document.querySelector(action.selector)
      if (!el) return { node: null, error: `selector not found: ${action.selector}` }
      if (!(el instanceof HTMLElement)) {
        return { node: null, error: `selector matched non-HTMLElement (got ${el.constructor.name})` }
      }
      return { node: el }
    }
    default:
      return { node: null, error: `unknown screenshot mode: ${mode}` }
  }
}

export async function handleDomScreenshot(action: DomScreenshotAction): Promise<ActionResult> {
  const lib = getLibrary()
  if (!lib) {
    return {
      success: false,
      error: "html-to-image library not loaded into this frame — SW must inject screenshot-runner.js before dispatching dom_screenshot"
    }
  }

  const { node, error } = resolveTarget(action)
  if (!node) return { success: false, error: error || "no target resolved" }

  const format = action.format === "jpeg" ? "jpeg" : "png"
  const qualityPct = typeof action.quality === "number" ? Math.max(1, Math.min(100, action.quality)) : 92
  const pixelRatio = typeof action.scale === "number" && action.scale > 0
    ? action.scale
    : (window.devicePixelRatio || 1)

  // 1×1 transparent PNG used as a placeholder for any image that html-to-image
  // can't fetch CORS-clean. Without a placeholder, the library falls back to
  // drawing the page's already-loaded <img> element, which taints the canvas
  // and breaks toDataURL().
  const TRANSPARENT_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg=="

  const opts: Record<string, unknown> = {
    cacheBust: true,
    pixelRatio,
    quality: qualityPct / 100,
    skipFonts: true,
    imagePlaceholder: TRANSPARENT_1PX,
    fetchRequestInit: { mode: "cors", cache: "no-cache" },
  }

  // First attempt: render as-is. Many image-heavy pages have third-party
  // <img> or CSS background-images that html-to-image can't fetch
  // CORS-clean even with our DNR rule (cached responses, server quirks),
  // and drawing those onto a canvas taints it. If we hit a tainted-canvas
  // error, retry with a filter that excludes <img> and <picture> elements
  // so the structural render still succeeds (without images).
  const renderWithOpts = async (effectiveOpts: Record<string, unknown>): Promise<string> => {
    return format === "jpeg"
      ? await lib.toJpeg(node, effectiveOpts)
      : await lib.toPng(node, effectiveOpts)
  }

  // For "full" mode, force the node's effective dimensions to the document's
  // scrollWidth/scrollHeight so html-to-image renders the whole page rather
  // than just the viewport-clipped portion.
  const isFull = (action.mode || "full") === "full" || (action.mode === "region")
  if (isFull) {
    opts.width = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0)
    opts.height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
    opts.canvasWidth = (opts.width as number) * pixelRatio
    opts.canvasHeight = (opts.height as number) * pixelRatio
  }

  try {
    let dataUrl: string
    try {
      dataUrl = await renderWithOpts(opts)
    } catch (err) {
      const msg = (err as Error).message || String(err)
      const isTaint = /taint|cross-origin|may not be exported/i.test(msg)
      if (!isTaint) throw err
      // Retry without images
      const filteredOpts: Record<string, unknown> = {
        ...opts,
        filter: (n: Node) => {
          if (!(n instanceof Element)) return true
          const tag = n.tagName?.toLowerCase()
          return tag !== "img" && tag !== "picture" && tag !== "video" && tag !== "canvas"
        }
      }
      dataUrl = await renderWithOpts(filteredOpts)
    }

    const rect = node.getBoundingClientRect()
    let outWidth = Math.round((isFull ? (opts.width as number) : rect.width) * pixelRatio)
    let outHeight = Math.round((isFull ? (opts.height as number) : rect.height) * pixelRatio)

    // Region mode: crop directly here in the content script before sending
    // the dataUrl back. The cropped image is much smaller than the full
    // render, which keeps the inter-frame and SW→daemon messages well under
    // any size limit.
    if ((action.mode === "region") && action.region) {
      const region = action.region
      const cropX = Math.round(region.x * pixelRatio)
      const cropY = Math.round(region.y * pixelRatio)
      const cropW = Math.round(region.width * pixelRatio)
      const cropH = Math.round(region.height * pixelRatio)
      const cropped = await cropDataUrl(dataUrl, cropX, cropY, cropW, cropH, format, qualityPct / 100)
      if (cropped) {
        dataUrl = cropped
        outWidth = cropW
        outHeight = cropH
      }
    }

    return {
      success: true,
      data: {
        dataUrl,
        format,
        width: outWidth,
        height: outHeight,
        pixelRatio,
        mode: action.mode || "full",
      }
    }
  } catch (err) {
    return { success: false, error: `dom render failed: ${(err as Error).message}` }
  }
}
