import { IK_CANVAS_OBSERVER } from "../../inject-keys"
import { sendNetDirect } from "../content-bridge"
import { sendToOffscreen } from "../offscreen"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

type CanvasListEntry = {
  index: number
  width: number
  height: number
  cssWidth: number
  cssHeight: number
  x: number
  y: number
  contextType: string
  hidden: boolean
  id?: string
  className?: string
}

type PassiveCapturedEntry = {
  url: string
  method: string
  status: number
  body?: string
  type: string
  timestamp: number
  tabUrl?: string
  contentType?: string
  truncated?: boolean
}

function normalizeCanvasLogKind(kind: unknown): string {
  return String(kind || "").trim()
}

function summarizeCanvasKinds(entries: Array<{ kind?: string }>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const entry of entries) {
    const kind = normalizeCanvasLogKind(entry.kind)
    if (!kind) continue
    out[kind] = (out[kind] || 0) + 1
  }
  return out
}

async function executeInMainWorld<T>(
  tabId: number,
  func: (...args: any[]) => T,
  args: unknown[] = []
): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: args.map((arg) => arg === undefined ? null : arg),
    func
  })
  return results[0]?.result as T
}

function hostCanvasSignals(limit = 20, obsKey?: string) {
  const canvases = Array.from(document.querySelectorAll("canvas"))
  const max = Number.isFinite(limit) && limit > 0 ? limit : 20
  const safeSlice = <T>(arr: T[]): T[] => arr.slice(0, max)

  function parseLocalStorageJson(key: string): { exists: boolean; rawLength?: number; type?: string; keys?: string[]; preview?: string } {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return { exists: false }
      const parsed = JSON.parse(raw)
      return {
        exists: true,
        rawLength: raw.length,
        type: Array.isArray(parsed) ? "array" : typeof parsed,
        keys: parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, max) : undefined,
        preview: JSON.stringify(parsed).slice(0, 600)
      }
    } catch {
      const raw = localStorage.getItem(key)
      return raw
        ? { exists: true, rawLength: raw.length, type: "raw", preview: raw.slice(0, 600) }
        : { exists: false }
    }
  }

  const docsIframe = document.querySelector<HTMLIFrameElement>(".docs-texteventtarget-iframe")
  let docsTextboxSummary: { exists: boolean; textLength?: number; textSample?: string } = { exists: false }
  try {
    const docsTextbox = docsIframe?.contentDocument?.querySelector<HTMLElement>('[role="textbox"], [contenteditable]')
    if (docsTextbox) {
      const text = (docsTextbox.textContent || "").toString()
      docsTextboxSummary = { exists: true, textLength: text.length, textSample: text.slice(0, 240) }
    }
  } catch {}

  const candidateGlobals = Object.keys(window)
    .filter((k) => /docs|kix|save|revision|model|collab|firebase|socket|scene|app|element|excal/i.test(k))
    .slice(0, max)

  const candidateGlobalDetails = Object.fromEntries(
    candidateGlobals.slice(0, Math.min(max, 15)).map((key) => {
      const value = (window as unknown as Record<string, unknown>)[key]
      return [key, {
        type: typeof value,
        isArray: Array.isArray(value),
        ctor: value && (value as { constructor?: { name?: string } }).constructor?.name || null,
        keys: value && typeof value === "object" ? Object.keys(value as Record<string, unknown>).slice(0, 12) : undefined
      }]
    })
  )

  const observer = (obsKey ? (window as any)[Symbol.for(obsKey)] : null) || null
  const excalidrawScene = parseLocalStorageJson("excalidraw")
  const docsSemanticMirror = !!docsTextboxSummary.exists
  const observerReasons: string[] = Array.isArray(observer?.partialCoverageReasons) ? observer.partialCoverageReasons.slice() : []
  const strategyHint =
    docsSemanticMirror ? "semantic-mirror" :
    excalidrawScene.exists ? "host-model" :
    observerReasons.includes("drawImage") ? "classify-then-ocr" :
    "inspect-canvas"

  return {
    href: location.href,
    host: location.host,
    canvasCount: canvases.length,
    canvases: safeSlice(
      canvases.map((c, i) => ({
        index: i,
        className: c.className || "",
        id: c.id || "",
        width: c.width,
        height: c.height
      }))
    ),
    features: {
      offscreenCanvas: typeof OffscreenCanvas !== "undefined",
      createImageBitmap: typeof createImageBitmap === "function",
      worker: typeof Worker === "function",
      imageBitmapRenderingContext: typeof (window as any).ImageBitmapRenderingContext !== "undefined"
    },
    observer: observer
      ? {
          installed: true,
          canvasCount: Array.isArray(observer.canvases) ? observer.canvases.length : undefined,
          logSize: Array.isArray(observer.log) ? observer.log.length : undefined,
          objectCount: Array.isArray(observer.objects) ? observer.objects.length : undefined,
          kindCounts: summarizeCanvasKinds(Array.isArray(observer.log) ? observer.log : []),
          partialCoverageReasons: observerReasons
        }
      : { installed: false },
    strategyHint,
    strategyReasons: [
      docsSemanticMirror ? "hidden semantic mirror present" : null,
      excalidrawScene.exists ? "host scene model present in localStorage" : null,
      observerReasons.includes("drawImage") ? "drawImage-heavy canvas pipeline" : null,
      observerReasons.includes("offscreenCanvas") ? "offscreen canvas signal present" : null
    ].filter(Boolean),
    docs: {
      textEventIframe: !!docsIframe,
      textbox: docsTextboxSummary,
      pageCount: document.querySelectorAll(".kix-page-paginated").length,
      tileCount: document.querySelectorAll(".kix-canvas-tile-content").length
    },
    excalidraw: {
      globals: candidateGlobals.filter((k) => /excal/i.test(k)).slice(0, max),
      localStorage: {
        scene: excalidrawScene,
        appState: parseLocalStorageJson("excalidraw-state"),
        collab: parseLocalStorageJson("excalidraw-collab")
      }
    },
    globals: candidateGlobalDetails
  }
}

