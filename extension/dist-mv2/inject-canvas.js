// extension/src/inject-keys.ts
var IK_NET = "z9n0";
var IK_CANVAS = "z9c0";
var IK_WS = "z9w0";
var IK_BROADCAST = "z9b0";
var IK_BEACON = "z9k0";
var IK_TT_POLICY = "z9t0";
var IK_CANVAS_OBSERVER = "z9o0";
var IK_CANVAS_WRAPPED = "z9r0";
var IK_GETCTX_WRAPPED = "z9r1";
var K_NET = Symbol.for(IK_NET);
var K_CANVAS = Symbol.for(IK_CANVAS);
var K_WS = Symbol.for(IK_WS);
var K_BROADCAST = Symbol.for(IK_BROADCAST);
var K_BEACON = Symbol.for(IK_BEACON);
var K_TT_POLICY = Symbol.for(IK_TT_POLICY);
var K_CANVAS_OBSERVER = Symbol.for(IK_CANVAS_OBSERVER);
var K_CANVAS_WRAPPED = Symbol.for(IK_CANVAS_WRAPPED);
var K_GETCTX_WRAPPED = Symbol.for(IK_GETCTX_WRAPPED);

// extension/src/inject-canvas.ts
if (!window[K_CANVAS]) {
  let safeString = function(value, max = 200) {
    if (value === null || value === undefined)
      return null;
    try {
      const s = String(value);
      return s.length > max ? s.slice(0, max) : s;
    } catch {
      return null;
    }
  }, getCanvasId = function(canvas) {
    if (!canvas || typeof canvas !== "object" && typeof canvas !== "function")
      return;
    const existing = canvasIds.get(canvas);
    if (existing)
      return existing;
    const id = `cv${nextCanvasId++}`;
    canvasIds.set(canvas, id);
    return id;
  }, canvasMeta = function(canvas) {
    if (!canvas || typeof canvas !== "object" && typeof canvas !== "function")
      return null;
    const c = canvas;
    const base = {
      canvasId: getCanvasId(canvas),
      width: typeof c.width === "number" ? c.width : null,
      height: typeof c.height === "number" ? c.height : null
    };
    if ("id" in c)
      base.id = safeString(c.id || "");
    if ("className" in c)
      base.className = safeString(c.className || "");
    if ("tagName" in c)
      base.tagName = safeString(c.tagName || "");
    try {
      if (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) {
        const domIndex = Array.from(document.querySelectorAll("canvas")).indexOf(canvas);
        if (domIndex >= 0)
          base.domIndex = domIndex;
      }
    } catch {}
    return base;
  }, rectLike = function(args) {
    const nums = args.slice(0, 4).map((v) => typeof v === "number" ? v : Number.NaN);
    if (nums.some((n) => Number.isNaN(n)))
      return null;
    return { x: nums[0], y: nums[1], w: nums[2], h: nums[3] };
  }, bboxFromPoints = function(points) {
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
  }, drawImageRect = function(args) {
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
  }, transformLike = function(ctx) {
    try {
      const m = ctx.getTransform?.();
      if (!m)
        return null;
      return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
    } catch {
      return null;
    }
  }, pushBounded = function(arr, item, cap) {
    if (arr.length >= cap)
      arr.shift();
    arr.push(item);
  }, summarizeKinds = function(entries) {
    const out = {};
    for (const entry of entries) {
      const kind = safeString(entry.kind || "", 80);
      if (!kind)
        continue;
      out[kind] = (out[kind] || 0) + 1;
    }
    return out;
  }, notePartial = function(reason) {
    if (!observer.partialCoverageReasons.includes(reason))
      observer.partialCoverageReasons.push(reason);
  }, registerCanvas = function(canvas) {
    const meta = canvasMeta(canvas);
    if (!meta)
      return;
    const canvasId = meta.canvasId;
    if (!canvasId)
      return;
    const existing = observer.canvases.find((c) => c.canvasId === canvasId);
    if (!existing)
      observer.canvases.push(meta);
    return canvasId;
  }, emit = function(entry, derived) {
    pushBounded(observer.log, entry, LOG_CAP);
    try {
      document.dispatchEvent(new CustomEvent("__interceptor_canvas_log", { detail: entry }));
    } catch {}
    if (derived) {
      pushBounded(observer.objects, derived, OBJECT_CAP);
      try {
        document.dispatchEvent(new CustomEvent("__interceptor_canvas_object", { detail: derived }));
      } catch {}
    }
  }, makeDerived = function(kind, canvas, payload) {
    return {
      t: Date.now(),
      kind,
      canvasId: getCanvasId(canvas),
      source: "draw-op",
      confidence: kind === "text" ? 0.9 : kind === "rect" ? 0.75 : kind === "image" ? 0.3 : kind === "path" ? 0.25 : 0.1,
      ...payload
    };
  }, patch2DPrototype = function(proto) {
    if (!proto || proto[K_CANVAS_WRAPPED])
      return;
    proto[K_CANVAS_WRAPPED] = true;
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
      registerCanvas(ctx.canvas);
      pathState.set(ctx, []);
      emit({
        t: Date.now(),
        kind: "beginPath",
        canvasId: getCanvasId(ctx.canvas)
      });
    });
    const pushPathPoint = (ctx, kind, args) => {
      registerCanvas(ctx.canvas);
      const x = typeof args[0] === "number" ? args[0] : Number(args[0]);
      const y = typeof args[1] === "number" ? args[1] : Number(args[1]);
      const points = pathState.get(ctx) || [];
      if (points.length < PATH_POINT_CAP && !Number.isNaN(x) && !Number.isNaN(y)) {
        points.push({ kind, x, y });
        pathState.set(ctx, points);
      }
      emit({
        t: Date.now(),
        kind,
        canvasId: getCanvasId(ctx.canvas),
        x,
        y,
        transform: transformLike(ctx)
      });
    };
    wrap("moveTo", (ctx, args) => pushPathPoint(ctx, "moveTo", args));
    wrap("lineTo", (ctx, args) => pushPathPoint(ctx, "lineTo", args));
    wrap("stroke", (ctx) => {
      registerCanvas(ctx.canvas);
      const points = pathState.get(ctx) || [];
      const bbox = bboxFromPoints(points);
      emit({
        t: Date.now(),
        kind: "stroke",
        canvasId: getCanvasId(ctx.canvas),
        pointCount: points.length,
        transform: transformLike(ctx)
      }, makeDerived("path", ctx.canvas, {
        operation: "stroke",
        pointCount: points.length,
        points,
        bbox
      }));
    });
    wrap("fill", (ctx, args) => {
      registerCanvas(ctx.canvas);
      const points = pathState.get(ctx) || [];
      const bbox = bboxFromPoints(points);
      emit({
        t: Date.now(),
        kind: "fill",
        canvasId: getCanvasId(ctx.canvas),
        fillRule: safeString(args[1] || args[0]),
        pointCount: points.length,
        transform: transformLike(ctx)
      }, makeDerived("path", ctx.canvas, {
        operation: "fill",
        pointCount: points.length,
        points,
        bbox
      }));
    });
    wrap("measureText", (ctx, args) => {
      registerCanvas(ctx.canvas);
      emit({
        t: Date.now(),
        kind: "measureText",
        canvasId: getCanvasId(ctx.canvas),
        text: safeString(args[0]),
        font: safeString(ctx.font)
      });
    });
    wrap("fillText", (ctx, args) => {
      registerCanvas(ctx.canvas);
      emit({
        t: Date.now(),
        kind: "fillText",
        canvasId: getCanvasId(ctx.canvas),
        text: safeString(args[0]),
        x: args[1],
        y: args[2],
        maxWidth: args[3] ?? null,
        font: safeString(ctx.font),
        fillStyle: safeString(ctx.fillStyle),
        strokeStyle: safeString(ctx.strokeStyle),
        textAlign: safeString(ctx.textAlign),
        textBaseline: safeString(ctx.textBaseline),
        transform: transformLike(ctx)
      }, makeDerived("text", ctx.canvas, {
        text: safeString(args[0]),
        x: args[1],
        y: args[2],
        font: safeString(ctx.font),
        textAlign: safeString(ctx.textAlign),
        textBaseline: safeString(ctx.textBaseline)
      }));
    });
    wrap("strokeText", (ctx, args) => {
      registerCanvas(ctx.canvas);
      emit({
        t: Date.now(),
        kind: "strokeText",
        canvasId: getCanvasId(ctx.canvas),
        text: safeString(args[0]),
        x: args[1],
        y: args[2],
        maxWidth: args[3] ?? null,
        font: safeString(ctx.font),
        transform: transformLike(ctx)
      }, makeDerived("text", ctx.canvas, {
        operation: "strokeText",
        text: safeString(args[0]),
        x: args[1],
        y: args[2],
        font: safeString(ctx.font)
      }));
    });
    const wrapRect = (name) => wrap(name, (ctx, args) => {
      registerCanvas(ctx.canvas);
      emit({
        t: Date.now(),
        kind: name,
        canvasId: getCanvasId(ctx.canvas),
        rect: rectLike(args),
        transform: transformLike(ctx)
      }, makeDerived("rect", ctx.canvas, {
        operation: name,
        rect: rectLike(args)
      }));
    });
    wrapRect("fillRect");
    wrapRect("strokeRect");
    wrapRect("clearRect");
    wrap("drawImage", (ctx, args) => {
      registerCanvas(ctx.canvas);
      const src = args[0];
      const rect = drawImageRect(args);
      notePartial("drawImage");
      emit({
        t: Date.now(),
        kind: "drawImage",
        canvasId: getCanvasId(ctx.canvas),
        srcTag: safeString(src?.tagName || Object.prototype.toString.call(src), 80),
        srcClassName: safeString(src?.className || "", 120),
        argCount: args.length,
        rect,
        transform: transformLike(ctx)
      }, makeDerived("image", ctx.canvas, {
        srcTag: safeString(src?.tagName || Object.prototype.toString.call(src), 80),
        srcClassName: safeString(src?.className || "", 120),
        argCount: args.length,
        rect
      }));
    });
  }, patchGetContext = function(Ctor, label) {
    if (!Ctor || !Ctor.prototype || Ctor.prototype[K_GETCTX_WRAPPED])
      return;
    const orig = Ctor.prototype.getContext;
    if (typeof orig !== "function")
      return;
    Ctor.prototype[K_GETCTX_WRAPPED] = true;
    Ctor.prototype.getContext = function(type, ...rest) {
      const ctx = orig.call(this, type, ...rest);
      const canvasId = registerCanvas(this);
      const entry = {
        t: Date.now(),
        kind: "getContext",
        canvasId,
        source: label,
        contextType: safeString(type, 40),
        canvas: canvasMeta(this)
      };
      pushBounded(observer.log, entry, LOG_CAP);
      try {
        document.dispatchEvent(new CustomEvent("__interceptor_canvas_log", { detail: entry }));
      } catch {}
      if (type === "2d" && ctx)
        patch2DPrototype(Object.getPrototypeOf(ctx));
      if (type === "webgl" || type === "webgl2")
        notePartial(type);
      if (label === "OffscreenCanvas")
        notePartial("offscreenCanvas");
      return ctx;
    };
  };
  window[K_CANVAS] = true;
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
        kindCounts: summarizeKinds(this.log),
        partialCoverageReasons: [...this.partialCoverageReasons]
      };
    }
  };
  patch2DPrototype(window.CanvasRenderingContext2D?.prototype);
  patchGetContext(window.HTMLCanvasElement, "HTMLCanvasElement");
  patchGetContext(window.OffscreenCanvas, "OffscreenCanvas");
  window[K_CANVAS_OBSERVER] = observer;
}
