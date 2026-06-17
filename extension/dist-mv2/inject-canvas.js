// extension/src/inject-canvas.ts
if (!window.__interceptor_canvas_installed) {
  let safeString2 = function(value, max = 200) {
    if (value === null || value === undefined)
      return null;
    try {
      const s = String(value);
      return s.length > max ? s.slice(0, max) : s;
    } catch {
      return null;
    }
  }, getCanvasId2 = function(canvas) {
    if (!canvas || typeof canvas !== "object" && typeof canvas !== "function")
      return;
    const existing = canvasIds.get(canvas);
    if (existing)
      return existing;
    const id = `cv${nextCanvasId++}`;
    canvasIds.set(canvas, id);
    return id;
  }, canvasMeta2 = function(canvas) {
    if (!canvas || typeof canvas !== "object" && typeof canvas !== "function")
      return null;
    const c = canvas;
    const base = {
      canvasId: getCanvasId2(canvas),
      width: typeof c.width === "number" ? c.width : null,
      height: typeof c.height === "number" ? c.height : null
    };
    if ("id" in c)
      base.id = safeString2(c.id || "");
    if ("className" in c)
      base.className = safeString2(c.className || "");
    if ("tagName" in c)
      base.tagName = safeString2(c.tagName || "");
    try {
      if (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) {
        const domIndex = Array.from(document.querySelectorAll("canvas")).indexOf(canvas);
        if (domIndex >= 0)
          base.domIndex = domIndex;
      }
    } catch {}
    return base;
  }, rectLike2 = function(args) {
    const nums = args.slice(0, 4).map((v) => typeof v === "number" ? v : Number.NaN);
    if (nums.some((n) => Number.isNaN(n)))
      return null;
    return { x: nums[0], y: nums[1], w: nums[2], h: nums[3] };
  }, bboxFromPoints2 = function(points) {
    if (!points.length)
      return null;
    let minX = points[0].x;
    let minY = points[0].y;
    let maxX = points[0].x;
    let maxY = points[0].y;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }, drawImageRect2 = function(args) {
    const nums = args.map((v) => typeof v === "number" ? v : Number.NaN);
    if (nums.length >= 9 && nums.slice(5, 9).every((n) => !Number.isNaN(n))) {
      return { x: nums[5], y: nums[6], w: nums[7], h: nums[8] };
    }
    if (nums.length >= 5 && nums.slice(1, 5).every((n) => !Number.isNaN(n))) {
      return { x: nums[1], y: nums[2], w: nums[3], h: nums[4] };
    }
    if (nums.length >= 3 && nums.slice(1, 3).every((n) => !Number.isNaN(n))) {
      return { x: nums[1], y: nums[2], w: null, h: null };
    }
    return null;
  }, transformLike2 = function(ctx) {
    try {
      const m = ctx.getTransform?.();
      if (!m)
        return null;
      return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
    } catch {
      return null;
    }
  }, pushBounded2 = function(arr, item, cap) {
    if (arr.length >= cap)
      arr.shift();
    arr.push(item);
  }, summarizeKinds2 = function(entries) {
    const out = {};
    for (const entry of entries) {
      const kind = safeString2(entry.kind || "", 80);
      if (!kind)
        continue;
      out[kind] = (out[kind] || 0) + 1;
    }
    return out;
  }, notePartial2 = function(reason) {
    if (!observer.partialCoverageReasons.includes(reason))
      observer.partialCoverageReasons.push(reason);
  }, registerCanvas2 = function(canvas) {
    const meta = canvasMeta2(canvas);
    if (!meta)
      return;
    const canvasId = meta.canvasId;
    if (!canvasId)
      return;
    const existing = observer.canvases.find((c) => c.canvasId === canvasId);
    if (!existing)
      observer.canvases.push(meta);
    return canvasId;
  }, emit2 = function(entry, derived) {
    pushBounded2(observer.log, entry, LOG_CAP);
    try {
      document.dispatchEvent(new CustomEvent("__interceptor_canvas_log", { detail: entry }));
    } catch {}
    if (derived) {
      pushBounded2(observer.objects, derived, OBJECT_CAP);
      try {
        document.dispatchEvent(new CustomEvent("__interceptor_canvas_object", { detail: derived }));
      } catch {}
    }
  }, makeDerived2 = function(kind, canvas, payload) {
    return {
      t: Date.now(),
      kind,
      canvasId: getCanvasId2(canvas),
      source: "draw-op",
      confidence: kind === "text" ? 0.9 : kind === "rect" ? 0.75 : kind === "image" ? 0.3 : kind === "path" ? 0.25 : 0.1,
      ...payload
    };
  }, patch2DPrototype2 = function(proto) {
    if (!proto || proto.__interceptor_canvas_wrapped)
      return;
    proto.__interceptor_canvas_wrapped = true;
    const wrap = (name, handler) => {
      const orig = proto[name];
      if (typeof orig !== "function")
        return;
      proto[name] = function(...args) {
        const out = orig.apply(this, args);
        try {
          handler(this, args, out);
        } catch {}
        return out;
      };
    };
    wrap("beginPath", (ctx) => {
      registerCanvas2(ctx.canvas);
      pathState.set(ctx, []);
      emit2({
        t: Date.now(),
        kind: "beginPath",
        canvasId: getCanvasId2(ctx.canvas)
      });
    });
    const pushPathPoint = (ctx, kind, args) => {
      registerCanvas2(ctx.canvas);
      const x = typeof args[0] === "number" ? args[0] : Number(args[0]);
      const y = typeof args[1] === "number" ? args[1] : Number(args[1]);
      const points = pathState.get(ctx) || [];
      if (points.length < PATH_POINT_CAP && !Number.isNaN(x) && !Number.isNaN(y)) {
        points.push({ kind, x, y });
        pathState.set(ctx, points);
      }
      emit2({
        t: Date.now(),
        kind,
        canvasId: getCanvasId2(ctx.canvas),
        x,
        y,
        transform: transformLike2(ctx)
      });
    };
    wrap("moveTo", (ctx, args) => pushPathPoint(ctx, "moveTo", args));
    wrap("lineTo", (ctx, args) => pushPathPoint(ctx, "lineTo", args));
    wrap("stroke", (ctx) => {
      registerCanvas2(ctx.canvas);
      const points = pathState.get(ctx) || [];
      const bbox = bboxFromPoints2(points);
      emit2({
        t: Date.now(),
        kind: "stroke",
        canvasId: getCanvasId2(ctx.canvas),
        pointCount: points.length,
        transform: transformLike2(ctx)
      }, makeDerived2("path", ctx.canvas, {
        operation: "stroke",
        pointCount: points.length,
        points,
        bbox
      }));
    });
    wrap("fill", (ctx, args) => {
      registerCanvas2(ctx.canvas);
      const points = pathState.get(ctx) || [];
      const bbox = bboxFromPoints2(points);
      emit2({
        t: Date.now(),
        kind: "fill",
        canvasId: getCanvasId2(ctx.canvas),
        fillRule: safeString2(args[1] || args[0]),
        pointCount: points.length,
        transform: transformLike2(ctx)
      }, makeDerived2("path", ctx.canvas, {
        operation: "fill",
        pointCount: points.length,
        points,
        bbox
      }));
    });
    wrap("measureText", (ctx, args) => {
      registerCanvas2(ctx.canvas);
      emit2({
        t: Date.now(),
        kind: "measureText",
        canvasId: getCanvasId2(ctx.canvas),
        text: safeString2(args[0]),
        font: safeString2(ctx.font)
      });
    });
    wrap("fillText", (ctx, args) => {
      registerCanvas2(ctx.canvas);
      emit2({
        t: Date.now(),
        kind: "fillText",
        canvasId: getCanvasId2(ctx.canvas),
        text: safeString2(args[0]),
        x: args[1],
        y: args[2],
        maxWidth: args[3] ?? null,
        font: safeString2(ctx.font),
        fillStyle: safeString2(ctx.fillStyle),
        strokeStyle: safeString2(ctx.strokeStyle),
        textAlign: safeString2(ctx.textAlign),
        textBaseline: safeString2(ctx.textBaseline),
        transform: transformLike2(ctx)
      }, makeDerived2("text", ctx.canvas, {
        text: safeString2(args[0]),
        x: args[1],
        y: args[2],
        font: safeString2(ctx.font),
        textAlign: safeString2(ctx.textAlign),
        textBaseline: safeString2(ctx.textBaseline)
      }));
    });
    wrap("strokeText", (ctx, args) => {
      registerCanvas2(ctx.canvas);
      emit2({
        t: Date.now(),
        kind: "strokeText",
        canvasId: getCanvasId2(ctx.canvas),
        text: safeString2(args[0]),
        x: args[1],
        y: args[2],
        maxWidth: args[3] ?? null,
        font: safeString2(ctx.font),
        transform: transformLike2(ctx)
      }, makeDerived2("text", ctx.canvas, {
        operation: "strokeText",
        text: safeString2(args[0]),
        x: args[1],
        y: args[2],
        font: safeString2(ctx.font)
      }));
    });
    const wrapRect = (name) => wrap(name, (ctx, args) => {
      registerCanvas2(ctx.canvas);
      emit2({
        t: Date.now(),
        kind: name,
        canvasId: getCanvasId2(ctx.canvas),
        rect: rectLike2(args),
        transform: transformLike2(ctx)
      }, makeDerived2("rect", ctx.canvas, {
        operation: name,
        rect: rectLike2(args)
      }));
    });
    wrapRect("fillRect");
    wrapRect("strokeRect");
    wrapRect("clearRect");
    wrap("drawImage", (ctx, args) => {
      registerCanvas2(ctx.canvas);
      const src = args[0];
      const rect = drawImageRect2(args);
      notePartial2("drawImage");
      emit2({
        t: Date.now(),
        kind: "drawImage",
        canvasId: getCanvasId2(ctx.canvas),
        srcTag: safeString2(src?.tagName || Object.prototype.toString.call(src), 80),
        srcClassName: safeString2(src?.className || "", 120),
        argCount: args.length,
        rect,
        transform: transformLike2(ctx)
      }, makeDerived2("image", ctx.canvas, {
        srcTag: safeString2(src?.tagName || Object.prototype.toString.call(src), 80),
        srcClassName: safeString2(src?.className || "", 120),
        argCount: args.length,
        rect
      }));
    });
  }, patchGetContext2 = function(Ctor, label) {
    if (!Ctor || !Ctor.prototype || Ctor.prototype.__interceptor_canvas_get_context_wrapped)
      return;
    const orig = Ctor.prototype.getContext;
    if (typeof orig !== "function")
      return;
    Ctor.prototype.__interceptor_canvas_get_context_wrapped = true;
    Ctor.prototype.getContext = function(type, ...rest) {
      const ctx = orig.call(this, type, ...rest);
      const canvasId = registerCanvas2(this);
      const entry = {
        t: Date.now(),
        kind: "getContext",
        canvasId,
        source: label,
        contextType: safeString2(type, 40),
        canvas: canvasMeta2(this)
      };
      pushBounded2(observer.log, entry, LOG_CAP);
      try {
        document.dispatchEvent(new CustomEvent("__interceptor_canvas_log", { detail: entry }));
      } catch {}
      if (type === "2d" && ctx)
        patch2DPrototype2(Object.getPrototypeOf(ctx));
      if (type === "webgl" || type === "webgl2")
        notePartial2(type);
      if (label === "OffscreenCanvas")
        notePartial2("offscreenCanvas");
      return ctx;
    };
  };
  safeString = safeString2, getCanvasId = getCanvasId2, canvasMeta = canvasMeta2, rectLike = rectLike2, bboxFromPoints = bboxFromPoints2, drawImageRect = drawImageRect2, transformLike = transformLike2, pushBounded = pushBounded2, summarizeKinds = summarizeKinds2, notePartial = notePartial2, registerCanvas = registerCanvas2, emit = emit2, makeDerived = makeDerived2, patch2DPrototype = patch2DPrototype2, patchGetContext = patchGetContext2;
  window.__interceptor_canvas_installed = true;
  const LOG_CAP = 2000;
  const OBJECT_CAP = 1000;
  const PATH_POINT_CAP = 24;
  const canvasIds = new WeakMap;
  const pathState = new WeakMap;
  let nextCanvasId = 1;
  const observer = {
    installedAt: Date.now(),
    version: 1,
    logCap: LOG_CAP,
    objectCap: OBJECT_CAP,
    canvases: [],
    log: [],
    objects: [],
    partialCoverageReasons: [],
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
        kindCounts: summarizeKinds2(this.log),
        partialCoverageReasons: [...this.partialCoverageReasons]
      };
    }
  };
  patch2DPrototype2(window.CanvasRenderingContext2D?.prototype);
  patchGetContext2(window.HTMLCanvasElement, "HTMLCanvasElement");
  patchGetContext2(window.OffscreenCanvas, "OffscreenCanvas");
  window.__interceptorCanvasObserver = observer;
}
var safeString;
var getCanvasId;
var canvasMeta;
var rectLike;
var bboxFromPoints;
var drawImageRect;
var transformLike;
var pushBounded;
var summarizeKinds;
var notePartial;
var registerCanvas;
var emit;
var makeDerived;
var patch2DPrototype;
var patchGetContext;