// Native accessibility text for a <canvas>, read in the MAIN world. A canvas's
// accessible text comes from aria-label / aria-labelledby / aria-describedby /
// title and, per the HTML spec, its child DOM (the "fallback content" the
// accessibility tree exposes) plus an enclosing <figure>'s <figcaption>. This
// is the browser-native text source — no pixel OCR, no library.
function canvasAccessibleText(canvasIndex: number) {
  const canvases = Array.from(document.querySelectorAll("canvas"))
  const c = canvases[canvasIndex]
  if (!c) return { found: false, error: "canvas index out of range", canvasCount: canvases.length }

  const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim()
  const byIds = (ids: string | null) =>
    !ids ? "" : ids.split(/\s+/).map((id) => norm(document.getElementById(id)?.textContent)).filter(Boolean).join(" ")

  const sources: Record<string, string> = {}
  const ariaLabel = norm(c.getAttribute("aria-label"))
  if (ariaLabel) sources.ariaLabel = ariaLabel
  const ariaLabelledby = byIds(c.getAttribute("aria-labelledby"))
  if (ariaLabelledby) sources.ariaLabelledby = ariaLabelledby
  // Child DOM of <canvas> is its accessibility fallback subtree.
  const fallback = norm(c.textContent)
  if (fallback) sources.fallback = fallback
  const fig = c.closest("figure")
  const figcaption = fig ? norm(fig.querySelector("figcaption")?.textContent) : ""
  if (figcaption) sources.figcaption = figcaption
  const ariaDescribedby = byIds(c.getAttribute("aria-describedby"))
  if (ariaDescribedby) sources.ariaDescribedby = ariaDescribedby
  const title = norm(c.getAttribute("title"))
  if (title) sources.title = title

  // Priority: explicit name → fallback content → caption → description → title.
  const text = [
    sources.ariaLabel,
    sources.ariaLabelledby,
    sources.fallback,
    sources.figcaption,
    sources.ariaDescribedby,
    sources.title
  ].filter(Boolean).join("\n")

  return {
    found: !!text,
    text,
    role: c.getAttribute("role") || "",
    sources,
    canvasCount: canvases.length
  }
}

