import { sendToContentScript } from "../content-bridge"
import { sendToOffscreen } from "../offscreen"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleScreenshotBackground(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  const format = (action.format as string) === "png" ? "image/png" : "image/jpeg"
  const quality = ((action.quality as number) || 50) / 100
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType]
    })
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
        justification: "Background tab screenshot via tabCapture"
      })
    }
    await new Promise<void>((resolve) => {
      chrome.runtime.sendMessage({ target: "offscreen", type: "capture_start", streamId }, () => resolve())
    })
    await new Promise(r => setTimeout(r, 300))
    const frameResult = await sendToOffscreen({
      type: "capture_frame", format, quality
    }) as { success: boolean; data?: string; error?: string }
    await sendToOffscreen({ type: "capture_stop" })
    if (!frameResult.success) return { success: false, error: frameResult.error || "capture frame failed" }
    const dataUrl = frameResult.data!
    const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75)
    return { success: true, data: { dataUrl, format: action.format || "jpeg", size: sizeBytes, method: "tabCapture" } }
  } catch (err) {
    return { success: false, error: `tabCapture failed: ${(err as Error).message}` }
  }
}

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

        for (let i = 0; i < stripCount; i++) {
          const scrollTo = i * viewportHeight
          await sendToContentScript(tabId, { type: "scroll_absolute", y: scrollTo })
          await new Promise(r => setTimeout(r, 150))
          const stripUrl = await chrome.tabs.captureVisibleTab({ format, quality })
          strips.push({ dataUrl: stripUrl, y: Math.round(scrollTo * devicePixelRatio) })
          if (i < stripCount - 1) await new Promise(r => setTimeout(r, 500))
        }

        await sendToContentScript(tabId, { type: "scroll_absolute", y: origScrollY })

        const stitchResult = await sendToOffscreen({
          type: "stitch",
          strips,
          totalWidth: Math.round(viewportWidth * devicePixelRatio),
          totalHeight: Math.round(scrollHeight * devicePixelRatio),
          format,
          quality: quality / 100
        }) as { success: boolean; data?: string; error?: string }

        if (!stitchResult.success) return { success: false, error: stitchResult.error }
        const stitchedUrl = stitchResult.data!
        const stitchedSize = Math.round((stitchedUrl.length - stitchedUrl.indexOf(",") - 1) * 0.75)
        if (action.save) {
          return { success: true, data: { dataUrl: stitchedUrl, format, size: stitchedSize, save: true, strips: stripCount } }
        }
        return { success: true, data: { dataUrl: stitchedUrl, format, size: stitchedSize, strips: stripCount } }
      }

      let dataUrl: string
      try {
        dataUrl = await chrome.tabs.captureVisibleTab({ format, quality })
      } catch {
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
  }
  return { success: false, error: `unknown screenshot action: ${action.type}` }
}
