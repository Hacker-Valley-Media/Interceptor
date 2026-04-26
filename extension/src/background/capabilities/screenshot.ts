import { sendToContentScript } from "../content-bridge"
import { sendToOffscreen } from "../offscreen"
import { installScreenshotCorsRule, uninstallScreenshotCorsRule } from "./screenshot-cors"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

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

async function stitchStripsInWorker(
  strips: Array<{ dataUrl: string; y: number }>,
  totalWidth: number,
  totalHeight: number,
  format: string,
  quality: number
): Promise<string | null> {
  try {
    const canvas = new OffscreenCanvas(totalWidth, totalHeight)
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    for (const strip of strips) {
      const res = await fetch(strip.dataUrl)
      const blob = await res.blob()
      const bmp = await createImageBitmap(blob)
      ctx.drawImage(bmp, 0, strip.y)
      bmp.close?.()
    }
    const outBlob = await canvas.convertToBlob({
      type: format === "png" ? "image/png" : "image/jpeg",
      quality
    })
    const buf = await outBlob.arrayBuffer()
    // base64-encode
    let binary = ""
    const bytes = new Uint8Array(buf)
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    const b64 = btoa(binary)
    return `data:${format === "png" ? "image/png" : "image/jpeg"};base64,${b64}`
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

async function injectScreenshotRunner(tabId: number): Promise<{ success: boolean; error?: string }> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED" as chrome.scripting.ExecutionWorld,
      files: ["screenshot-runner.js"]
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: `failed to inject screenshot-runner.js: ${(err as Error).message}` }
  }
}

