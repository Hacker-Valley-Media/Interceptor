---
mechanic: canvas-camera-overlays
authored_by: claude-opus-4.7
last_validated: 2026-04-30
interceptor_min_version: 0.8.0
tags: [webgl, canvas, web-mercator, dom-overlays, dispatched-pan-zoom, css-filter, url-watcher]
---

# Canvas-Camera Overlays (Maps / 3D-viewer / geo-dashboard pattern)

## Goal

Drive a WebGL canvas-rendered camera app (map viewers, OSM-based tools, 3D scene viewers, charting dashboards that draw to a canvas) entirely from MAIN-world JS. Pan and zoom the camera via dispatched events, project lat/lng (or any model coordinate) to viewport pixels so DOM overlays track the camera, and restyle the rendered canvas via CSS filters — all without `chrome.debugger`, without OS-level CGEvent input, without the macOS bridge.

Companion to `canvas-rendered-editor-input.md`. Same `userActivation` + `__interceptor_trust` foundation, different output surface (camera state instead of text caret).

## What works

Three pillars:

1. **Pre-load `userActivation` override** (already shipped in `extension/src/inject-net.ts` at `document_start`, MAIN world). Page reads of `navigator.userActivation.isActive` always return `true`. This is what lets dispatched `MouseEvent` / `WheelEvent` / `KeyboardEvent` propagate as if from real input.
2. **Direct event dispatch on the canvas element** — `mousedown` → `mousemove` sweep → `mouseup` for pan, `WheelEvent { deltaY: ±120 }` for zoom, `KeyboardEvent` for arrow-key pan and `Minus`/`Equal` zoom shortcuts. All marked with `event.__interceptor_trust = true`.
3. **URL watcher** — many modern map SPAs write camera state to `location.href` (commonly an `@LAT,LNG,ZOOMz` segment in the path or a `#map=ZOOM/LAT/LNG` fragment). Polling the URL every ~120ms is a reliable substitute for an internal "camera changed" event when the app doesn't expose one to the page world.

```js
// Run inside `interceptor eval --main "..."`.
const canvas = document.querySelector('canvas.H1VXrf');  // Maps' main WebGL canvas
const r = canvas.getBoundingClientRect();

// --- Pan: chained mousedown → mousemove sweep → mouseup ---
function dm(type, x, y) {
  const e = new MouseEvent(type, {
    bubbles: true, cancelable: true,
    clientX: x, clientY: y,
    button: 0, buttons: type === 'mouseup' ? 0 : 1,
    view: window
  });
  e.__interceptor_trust = true;
  canvas.dispatchEvent(e);
}
const cy = r.y + r.height / 2;
const sX = r.x + r.width * 0.85;
const eX = r.x + r.width * 0.15;
dm('mousedown', sX, cy);
for (let s = 1; s <= 22; s++) {
  dm('mousemove', sX - (sX - eX) * s / 22, cy);
  await new Promise(r => setTimeout(r, 28));   // ~28ms between steps; under ~20ms causes drops
}
dm('mouseup', eX, cy);

// --- Zoom: WheelEvent at a specific point (zooms toward cursor) ---
const ev = new WheelEvent('wheel', {
  bubbles: true, cancelable: true,
  clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
  deltaY: -120, deltaMode: 0, view: window
});
ev.__interceptor_trust = true;
canvas.dispatchEvent(ev);

// --- Keyboard zoom (Maps shortcut) ---
function dk(key, code, kc) {
  for (const t of ['keydown', 'keyup']) {
    const e = new KeyboardEvent(t, { bubbles: true, cancelable: true, key, code, keyCode: kc });
    e.__interceptor_trust = true;
    canvas.dispatchEvent(e);
    document.dispatchEvent(e);
  }
}
dk('-', 'Minus', 189);    // zoom out one level
dk('=', 'Equal', 187);    // zoom in one level (no Shift needed for Maps)
```

### Web Mercator projection helper

For Maps and any Web Mercator-projected canvas, `pixels per degree of longitude = 256 * 2^zoom / 360`. Latitude pixels need the cosine of the center latitude to account for projection compression away from the equator.

