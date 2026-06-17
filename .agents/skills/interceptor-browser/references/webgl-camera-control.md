---
mechanic: webgl-camera-control
authored_by: claude-opus-4.7
last_validated: 2026-04-30
interceptor_min_version: 0.8.0
tags: [webgl, canvas, camera, pan, zoom, web-mercator, lat-lng-overlay, css-skin]
---

# WebGL Camera Control + Lat/Lng Overlay Anchoring

## Goal

Drive any WebGL-rendered camera viewer (zoom, pan, click) entirely through dispatched events on the canvas, anchor DOM overlays to lat/lng coordinates that survive camera movement, and restyle the rendered viewport via CSS filters — all without OS-level input or `chrome.debugger`.

This is the generic mechanic. The same primitives apply to any WebGL camera surface that uses `MouseEvent`/`WheelEvent` for input and exposes some form of camera state to the URL or page state.

## What works

### 1. Identify the main rendering canvas

WebGL viewers typically render multiple `<canvas>` elements; only one is the main viewport. Filter by largest `getBoundingClientRect` or by a stable class name once you have observed which canvas is the visible scene.

```js
(() => {
  const canvases = Array.from(document.querySelectorAll('canvas'));
  return canvases.map(c => {
    const r = c.getBoundingClientRect();
    return { className: c.className, width: r.width, height: r.height };
  });
})()
```

### 2. Pan via dispatched MouseEvent sequences

A pan is `mousedown` → N `mousemove` events → `mouseup`. Most engines need the mouse to land on the canvas itself, not a DOM overlay above it.

```js
async function dragPan(canvas, fromX, fromY, toX, toY, steps = 22) {
  const seq = ['mousedown', ...Array(steps).fill('mousemove'), 'mouseup'];
  for (let i = 0; i < seq.length; i++) {
    const t = seq[i];
    const progress = i === 0 ? 0 : (i === seq.length - 1 ? 1 : i / steps);
    const e = new MouseEvent(t, {
      bubbles: true, cancelable: true,
      clientX: fromX + (toX - fromX) * progress,
      clientY: fromY + (toY - fromY) * progress,
      button: 0,
      buttons: t === 'mouseup' ? 0 : 1,
      view: window
    });
    e.__interceptor_trust = true;
    canvas.dispatchEvent(e);
    if (t === 'mousemove') await new Promise(r => setTimeout(r, 16));
  }
}
```

### 3. Zoom via WheelEvent or keyboard

Two equivalent paths. Wheel zooms toward/away from the event coordinates; keys zoom the current camera center.

```js
// Wheel zoom toward (clientX, clientY)
function wheelZoom(canvas, clientX, clientY, deltaY = -120) {
  const e = new WheelEvent('wheel', {
    bubbles: true, cancelable: true,
    clientX, clientY, deltaY,
    view: window
  });
  e.__interceptor_trust = true;
  canvas.dispatchEvent(e);
}

// Key zoom — works when the canvas (or document) has focus
async function keyZoom(direction = 'in') {
  const code = direction === 'in' ? 'Equal' : 'Minus';
  const keyCode = direction === 'in' ? 187 : 189;
  for (const t of ['keydown', 'keyup']) {
    const e = new KeyboardEvent(t, { bubbles: true, cancelable: true, code, keyCode, which: keyCode });
    e.__interceptor_trust = true;
    document.dispatchEvent(e);
  }
  await new Promise(r => setTimeout(r, 180));
}
```

### 4. Web Mercator projection helper

To anchor DOM overlays at specific lat/lng coordinates, you need to project geographic coordinates → viewport pixels. The standard tile system uses Web Mercator at 256 pixels per tile, so:

