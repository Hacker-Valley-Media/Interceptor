const NET_BUFFER_CAP = 500
type PassiveCapturedEntry = { url: string; method: string; status: number; body: string; type: string; timestamp: number; tabUrl: string }
const netBuffer: PassiveCapturedEntry[] = []

type CapturedHeaderEntry = { url: string; method: string; headers: Record<string, string>; type: string; timestamp: number }
const capturedHeaders: CapturedHeaderEntry[] = []
const HEADER_CAP = 200

document.addEventListener("__slop_net", ((e: CustomEvent) => {
  try {
    const entry: PassiveCapturedEntry = { ...e.detail, tabUrl: location.href }
    if (netBuffer.length >= NET_BUFFER_CAP) netBuffer.shift()
    netBuffer.push(entry)
  } catch {}
}) as EventListener)

document.addEventListener("__slop_headers", ((e: CustomEvent) => {
  try {
    const entry: CapturedHeaderEntry = e.detail
    if (capturedHeaders.length >= HEADER_CAP) capturedHeaders.shift()
    capturedHeaders.push(entry)
  } catch {}
}) as EventListener)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "get_net_log") {
    try {
      let entries = netBuffer.slice()
      if (msg.filter) {
        const pattern = msg.filter.toLowerCase()
        entries = entries.filter(e => e.url.toLowerCase().includes(pattern))
      }
      if (msg.since) {
        entries = entries.filter(e => e.timestamp >= msg.since)
      }
      sendResponse({ success: true, data: entries })
    } catch (err) {
      sendResponse({ success: false, error: (err as Error).message })
    }
    return true
  }
  if (msg.type === "clear_net_log") {
    netBuffer.length = 0
    capturedHeaders.length = 0
    sendResponse({ success: true })
    return true
  }
  if (msg.type === "get_captured_headers") {
    try {
      let headers = capturedHeaders.slice()
      if (msg.filter) {
        const pattern = msg.filter.toLowerCase()
        headers = headers.filter(h => h.url.toLowerCase().includes(pattern))
      }
      sendResponse({ success: true, data: headers })
    } catch (err) {
      sendResponse({ success: false, error: (err as Error).message })
    }
    return true
  }
  if (msg.type === "set_net_overrides") {
    try {
      document.dispatchEvent(new CustomEvent("__slop_set_overrides", { detail: msg.rules || [] }))
      sendResponse({ success: true })
    } catch (err) {
      sendResponse({ success: false, error: (err as Error).message })
    }
    return true
  }
  if (msg.type === "clear_net_overrides") {
    try {
      document.dispatchEvent(new CustomEvent("__slop_set_overrides", { detail: [] }))
      sendResponse({ success: true })
    } catch (err) {
      sendResponse({ success: false, error: (err as Error).message })
    }
    return true
  }
})
