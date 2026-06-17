// extension/src/content/net-buffer.ts
var NET_BUFFER_CAP = 500;
var netBuffer = [];
var capturedHeaders = [];
var HEADER_CAP = 200;
var pageCommBuffer = [];
var PAGE_COMM_CAP = 1000;
var pageCommState = globalThis;
pageCommState.__interceptorPageCommSnapshot = () => pageCommBuffer.slice();
document.addEventListener("__interceptor_net", (e) => {
  try {
    const entry = { ...e.detail, tabUrl: location.href };
    if (netBuffer.length >= NET_BUFFER_CAP)
      netBuffer.shift();
    netBuffer.push(entry);
  } catch {}
});
document.addEventListener("__interceptor_headers", (e) => {
  try {
    const entry = e.detail;
    if (capturedHeaders.length >= HEADER_CAP)
      capturedHeaders.shift();
    capturedHeaders.push(entry);
  } catch {}
});
document.addEventListener("__interceptor_page_comm", (e) => {
  try {
    const entry = { ...e.detail, tabUrl: location.href };
    if (pageCommBuffer.length >= PAGE_COMM_CAP)
      pageCommBuffer.shift();
    pageCommBuffer.push(entry);
  } catch {}
});
var activeStreams = new Map;
var completedStreams = [];
var COMPLETED_SSE_CAP = 50;
document.addEventListener("__interceptor_sse", (e) => {
  try {
    const d = e.detail;
    if (!d || !d.url)
      return;
    const key = d.url;
    let stream = activeStreams.get(key);
    if (!stream) {
      stream = { url: d.url, method: d.method || "GET", status: d.status || 0, chunks: [], startTime: d.timestamp, lastChunkTime: d.timestamp, totalBytes: 0 };
      activeStreams.set(key, stream);
    }
    stream.chunks.push(d.chunk);
    stream.lastChunkTime = d.timestamp;
    stream.totalBytes += d.chunk.length;
  } catch {}
});
document.addEventListener("__interceptor_sse_done", (e) => {
  try {
    const d = e.detail;
    if (!d || !d.url)
      return;
    const stream = activeStreams.get(d.url);
    if (stream) {
      const completed = {
        url: stream.url,
        method: stream.method,
        status: stream.status,
        body: stream.chunks.join(""),
        startTime: stream.startTime,
        endTime: Date.now(),
        totalChunks: stream.chunks.length,
        totalBytes: stream.totalBytes,
        duration: d.duration
      };
      if (completedStreams.length >= COMPLETED_SSE_CAP)
        completedStreams.shift();
      completedStreams.push(completed);
      activeStreams.delete(d.url);
    }
  } catch {}
});
document.addEventListener("__interceptor_sse_close", (e) => {
  try {
    const d = e.detail;
    if (d?.url) {
      const stream = activeStreams.get(d.url);
      if (stream) {
        const completed = {
          url: stream.url,
          method: stream.method,
          status: stream.status,
          body: stream.chunks.join(""),
          startTime: stream.startTime,
          endTime: Date.now(),
          totalChunks: stream.chunks.length,
          totalBytes: stream.totalBytes,
          duration: Date.now() - stream.startTime
        };
        if (completedStreams.length >= COMPLETED_SSE_CAP)
          completedStreams.shift();
        completedStreams.push(completed);
        activeStreams.delete(d.url);
      }
    }
  } catch {}
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "get_net_log") {
    try {
      let entries = netBuffer.slice();
      if (msg.filter) {
        const pattern = msg.filter.toLowerCase();
        entries = entries.filter((e) => e.url.toLowerCase().includes(pattern));
      }
      if (msg.since) {
        entries = entries.filter((e) => e.timestamp >= msg.since);
      }
      sendResponse({ success: true, data: entries });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }
  if (msg.type === "clear_net_log") {
    netBuffer.length = 0;
    capturedHeaders.length = 0;
    pageCommBuffer.length = 0;
    sendResponse({ success: true });
    return true;
  }
  if (msg.type === "get_page_comm_log") {
    try {
      let entries = pageCommBuffer.slice();
      if (msg.filter) {
        const pattern = msg.filter.toLowerCase();
        entries = entries.filter((e) => {
          const url = typeof e.url === "string" ? e.url : "";
          const channel = typeof e.channelName === "string" ? e.channelName : "";
          const event = typeof e.event === "string" ? e.event : "";
          return url.toLowerCase().includes(pattern) || channel.toLowerCase().includes(pattern) || event.toLowerCase().includes(pattern);
        });
      }
      if (msg.entryType) {
        const entryType = String(msg.entryType).toLowerCase();
        entries = entries.filter((e) => String(e.type || "").toLowerCase() === entryType);
      }
      if (msg.since) {
        entries = entries.filter((e) => e.timestamp >= msg.since);
      }
      const limit = msg.limit || 100;
      entries = entries.slice(-limit);
      sendResponse({ success: true, data: entries });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }
  if (msg.type === "clear_page_comm_log") {
    pageCommBuffer.length = 0;
    sendResponse({ success: true });
    return true;
  }
  if (msg.type === "get_captured_headers") {
    try {
      let headers = capturedHeaders.slice();
      if (msg.filter) {
        const pattern = msg.filter.toLowerCase();
        headers = headers.filter((h) => h.url.toLowerCase().includes(pattern));
      }
      sendResponse({ success: true, data: headers });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }
  if (msg.type === "set_net_overrides") {
    try {
      document.dispatchEvent(new CustomEvent("__interceptor_set_overrides", { detail: msg.rules || [] }));
      sendResponse({ success: true });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }
  if (msg.type === "clear_net_overrides") {
    try {
      document.dispatchEvent(new CustomEvent("__interceptor_set_overrides", { detail: [] }));
      sendResponse({ success: true });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }
  if (msg.type === "get_sse_log") {
    try {
      let entries = completedStreams.slice();
      if (msg.filter) {
        const pattern = msg.filter.toLowerCase();
        entries = entries.filter((e) => e.url.toLowerCase().includes(pattern));
      }
      const limit = msg.limit || 50;
      entries = entries.slice(-limit);
      sendResponse({ success: true, data: entries });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }
  if (msg.type === "get_sse_streams") {
    try {
      const streams = [];
      for (const [, s] of activeStreams) {
        streams.push({
          url: s.url,
          method: s.method,
          status: s.status,
          chunkCount: s.chunks.length,
          totalBytes: s.totalBytes,
          startTime: s.startTime,
          lastChunkTime: s.lastChunkTime,
          duration: Date.now() - s.startTime,
          currentText: s.chunks.join("").slice(-2000)
        });
      }
      sendResponse({ success: true, data: streams });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }
  if (msg.type === "get_sse_chunk") {
    try {
      const filter = (msg.filter || "").toLowerCase();
      let found;
      for (const [, s] of activeStreams) {
        if (!filter || s.url.toLowerCase().includes(filter)) {
          found = s;
          break;
        }
      }
      if (!found) {
        sendResponse({ success: true, data: { active: false, text: "", chunkCount: 0 } });
      } else {
        const since = msg.since || 0;
        const allText = found.chunks.join("");
        const newText = allText.slice(since);
        sendResponse({ success: true, data: { active: true, url: found.url, text: newText, offset: allText.length, chunkCount: found.chunks.length, totalBytes: found.totalBytes } });
      }
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }
});
