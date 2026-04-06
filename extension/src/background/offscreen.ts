export const OFFSCREEN_IDLE_MS = 30_000
let offscreenIdleTimer: ReturnType<typeof setTimeout> | null = null

export async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType]
  })
  if (contexts.length > 0) {
    resetOffscreenTimer()
    return
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS" as chrome.offscreen.Reason],
    justification: "Image crop, stitch, and diff operations"
  })
  resetOffscreenTimer()
}

export function resetOffscreenTimer(): void {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer)
  offscreenIdleTimer = setTimeout(async () => {
    try { await chrome.offscreen.closeDocument() } catch {}
    offscreenIdleTimer = null
  }, OFFSCREEN_IDLE_MS)
}

export async function sendToOffscreen(msg: Record<string, unknown>): Promise<unknown> {
  await ensureOffscreen()
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...msg, target: "offscreen" }, resolve)
  })
}
