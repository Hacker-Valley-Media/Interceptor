const NET_BUFFER_CAP = 500
type PassiveCapturedEntry = { url: string; method: string; status: number; body: string; type: string; timestamp: number; tabUrl: string }
const netBuffer: PassiveCapturedEntry[] = []

type CapturedHeaderEntry = { url: string; method: string; headers: Record<string, string>; type: string; timestamp: number }
const capturedHeaders: CapturedHeaderEntry[] = []
const HEADER_CAP = 200

document.addEventListener("__interceptor_net", ((e: CustomEvent) => {
  try {
    const entry: PassiveCapturedEntry = { ...e.detail, tabUrl: location.href }
    if (netBuffer.length >= NET_BUFFER_CAP) netBuffer.shift()
    netBuffer.push(entry)
  } catch {}
}) as EventListener)

document.addEventListener("__interceptor_headers", ((e: CustomEvent) => {
  try {
    const entry: CapturedHeaderEntry = e.detail
    if (capturedHeaders.length >= HEADER_CAP) capturedHeaders.shift()
    capturedHeaders.push(entry)
  } catch {}
}) as EventListener)

// SSE stream buffer
type SseStreamEntry = { url: string; method: string; status: number; chunks: string[]; startTime: number; lastChunkTime: number; totalBytes: number }
type CompletedSseEntry = { url: string; method: string; status: number; body: string; startTime: number; endTime: number; totalChunks: number; totalBytes: number; duration: number }

const activeStreams = new Map<string, SseStreamEntry>()
const completedStreams: CompletedSseEntry[] = []
const COMPLETED_SSE_CAP = 50

document.addEventListener("__interceptor_sse", ((e: CustomEvent) => {
  try {
    const d = e.detail as { url: string; method?: string; status?: number; chunk: string; seq: number; timestamp: number }
    if (!d || !d.url) return
    const key = d.url
    let stream = activeStreams.get(key)
    if (!stream) {
      stream = { url: d.url, method: d.method || "GET", status: d.status || 0, chunks: [], startTime: d.timestamp, lastChunkTime: d.timestamp, totalBytes: 0 }
      activeStreams.set(key, stream)
    }
    stream.chunks.push(d.chunk)
    stream.lastChunkTime = d.timestamp
    stream.totalBytes += d.chunk.length
  } catch {}
}) as EventListener)

document.addEventListener("__interceptor_sse_done", ((e: CustomEvent) => {
  try {
    const d = e.detail as { url: string; method?: string; status?: number; totalChunks: number; totalBytes: number; duration: number }
    if (!d || !d.url) return
    const stream = activeStreams.get(d.url)
    if (stream) {
      const completed: CompletedSseEntry = {
        url: stream.url,
        method: stream.method,
        status: stream.status,
        body: stream.chunks.join(""),
        startTime: stream.startTime,
        endTime: Date.now(),
        totalChunks: stream.chunks.length,
        totalBytes: stream.totalBytes,
        duration: d.duration
      }
      if (completedStreams.length >= COMPLETED_SSE_CAP) completedStreams.shift()
      completedStreams.push(completed)
      activeStreams.delete(d.url)
    }
  } catch {}
}) as EventListener)

document.addEventListener("__interceptor_sse_close", ((e: CustomEvent) => {
  try {
    const d = e.detail as { url: string }
    if (d?.url) {
      const stream = activeStreams.get(d.url)
      if (stream) {
        const completed: CompletedSseEntry = {
          url: stream.url, method: stream.method, status: stream.status,
          body: stream.chunks.join(""), startTime: stream.startTime, endTime: Date.now(),
          totalChunks: stream.chunks.length, totalBytes: stream.totalBytes,
          duration: Date.now() - stream.startTime
        }
        if (completedStreams.length >= COMPLETED_SSE_CAP) completedStreams.shift()
        completedStreams.push(completed)
        activeStreams.delete(d.url)
      }
    }
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
      document.dispatchEvent(new CustomEvent("__interceptor_set_overrides", { detail: msg.rules || [] }))
      sendResponse({ success: true })
    } catch (err) {
      sendResponse({ success: false, error: (err as Error).message })
    }
    return true
  }
  if (msg.type === "clear_net_overrides") {
    try {
      document.dispatchEvent(new CustomEvent("__interceptor_set_overrides", { detail: [] }))
      sendResponse({ success: true })
    } catch (err) {
      sendResponse({ success: false, error: (err as Error).message })
    }
    return true
  }
  if (msg.type === "get_sse_log") {
    try {
      let entries = completedStreams.slice()
      if (msg.filter) {
        const pattern = msg.filter.toLowerCase()
        entries = entries.filter(e => e.url.toLowerCase().includes(pattern))
      }
      const limit = msg.limit || 50
      entries = entries.slice(-limit)
      sendResponse({ success: true, data: entries })
    } catch (err) {
      sendResponse({ success: false, error: (err as Error).message })
    }
    return true
  }
  if (msg.type === "get_sse_streams") {
    try {
      const streams: Array<{ url: string; method: string; status: number; chunkCount: number; totalBytes: number; startTime: number; lastChunkTime: number; duration: number; currentText: string }> = []
      for (const [, s] of activeStreams) {
        streams.push({
          url: s.url, method: s.method, status: s.status,
          chunkCount: s.chunks.length, totalBytes: s.totalBytes,
          startTime: s.startTime, lastChunkTime: s.lastChunkTime,
          duration: Date.now() - s.startTime,
          currentText: s.chunks.join("").slice(-2000)
        })
      }
      sendResponse({ success: true, data: streams })
    } catch (err) {
      sendResponse({ success: false, error: (err as Error).message })
    }
    return true
  }
  if (msg.type === "get_sse_chunk") {
    try {
      const filter = (msg.filter || "").toLowerCase()
      let found: SseStreamEntry | undefined
      for (const [, s] of activeStreams) {
        if (!filter || s.url.toLowerCase().includes(filter)) { found = s; break }
      }
      if (!found) {
        sendResponse({ success: true, data: { active: false, text: "", chunkCount: 0 } })
      } else {
        const since = msg.since || 0
        const allText = found.chunks.join("")
        const newText = allText.slice(since)
        sendResponse({ success: true, data: { active: true, url: found.url, text: newText, offset: allText.length, chunkCount: found.chunks.length, totalBytes: found.totalBytes } })
      }
    } catch (err) {
      sendResponse({ success: false, error: (err as Error).message })
    }
    return true
  }
})