function canvasObserverSummary(limit = 100, kinds?: string[], canvasIndex?: number, obsKey?: string) {
  function normalize(kind: unknown): string {
    return String(kind || "").trim()
  }

  function summarize(entries: Array<{ kind?: unknown }>): Record<string, number> {
    const out: Record<string, number> = {}
    for (const entry of entries) {
      const kind = normalize(entry.kind)
      if (!kind) continue
      out[kind] = (out[kind] || 0) + 1
    }
    return out
  }

  function resolveCanvasId(observer: { canvases?: Array<Record<string, unknown>> } | null, canvasIndex?: number): string | null | undefined {
    if (canvasIndex === undefined) return undefined
    const canvases = Array.isArray(observer?.canvases) ? observer.canvases.slice() : []
    const ordered = canvases.sort((a, b) => {
      const left = typeof a.domIndex === "number" ? a.domIndex : Number.MAX_SAFE_INTEGER
      const right = typeof b.domIndex === "number" ? b.domIndex : Number.MAX_SAFE_INTEGER
      if (left !== right) return left - right
      return String(a.canvasId || "").localeCompare(String(b.canvasId || ""))
    })
    const canvasId = ordered[canvasIndex]?.canvasId
    return typeof canvasId === "string" && canvasId ? canvasId : null
  }

  const observer = (obsKey ? (window as any)[Symbol.for(obsKey)] : null) || null
  if (!observer || !Array.isArray(observer.log)) {
    return {
      installed: false,
      entries: [],
      total: 0,
      kindCounts: {},
      diagnostics: { reason: "observer not installed" }
    }
  }
  const kindFilter = (kinds || []).map(normalize).filter(Boolean)
  const canvasId = resolveCanvasId(observer, canvasIndex)
  let entries = observer.log.slice()
  if (canvasId === null) entries = []
  else if (canvasId) entries = entries.filter((entry: { canvasId?: string }) => String(entry.canvasId || "") === canvasId)
  if (kindFilter.length > 0) {
    entries = entries.filter((entry: { kind?: string }) => kindFilter.includes(normalize(entry.kind)))
  }
  const bounded = entries.slice(-Math.max(1, limit))
  return {
    installed: true,
    total: entries.length,
    kindCounts: summarize(entries),
    entries: bounded
  }
}

function canvasObserverObjectsSummary(limit = 100, kind?: string, canvasIndex?: number, obsKey?: string) {
  function normalize(value: unknown): string {
    return String(value || "").trim()
  }

  function resolveCanvasId(observer: { canvases?: Array<Record<string, unknown>> } | null, canvasIndex?: number): string | null | undefined {
    if (canvasIndex === undefined) return undefined
    const canvases = Array.isArray(observer?.canvases) ? observer.canvases.slice() : []
    const ordered = canvases.sort((a, b) => {
      const left = typeof a.domIndex === "number" ? a.domIndex : Number.MAX_SAFE_INTEGER
      const right = typeof b.domIndex === "number" ? b.domIndex : Number.MAX_SAFE_INTEGER
      if (left !== right) return left - right
      return String(a.canvasId || "").localeCompare(String(b.canvasId || ""))
    })
    const canvasId = ordered[canvasIndex]?.canvasId
    return typeof canvasId === "string" && canvasId ? canvasId : null
  }

  const observer = (obsKey ? (window as any)[Symbol.for(obsKey)] : null) || null
  if (!observer || !Array.isArray(observer.objects)) {
    return {
      installed: false,
      objects: [],
      total: 0,
      diagnostics: { reason: "observer not installed" }
    }
  }
  const kindFilter = normalize(kind)
  const canvasId = resolveCanvasId(observer, canvasIndex)
  let objects = observer.objects.slice()
  if (canvasId === null) objects = []
  else if (canvasId) objects = objects.filter((entry: { canvasId?: string }) => String(entry.canvasId || "") === canvasId)
  if (kindFilter) {
    objects = objects.filter((entry: { kind?: string }) => normalize(entry.kind) === kindFilter)
  }
  return {
    installed: true,
    total: objects.length,
    objects: objects.slice(-Math.max(1, limit))
  }
}

