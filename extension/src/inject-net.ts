import { K_BEACON, K_BROADCAST, K_NET, K_TT_POLICY, K_WS, TT_NET_POLICY_NAME, TT_POLICY_NAME } from "./inject-keys"

if ((window as any)[K_NET]) {
  // already patched — skip
} else {
  (window as any)[K_NET] = true

  // Trust overrides — must run before any page bundle captures native getters.
  // Pages tag synthetic events with `event.__interceptor_trust = true` to claim
  // trusted-input semantics. Used to defeat user-activation gates on
  // canvas-rendered editors (Google Docs, Slides, Sheets) where the only path
  // to the editing model is through dispatched InputEvent / MouseEvent.
  //
  // NB: `__interceptor_trust` is a DOCUMENTED PUBLIC CONTRACT — user/agent
  // `eval --main` code sets it by this exact string name (README, AGENTS.md, and
  // the use-cases/ recipes). It is therefore intentionally NOT de-branded here:
  // symbol-keying the getter would silently break every external caller. Hiding
  // it from page listeners needs a per-session random namespace shared with the
  // eval tooling, tracked with the deferred CustomEvent-channel work (#178).
  try {
    const origIsTrusted = Object.getOwnPropertyDescriptor(Event.prototype, "isTrusted")
    Object.defineProperty(Event.prototype, "isTrusted", {
      configurable: true,
      get(this: Event & { __interceptor_trust?: boolean }) {
        if (this.__interceptor_trust === true) return true
        return origIsTrusted && origIsTrusted.get ? origIsTrusted.get.call(this) : false
      }
    })
  } catch {}

  try {
    const ua = (navigator as Navigator & { userActivation?: { isActive: boolean; hasBeenActive: boolean } }).userActivation
    if (ua) {
      const proto = Object.getPrototypeOf(ua)
      Object.defineProperty(proto, "isActive", { configurable: true, get() { return true } })
      Object.defineProperty(proto, "hasBeenActive", { configurable: true, get() { return true } })
    }
  } catch {}

  if ((window as any).trustedTypes?.createPolicy) {
    try {
      (window as any).trustedTypes.createPolicy(TT_NET_POLICY_NAME, {
        createHTML: (input: string) => input,
        createScriptURL: (input: string) => input,
        createScript: (input: string) => input,
      })
    } catch {}
    if (!(window as any)[K_TT_POLICY]) {
      try {
        (window as any)[K_TT_POLICY] = (window as any).trustedTypes.createPolicy(TT_POLICY_NAME, {
          createScript: (input: string) => input,
        })
      } catch {
        try {
          (window as any)[K_TT_POLICY] = (window as any).trustedTypes.createPolicy(TT_POLICY_NAME + "-" + Date.now(), {
            createScript: (input: string) => input,
          })
        } catch {}
      }
    }
  }

  type OverrideRule = { urlPattern: string; queryAddOrReplace?: Record<string, string | number | boolean>; queryRemove?: string[] }
  // NB: kept as a closure-local. The window property (`__interceptor_override_rules`)
  // this used to publish was vestigial — every read below goes through this const —
  // and it was a page-visible tell, so it is no longer assigned to `window`.
  const overrideRules: OverrideRule[] = []

  document.addEventListener("__interceptor_set_overrides", ((e: CustomEvent) => {
    overrideRules.length = 0
    if (Array.isArray(e.detail)) {
      for (const rule of e.detail) overrideRules.push(rule)
    }
  }) as EventListener)

  // Main-world gesture dispatch. Synthetic pointer events fired from the content
  // script's ISOLATED world don't drive some frameworks' `pointerdown` handlers
  // (Radix / Floating UI menus open on pointerdown but ignore isolated-world
  // events). The content script bridges here by dispatching an
  // `__interceptor_click` CustomEvent on the target; we re-fire the gesture in
  // the MAIN world — where the page's own listeners treat it as a real event —
  // tagging each event trusted, and ack synchronously so the isolated side knows
  // it does not need its legacy fallback dispatch.
  document.addEventListener("__interceptor_click", ((e: CustomEvent) => {
    const target = e.target as (Element & { focus?: () => void }) | null
    if (!target || typeof (target as Element).dispatchEvent !== "function") return
    const d = (e.detail || {}) as { x?: number; y?: number }
    const base = {
      bubbles: true, cancelable: true, composed: true,
      clientX: d.x ?? 0, clientY: d.y ?? 0,
      button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true,
    }
    const fire = (ev: Event) => {
      (ev as Event & { __interceptor_trust?: boolean }).__interceptor_trust = true
      target.dispatchEvent(ev)
    }
    try {
      fire(new PointerEvent("pointerover", { ...base, buttons: 1 }))
      fire(new MouseEvent("mouseover", { ...base, buttons: 1 }))
      fire(new PointerEvent("pointerdown", { ...base, buttons: 1 }))
      fire(new MouseEvent("mousedown", { ...base, buttons: 1 }))
      try { target.focus?.() } catch {}
      fire(new PointerEvent("pointerup", { ...base, buttons: 0 }))
      fire(new MouseEvent("mouseup", { ...base, buttons: 0 }))
      fire(new MouseEvent("click", { ...base, buttons: 0 }))
      target.dispatchEvent(new CustomEvent("__interceptor_click_ack", { bubbles: true }))
    } catch {}
  }) as EventListener, true)

  // File-drop trust bridge. The content script (ISOLATED) can build a File and
  // fire a drop, but that drop is isTrusted:false — some dropzones reject it.
  // Here in MAIN we re-build the File from the blob: URL it handed us and fire
  // the drag sequence *inside our own realm*, tagged trusted, so the page's own
  // drop listener sees isTrusted:true (the tag only works in the realm that owns
  // the isTrusted getter override above). Ack back with {id, ok} so the content
  // side knows whether to fall back to its own isolated dispatch.
  document.addEventListener("__interceptor_file_drop", ((e: CustomEvent) => {
    const target = e.target as (Element & { dispatchEvent: (ev: Event) => boolean }) | null
    const d = (e.detail || {}) as { id?: string; blobUrl?: string; name?: string; type?: string; x?: number; y?: number }
    if (!target || !d.id || !d.blobUrl) return
    const ack = (ok: boolean) => {
      try {
        target.dispatchEvent(new CustomEvent("__interceptor_file_drop_ack", { bubbles: true, detail: { id: d.id, ok } }))
      } catch {}
    }
    ;(async () => {
      try {
        const resp = await fetch(d.blobUrl as string)
        const blob = await resp.blob()
        const file = new File([blob], d.name || "file", { type: d.type || blob.type || "application/octet-stream" })
        const dt = new DataTransfer()
        dt.items.add(file)
        const base = {
          bubbles: true, cancelable: true, composed: true,
          clientX: d.x ?? 0, clientY: d.y ?? 0,
        }
        const fire = (type: string) => {
          const ev = new DragEvent(type, { ...base, dataTransfer: dt }) as DragEvent & { __interceptor_trust?: boolean }
          ev.__interceptor_trust = true
          target.dispatchEvent(ev)
        }
        fire("dragenter")
        fire("dragover")
        fire("drop")
        ack(true)
      } catch {
        ack(false)
      }
    })()
  }) as EventListener, true)

  // File System Access API shim. Sites whose "browse" button calls
  // window.showOpenFilePicker() open a native OS panel the browser surface can't
  // drive. The content script stages a file via __interceptor_stage_file; the
  // next showOpenFilePicker() call resolves to that file instead of opening the
  // panel. Only installed when the native API exists (Chromium), so we never
  // fake support that would change a page's feature detection.
  {
    const stagedFiles: Array<{ blobUrl: string; name: string; type: string }> = []
    document.addEventListener("__interceptor_stage_file", ((e: CustomEvent) => {
      const d = (e.detail || {}) as { blobUrl?: string; name?: string; type?: string }
      if (d.blobUrl) stagedFiles.push({ blobUrl: d.blobUrl, name: d.name || "file", type: d.type || "application/octet-stream" })
    }) as EventListener)

    const win = window as unknown as { showOpenFilePicker?: (...a: unknown[]) => Promise<unknown> }
    if (typeof win.showOpenFilePicker === "function") {
      const orig = win.showOpenFilePicker.bind(window)
      try {
        Object.defineProperty(window, "showOpenFilePicker", {
          configurable: true,
          writable: true,
          value: async function (...args: unknown[]) {
            const staged = stagedFiles.shift()
            if (!staged) return orig(...args)
            const resp = await fetch(staged.blobUrl)
            const blob = await resp.blob()
            const file = new File([blob], staged.name, { type: staged.type || blob.type || "application/octet-stream" })
            try { URL.revokeObjectURL(staged.blobUrl) } catch {}
            return [{
              kind: "file",
              name: staged.name,
              getFile: async () => file,
              isSameEntry: async () => false,
              queryPermission: async () => "granted",
              requestPermission: async () => "granted",
            }]
          }
        })
      } catch {}
    }
  }

  function applyOverrides(rawUrl: string): string {
    if (!overrideRules.length) return rawUrl
    for (const rule of overrideRules) {
      if (!matchesPattern(rawUrl, rule.urlPattern)) continue
      try {
        const base = rawUrl.startsWith("/") ? window.location.origin + rawUrl : rawUrl
        const u = new URL(base)
        if (rule.queryRemove) {
          for (const key of rule.queryRemove) u.searchParams.delete(key)
        }
        if (rule.queryAddOrReplace) {
          for (const [key, value] of Object.entries(rule.queryAddOrReplace)) {
            u.searchParams.set(key, String(value))
          }
        }
        const result = rawUrl.startsWith("/") ? u.pathname + u.search + u.hash : u.toString()
        return result
      } catch {}
    }
    return rawUrl
  }

  function matchesPattern(url: string, pattern: string): boolean {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")
    return new RegExp(escaped, "i").test(url)
  }

  const PAGE_COMM_PREVIEW_CAP = 4096

  type PayloadSummary = {
    payloadKind: string
    payloadPreview?: string
    payloadBytes?: number
    payloadEncoding?: "base64"
    truncated?: boolean
  }

  function byteLength(text: string): number {
    try { return new TextEncoder().encode(text).byteLength } catch { return text.length }
  }

  function bytesToBase64Preview(bytes: Uint8Array): { text: string; truncated: boolean } {
    const capped = bytes.byteLength > PAGE_COMM_PREVIEW_CAP
      ? bytes.slice(0, PAGE_COMM_PREVIEW_CAP)
      : bytes
    let binary = ""
    for (let i = 0; i < capped.byteLength; i++) binary += String.fromCharCode(capped[i])
    return { text: btoa(binary), truncated: bytes.byteLength > PAGE_COMM_PREVIEW_CAP }
  }

  function safeJsonPreview(value: unknown): { text: string; truncated: boolean } {
    const seen = new WeakSet<object>()
    let raw: string
    try {
      raw = JSON.stringify(value, (_key, item) => {
        if (typeof item === "function") return "[Function]"
        if (typeof item === "symbol") return String(item)
        if (typeof item === "bigint") return `${String(item)}n`
        if (item && typeof item === "object") {
          if (seen.has(item)) return "[Circular]"
          seen.add(item)
        }
        return item
      })
    } catch {
      try { raw = String(value) } catch { raw = "[Unserializable]" }
    }
    if (raw === undefined) raw = "undefined"
    return {
      text: raw.length > PAGE_COMM_PREVIEW_CAP ? raw.slice(0, PAGE_COMM_PREVIEW_CAP) : raw,
      truncated: raw.length > PAGE_COMM_PREVIEW_CAP
    }
  }

  function summarizePayload(value: unknown): PayloadSummary {
    try {
      if (value === undefined) return { payloadKind: "undefined", payloadBytes: 0 }
      if (value === null) return { payloadKind: "null", payloadBytes: 0 }
      if (typeof value === "string") {
        const truncated = value.length > PAGE_COMM_PREVIEW_CAP
        return {
          payloadKind: "string",
          payloadPreview: truncated ? value.slice(0, PAGE_COMM_PREVIEW_CAP) : value,
          payloadBytes: byteLength(value),
          truncated
        }
      }
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        const text = String(value)
        return { payloadKind: typeof value, payloadPreview: text, payloadBytes: byteLength(text), truncated: false }
      }
      if (value instanceof Blob) {
        return {
          payloadKind: "blob",
          payloadPreview: value.type || undefined,
          payloadBytes: value.size,
          truncated: value.size > 0
        }
      }
      if (value instanceof ArrayBuffer) {
        const bytes = new Uint8Array(value)
        const preview = bytesToBase64Preview(bytes)
        return {
          payloadKind: "arraybuffer",
          payloadPreview: preview.text,
          payloadBytes: bytes.byteLength,
          payloadEncoding: "base64",
          truncated: preview.truncated
        }
      }
      if (ArrayBuffer.isView(value as ArrayBufferView)) {
        const view = value as ArrayBufferView
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
        const preview = bytesToBase64Preview(bytes)
        return {
          payloadKind: value instanceof DataView ? "dataview" : "typedarray",
          payloadPreview: preview.text,
          payloadBytes: bytes.byteLength,
          payloadEncoding: "base64",
          truncated: preview.truncated
        }
      }
      if (value instanceof URLSearchParams) {
        const text = value.toString()
        const truncated = text.length > PAGE_COMM_PREVIEW_CAP
        return {
          payloadKind: "urlsearchparams",
          payloadPreview: truncated ? text.slice(0, PAGE_COMM_PREVIEW_CAP) : text,
          payloadBytes: byteLength(text),
          truncated
        }
      }
      if (value instanceof FormData) {
        const fields: Array<{ name: string; value: string }> = []
        value.forEach((entry, name) => {
          if (fields.length >= 50) return
          fields.push({
            name,
            value: entry instanceof File
              ? `[File name=${entry.name} type=${entry.type || "unknown"} size=${entry.size}]`
              : String(entry)
          })
        })
        const preview = safeJsonPreview(fields)
        return {
          payloadKind: "formdata",
          payloadPreview: preview.text,
          payloadBytes: byteLength(preview.text),
          truncated: preview.truncated || fields.length >= 50
        }
      }
      const preview = safeJsonPreview(value)
      return {
        payloadKind: Array.isArray(value) ? "array" : typeof value,
        payloadPreview: preview.text,
        payloadBytes: byteLength(preview.text),
        truncated: preview.truncated
      }
    } catch (err) {
      const text = (err as Error)?.message || String(err)
      return { payloadKind: "unserializable", payloadPreview: text, payloadBytes: byteLength(text), truncated: false }
    }
  }

  function dispatchPageComm(detail: Record<string, unknown>): void {
    try {
      document.dispatchEvent(new CustomEvent("__interceptor_page_comm", {
        detail: {
          timestamp: Date.now(),
          tabUrl: location.href,
          ...detail
        }
      }))
    } catch {}
  }

  const originalFetch = window.fetch

  const patchedFetch = Object.assign(function (this: typeof window, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url: string
    try {
      if (typeof input === "string") url = input
      else if (input instanceof URL) url = input.toString()
      else if (input instanceof Request) url = input.url
      else url = String(input)
    } catch {
      return originalFetch.call(this, input, init)
    }

    const overriddenUrl = applyOverrides(url)
    if (overriddenUrl !== url) {
      if (typeof input === "string") input = overriddenUrl
      else if (input instanceof URL) input = new URL(overriddenUrl)
      else if (input instanceof Request) input = new Request(overriddenUrl, input)
      url = overriddenUrl
    }

    const method = init?.method || "GET"

    let reqHeaders: Record<string, string> | undefined
    try {
      if (init?.headers) {
        reqHeaders = {}
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => { reqHeaders![k] = v })
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) reqHeaders[k] = v
        } else {
          for (const [k, v] of Object.entries(init.headers)) reqHeaders[k] = String(v)
        }
      }
    } catch {}

    return originalFetch.call(this, input, init).then((response) => {
      if (reqHeaders) {
        try {
          document.dispatchEvent(new CustomEvent("__interceptor_headers", {
            detail: { url, method, headers: reqHeaders, type: "fetch", timestamp: Date.now() }
          }))
        } catch {}
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase()
      const acceptHeader = (reqHeaders?.accept || reqHeaders?.Accept || "").toLowerCase()
      const isSse = contentType.includes("text/event-stream") || acceptHeader.includes("text/event-stream")

      const responseHeaders: Record<string, string> = {}
      try {
        const setCookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
        response.headers.forEach((v, k) => { responseHeaders[k] = v })
        if (setCookies && setCookies.length > 1) {
          responseHeaders["set-cookie"] = setCookies.join("\n")
        }
      } catch {}

      if (isSse && response.body && !response.bodyUsed) {
        try {
          const reader = response.body.getReader()
          const decoder = new TextDecoder("utf-8")
          const chunks: string[] = []
          let chunkSeq = 0
          const streamStart = Date.now()
          const MAX_ACCUMULATE = 10 * 1024 * 1024
          let totalBytes = 0
          let truncated = false

          const passThrough = new ReadableStream({
            start(controller) {
              function pump(): void {
                reader.read().then(({ done, value }) => {
                  if (done) {
                    try {
                      const fullBody = chunks.join("")
                      document.dispatchEvent(new CustomEvent("__interceptor_net", {
                        detail: {
                          url,
                          method,
                          status: response.status,
                          body: fullBody,
                          type: "fetch",
                          timestamp: Date.now(),
                          truncated,
                          contentType,
                          requestHeaders: reqHeaders || {},
                          responseHeaders
                        }
                      }))
                      document.dispatchEvent(new CustomEvent("__interceptor_sse_done", {
                        detail: { url, method, status: response.status, totalChunks: chunkSeq, totalBytes, duration: Date.now() - streamStart }
                      }))
                    } catch {}
                    controller.close()
                    return
                  }

                  try {
                    const text = decoder.decode(value, { stream: true })
                    totalBytes += value.byteLength
                    if (!truncated) {
                      if (totalBytes <= MAX_ACCUMULATE) {
                        chunks.push(text)
                      } else {
                        truncated = true
                      }
                    }
                    document.dispatchEvent(new CustomEvent("__interceptor_sse", {
                      detail: { url, method, status: response.status, chunk: text, seq: chunkSeq++, timestamp: Date.now() }
                    }))
                  } catch {}

                  controller.enqueue(value)
                  pump()
                }).catch((err) => {
                  try {
                    document.dispatchEvent(new CustomEvent("__interceptor_sse_error", {
                      detail: { url, error: err?.message || String(err) }
                    }))
                  } catch {}
                  controller.error(err)
                })
              }
              pump()
            },
            cancel(reason) {
              reader.cancel(reason).catch(() => {})
            }
          })

          return new Response(passThrough, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          })
        } catch {
          return response
        }
      }

      try {
        const clone = response.clone()
        clone.text().then((body) => {
          document.dispatchEvent(new CustomEvent("__interceptor_net", {
            detail: {
              url,
              method,
              status: response.status,
              body,
              type: "fetch",
              timestamp: Date.now(),
              truncated: false,
              contentType,
              requestHeaders: reqHeaders || {},
              responseHeaders
            }
          }))
        }).catch(() => {})
      } catch {}

      return response
    }).catch((err) => {
      throw err
    })
  }, originalFetch)

  window.fetch = patchedFetch

  const XHR = XMLHttpRequest.prototype

  interface XHRWithInterceptor extends XMLHttpRequest {
    _interceptor_url?: string
    _interceptor_method?: string
    _interceptor_headers?: Record<string, string>
  }

  const origOpen = XHR.open
  const origSend = XHR.send
  const origSetHeader = XHR.setRequestHeader

  XHR.open = function (this: XHRWithInterceptor, method: string, url: string | URL, ...rest: any[]): void {
    const rawUrl = url.toString()
    const overriddenUrl = applyOverrides(rawUrl)
    this._interceptor_url = overriddenUrl
    this._interceptor_method = method
    this._interceptor_headers = {}
    if (overriddenUrl !== rawUrl) {
      return origOpen.apply(this, [method, overriddenUrl, ...rest] as any)
    }
    return origOpen.apply(this, arguments as any)
  }

  XHR.setRequestHeader = function (this: XHRWithInterceptor, header: string, value: string): void {
    if (this._interceptor_headers) this._interceptor_headers[header] = value
    return origSetHeader.apply(this, arguments as any)
  }

  XHR.send = function (this: XHRWithInterceptor, body?: Document | XMLHttpRequestBodyInit | null): void {
    const xhrUrl = this._interceptor_url
    const xhrMethod = this._interceptor_method || "GET"
    const xhrHeaders = this._interceptor_headers

    this.addEventListener("load", function (this: XHRWithInterceptor) {
      try {
        const responseText = this.responseText
        const responseHeaders: Record<string, string> = {}
        try {
          const raw = this.getAllResponseHeaders() || ""
          for (const line of raw.split(/\r?\n/)) {
            const idx = line.indexOf(":")
            if (idx > 0) {
              const name = line.slice(0, idx).trim().toLowerCase()
              const value = line.slice(idx + 1).trim()
              if (name in responseHeaders) {
                responseHeaders[name] = responseHeaders[name] + "\n" + value
              } else {
                responseHeaders[name] = value
              }
            }
          }
        } catch {}
        document.dispatchEvent(new CustomEvent("__interceptor_net", {
          detail: {
            url: xhrUrl,
            method: xhrMethod,
            status: this.status,
            body: responseText,
            type: "xhr",
            timestamp: Date.now(),
            truncated: false,
            contentType: (this.getResponseHeader("content-type") || "").toLowerCase(),
            requestHeaders: xhrHeaders || {},
            responseHeaders
          }
        }))
      } catch {}

      if (xhrHeaders && Object.keys(xhrHeaders).length > 0) {
        try {
          document.dispatchEvent(new CustomEvent("__interceptor_headers", {
            detail: { url: xhrUrl, method: xhrMethod, headers: xhrHeaders, type: "xhr", timestamp: Date.now() }
          }))
        } catch {}
      }
    })

    return origSend.apply(this, arguments as any)
  }

	  const OriginalEventSource = (window as any).EventSource as typeof EventSource | undefined
	  if (OriginalEventSource) {
    const InterceptorEventSource = function (this: EventSource, url: string | URL, init?: EventSourceInit) {
      const resolvedUrl = typeof url === "string" ? url : url.toString()
      const real = new OriginalEventSource(url, init) as EventSource

      try {
        document.dispatchEvent(new CustomEvent("__interceptor_sse_open", {
          detail: { url: resolvedUrl, withCredentials: init?.withCredentials || false, source: "eventsource", timestamp: Date.now() }
        }))
      } catch {}

      const origAddEventListener = real.addEventListener.bind(real)

      real.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
        if (type === "message" && listener) {
          const wrapped = function (this: EventSource, ev: MessageEvent) {
            try {
              document.dispatchEvent(new CustomEvent("__interceptor_sse", {
                detail: { url: resolvedUrl, chunk: ev.data, seq: -1, event: ev.type, lastEventId: ev.lastEventId, source: "eventsource", timestamp: Date.now() }
              }))
            } catch {}
            if (typeof listener === "function") listener.call(this, ev)
            else if (listener && typeof listener.handleEvent === "function") listener.handleEvent(ev)
          }
          origAddEventListener(type, wrapped as EventListener, options)
          return
        }
        if (!listener) return
        origAddEventListener(type, listener, options)
      } as typeof real.addEventListener

      const origOnMessage = Object.getOwnPropertyDescriptor(OriginalEventSource.prototype, "onmessage")
      if (origOnMessage) {
        let userOnMessage: ((ev: MessageEvent) => void) | null = null
        Object.defineProperty(real, "onmessage", {
          get() { return userOnMessage },
          set(fn: ((ev: MessageEvent) => void) | null) {
            userOnMessage = fn
            if (origOnMessage.set) {
              origOnMessage.set.call(real, fn ? function (this: EventSource, ev: MessageEvent) {
                try {
                  document.dispatchEvent(new CustomEvent("__interceptor_sse", {
                    detail: { url: resolvedUrl, chunk: ev.data, seq: -1, event: "message", lastEventId: ev.lastEventId, source: "eventsource", timestamp: Date.now() }
                  }))
                } catch {}
                fn.call(this, ev)
              } : null)
            }
          },
          configurable: true
        })
      }

      const origClose = real.close.bind(real)
      real.close = function () {
        try {
          document.dispatchEvent(new CustomEvent("__interceptor_sse_close", {
            detail: { url: resolvedUrl, source: "eventsource", timestamp: Date.now() }
          }))
        } catch {}
        origClose()
      }

      real.addEventListener("error", () => {
        try {
          document.dispatchEvent(new CustomEvent("__interceptor_sse_error", {
            detail: { url: resolvedUrl, error: "EventSource error", source: "eventsource" }
          }))
        } catch {}
      })

      return real as unknown as EventSource
    } as unknown as typeof EventSource

      InterceptorEventSource.prototype = OriginalEventSource.prototype
      Object.defineProperties(InterceptorEventSource, {
        CONNECTING: { value: OriginalEventSource.CONNECTING },
        OPEN: { value: OriginalEventSource.OPEN },
        CLOSED: { value: OriginalEventSource.CLOSED }
      })
	      ;(window as any).EventSource = InterceptorEventSource
	  }

  const OriginalWebSocket = (window as any).WebSocket as typeof WebSocket | undefined
  if (OriginalWebSocket && !(window as any)[K_WS]) {
    ;(window as any)[K_WS] = true
    let wsSeq = 0
    const InterceptorWebSocket = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const socketId = `ws-${Date.now()}-${++wsSeq}`
      const args = protocols === undefined ? [url] : [url, protocols]
      const real = Reflect.construct(OriginalWebSocket, args, new.target || InterceptorWebSocket) as WebSocket
      const requestedUrl = typeof url === "string" ? url : url.toString()

      dispatchPageComm({
        type: "ws",
        event: "ws_opening",
        socketId,
        direction: "open",
        url: requestedUrl,
        protocols: protocols === undefined ? [] : protocols
      })

      real.addEventListener("open", () => {
        dispatchPageComm({
          type: "ws",
          event: "ws_open",
          socketId,
          direction: "open",
          url: real.url || requestedUrl,
          protocol: real.protocol,
          extensions: real.extensions,
          readyState: real.readyState
        })
      })

      real.addEventListener("message", (ev: MessageEvent) => {
        dispatchPageComm({
          type: "ws",
          event: "ws_message",
          socketId,
          direction: "receive",
          url: real.url || requestedUrl,
          binaryType: real.binaryType,
          ...summarizePayload(ev.data)
        })
      })

      real.addEventListener("error", () => {
        dispatchPageComm({
          type: "ws",
          event: "ws_error",
          socketId,
          direction: "error",
          url: real.url || requestedUrl,
          readyState: real.readyState
        })
      })

      real.addEventListener("close", (ev: CloseEvent) => {
        dispatchPageComm({
          type: "ws",
          event: "ws_close",
          socketId,
          direction: "close",
          url: real.url || requestedUrl,
          code: ev.code,
          reason: ev.reason,
          wasClean: ev.wasClean,
          readyState: real.readyState
        })
      })

      const originalSend = real.send.bind(real)
      real.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        dispatchPageComm({
          type: "ws",
          event: "ws_send",
          socketId,
          direction: "send",
          url: real.url || requestedUrl,
          readyState: real.readyState,
          bufferedAmount: real.bufferedAmount,
          ...summarizePayload(data)
        })
        return originalSend(data)
      }

      return real
    } as unknown as typeof WebSocket

    try { Object.setPrototypeOf(InterceptorWebSocket, OriginalWebSocket) } catch {}
    InterceptorWebSocket.prototype = OriginalWebSocket.prototype
    Object.defineProperties(InterceptorWebSocket, {
      CONNECTING: { value: OriginalWebSocket.CONNECTING },
      OPEN: { value: OriginalWebSocket.OPEN },
      CLOSING: { value: OriginalWebSocket.CLOSING },
      CLOSED: { value: OriginalWebSocket.CLOSED }
    })
    ;(window as any).WebSocket = InterceptorWebSocket
  }

  const originalBeacon = navigator.sendBeacon?.bind(navigator)
  if (originalBeacon && !(navigator as any)[K_BEACON]) {
    ;(navigator as any)[K_BEACON] = true
    navigator.sendBeacon = function (url: string | URL, data?: BodyInit | null): boolean {
      const resolvedUrl = typeof url === "string" ? url : url.toString()
      try {
        const result = originalBeacon(url, data)
        dispatchPageComm({
          type: "beacon",
          event: "beacon",
          direction: "send",
          method: "POST",
          url: resolvedUrl,
          returnValue: result,
          ...summarizePayload(data)
        })
        return result
      } catch (err) {
        dispatchPageComm({
          type: "beacon",
          event: "beacon_error",
          direction: "error",
          method: "POST",
          url: resolvedUrl,
          error: (err as Error)?.message || String(err),
          ...summarizePayload(data)
        })
        throw err
      }
    }
  }

  const OriginalBroadcastChannel = (window as any).BroadcastChannel as typeof BroadcastChannel | undefined
  if (OriginalBroadcastChannel && !(window as any)[K_BROADCAST]) {
    ;(window as any)[K_BROADCAST] = true
    let bcSeq = 0
    const InterceptorBroadcastChannel = function (this: BroadcastChannel, name: string) {
      const channelId = `bc-${Date.now()}-${++bcSeq}`
      const real = Reflect.construct(OriginalBroadcastChannel, [name], new.target || InterceptorBroadcastChannel) as BroadcastChannel

      dispatchPageComm({
        type: "broadcast",
        event: "broadcast_open",
        channelId,
        direction: "open",
        channelName: name
      })

      real.addEventListener("message", (ev: MessageEvent) => {
        dispatchPageComm({
          type: "broadcast",
          event: "broadcast_message",
          channelId,
          direction: "receive",
          channelName: real.name || name,
          ...summarizePayload(ev.data)
        })
      })

      real.addEventListener("messageerror", (ev: MessageEvent) => {
        dispatchPageComm({
          type: "broadcast",
          event: "broadcast_error",
          channelId,
          direction: "error",
          channelName: real.name || name,
          ...summarizePayload(ev.data)
        })
      })

      const originalPostMessage = real.postMessage.bind(real)
      real.postMessage = function (message: unknown): void {
        dispatchPageComm({
          type: "broadcast",
          event: "broadcast_send",
          channelId,
          direction: "send",
          channelName: real.name || name,
          ...summarizePayload(message)
        })
        return originalPostMessage(message)
      }

      const originalClose = real.close.bind(real)
      real.close = function (): void {
        dispatchPageComm({
          type: "broadcast",
          event: "broadcast_close",
          channelId,
          direction: "close",
          channelName: real.name || name
        })
        return originalClose()
      }

      return real
    } as unknown as typeof BroadcastChannel

    try { Object.setPrototypeOf(InterceptorBroadcastChannel, OriginalBroadcastChannel) } catch {}
    InterceptorBroadcastChannel.prototype = OriginalBroadcastChannel.prototype
    ;(window as any).BroadcastChannel = InterceptorBroadcastChannel
  }
	}