```js
function projectLatLng(lat, lng, canvas) {
  const m = location.href.match(/@([\-\d.]+),([\-\d.]+),([\d.]+)z/);
  if (!m) return null;
  const cLat = parseFloat(m[1]), cLng = parseFloat(m[2]), z = parseFloat(m[3]);
  const r = canvas.getBoundingClientRect();
  const px = 256 * Math.pow(2, z) / 360;

  // Antimeridian wrap — keep |dLng| <= 180 so projection picks the short way
  let dLng = lng - cLng;
  if (dLng > 180) dLng -= 360;
  else if (dLng < -180) dLng += 360;

  const dx = dLng * px;
  const dy = -(lat - cLat) * (px / Math.cos(cLat * Math.PI / 180));
  return {
    cx: Math.round(r.x + r.width / 2 + dx),
    cy: Math.round(r.y + r.height / 2 + dy),
    zoom: z
  };
}
```

### URL-watcher pattern (anchored DOM overlays)

```js
// Marker overlay layer (above canvas, pointer-events:none so map stays interactive)
const layer = document.createElement('div');
layer.id = 'interceptor-markers';
layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99999';
document.body.appendChild(layer);

const anchors = [
  { lat: 40.7128, lng: -74.0060, label: 'Example POI' },
  // ... more lat/lng anchored points
];
const offsets = [{ x: 0, y: 0 }, { x: -40, y: -30 }, { x: 55, y: -15 }];

function reproject() {
  anchors.forEach((a, i) => {
    const p = projectLatLng(a.lat, a.lng, canvas);
    if (!p) return;
    const off = offsets[i] || { x: 0, y: 0 };
    const pin = layer.children[i];
    if (!pin) return;
    pin.style.left = (p.cx + off.x - 12) + 'px';
    pin.style.top  = (p.cy + off.y - 30) + 'px';
    // Fade pins that are off-viewport so user knows they're still anchored
    const r = canvas.getBoundingClientRect();
    const off_view = p.cx < -50 || p.cx > r.width + 50 || p.cy < -50 || p.cy > r.height + 50;
    pin.style.opacity = off_view ? '0.25' : '1';
  });
}

let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) { lastUrl = location.href; reproject(); }
}, 120);
```

### Canvas restyle via CSS filter

A WebGL canvas can be visually re-themed without touching the GPU pipeline by stacking `filter` chains. Classic dark-cyberpunk look on a light-themed map:

```css
canvas.H1VXrf {
  filter: invert(1) hue-rotate(180deg) saturate(2.4) contrast(1.15) brightness(.9) !important;
}
```

`invert(1) + hue-rotate(180deg)` flips light → dark while keeping the original hue family (so blue water stays blueish, green parks stay greenish — but darkened). `saturate(2.4)` amps neon. Pair with overlay layers (scanlines, vignette, gradient stripes) using `mix-blend-mode: screen` for additive neon glow without occluding the map.

## URL patterns + camera state location

- **Path-segment camera state** (e.g. `/.../@<lat>,<lng>,<zoom>z`) — common on map viewers that use the URL as canonical state.
- **Hash-fragment camera state** (e.g. `#map=<zoom>/<lat>/<lng>` on OpenStreetMap-style viewers) — read from `location.hash`.
- **Query-string camera state** (e.g. `?lat=&lng=&zoom=`) — common on Mapbox GL-based viewers.
- **Generic**: pan manually once and watch `location.href`; whatever changed is your camera-state field.

## Stable selectors

- The main viewport is usually a single `<canvas>` element. There are often 2–3 canvases on a map page; only one is the visible viewport. Filter by class (after observing what the host engine uses) or by largest `getBoundingClientRect()`.
- A search-results panel typically has `role="feed"` and contains per-result anchor elements with stable `href` patterns.
- The map element often has `role="application"` for accessibility-tree readback.

## Selectors that look right but break