function walkCanvasElements(): CanvasListEntry[] {
  const canvases = Array.from(document.querySelectorAll("canvas"))
  function walkShadowRoots(root: Element | ShadowRoot): HTMLCanvasElement[] {
    const found: HTMLCanvasElement[] = []
    const children = Array.from(root.children)
    for (const child of children) {
      if (child.tagName === "CANVAS") found.push(child as HTMLCanvasElement)
      const shadow = (child as any).shadowRoot
      if (shadow) found.push(...walkShadowRoots(shadow))
      found.push(...walkShadowRoots(child))
    }
    return found
  }
  const shadowCanvases = document.body ? walkShadowRoots(document.body) : []
  const all = [...new Set([...canvases, ...shadowCanvases])]
  return all.map((c, i) => {
    const rect = c.getBoundingClientRect()
    let contextType = "none"
    try {
      if (c.getContext("2d")) contextType = "2d"
      else if (c.getContext("webgl2")) contextType = "webgl2"
      else if (c.getContext("webgl")) contextType = "webgl"
      else if (c.getContext("bitmaprenderer")) contextType = "bitmaprenderer"
    } catch {}
    const style = getComputedStyle(c)
    const hidden = style.display === "none" || style.visibility === "hidden" || (c.width === 0 && c.height === 0)
    return {
      index: i,
      width: c.width,
      height: c.height,
      cssWidth: rect.width,
      cssHeight: rect.height,
      x: rect.x,
      y: rect.y,
      contextType,
      hidden,
      id: c.id || undefined,
      className: c.className || undefined
    }
  })
}

export function inferRouteCandidates(entries: PassiveCapturedEntry[], filter?: string, limit = 20) {
  const normalizedFilter = (filter || "").toLowerCase()
  const candidates = new Map<string, {
    route: string
    methods: Set<string>
    statuses: Set<number>
    count: number
    lastSeen: number
    contentTypes: Set<string>
    reasons: Set<string>
    sampleUrl: string
  }>()

  for (const entry of entries) {
    if (!entry.url) continue
    const sampleUrl = entry.url
    const absoluteUrl = entry.url.startsWith("http")
      ? entry.url
      : (() => {
          try {
            return new URL(entry.url, entry.tabUrl || "https://example.invalid").toString()
          } catch {
            return entry.url
          }
        })()

    let route = absoluteUrl
    try {
      const url = new URL(absoluteUrl, entry.tabUrl || undefined)
      route = `${url.origin}${url.pathname}`
    } catch {}

    if (normalizedFilter && !route.toLowerCase().includes(normalizedFilter) && !sampleUrl.toLowerCase().includes(normalizedFilter)) {
      continue
    }

    const candidate = candidates.get(route) || {
      route,
      methods: new Set<string>(),
      statuses: new Set<number>(),
      count: 0,
      lastSeen: 0,
      contentTypes: new Set<string>(),
      reasons: new Set<string>(),
      sampleUrl
    }

    candidate.methods.add(entry.method || "GET")
    candidate.statuses.add(entry.status || 0)
    candidate.count += 1
    candidate.lastSeen = Math.max(candidate.lastSeen, entry.timestamp || 0)
    if (entry.contentType) candidate.contentTypes.add(entry.contentType)
    if (/\/save\b|[?&]save=|\/update\b|\/revision\b|\/sync\b|\/delta\b/i.test(entry.url)) candidate.reasons.add("mutation-like-route")
    if ((entry.method || "").toUpperCase() !== "GET") candidate.reasons.add("non-get")
    if ((entry.contentType || "").toLowerCase().includes("json")) candidate.reasons.add("json-response")
    if (entry.body && /revision|ack|delta|operation|clientModel/i.test(entry.body)) candidate.reasons.add("state-bearing-body")
    candidates.set(route, candidate)
  }

  return [...candidates.values()]
    .map((candidate) => ({
      route: candidate.route,
      sampleUrl: candidate.sampleUrl,
      methods: [...candidate.methods].sort(),
      statuses: [...candidate.statuses].sort((a, b) => a - b),
      contentTypes: [...candidate.contentTypes].sort(),
      count: candidate.count,
      lastSeen: candidate.lastSeen,
      reasons: [...candidate.reasons].sort(),
      score:
        candidate.count +
        candidate.reasons.size * 2 +
        (candidate.methods.has("POST") ? 3 : 0) +
        ([...candidate.contentTypes].some((ct) => ct.toLowerCase().includes("json")) ? 2 : 0)
    }))
    .sort((a, b) => b.score - a.score || b.count - a.count || b.lastSeen - a.lastSeen)
    .slice(0, Math.max(1, limit))
}

