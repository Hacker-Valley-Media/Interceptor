import { K_CANVAS, K_CANVAS_OBSERVER, K_CANVAS_WRAPPED, K_GETCTX_WRAPPED } from "./inject-keys"

if (!(window as any)[K_CANVAS]) {
  ;(window as any)[K_CANVAS] = true

  type CanvasLike = HTMLCanvasElement | OffscreenCanvas
  type CanvasObserverEntry = Record<string, unknown> & { t: number; kind: string; canvasId?: string }
  type CanvasDerivedObject = Record<string, unknown> & { t: number; kind: string; canvasId?: string; source: string; confidence: number }

  const LOG_CAP = 2000
  const OBJECT_CAP = 1000
  const PATH_POINT_CAP = 24
  const canvasIds = new WeakMap<object, string>()
  const pathState = new WeakMap<object, Array<{ kind: string; x: number; y: number }>>()
  let nextCanvasId = 1

  function safeString(value: unknown, max = 200): string | null {
    if (value === null || value === undefined) return null
    try {
      const s = String(value)
      return s.length > max ? s.slice(0, max) : s
    } catch {
      return null
    }
  }

  function getCanvasId(canvas: unknown): string | undefined {
    if (!canvas || (typeof canvas !== "object" && typeof canvas !== "function")) return undefined
    const existing = canvasIds.get(canvas as object)
    if (existing) return existing
    const id = `cv${nextCanvasId++}`
    canvasIds.set(canvas as object, id)
    return id
  }

  function canvasMeta(canvas: unknown): Record<string, unknown> | null {
    if (!canvas || (typeof canvas !== "object" && typeof canvas !== "function")) return null
    const c = canvas as Partial<HTMLCanvasElement> & Partial<OffscreenCanvas>
    const base: Record<string, unknown> = {
      canvasId: getCanvasId(canvas),
      width: typeof c.width === "number" ? c.width : null,
      height: typeof c.height === "number" ? c.height : null
    }
    if ("id" in c) base.id = safeString((c as HTMLCanvasElement).id || "")
    if ("className" in c) base.className = safeString((c as HTMLCanvasElement).className || "")
    if ("tagName" in c) base.tagName = safeString((c as HTMLCanvasElement).tagName || "")
    try {
      if (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) {
        const domIndex = Array.from(document.querySelectorAll("canvas")).indexOf(canvas)
        if (domIndex >= 0) base.domIndex = domIndex
      }
    } catch {}
    return base
  }

  function rectLike(args: unknown[]): Record<string, unknown> | null {
    const nums = args.slice(0, 4).map((v) => typeof v === "number" ? v : Number.NaN)
    if (nums.some((n) => Number.isNaN(n))) return null
    return { x: nums[0], y: nums[1], w: nums[2], h: nums[3] }
  }

  function bboxFromPoints(points: Array<{ x: number; y: number }>): Record<string, unknown> | null {
    if (!points.length) return null
    let minX = points[0].x
    let minY = points[0].y
    let maxX = points[0].x
    let maxY = points[0].y
    for (const point of points) {
      minX = Math.min(minX, point.x)
      minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x)
      maxY = Math.max(maxY, point.y)
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }

  function drawImageRect(args: unknown[]): Record<string, unknown> | null {
    const nums = args.map((v) => typeof v === "number" ? v : Number.NaN)
    if (nums.length >= 9 && nums.slice(5, 9).every((n) => !Number.isNaN(n))) {
      return { x: nums[5], y: nums[6], w: nums[7], h: nums[8] }
    }
    if (nums.length >= 5 && nums.slice(1, 5).every((n) => !Number.isNaN(n))) {
      return { x: nums[1], y: nums[2], w: nums[3], h: nums[4] }
    }
    if (nums.length >= 3 && nums.slice(1, 3).every((n) => !Number.isNaN(n))) {
      return { x: nums[1], y: nums[2], w: null, h: null }
    }
    return null
  }

  function transformLike(ctx: unknown): Record<string, unknown> | null {
    try {
      const m = (ctx as CanvasRenderingContext2D).getTransform?.()
      if (!m) return null
      return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f }
    } catch {
      return null
    }
  }

  function pushBounded<T>(arr: T[], item: T, cap: number): void {
    if (arr.length >= cap) arr.shift()
    arr.push(item)
  }

  function summarizeKinds(entries: Array<{ kind?: string }>): Record<string, number> {
    const out: Record<string, number> = {}
    for (const entry of entries) {
      const kind = safeString(entry.kind || "", 80)
      if (!kind) continue
      out[kind] = (out[kind] || 0) + 1
    }
    return out
  }

  const observer = {
    installedAt: Date.now(),
    version: 1,
    logCap: LOG_CAP,
    objectCap: OBJECT_CAP,
    canvases: [] as Array<Record<string, unknown>>,
    log: [] as CanvasObserverEntry[],
    objects: [] as CanvasDerivedObject[],
    partialCoverageReasons: [] as string[],
    featureSignals: {
      offscreenCanvas: typeof OffscreenCanvas !== "undefined",
      createImageBitmap: typeof createImageBitmap === "function",
      worker: typeof Worker === "function"
    },
    diagnostics() {
      return {
        installed: true,
        canvasCount: this.canvases.length,
        logSize: this.log.length,
        objectCount: this.objects.length,
        kindCounts: summarizeKinds(this.log),
        partialCoverageReasons: [...this.partialCoverageReasons]
      }
    }
  }

  function notePartial(reason: string): void {
    if (!observer.partialCoverageReasons.includes(reason)) observer.partialCoverageReasons.push(reason)
  }

  function registerCanvas(canvas: unknown): string | undefined {
    const meta = canvasMeta(canvas)
    if (!meta) return undefined
    const canvasId = meta.canvasId as string | undefined
    if (!canvasId) return undefined
    const existing = observer.canvases.find((c) => c.canvasId === canvasId)
    if (!existing) observer.canvases.push(meta)
    return canvasId
  }

  function emit(entry: CanvasObserverEntry, derived?: CanvasDerivedObject): void {
    pushBounded(observer.log, entry, LOG_CAP)
    try {
      document.dispatchEvent(new CustomEvent("__interceptor_canvas_log", { detail: entry }))
    } catch {}
    if (derived) {
      pushBounded(observer.objects, derived, OBJECT_CAP)
      try {
        document.dispatchEvent(new CustomEvent("__interceptor_canvas_object", { detail: derived }))
      } catch {}
    }
  }

  function makeDerived(kind: string, canvas: unknown, payload: Record<string, unknown>): CanvasDerivedObject {
    return {
      t: Date.now(),
      kind,
      canvasId: getCanvasId(canvas),
      source: "draw-op",
      confidence:
        kind === "text" ? 0.9 :
        kind === "rect" ? 0.75 :
        kind === "image" ? 0.3 :
        kind === "path" ? 0.25 :
        0.1,
      ...payload
    }
  }

  function patch2DPrototype(proto: CanvasRenderingContext2D | any): void {
    if (!proto || (proto as any)[K_CANVAS_WRAPPED]) return
    ;(proto as any)[K_CANVAS_WRAPPED] = true

    const wrap = (name: string, handler: (ctx: CanvasRenderingContext2D, args: unknown[], out: unknown) => void) => {
      const orig = proto[name]
      if (typeof orig !== "function") return
      proto[name] = function (...args: unknown[]) {
        const out = orig.apply(this, args)
        try { handler(this, args, out) } catch {}
        return out
      }
    }

    wrap("beginPath", (ctx) => {
      registerCanvas((ctx as any).canvas)
      pathState.set(ctx, [])
      emit({
        t: Date.now(),
        kind: "beginPath",
        canvasId: getCanvasId((ctx as any).canvas)
      })
    })

    const pushPathPoint = (ctx: CanvasRenderingContext2D, kind: string, args: unknown[]) => {
      registerCanvas((ctx as any).canvas)
      const x = typeof args[0] === "number" ? args[0] : Number(args[0])
      const y = typeof args[1] === "number" ? args[1] : Number(args[1])
      const points = pathState.get(ctx) || []
      if (points.length < PATH_POINT_CAP && !Number.isNaN(x) && !Number.isNaN(y)) {
        points.push({ kind, x, y })
        pathState.set(ctx, points)
      }
      emit({
        t: Date.now(),
        kind,
        canvasId: getCanvasId((ctx as any).canvas),
        x, y,
        transform: transformLike(ctx)
      })
    }

    wrap("moveTo", (ctx, args) => pushPathPoint(ctx, "moveTo", args))
    wrap("lineTo", (ctx, args) => pushPathPoint(ctx, "lineTo", args))

    wrap("stroke", (ctx) => {
      registerCanvas((ctx as any).canvas)
      const points = pathState.get(ctx) || []
      const bbox = bboxFromPoints(points)
      emit(
        {
          t: Date.now(),
          kind: "stroke",
          canvasId: getCanvasId((ctx as any).canvas),
          pointCount: points.length,
          transform: transformLike(ctx)
        },
        makeDerived("path", (ctx as any).canvas, {
          operation: "stroke",
          pointCount: points.length,
          points,
          bbox
        })
      )
    })

    wrap("fill", (ctx, args) => {
      registerCanvas((ctx as any).canvas)
      const points = pathState.get(ctx) || []
      const bbox = bboxFromPoints(points)
      emit(
        {
          t: Date.now(),
          kind: "fill",
          canvasId: getCanvasId((ctx as any).canvas),
          fillRule: safeString(args[1] || args[0]),
          pointCount: points.length,
          transform: transformLike(ctx)
        },
        makeDerived("path", (ctx as any).canvas, {
          operation: "fill",
          pointCount: points.length,
          points,
          bbox
        })
      )
    })

    wrap("measureText", (ctx, args) => {
      registerCanvas((ctx as any).canvas)
      emit({
        t: Date.now(),
        kind: "measureText",
        canvasId: getCanvasId((ctx as any).canvas),
        text: safeString(args[0]),
        font: safeString((ctx as any).font)
      })
    })

    wrap("fillText", (ctx, args) => {
      registerCanvas((ctx as any).canvas)
      emit(
        {
          t: Date.now(),
          kind: "fillText",
          canvasId: getCanvasId((ctx as any).canvas),
          text: safeString(args[0]),
          x: args[1],
          y: args[2],
          maxWidth: args[3] ?? null,
          font: safeString((ctx as any).font),
          fillStyle: safeString((ctx as any).fillStyle),
          strokeStyle: safeString((ctx as any).strokeStyle),
          textAlign: safeString((ctx as any).textAlign),
          textBaseline: safeString((ctx as any).textBaseline),
          transform: transformLike(ctx)
        },
        makeDerived("text", (ctx as any).canvas, {
          text: safeString(args[0]),
          x: args[1],
          y: args[2],
          font: safeString((ctx as any).font),
          textAlign: safeString((ctx as any).textAlign),
          textBaseline: safeString((ctx as any).textBaseline)
        })
      )
    })

    wrap("strokeText", (ctx, args) => {
      registerCanvas((ctx as any).canvas)
      emit(
        {
          t: Date.now(),
          kind: "strokeText",
          canvasId: getCanvasId((ctx as any).canvas),
          text: safeString(args[0]),
          x: args[1],
          y: args[2],
          maxWidth: args[3] ?? null,
          font: safeString((ctx as any).font),
          transform: transformLike(ctx)
        },
        makeDerived("text", (ctx as any).canvas, {
          operation: "strokeText",
          text: safeString(args[0]),
          x: args[1],
          y: args[2],
          font: safeString((ctx as any).font)
        })
      )
    })

    const wrapRect = (name: string) => wrap(name, (ctx, args) => {
      registerCanvas((ctx as any).canvas)
      emit(
        {
          t: Date.now(),
          kind: name,
          canvasId: getCanvasId((ctx as any).canvas),
          rect: rectLike(args),
          transform: transformLike(ctx)
        },
        makeDerived("rect", (ctx as any).canvas, {
          operation: name,
          rect: rectLike(args)
        })
      )
    })

    wrapRect("fillRect")
    wrapRect("strokeRect")
    wrapRect("clearRect")

    wrap("drawImage", (ctx, args) => {
      registerCanvas((ctx as any).canvas)
      const src = args[0] as any
      const rect = drawImageRect(args)
      notePartial("drawImage")
      emit(
        {
          t: Date.now(),
          kind: "drawImage",
          canvasId: getCanvasId((ctx as any).canvas),
          srcTag: safeString(src?.tagName || Object.prototype.toString.call(src), 80),
          srcClassName: safeString(src?.className || "", 120),
          argCount: args.length,
          rect,
          transform: transformLike(ctx)
        },
        makeDerived("image", (ctx as any).canvas, {
          srcTag: safeString(src?.tagName || Object.prototype.toString.call(src), 80),
          srcClassName: safeString(src?.className || "", 120),
          argCount: args.length,
          rect
        })
      )
    })
  }

  function patchGetContext(Ctor: any, label: string): void {
    if (!Ctor || !Ctor.prototype || (Ctor.prototype as any)[K_GETCTX_WRAPPED]) return
    const orig = Ctor.prototype.getContext
    if (typeof orig !== "function") return
    ;(Ctor.prototype as any)[K_GETCTX_WRAPPED] = true
    Ctor.prototype.getContext = function (type: string, ...rest: unknown[]) {
      const ctx = orig.call(this, type, ...rest)
      const canvasId = registerCanvas(this)
      const entry: CanvasObserverEntry = {
        t: Date.now(),
        kind: "getContext",
        canvasId,
        source: label,
        contextType: safeString(type, 40),
        canvas: canvasMeta(this)
      }
      pushBounded(observer.log, entry, LOG_CAP)
      try {
        document.dispatchEvent(new CustomEvent("__interceptor_canvas_log", { detail: entry }))
      } catch {}

      if (type === "2d" && ctx) patch2DPrototype(Object.getPrototypeOf(ctx))
      if (type === "webgl" || type === "webgl2") notePartial(type)
      if (label === "OffscreenCanvas") notePartial("offscreenCanvas")
      return ctx
    }
  }

  patch2DPrototype((window as any).CanvasRenderingContext2D?.prototype)
  patchGetContext((window as any).HTMLCanvasElement, "HTMLCanvasElement")
  patchGetContext((window as any).OffscreenCanvas, "OffscreenCanvas")

  ;(window as any)[K_CANVAS_OBSERVER] = observer
}