```js
function projectLatLng(lat, lng, cameraLat, cameraLng, zoom, viewportW, viewportH) {
  // pixels per degree at this zoom
  const pxPerDegLng = 256 * Math.pow(2, zoom) / 360;
  // mercator y projection
  const latRad = lat * Math.PI / 180;
  const cameraLatRad = cameraLat * Math.PI / 180;
  const mercY    = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  const cameraMy = Math.log(Math.tan(Math.PI / 4 + cameraLatRad / 2));
  const dx = (lng - cameraLng) * pxPerDegLng;
  const dy = (cameraMy - mercY) * (256 * Math.pow(2, zoom) / (2 * Math.PI));
  return { x: viewportW / 2 + dx, y: viewportH / 2 + dy };
}
```

### 5. Anchor overlays as a fixed-position layer

Inject a single full-viewport overlay container with `pointer-events: none` so the canvas underneath still receives input. Re-project on every camera change.

```js
function ensureMarkerLayer() {
  let layer = document.getElementById('interceptor-markers');
  if (layer) return layer;
  layer = document.createElement('div');
  layer.id = 'interceptor-markers';
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99999';
  document.body.appendChild(layer);
  return layer;
}

function placePin(layer, x, y, label, color = '#e11d48') {
  const pin = document.createElement('div');
  pin.style.cssText = `position:absolute;left:${x-12}px;top:${y-30}px;pointer-events:auto`;
  pin.innerHTML = `
    <div style="width:24px;height:24px;border-radius:50% 50% 50% 0;background:${color};
                transform:rotate(-45deg);border:2px solid white;
                box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>
    <div style="position:absolute;left:30px;top:0;background:white;padding:2px 8px;
                border-radius:4px;font:600 12px Arial;box-shadow:0 1px 4px rgba(0,0,0,.3);
                white-space:nowrap;color:#111">${label}</div>`;
  layer.appendChild(pin);
}
```

### 6. Refresh overlays on camera change

Most WebGL viewers expose camera state in either the URL (`@LAT,LNG,ZOOMz` style fragments) or via observable DOM state. Watch for changes and re-project:

```js
(() => {
  let lastUrl = location.href;
  const watcher = setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Re-parse camera from URL, re-call projectLatLng() for every marker, update positions.
      window.dispatchEvent(new CustomEvent('interceptor-camera-change'));
    }
  }, 200);
  window.__interceptor_camera_watcher = watcher;
})()
```

For viewers that expose camera state through page-side JS (e.g. via a `window.app.camera` global), patch that object's setters instead of polling the URL.

### 7. Restyle the rendered viewport

CSS `filter` on the canvas element re-tints/inverts/recolors the rendered output without touching the WebGL pipeline. Pair with overlay layers for scanlines, vignettes, or tinted gradients.

```js
const style = document.createElement('style');
style.textContent = `
  canvas.MAIN_VIEWPORT_CLASS {
    filter: invert(1) hue-rotate(180deg) saturate(2.4) contrast(1.15) !important
  }
  #interceptor-scanlines {
    position: fixed; inset: 0; pointer-events: none; z-index: 99998;
    background: repeating-linear-gradient(
      0deg, rgba(255,0,200,.04) 0, rgba(255,0,200,.04) 1px, transparent 1px, transparent 3px
    );
    mix-blend-mode: screen;
  }
`;
document.head.appendChild(style);

