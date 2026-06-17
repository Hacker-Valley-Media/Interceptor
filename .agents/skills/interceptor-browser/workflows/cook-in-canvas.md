# Use Case: Cook Inside Existing Canvases

**Date:** 2026-04-23
**Agent:** Codex
**Target:** Existing `<canvas>` surfaces in live sites such as Google Docs and Excalidraw

---

## Goal

Create dramatic visual effects directly inside the page's existing canvas without adding extra HTML overlays.

This is different from [cook-on-top-of-pages](cook-on-top-of-pages.md):

- `cook-on-top-of-pages` paints with injected DOM and CSS on top of the live page
- `cook-in-canvas` paints through the target page's own `CanvasRenderingContext2D`

Use this when the user explicitly wants:

- fireworks
- explosions
- roses
- debug markers
- visual proof-of-life
- "draw in the canvas itself"

---

## Core Technique

Use `interceptor eval --main` to:

1. find the visible target canvas
2. get its `2d` context
3. draw directly into that context
4. optionally keep an animation loop running

This does **not** create new DOM overlays.

---

## Fast Proof

Draw a visible marker into the live canvas and verify it landed:

```bash
interceptor eval --main '
(() => {
  const c =
    document.querySelector(".kix-canvas-tile-content") ||
    document.querySelector("canvas.excalidraw__canvas.static") ||
    document.querySelector("canvas.excalidraw__canvas.interactive") ||
    document.querySelector("canvas");
  if (!c) return { ok:false, error:"no target canvas" };
  const ctx = c.getContext("2d");
  if (!ctx) return { ok:false, error:"no 2d context" };
  ctx.save();
  ctx.fillStyle = "rgba(255,0,255,1)";
  ctx.fillRect(40, 40, 40, 40);
  ctx.font = "bold 24px monospace";
  ctx.fillStyle = "rgba(0,255,255,1)";
  ctx.fillText("CY", 90, 80);
  ctx.restore();
  return { ok:true, width:c.width, height:c.height };
})()
'
```

Verify with a direct pixel read:

```bash
interceptor eval --main '
(() => {
  const c =
    document.querySelector(".kix-canvas-tile-content") ||
    document.querySelector("canvas.excalidraw__canvas.static") ||
    document.querySelector("canvas.excalidraw__canvas.interactive") ||
    document.querySelector("canvas");
  if (!c) return { ok:false, error:"no target canvas" };
  const ctx = c.getContext("2d");
  return {
    ok:true,
    marker: Array.from(ctx.getImageData(45,45,1,1).data),
    text: Array.from(ctx.getImageData(95,75,1,1).data)
  };
})()
'
```

---

## Canvas Party

For a lightweight but dramatic effect, run a page-world script from a local scratch file or inline string. Keep machine-specific scratch paths out of committed examples.

```bash
interceptor eval --main "$(cat path/to/local/canvas_party.js)"
```

What it does:

- finds the page's main visible canvas
- draws a dark cinematic tint each frame
- adds fireworks bursts
- draws glowing explosion rings
- drops rose and sparkle glyphs

The script stores a stop handle at `window.__canvasPartyStop`.

Stop the effect:

```bash
interceptor eval --main '
(() => {
  if (window.__canvasPartyStop) {
    window.__canvasPartyStop();
    return { ok:true, stopped:true };
  }
  return { ok:false, stopped:false };
})()
'
```

---

## Site Notes

### Google Docs

- Preferred semantic path remains `interceptor scene text` / `scene insert`
- Use direct canvas drawing only for:
  - visual effects
  - markers
  - demos
  - experiments

Target canvas selector:

```js
document.querySelector(".kix-canvas-tile-content")
```

### Excalidraw

- Host-state path can read scene data from `localStorage.excalidraw`
- Direct canvas drawing works for visual effects and proof-of-life

Preferred visual target:

```js
document.querySelector("canvas.excalidraw__canvas.static")
```

---

## Agent Guidance

If the user asks to "cook" a canvas-heavy site:

1. inspect the page with `scene profile`, `canvas list`, and `canvas model`
2. choose the visible target canvas
3. prefer drawing through the target canvas context
4. do **not** default to adding extra DOM overlays
5. verify the result with pixel reads or screenshots

If the user asks to preserve semantics or edit the document itself:

- prefer host semantic paths first
- use canvas cooking only as a visual layer