export async function handleCanvasActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "canvas_list": {
      const data = await executeInMainWorld<CanvasListEntry[]>(tabId, walkCanvasElements)
      return { success: true, data: data || [] }
    }

    case "canvas_status": {
      const list = await executeInMainWorld<CanvasListEntry[]>(tabId, walkCanvasElements)
      const host = await executeInMainWorld<ReturnType<typeof hostCanvasSignals>>(tabId, hostCanvasSignals, [action.limit as number | undefined, IK_CANVAS_OBSERVER])
      return {
        success: true,
        data: {
          canvases: list || [],
          host
        }
      }
    }

    case "canvas_model": {
      const data = await executeInMainWorld<ReturnType<typeof hostCanvasSignals>>(tabId, hostCanvasSignals, [action.limit as number | undefined])
      return { success: true, data }
    }

    case "canvas_log": {
      const data = await executeInMainWorld<ReturnType<typeof canvasObserverSummary>>(
        tabId,
        canvasObserverSummary,
        [action.limit as number | undefined, action.kinds as string[] | undefined, action.canvasIndex as number | undefined, IK_CANVAS_OBSERVER]
      )
      return { success: true, data }
    }

    case "canvas_objects": {
      const data = await executeInMainWorld<ReturnType<typeof canvasObserverObjectsSummary>>(
        tabId,
        canvasObserverObjectsSummary,
        [action.limit as number | undefined, action.kind as string | undefined, action.canvasIndex as number | undefined, IK_CANVAS_OBSERVER]
      )
      return { success: true, data }
    }

    case "canvas_routes": {
      const result = await sendNetDirect(tabId, {
        type: "get_net_log"
      }) as { success: boolean; data?: PassiveCapturedEntry[]; error?: string }
      if (!result.success) {
        return { success: false, error: result.error || "failed to read passive net log" }
      }
      const entries = (result.data || []).slice()
      const data = inferRouteCandidates(entries, action.filter as string | undefined, action.limit as number | undefined)
      return {
        success: true,
        data: {
          totalEntries: entries.length,
          candidates: data
        }
      }
    }

    case "canvas_ocr": {
      // Native text only — no pixel OCR. Read the canvas's accessibility text
      // (aria-* + fallback subtree) plus the page's own semantic textbox model.
      // For a canvas-rendered editor prefer `scene text`; for genuine pixel-only
      // text use `macos vision text` (native macOS Vision OCR).
      const a11y = await executeInMainWorld<ReturnType<typeof canvasAccessibleText>>(
        tabId, canvasAccessibleText, [action.canvasIndex]
      )
      if (a11y && (a11y as { error?: string }).error) {
        return { success: false, error: (a11y as { error?: string }).error }
      }
      const hostSignals = await executeInMainWorld<ReturnType<typeof hostCanvasSignals>>(tabId, hostCanvasSignals, [10])
      const semanticText = hostSignals?.docs?.textbox?.exists ? (hostSignals.docs.textbox.textSample || "") : ""
      const a11yText = a11y && (a11y as { found?: boolean }).found ? ((a11y as { text?: string }).text || "") : ""

      let text = a11yText || semanticText
      let source = a11yText ? "accessibility" : (semanticText ? "semantic-textbox" : "none")
      let confidence: number | null = null
      let ocrFallbackUsed = false

      // No native text → OCR the canvas pixels with the bundled Tesseract engine
      // (offline, cross-platform — works on browser-only / non-macOS installs).
      if (!text) {
        const readResult = await handleCanvasActions({
          type: "canvas_read", canvasIndex: action.canvasIndex, region: action.region, format: "png"
        }, tabId)
        const dataUrl = readResult.success ? (readResult.data as { dataUrl?: string }).dataUrl : undefined
        if (dataUrl) {
          const ocr = await sendToOffscreen({ type: "ocr", dataUrl }) as { success: boolean; data?: { text?: string; confidence?: number | null }; error?: string }
          if (ocr.success && (ocr.data?.text || "").trim()) {
            text = (ocr.data!.text as string).trim()
            source = "tesseract"
            confidence = ocr.data?.confidence ?? null
            ocrFallbackUsed = true
          }
        }
      }

      return {
        success: true,
        data: {
          text,
          source,
          confidence,
          diagnostics: {
            accessibilityText: !!a11yText,
            accessibilitySources: (a11y as { sources?: unknown })?.sources || null,
            semanticTextboxAvailable: !!semanticText,
            ocrFallbackUsed,
            hint: text
              ? undefined
              : "No accessible/semantic text and pixel OCR found nothing. For a canvas-rendered editor use `interceptor scene text`."
          }
        }
      }
    }

    case "canvas_read": {
      const canvasIdx = action.canvasIndex as number
      const fmt = (action.format as string) === "png" ? "image/png" : "image/jpeg"
      const qual = (action.quality as number) || 0.5
      const region = action.region as { x: number; y: number; width: number; height: number } | undefined
      const isWebgl = action.webgl as boolean | undefined

      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [canvasIdx, fmt, qual, region ?? null, isWebgl ?? false],
        func: (idx: number, format: string, quality: number, reg: { x: number; y: number; width: number; height: number } | null, webgl: boolean) => {
          const canvases = Array.from(document.querySelectorAll("canvas"))
          const c = canvases[idx]
          if (!c) return { success: false, error: `no canvas at index ${idx}` }
          try {
            if (reg) {
              const ctx = c.getContext("2d")
              if (!ctx) return { success: false, error: "canvas has no 2d context for region read" }
              const data = ctx.getImageData(reg.x, reg.y, reg.width, reg.height)
              const tmpCanvas = document.createElement("canvas")
              tmpCanvas.width = reg.width
              tmpCanvas.height = reg.height
              const tmpCtx = tmpCanvas.getContext("2d")!
              tmpCtx.putImageData(data, 0, 0)
              return { success: true, data: tmpCanvas.toDataURL(format, quality) }
            }
            if (webgl) {
              const gl = c.getContext("webgl2") || c.getContext("webgl")
              if (!gl) return { success: false, error: "canvas has no webgl context" }
              const pixels = new Uint8Array(c.width * c.height * 4)
              gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
              const tmpCanvas = document.createElement("canvas")
              tmpCanvas.width = c.width
              tmpCanvas.height = c.height
              const tmpCtx = tmpCanvas.getContext("2d")!
              const imageData = tmpCtx.createImageData(c.width, c.height)
              for (let row = 0; row < c.height; row++) {
                const srcOff = row * c.width * 4
                const dstOff = (c.height - 1 - row) * c.width * 4
                imageData.data.set(pixels.subarray(srcOff, srcOff + c.width * 4), dstOff)
              }
              tmpCtx.putImageData(imageData, 0, 0)
              return { success: true, data: tmpCanvas.toDataURL(format, quality) }
            }
            return { success: true, data: c.toDataURL(format, quality) }
          } catch (e: any) {
            if (e.message?.includes("tainted")) return { success: false, error: "canvas is tainted (cross-origin content)" }
            return { success: false, error: e.message }
          }
        }
      })
      const res = results[0]?.result as { success: boolean; error?: string; data?: string } | undefined
      if (!res) return { success: false, error: "no result from canvas read" }
      if (!res.success) return { success: false, error: res.error }
      const dataUrl = res.data!
      const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75)
      if (sizeBytes > 800 * 1024) {
        return { success: true, data: { dataUrl, size: sizeBytes, warning: "Response exceeds 800KB — consider JPEG or smaller region" } }
      }
      return { success: true, data: { dataUrl, size: sizeBytes } }
    }
  }

  return { success: false, error: `unknown canvas action: ${action.type}` }
}
