if ((window as any).__slop_net_installed) {
  // already patched — skip
} else {
  (window as any).__slop_net_installed = true

  if ((window as any).trustedTypes?.createPolicy) {
    try {
      (window as any).trustedTypes.createPolicy("slop-net", {
        createHTML: (input: string) => input,
        createScriptURL: (input: string) => input,
        createScript: (input: string) => input,
      })
    } catch {}
  }

  type OverrideRule = { urlPattern: string; queryAddOrReplace?: Record<string, string | number | boolean>; queryRemove?: string[] }
  const overrideRules: OverrideRule[] = (window as any).__slop_override_rules = []

  document.addEventListener("__slop_set_overrides", ((e: CustomEvent) => {
    overrideRules.length = 0
    if (Array.isArray(e.detail)) {
      for (const rule of e.detail) overrideRules.push(rule)
    }
  }) as EventListener)

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

  const originalFetch = window.fetch

  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
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
      try {
        const clone = response.clone()
        clone.text().then((body) => {
          document.dispatchEvent(new CustomEvent("__slop_net", {
            detail: {
              url,
              method,
              status: response.status,
              body,
              type: "fetch",
              timestamp: Date.now()
            }
          }))
        }).catch(() => {})
      } catch {}

      if (reqHeaders) {
        try {
          document.dispatchEvent(new CustomEvent("__slop_headers", {
            detail: { url, method, headers: reqHeaders, type: "fetch", timestamp: Date.now() }
          }))
        } catch {}
      }

      return response
    }).catch((err) => {
      throw err
    })
  }

  const XHR = XMLHttpRequest.prototype

  interface XHRWithSlop extends XMLHttpRequest {
    _slop_url?: string
    _slop_method?: string
    _slop_headers?: Record<string, string>
  }

  const origOpen = XHR.open
  const origSend = XHR.send
  const origSetHeader = XHR.setRequestHeader

  XHR.open = function (this: XHRWithSlop, method: string, url: string | URL, ...rest: any[]): void {
    const rawUrl = url.toString()
    const overriddenUrl = applyOverrides(rawUrl)
    this._slop_url = overriddenUrl
    this._slop_method = method
    this._slop_headers = {}
    if (overriddenUrl !== rawUrl) {
      return origOpen.apply(this, [method, overriddenUrl, ...rest] as any)
    }
    return origOpen.apply(this, arguments as any)
  }

  XHR.setRequestHeader = function (this: XHRWithSlop, header: string, value: string): void {
    if (this._slop_headers) this._slop_headers[header] = value
    return origSetHeader.apply(this, arguments as any)
  }

  XHR.send = function (this: XHRWithSlop, body?: Document | XMLHttpRequestBodyInit | null): void {
    const xhrUrl = this._slop_url
    const xhrMethod = this._slop_method || "GET"
    const xhrHeaders = this._slop_headers

    this.addEventListener("load", function (this: XHRWithSlop) {
      try {
        const responseText = this.responseText
        document.dispatchEvent(new CustomEvent("__slop_net", {
          detail: {
            url: xhrUrl,
            method: xhrMethod,
            status: this.status,
            body: responseText,
            type: "xhr",
            timestamp: Date.now()
          }
        }))
      } catch {}

      if (xhrHeaders && Object.keys(xhrHeaders).length > 0) {
        try {
          document.dispatchEvent(new CustomEvent("__slop_headers", {
            detail: { url: xhrUrl, method: xhrMethod, headers: xhrHeaders, type: "xhr", timestamp: Date.now() }
          }))
        } catch {}
      }
    })

    return origSend.apply(this, arguments as any)
  }
}