- ❌ `canvas` (any) — there are usually multiple canvases on a map page, only one is the main viewport. Always scope to a class or `getBoundingClientRect()`-largest filter.
- ❌ Re-injecting the overlay layer on every camera change — causes flicker. Build it once, mutate `style.left`/`top` on its children.
- ❌ Fixed-pixel markers without re-projection — they appear "right" only at the camera state where they were placed. Without the URL watcher, panning floats them in screen space rather than world space.

## Waits + reasons

- After a `WheelEvent` zoom dispatch → wait ~500–700ms before reading new camera. Most engines animate the zoom over ~400ms; URL is updated when the animation settles.
- After keyboard zoom → ~150–180ms is enough; keyboard zooms are typically instant.
- After a mouse drag (mouseup) → wait ~700–800ms before reading new center. Many engines apply a small inertia even on slow drags.
- Between mousemove steps in a sweep → 25–30ms. Under 20ms, engines often coalesce or drop events.

## Traps

1. **Single eval longer than 15s breaks the daemon connection.** The page-side script keeps running, but the CLI eval call returns a timeout error and you lose the return value. For animations longer than that, either split into multiple sequential evals or fire-and-forget by not awaiting (return immediately, let `setTimeout` chains carry the work).
2. **Engines coalesce rapid-fire zoom keys.** Asking for 12 minus-keys with 100ms gaps may only register as 4–5 actual zoom levels. Add ~180ms between keys, or test the URL after each press.
3. **Mouse drag on a freshly-loaded tab works; after a connection blip it can no-op.** Workaround: dispatch a single `mousemove` outside any drag first (no buttons), then start the drag. This re-arms the engine's input router.
4. **WheelEvent with `ctrlKey: true` is treated as pinch-zoom by browsers.** Don't set ctrlKey unless you specifically want pinch behavior — leave it false for trackpad-style scroll-pan.
5. **Antimeridian wrap is automatic in most engines but NOT in your projection math** unless you wrap `dLng` into `[-180, 180]` (see `projectLatLng` above). Otherwise overlays jump 360° off-screen when crossing ±180° longitude.
6. **CSS `filter` on the canvas affects only that canvas.** Overlays in different DOM subtrees keep their own colors — useful for keeping markers neon while the map goes dark, but means a single body filter would also tint your overlays.

## Disposable handler pattern

For features users toggle on/off (a flick handler, a custom navigator, an overlay layer), store a disposer on `window.__interceptor_<feature>` so the next install can clean up the old one cleanly:

```js
if (window.__interceptor_flick) window.__interceptor_flick.dispose();
const onWheel = (e) => { /* ... */ };
canvas.addEventListener('wheel', onWheel, { capture: true, passive: false });
const urlWatch = setInterval(() => { /* ... */ }, 120);
window.__interceptor_flick = {
  dispose() {
    canvas.removeEventListener('wheel', onWheel, { capture: true });
    clearInterval(urlWatch);
  }
};
```

## Why this works (architecture)

- **`userActivation` override** (`extension/src/inject-net.ts:5-29`) gates all dispatched-event paths in modern Chromium. With it pre-loaded, dispatched events from MAIN world flow through the engine's event router unimpeded.
- **Event dispatch on a canvas element propagates to whatever JS handler the page registered.** Most engines register handlers via plain JS event listeners that read `e.clientX`/`clientY`/`deltaY` etc. — same fields any synthetic event sets.
- **URL is the most reliable camera-state surface for cross-camera-change overlay updates** without reverse-engineering the page's WebGL rendering loop. Polling at 120ms is invisible to humans (8 fps overlay refresh on a 60 fps map render).

## See also

- [canvas-rendered-editor-input.md](canvas-rendered-editor-input.md) — companion mechanic for canvas-rendered text editors (Docs/Slides/Sheets). Same `userActivation` + `__interceptor_trust` foundation, different output (caret/text instead of camera).
- [webgl-camera-control.md](webgl-camera-control.md) — sibling pattern with the same primitives, packaged as a reusable recipe for WebGL camera control + lat/lng overlay anchoring.
