import { sendToOffscreen } from "../offscreen"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleCaptureStreamActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "capture_start": {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType]
      })
      if (contexts.length === 0) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
          justification: "Tab capture stream processing"
        })
      }
      chrome.runtime.sendMessage({ target: "offscreen", type: "capture_start", streamId })
      return { success: true, data: { streamId, tabId } }
    }

    case "capture_frame": {
      const fmt = (action.format as string) === "png" ? "image/png" : "image/jpeg"
      const qual = (action.quality as number) || 50
      const frameResult = await sendToOffscreen({
        type: "capture_frame", format: fmt, quality: qual / 100
      }) as { success: boolean; data?: string; error?: string }
      if (!frameResult.success) return { success: false, error: frameResult.error }
      return { success: true, data: { dataUrl: frameResult.data } }
    }

    case "capture_stop": {
      await sendToOffscreen({ type: "capture_stop" })
      try { await chrome.offscreen.closeDocument() } catch {}
      return { success: true }
    }

    case "canvas_diff": {
      const diffResult = await sendToOffscreen({
        type: "diff",
        image1: action.image1 as string,
        image2: action.image2 as string,
        threshold: (action.threshold as number) || 0,
        returnImage: (action.returnImage as boolean) || false
      }) as { success: boolean; data?: unknown; error?: string }
      if (!diffResult.success) return { success: false, error: diffResult.error }
      return { success: true, data: diffResult.data }
    }
  }
  return { success: false, error: `unknown capture action: ${action.type}` }
}