const scan = document.createElement('div');
scan.id = 'interceptor-scanlines';
document.body.appendChild(scan);
```

The `mix-blend-mode: screen` over a `pointer-events:none` overlay means the user can still drive the camera through the recolored canvas.

## Stable hooks

- `MouseEvent`, `WheelEvent`, `KeyboardEvent` constructors — universal Web API, present everywhere.
- `event.__interceptor_trust = true` — the per-event marker that satisfies sites that gate on `isTrusted` via the prototype.
- `getBoundingClientRect()` for canvas size; `clientX`/`clientY` for event coordinates relative to the viewport.
- The pre-load `userActivation` override (in `extension/src/inject-net.ts`) that satisfies `navigator.userActivation.isActive` for sites that gate on transient activation.

## Selectors / tactics that look right but break

- ❌ `'canvas'` (un-classed) — most WebGL apps render multiple canvases. Filter by class or by largest `getBoundingClientRect`.
- ❌ Dispatching `mousemove` events without `buttons: 1` — many camera engines only treat a sequence as a drag when `buttons` indicates the primary button is held.
- ❌ Dispatching directly on the canvas element when the input handler is attached at `document` or `window` level — try both targets if the dispatch on the canvas alone has no effect.
- ❌ Setting `event.isTrusted` directly — it's a read-only spec property. Use the `__interceptor_trust` marker instead and rely on the pre-load override.
- ❌ Synthetic `KeyboardEvent` with only `key: 'PageUp'` — pair with `code` and `keyCode` for compatibility with engines that read all three.

## Waits + reasons

- After a key zoom press → wait ~180 ms for the engine to re-tile and animate.
- Between drag-pan iterations → wait ~16 ms per `mousemove` step (60 fps cadence). Faster causes the engine to coalesce events.
- After URL change (camera moved) → wait ~200 ms before re-projecting overlays. The camera state may settle a frame after the URL update.
- Long auto-pan tours → don't `await` the whole animation in a single `eval --main` call; the daemon caps `eval` at ~15 s. Use fire-and-forget `setTimeout` chains.

## Traps

1. **Eval longer than 15 s breaks the daemon connection.** For multi-step animated tours, kick off a `setTimeout` chain inside the eval and return immediately. Poll `window.__interceptor_tour_progress` from shell side.
2. **Some viewers filter synthetic input on the canvas itself.** If `mousedown`/`mousemove`/`mouseup` on `canvas` does nothing, retry on `document.body` or on the canvas's parent. The `__interceptor_trust` marker still applies.
3. **Overlay markers drift after camera move** if the projection function doesn't account for Mercator latitude distortion. The helper above does — but verify by placing a marker at the camera center and confirming it stays put when you drag.
4. **Camera state not in the URL.** Some viewers don't write camera state to the URL at all. In that case poll `window.app.camera` (or the engine's equivalent) instead of `location.href`.
5. **CSS filter performance.** Heavy `filter: invert+hue-rotate+saturate+contrast` chains can drop the camera framerate noticeably. Test on the target machine before publishing a "skin."
6. **Pinch zoom not synthesizable.** Touch-based pinch zoom requires `Touch` / `TouchEvent` constructors which behave differently per engine. Stick to wheel/key zoom on desktop.

## Why this works (architecture)

WebGL camera engines listen for ordinary DOM events on the canvas. The pre-load `userActivation` override forces `navigator.userActivation.isActive` to read true, satisfying transient-activation gates that some engines use to ignore programmatic input. Tagging dispatched events with `__interceptor_trust = true` further satisfies the per-event prototype `isTrusted` check. With those two satisfied, the engine receives the events as if a human had moved the mouse or scrolled the wheel.

Lat/lng overlay anchoring is a separate, parallel layer: a fixed-position DOM container above the canvas, positioned by Web Mercator projection. Because the container is `pointer-events: none`, the canvas underneath still receives all input, so camera control and overlays compose cleanly.

## Generic flow (composable)

```
[identify main canvas — by class or largest bounding box]
  ↓
[install __interceptor_trust event marker tooling once per session]
  ↓
[drive camera via dispatched MouseEvent / WheelEvent / KeyboardEvent on the canvas]
  ↓
[inject overlay layer + project lat/lng via Web Mercator helper]
  ↓
[watch URL or page-state for camera changes; re-project overlays]
  ↓
[optional: CSS filter on canvas + scanline/vignette overlay for visual restyling]
```

Each stage is independent. If a particular viewer needs a different input target (document vs canvas vs parent div), only the dispatch stage changes — projection, overlays, and restyling are universal.

## See also

- [canvas-camera-overlays.md](canvas-camera-overlays.md) — earlier sibling pattern with the projection helper, URL-watcher, disposable handler pattern, and antimeridian wrap.
- [canvas-rendered-editor-input.md](canvas-rendered-editor-input.md) — companion pattern for canvas-rendered TEXT editors when you need to write content rather than navigate a camera.
- [blob-export-capture.md](blob-export-capture.md) — capture client-side render output without Save dialogs.
