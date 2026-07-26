import { sendToContentScript } from "../content-bridge"
import { sendToOffscreen } from "../offscreen"
import { installScreenshotCorsRule, uninstallScreenshotCorsRule } from "./screenshot-cors"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number; fallbackEligible?: boolean }

const CAPTURE_TIMEOUT_MS = 5000
const DOM_RENDER_TIMEOUT_MS = 30_000
const VISIBILITY_HINT = "Chrome/Brave window may not be visible — bring it to the front and retry, or pass --tab <id> of a tab in a visible window."

class CaptureTimeoutError extends Error {
  readonly operation: string
  readonly timeoutMs: number
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`)
    this.name = "CaptureTimeoutError"
    this.operation = operation
    this.timeoutMs = timeoutMs
  }
}

function withCaptureTimeout<T>(operation: string, p: Promise<T>, ms = CAPTURE_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CaptureTimeoutError(operation, ms)), ms)
    p.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err) }
    )
  })
}

function mimeTypeForFormat(format: string): string {
  if (format === "webp") return "image/webp"
  if (format === "png") return "image/png"
  return "image/jpeg"
}

// Background-first contract: chrome.tabs.captureVisibleTab captures the
// **active** tab in a window, ignoring the tabId we pass — so when the target
// tab was opened with `active: false` (the new default), the strip loop would
// capture whichever foreground tab the user is actually looking at instead.
// Mitigation: briefly activate our target around the capture window, then
// restore whichever tab was active when we started. The visible flash is the
// price; silently capturing the user's foreground tab is the bug we cannot
// ship. Caller is expected to wrap the entire captureVisibleTab block —
// including the rate-limit gap between strips — so the prior-active tab is
// only restored once the full sequence is done.
export async function withCaptureVisibleTabFocus<T>(
  tabId: number,
  windowId: number,
  fn: () => Promise<T>
): Promise<T> {
  const [priorActive] = await chrome.tabs.query({ active: true, windowId })
  const targetAlreadyActive = priorActive?.id === tabId
  if (!targetAlreadyActive) {
    try {
      await chrome.tabs.update(tabId, { active: true })
    } catch {
      // If activation fails (tab vanished, window state changed), let the
      // caller's captureVisibleTab call surface the underlying error so the
      // existing diagnostics path stays authoritative.
    }
  }
  try {
    return await fn()
  } finally {
    if (!targetAlreadyActive && typeof priorActive?.id === "number" && priorActive.id !== tabId) {
      await chrome.tabs.update(priorActive.id, { active: true }).catch(() => undefined)
    }
  }
}

async function stitchStripsInWorker(
  strips: Array<{ dataUrl: string; y: number }>,
  totalWidth: number,
  totalHeight: number,
  format: string,
  quality: number,
  scale: number = 1
): Promise<string | null> {
  try {
    // Scale during draw, not during allocation. Pre-computing scaled output
    // dimensions avoids hitting the 16384 Skia ceiling on tall pages even if
    // the natural canvas would have exceeded it.
    const outWidth = Math.max(1, Math.round(totalWidth * scale))
    const outHeight = Math.max(1, Math.round(totalHeight * scale))
    const canvas = new OffscreenCanvas(outWidth, outHeight)
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    for (const strip of strips) {
      const res = await fetch(strip.dataUrl)
      const blob = await res.blob()
      const bmp = await createImageBitmap(blob)
      const dx = 0
      const dy = Math.round(strip.y * scale)
      const dw = Math.round(bmp.width * scale)
      const dh = Math.round(bmp.height * scale)
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, dx, dy, dw, dh)
      bmp.close?.()
    }
    const mime = mimeTypeForFormat(format)
    const outBlob = await canvas.convertToBlob({ type: mime, quality })
    const buf = await outBlob.arrayBuffer()
    // base64-encode
    let binary = ""
    const bytes = new Uint8Array(buf)
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    const b64 = btoa(binary)
    return `data:${mime};base64,${b64}`
  } catch (err) {
    console.error("[stitchStripsInWorker] failed:", err)
    return null
  }
}

// ─── DOM render path (default) ────────────────────────────────────────────────

type DomScreenshotMode = "full" | "element" | "selector" | "region"

function resolveDomMode(action: { [key: string]: unknown }): DomScreenshotMode {
  if (typeof action.selector === "string") return "selector"
  if (action.element !== undefined || typeof action.ref === "string") return "element"
  if (action.region || action.clip) return "region"
  return "full"
}

// Re-encode a PNG/JPEG dataUrl as WebP using OffscreenCanvas.
// html-to-image only emits PNG/JPEG, and chrome.tabs.captureVisibleTab only
// accepts PNG/JPEG. WebP support is added by re-encoding at the SW boundary.
async function reencodeAsWebP(dataUrl: string, qualityPct: number): Promise<string> {
  const res = await fetch(dataUrl)
  const blob = await res.blob()
  const bmp = await createImageBitmap(blob)
  try {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable")
    ctx.drawImage(bmp, 0, 0)
    const out = await canvas.convertToBlob({ type: "image/webp", quality: Math.max(0, Math.min(1, qualityPct / 100)) })
    const buf = await out.arrayBuffer()
    let binary = ""
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return `data:image/webp;base64,${btoa(binary)}`
  } finally {
    bmp.close?.()
  }
}

async function handleDomRenderScreenshot(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  const mode = resolveDomMode(action)
  const requestedFormat = (action.format as string) === "webp" ? "webp"
    : (action.format as string) === "jpeg" ? "jpeg"
    : "png"
  // For WebP requests, render PNG (lossless) in the content script and re-encode
  // at the SW boundary. JPEG → WebP would double-lossy.
  const renderFormat = requestedFormat === "webp" ? "png" : requestedFormat
  const quality = typeof action.quality === "number" ? (action.quality as number) : 92
  // WebP default quality is 85; other formats keep their existing default of 92.
  const webpQuality = typeof action.quality === "number" ? (action.quality as number) : 85
  const scale = typeof action.scale === "number" ? (action.scale as number) : undefined
  const targetMaxLongEdge = typeof action.target_max_long_edge === "number"
    ? (action.target_max_long_edge as number)
    : undefined

  const region = (action.region || action.clip) as { x: number; y: number; width: number; height: number } | undefined

  const targetTab = await chrome.tabs.get(tabId).catch(() => null)
  if (!targetTab) {
    return { success: false, error: `tab ${tabId} not found` }
  }

  // Preflight: a minimized window has no live compositor frame to render, so
  // the DOM-render path would inject screenshot-runner.js and then hang until
  // the CLI WebSocket client times out at 15s (cli/transport.ts). Match the
  // --pixel path's fast, honest failure instead.
  const renderWindow = await chrome.windows.get(targetTab.windowId, { populate: false }).catch(() => null)
  if (renderWindow && renderWindow.state === "minimized") {
    return {
      success: false,
      error: `window ${targetTab.windowId} is minimized — DOM-render requires the window to be non-minimized`,
      data: { hint: VISIBILITY_HINT, layer: "preflight", windowState: renderWindow.state }
    }
  }

  // The DNR CORS rule lets the content script fetch third-party <img> /
  // background-image resources CORS-clean so they can be embedded as data URLs.
  // No library injection is needed — content.ts renders natively.
  await installScreenshotCorsRule(tabId)
  try {
    const dsAction: { type: string; [key: string]: unknown } = { type: "dom_screenshot", mode, format: renderFormat, quality }
    if (action.ref !== undefined) dsAction.ref = action.ref
    if (action.element !== undefined) dsAction.index = action.element
    if (action.selector !== undefined) dsAction.selector = action.selector
    if (region) dsAction.region = region
    if (scale !== undefined) dsAction.scale = scale
    if (targetMaxLongEdge !== undefined) dsAction.target_max_long_edge = targetMaxLongEdge

    // Guard the content-script render with DOM_RENDER_TIMEOUT_MS so a stalled
    // render fails fast with a clear error instead of silently hanging until
    // the CLI's 45s WebSocket timeout (which returns no diagnostics at all).
    let renderResult: { success: boolean; error?: string; data?: { dataUrl: string; format: string; width: number; height: number; pixelRatio: number; mode: string } }
    try {
      renderResult = await withCaptureTimeout(
        "dom-render",
        sendToContentScript(tabId, dsAction),
        DOM_RENDER_TIMEOUT_MS
      ) as { success: boolean; error?: string; data?: { dataUrl: string; format: string; width: number; height: number; pixelRatio: number; mode: string } }
    } catch (err) {
      if (err instanceof CaptureTimeoutError) {
        return {
          success: false,
          error: `DOM-render timed out after ${DOM_RENDER_TIMEOUT_MS}ms — the content script did not return image data. The render stalled (e.g. a resource never settled); retry, or use --pixel for a compositor capture.`,
          data: { layer: "dom-render-timeout" }
        }
      }
      throw err
    }

    if (!renderResult || !renderResult.success || !renderResult.data) {
      // The genuine render failure (content script couldn't rasterize — e.g. the
      // serialized foreignObject SVG won't decode on a heavy page). ONLY this
      // branch is eligible for the pixel fallback; the earlier returns (tab not
      // found, restricted page) and the timeout return above are actionable
      // errors a pixel retry can't fix, so they are NOT tagged.
      return { success: false, error: renderResult?.error || "dom render returned no data", fallbackEligible: true }
    }

    let dataUrl = renderResult.data.dataUrl
    const width = renderResult.data.width
    const height = renderResult.data.height
    let outputFormat = renderResult.data.format

    if (requestedFormat === "webp") {
      try {
        // Bound the post-render webp re-encode too, so a large render that
        // succeeds but re-encodes slowly can't hang past the CLI ceiling
        // (the render guard above only covers the render itself).
        dataUrl = await withCaptureTimeout("webp-reencode", reencodeAsWebP(dataUrl, webpQuality), DOM_RENDER_TIMEOUT_MS)
        outputFormat = "webp"
      } catch (err) {
        if (err instanceof CaptureTimeoutError) {
          return { success: false, error: `webp re-encode timed out after ${DOM_RENDER_TIMEOUT_MS}ms — the rendered page was too large to re-encode in time` }
        }
        return { success: false, error: `webp re-encode failed: ${(err as Error).message}` }
      }
    }

    const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75)

    if (action.save) {
      return { success: true, data: { dataUrl, format: outputFormat, size: sizeBytes, width, height, mode, save: true } }
    }

    return { success: true, data: { dataUrl, format: outputFormat, size: sizeBytes, width, height, mode } }
  } finally {
    await uninstallScreenshotCorsRule(tabId)
  }
}

// ─── Pixel-true path (--pixel escape hatch) ───────────────────────────────────

export async function handleScreenshotBackground(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  const format = (action.format as string) === "png" ? "image/png" : "image/jpeg"
  const quality = ((action.quality as number) || 50) / 100
  try {
    const streamId = await withCaptureTimeout(
      "tabCapture.getMediaStreamId",
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
    )
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType]
    })
    if (contexts.length === 0) {
      await withCaptureTimeout(
        "offscreen.createDocument",
        chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
          justification: "Background tab screenshot via tabCapture"
        })
      )
    }
    await withCaptureTimeout(
      "offscreen.capture_start",
      new Promise<void>((resolve) => {
        chrome.runtime.sendMessage({ target: "offscreen", type: "capture_start", streamId }, () => resolve())
      })
    )
    await new Promise(r => setTimeout(r, 300))
    const frameResult = await withCaptureTimeout(
      "offscreen.capture_frame",
      sendToOffscreen({ type: "capture_frame", format, quality })
    ) as { success: boolean; data?: string; error?: string }
    await withCaptureTimeout(
      "offscreen.capture_stop",
      sendToOffscreen({ type: "capture_stop" })
    ).catch(() => undefined)
    if (!frameResult.success) return { success: false, error: frameResult.error || "capture frame failed" }
    const dataUrl = frameResult.data!
    const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75)
    return { success: true, data: { dataUrl, format: action.format || "jpeg", size: sizeBytes, method: "tabCapture" } }
  } catch (err) {
    if (err instanceof CaptureTimeoutError) {
      return {
        success: false,
        error: `tabCapture timed out at ${err.operation} (${err.timeoutMs}ms)`,
        data: { hint: VISIBILITY_HINT, layer: "tabCapture", timedOutAt: err.operation }
      }
    }
    return { success: false, error: `tabCapture failed: ${(err as Error).message}` }
  }
}

async function handlePixelScreenshot(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  // Output format requested by caller. WebP is supported via OffscreenCanvas
  // re-encode (chrome.tabs.captureVisibleTab itself only emits PNG/JPEG).
  const requestedFormat = (action.format as string) === "webp" ? "webp"
    : (action.format as string) === "png" ? "png"
    : "jpeg"
  // captureVisibleTab format: WebP requests use PNG strips (lossless source) so
  // the OffscreenCanvas re-encode can produce a clean WebP output.
  const captureFormat = requestedFormat === "webp" ? "png" : requestedFormat
  const quality = (action.quality as number) || 50
  const targetMaxLongEdge = typeof action.target_max_long_edge === "number"
    ? (action.target_max_long_edge as number)
    : undefined

  if (action.full) {
    const dims = await sendToContentScript(tabId, { type: "get_page_dimensions" }) as {
      success: boolean
      data?: { scrollHeight: number; scrollWidth: number; viewportHeight: number; viewportWidth: number; scrollY: number; devicePixelRatio: number }
    }
    if (!dims.success || !dims.data) return { success: false, error: "failed to get page dimensions" }
    const { scrollHeight, viewportHeight, viewportWidth, scrollY: origScrollY, devicePixelRatio } = dims.data
    const stripCount = Math.ceil(scrollHeight / viewportHeight)
    const strips: { dataUrl: string; y: number }[] = []

    const fullTab = await chrome.tabs.get(tabId).catch(() => null)
    if (!fullTab) return { success: false, error: `tab ${tabId} not found`, data: { hint: VISIBILITY_HINT } }
    const fullWindow = await chrome.windows.get(fullTab.windowId, { populate: false }).catch(() => null)
    if (fullWindow && fullWindow.state === "minimized") {
      return {
        success: false,
        error: `window ${fullTab.windowId} is minimized — captureVisibleTab cannot capture minimized windows`,
        data: { hint: VISIBILITY_HINT, layer: "preflight", windowState: fullWindow.state }
      }
    }

    // captureVisibleTab targets the active tab in the window. Wrap the entire
    // strip sequence in one focus borrow so we only flash once for a full-page
    // capture — not once per strip — and the user's prior-active tab is
    // restored after the final strip lands.
    const stripCaptureOutcome = await withCaptureVisibleTabFocus(tabId, fullTab.windowId, async () => {
      for (let i = 0; i < stripCount; i++) {
        const scrollTo = i * viewportHeight
        await sendToContentScript(tabId, { type: "scroll_absolute", y: scrollTo })
        await new Promise(r => setTimeout(r, 150))
        let stripUrl: string
        try {
          stripUrl = await withCaptureTimeout(
            `captureVisibleTab(strip ${i + 1}/${stripCount})`,
            chrome.tabs.captureVisibleTab(fullTab.windowId, { format: captureFormat, quality })
          )
        } catch (err) {
          await sendToContentScript(tabId, { type: "scroll_absolute", y: origScrollY }).catch(() => undefined)
          if (err instanceof CaptureTimeoutError) {
            return {
              ok: false as const,
              error: {
                success: false,
                error: `full-page screenshot failed: ${err.operation} timed out after ${err.timeoutMs}ms`,
                data: { hint: VISIBILITY_HINT, layer: "captureVisibleTab", strip: i + 1, totalStrips: stripCount, timedOutAt: err.operation }
              } as ActionResult
            }
          }
          return {
            ok: false as const,
            error: { success: false, error: `captureVisibleTab failed on strip ${i + 1}/${stripCount}: ${(err as Error).message}` } as ActionResult
          }
        }
        strips.push({ dataUrl: stripUrl, y: Math.round(scrollTo * devicePixelRatio) })
        // Chrome rate-limits captureVisibleTab to MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
        // (default: 2/sec). 1100ms between strips clears the quota with margin.
        if (i < stripCount - 1) await new Promise(r => setTimeout(r, 1100))
      }
      await sendToContentScript(tabId, { type: "scroll_absolute", y: origScrollY }).catch(() => undefined)
      return { ok: true as const }
    })
    if (!stripCaptureOutcome.ok) return stripCaptureOutcome.error

    // Stitch inline in the SW using OffscreenCanvas — avoids the
    // SW ↔ offscreen-document IPC round-trip which silently drops
    // multi-hundred-KB messages. The SW already has access to
    // OffscreenCanvas + createImageBitmap (it's a Worker context).
    //
    // When target_max_long_edge is set, compute a downsample scale and pass it
    // to the stitch so the output OffscreenCanvas allocation never approaches
    // the 16384 Skia ceiling.
    const naturalWidth = Math.round(viewportWidth * devicePixelRatio)
    const naturalHeight = Math.round(scrollHeight * devicePixelRatio)
    let stitchScale = 1
    if (targetMaxLongEdge !== undefined && targetMaxLongEdge > 0) {
      const longEdge = Math.max(naturalWidth, naturalHeight)
      if (longEdge > targetMaxLongEdge) stitchScale = targetMaxLongEdge / longEdge
    }
    // WebP output uses default quality 85; PNG/JPEG keep their existing
    // quality semantics.
    const stitchQuality = requestedFormat === "webp"
      ? (typeof action.quality === "number" ? (action.quality as number) : 85) / 100
      : quality / 100
    const stitchedUrl = await stitchStripsInWorker(
      strips,
      naturalWidth,
      naturalHeight,
      requestedFormat,
      stitchQuality,
      stitchScale
    )
    if (!stitchedUrl) return { success: false, error: "stitch failed (could not render strips into OffscreenCanvas)" }
    const stitchedSize = Math.round((stitchedUrl.length - stitchedUrl.indexOf(",") - 1) * 0.75)
    if (action.save) {
      return { success: true, data: { dataUrl: stitchedUrl, format: requestedFormat, size: stitchedSize, save: true, strips: stripCount } }
    }
    return { success: true, data: { dataUrl: stitchedUrl, format: requestedFormat, size: stitchedSize, strips: stripCount } }
  }

  const targetTab = await chrome.tabs.get(tabId).catch(() => null)
  if (!targetTab) {
    return { success: false, error: `tab ${tabId} not found`, data: { hint: VISIBILITY_HINT } }
  }
  const targetWindow = await chrome.windows.get(targetTab.windowId, { populate: false }).catch(() => null)
  if (targetWindow && targetWindow.state === "minimized") {
    return {
      success: false,
      error: `window ${targetTab.windowId} is minimized — captureVisibleTab cannot capture minimized windows`,
      data: { hint: VISIBILITY_HINT, layer: "preflight", windowState: targetWindow.state }
    }
  }

  let dataUrl: string
  try {
    // Same borrow-and-restore as the strip path. One brief flash for a single
    // capture is the cost of background-first defaults.
    dataUrl = await withCaptureVisibleTabFocus(tabId, targetTab.windowId, () =>
      withCaptureTimeout(
        "captureVisibleTab",
        chrome.tabs.captureVisibleTab(targetTab.windowId, { format: captureFormat, quality })
      )
    )
  } catch (err) {
    if (err instanceof CaptureTimeoutError) {
      return {
        success: false,
        error: `captureVisibleTab timed out after ${err.timeoutMs}ms`,
        data: { hint: VISIBILITY_HINT, layer: "captureVisibleTab", timedOutAt: err.operation }
      }
    }
    const fallback = await handleScreenshotBackground(
      { type: "screenshot_background", format: action.format, quality: action.quality },
      tabId
    )
    if (fallback.success && fallback.data) {
      (fallback.data as Record<string, unknown>).fallback = "tabCapture (captureVisibleTab failed)"
    }
    return fallback
  }

  let clip = action.clip as { x: number; y: number; width: number; height: number } | undefined
  if (!clip && action.element !== undefined) {
    const elemResult = await sendToContentScript(tabId, {
      type: "rect", index: action.element
    }) as { success: boolean; data?: { x: number; y: number; width: number; height: number } }
    if (elemResult.success && elemResult.data) clip = elemResult.data
  }

  if (clip) {
    const cropResult = await sendToOffscreen({ type: "crop", dataUrl, clip }) as {
      success: boolean; data?: string; error?: string
    }
    if (!cropResult.success) return { success: false, error: cropResult.error }
    dataUrl = cropResult.data!
  }

  // Post-capture transform — downsample to fit target_max_long_edge and/or
  // re-encode to WebP. Done in one OffscreenCanvas pass for efficiency.
  const transformed = await transformPixelDataUrl(dataUrl, requestedFormat, action.quality as number | undefined, targetMaxLongEdge)
  if (!transformed.success) return { success: false, error: transformed.error || "post-capture transform failed" }
  const finalUrl = transformed.dataUrl
  const finalSize = Math.round((finalUrl.length - finalUrl.indexOf(",") - 1) * 0.75)

  if (action.save) {
    return { success: true, data: { dataUrl: finalUrl, format: requestedFormat, size: finalSize, save: true } }
  }

  if (clip) {
    return { success: true, data: { dataUrl: finalUrl, format: requestedFormat, size: finalSize, clip } }
  }

  if (requestedFormat === "png" && finalSize > 800 * 1024) {
    return {
      success: true,
      data: { dataUrl: finalUrl, format: requestedFormat, size: finalSize, warning: "PNG exceeds 800KB — consider using JPEG or WebP for smaller responses" }
    }
  }
  return { success: true, data: { dataUrl: finalUrl, format: requestedFormat, size: finalSize } }
}

// Post-capture transform for the pixel path. Applies downsample
// (target_max_long_edge) and/or format re-encode (PNG/JPEG/WebP) in one
// OffscreenCanvas pass. Returns the same dataUrl unchanged when no transform
// is needed, so callers pay zero cost for default invocations.
async function transformPixelDataUrl(
  dataUrl: string,
  requestedFormat: string,
  quality: number | undefined,
  targetMaxLongEdge: number | undefined
): Promise<{ success: true; dataUrl: string } | { success: false; error: string }> {
  // Detect current MIME from the dataUrl prefix so we can short-circuit no-ops.
  const currentMime = dataUrl.startsWith("data:image/webp") ? "webp"
    : dataUrl.startsWith("data:image/png") ? "png"
    : "jpeg"
  const formatChange = currentMime !== requestedFormat
  const needsDownsample = targetMaxLongEdge !== undefined && targetMaxLongEdge > 0
  if (!formatChange && !needsDownsample) {
    return { success: true, dataUrl }
  }
  try {
    const res = await fetch(dataUrl)
    const blob = await res.blob()
    const bmp = await createImageBitmap(blob)
    try {
      let scale = 1
      if (needsDownsample) {
        const longEdge = Math.max(bmp.width, bmp.height)
        if (longEdge > targetMaxLongEdge!) scale = targetMaxLongEdge! / longEdge
      }
      const outWidth = Math.max(1, Math.round(bmp.width * scale))
      const outHeight = Math.max(1, Math.round(bmp.height * scale))
      const canvas = new OffscreenCanvas(outWidth, outHeight)
      const ctx = canvas.getContext("2d")
      if (!ctx) return { success: false, error: "OffscreenCanvas 2d context unavailable" }
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, outWidth, outHeight)
      const mime = mimeTypeForFormat(requestedFormat)
      const encodeQuality = requestedFormat === "webp"
        ? Math.max(0, Math.min(1, (typeof quality === "number" ? quality : 85) / 100))
        : Math.max(0, Math.min(1, (typeof quality === "number" ? quality : 50) / 100))
      const outBlob = await canvas.convertToBlob({ type: mime, quality: encodeQuality })
      const buf = await outBlob.arrayBuffer()
      let binary = ""
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      return { success: true, dataUrl: `data:${mime};base64,${btoa(binary)}` }
    } finally {
      bmp.close?.()
    }
  } catch (err) {
    return { success: false, error: `transform failed: ${(err as Error).message}` }
  }
}

// ─── OCR: native capture → bundled Tesseract → deterministic text ─────────────
// Renders the target (selector / element / region / full page) to a PNG via the
// native DOM-render path, then OCRs it in the offscreen document with the
// bundled Tesseract.js engine. Cross-platform, offline, no macOS bridge, and no
// round-trip of pixels to the agent — returns a plain text string.
async function handleOcr(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  const shot: { type: string; [key: string]: unknown } = { type: "screenshot", format: "png", save: false }
  for (const k of ["selector", "element", "ref", "region", "clip", "scale", "target_max_long_edge"]) {
    if (action[k] !== undefined) shot[k] = action[k]
  }
  const rendered = await handleDomRenderScreenshot(shot, tabId)
  if (!rendered.success) return rendered
  const dataUrl = (rendered.data as { dataUrl?: string } | undefined)?.dataUrl
  if (!dataUrl) return { success: false, error: "capture for OCR produced no image" }

  const ocr = await sendToOffscreen({ type: "ocr", dataUrl }) as {
    success: boolean; data?: { text?: string; source?: string; confidence?: number | null }; error?: string
  }
  if (!ocr.success) return { success: false, error: ocr.error || "OCR failed" }
  return {
    success: true,
    data: {
      text: (ocr.data?.text || "").trim(),
      source: ocr.data?.source || "tesseract",
      confidence: ocr.data?.confidence ?? null,
      width: (rendered.data as { width?: number } | undefined)?.width,
      height: (rendered.data as { height?: number } | undefined)?.height
    }
  }
}

// ─── Auto-fallback planning (pure) ────────────────────────────────────────────

// Decide whether a failed DOM-render screenshot should retry via the pixel
// path, and if so, shape the pixel request. Pure so it's unit-testable without
// chrome. Returns null when NO fallback should happen.
//
// The pixel path is a DIFFERENT capture mechanism that can only honor a subset
// of the request, so the fallback is gated tightly:
//  - Only on a genuine render failure (domResult.fallbackEligible) — not on
//    tab-not-found / restricted-page / timeout errors, which a pixel retry
//    can't fix and would only mask behind extra latency.
//  - Only for a whole-page capture. region/clip/selector are DOM-render-only
//    concepts; element/ref crops resolve against the DOM, and the pixel path
//    can't honor `ref` at all and would crop an off-screen element against the
//    wrong (viewport) origin — a wrong image reported as success.
//
// When it does fall back it reconstructs an EXPLICIT full-page pixel request
// (the default DOM-render screenshot is whole-page by contract, so the fallback
// must be too — `full: true` selects the strip-and-stitch path, not a viewport
// grab) carrying only the fields the pixel path honors. Options the pixel path
// can't apply (`--scale` and DOM-only fields) are dropped and named in the note.
export function planPixelFallback(
  action: { type: string; [key: string]: unknown },
  domResult: ActionResult
): { pixelAction: { type: string; [key: string]: unknown }; note: string } | null {
  const isWholePageCapture = !(
    action.region || action.clip || action.selector ||
    action.element !== undefined || action.ref !== undefined
  )
  if (!domResult.fallbackEligible || !isWholePageCapture) return null

  const droppedOpts: string[] = []
  if (action.scale !== undefined) droppedOpts.push("--scale")

  const pixelAction: { type: string; [key: string]: unknown } = {
    type: "screenshot",
    pixel: true,
    full: true,
  }
  // Match the DOM-render defaults (PNG, quality 92) when the caller pinned
  // neither — otherwise the pixel path's own defaults (JPEG, quality 50) would
  // silently downgrade a whole-page capture that the DOM path would have
  // returned as a lossless PNG. A caller who asked for jpeg/webp or a specific
  // quality still gets exactly that; only the unspecified case changes.
  pixelAction.format = action.format !== undefined ? action.format : "png"
  pixelAction.quality = action.quality !== undefined ? action.quality : 92
  if (action.target_max_long_edge !== undefined) pixelAction.target_max_long_edge = action.target_max_long_edge
  if (action.save !== undefined) pixelAction.save = action.save

  const note = droppedOpts.length
    ? `dom-render (${domResult.error}) → pixel [dropped: ${droppedOpts.join(", ")}]`
    : `dom-render (${domResult.error}) → pixel`
  return { pixelAction, note }
}

// ─── Public dispatcher ────────────────────────────────────────────────────────

export async function handleScreenshotActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "screenshot_background":
      return handleScreenshotBackground(action, tabId)

    case "ocr":
      return handleOcr(action, tabId)

    case "page_capture": {
      const mhtml = await chrome.pageCapture.saveAsMHTML({ tabId })
      const text = await (mhtml as Blob).text()
      return { success: true, data: { size: text.length, preview: text.slice(0, 500) } }
    }

    case "screenshot": {
      // --pixel flag routes to the legacy captureVisibleTab path. Default
      // path is the DOM-render pipeline.
      if (action.pixel === true) {
        return handlePixelScreenshot(action, tabId)
      }
      const domResult = await handleDomRenderScreenshot(action, tabId)
      if (domResult.success) return domResult

      // Auto-fallback: the native DOM renderer fails outright on some heavy
      // real pages (the serialized foreignObject SVG won't decode → an
      // image-load error). Rather than surface a dead end, transparently retry
      // via the pixel (captureVisibleTab) path so the default command still
      // produces an image. Gating + request-shaping is pure logic in
      // planPixelFallback so it stays testable without chrome mocks.
      const plan = planPixelFallback(action, domResult)
      if (!plan) return domResult

      const pixelResult = await handlePixelScreenshot(plan.pixelAction, tabId)
      if (pixelResult.success && pixelResult.data) {
        (pixelResult.data as Record<string, unknown>).fallback = plan.note
        return pixelResult
      }
      // Pixel also failed — return the original DOM-render error (the primary
      // path the caller asked for), noting the pixel fallback was tried.
      return { success: false, error: `${domResult.error} (pixel fallback also failed: ${pixelResult.error})` }
    }
  }
  return { success: false, error: `unknown screenshot action: ${action.type}` }
}
