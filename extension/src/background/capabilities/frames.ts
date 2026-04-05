type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleFrameActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  if (action.type === "frames_list") {
    const frames = await chrome.webNavigation.getAllFrames({ tabId })
    return {
      success: true,
      data: frames?.map(f => ({ frameId: f.frameId, url: f.url, parentFrameId: f.parentFrameId }))
    }
  }
  return { success: false, error: `unknown frame action: ${action.type}` }
}
