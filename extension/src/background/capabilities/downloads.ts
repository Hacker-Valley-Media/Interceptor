type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleDownloadActions(
  action: { type: string; [key: string]: unknown },
  _tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "downloads_start": {
      const downloadId = await chrome.downloads.download({
        url: action.url as string,
        filename: action.filename as string | undefined,
        saveAs: !!action.saveAs
      })
      return { success: true, data: { downloadId } }
    }

    case "downloads_search": {
      const items = await chrome.downloads.search({
        query: action.query ? [action.query as string] : undefined,
        limit: (action.limit as number) || 20,
        orderBy: ["-startTime"]
      })
      return {
        success: true,
        data: items.map(d => ({
          id: d.id, url: d.url, filename: d.filename, state: d.state,
          bytesReceived: d.bytesReceived, totalBytes: d.totalBytes,
          mime: d.mime, startTime: d.startTime
        }))
      }
    }

    case "downloads_cancel":
      await chrome.downloads.cancel(action.downloadId as number)
      return { success: true }

    case "downloads_pause":
      await chrome.downloads.pause(action.downloadId as number)
      return { success: true }

    case "downloads_resume":
      await chrome.downloads.resume(action.downloadId as number)
      return { success: true }
  }
  return { success: false, error: `unknown download action: ${action.type}` }
}