async function handleDomRenderScreenshot(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  const mode = resolveDomMode(action)
  const format = (action.format as string) === "jpeg" ? "jpeg" : "png"
  const quality = typeof action.quality === "number" ? (action.quality as number) : 92
  const scale = typeof action.scale === "number" ? (action.scale as number) : undefined

  const region = (action.region || action.clip) as { x: number; y: number; width: number; height: number } | undefined

  const targetTab = await chrome.tabs.get(tabId).catch(() => null)
  if (!targetTab) {
    return { success: false, error: `tab ${tabId} not found` }
  }

  await installScreenshotCorsRule(tabId)
  try {
    const inject = await injectScreenshotRunner(tabId)
    if (!inject.success) return { success: false, error: inject.error || "runner injection failed" }

    const dsAction: { type: string; [key: string]: unknown } = { type: "dom_screenshot", mode, format, quality }
    if (action.ref !== undefined) dsAction.ref = action.ref
    if (action.element !== undefined) dsAction.index = action.element
    if (action.selector !== undefined) dsAction.selector = action.selector
    if (region) dsAction.region = region
    if (scale !== undefined) dsAction.scale = scale

    const renderResult = await sendToContentScript(tabId, dsAction) as { success: boolean; error?: string; data?: { dataUrl: string; format: string; width: number; height: number; pixelRatio: number; mode: string } }

    if (!renderResult || !renderResult.success || !renderResult.data) {
      return { success: false, error: renderResult?.error || "dom render returned no data" }
    }

    const dataUrl = renderResult.data.dataUrl
    const width = renderResult.data.width
    const height = renderResult.data.height

    const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75)

    if (action.save) {
      return { success: true, data: { dataUrl, format, size: sizeBytes, width, height, mode, save: true } }
    }

    return { success: true, data: { dataUrl, format, size: sizeBytes, width, height, mode } }
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
  const format = (action.format as string) === "png" ? "png" : "jpeg"
  const quality = (action.quality as number) || 50

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

    for (let i = 0; i < stripCount; i++) {
      const scrollTo = i * viewportHeight
      await sendToContentScript(tabId, { type: "scroll_absolute", y: scrollTo })
      await new Promise(r => setTimeout(r, 150))
      let stripUrl: string
      try {
        stripUrl = await withCaptureTimeout(
          `captureVisibleTab(strip ${i + 1}/${stripCount})`,
          chrome.tabs.captureVisibleTab(fullTab.windowId, { format, quality })
        )
      } catch (err) {
        await sendToContentScript(tabId, { type: "scroll_absolute", y: origScrollY }).catch(() => undefined)
        if (err instanceof CaptureTimeoutError) {
          return {
            success: false,
            error: `full-page screenshot failed: ${err.operation} timed out after ${err.timeoutMs}ms`,
            data: { hint: VISIBILITY_HINT, layer: "captureVisibleTab", strip: i + 1, totalStrips: stripCount, timedOutAt: err.operation }
          }
        }
        return { success: false, error: `captureVisibleTab failed on strip ${i + 1}/${stripCount}: ${(err as Error).message}` }
      }
      strips.push({ dataUrl: stripUrl, y: Math.round(scrollTo * devicePixelRatio) })
      // Chrome rate-limits captureVisibleTab to MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
      // (default: 2/sec). 1100ms between strips clears the quota with margin.
      if (i < stripCount - 1) await new Promise(r => setTimeout(r, 1100))
    }

    await sendToContentScript(tabId, { type: "scroll_absolute", y: origScrollY }).catch(() => undefined)

    // Stitch inline in the SW using OffscreenCanvas — avoids the
    // SW ↔ offscreen-document IPC round-trip which silently drops
    // multi-hundred-KB messages. The SW already has access to
    // OffscreenCanvas + createImageBitmap (it's a Worker context).
    const stitchedUrl = await stitchStripsInWorker(
      strips,
      Math.round(viewportWidth * devicePixelRatio),
      Math.round(scrollHeight * devicePixelRatio),
      format,
      quality / 100
    )
    if (!stitchedUrl) return { success: false, error: "stitch failed (could not render strips into OffscreenCanvas)" }
    const stitchedSize = Math.round((stitchedUrl.length - stitchedUrl.indexOf(",") - 1) * 0.75)
    if (action.save) {
      return { success: true, data: { dataUrl: stitchedUrl, format, size: stitchedSize, save: true, strips: stripCount } }
    }
    return { success: true, data: { dataUrl: stitchedUrl, format, size: stitchedSize, strips: stripCount } }
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
    dataUrl = await withCaptureTimeout(
      "captureVisibleTab",
      chrome.tabs.captureVisibleTab(targetTab.windowId, { format, quality })
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
  const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75)

  if (action.save) {
    return { success: true, data: { dataUrl, format, size: sizeBytes, save: true } }
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
    const croppedUrl = cropResult.data!
    const croppedSize = Math.round((croppedUrl.length - croppedUrl.indexOf(",") - 1) * 0.75)
    return { success: true, data: { dataUrl: croppedUrl, format, size: croppedSize, clip } }
  }

  if (format === "png" && sizeBytes > 800 * 1024) {
    return {
      success: true,
      data: { dataUrl, format, size: sizeBytes, warning: "PNG exceeds 800KB — consider using JPEG for smaller responses" }
    }
  }
  return { success: true, data: { dataUrl, format, size: sizeBytes } }
}

// ─── Public dispatcher ────────────────────────────────────────────────────────

export async function handleScreenshotActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "screenshot_background":
      return handleScreenshotBackground(action, tabId)

    case "page_capture": {
      const mhtml = await chrome.pageCapture.saveAsMHTML({ tabId })
      const text = await (mhtml as Blob).text()
      return { success: true, data: { size: text.length, preview: text.slice(0, 500) } }
    }

    case "screenshot": {
      // --pixel flag routes to the legacy captureVisibleTab path. Default
      // path is the new DOM-render pipeline (PRD-44).
      if (action.pixel === true) {
        return handlePixelScreenshot(action, tabId)
      }
      return handleDomRenderScreenshot(action, tabId)
    }
  }
  return { success: false, error: `unknown screenshot action: ${action.type}` }
}
