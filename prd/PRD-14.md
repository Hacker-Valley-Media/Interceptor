# PRD-14: `slop canvas` — Unified Scene-Graph Access for DOM-Rendered Editors (Canva, Google Docs, Google Slides)

**Goal:** Add a `slop canvas` command surface that lets an agent enumerate, inspect, click, and edit objects inside visual editors whose "canvas" is actually a layered DOM / SVG / hidden-iframe model rather than a real `<canvas>` element. First-class profiles for **canva.com**, **docs.google.com/document**, and **docs.google.com/presentation**, plus a generic vision fallback for truly canvas-rendered editors. No CDP. No debugger. No detection surface.

**Scope:** New `extension/src/content/scene/` module tree with per-host profiles, new `extension/src/content/scene/engine.ts` top-level dispatcher, new `extension/src/content/actions/canvas.ts` action handlers wired through `content.ts`, new `cli/commands/canvas.ts` CLI subcommands, and one **critical fix to `extension/src/background/capabilities/evaluate.ts` to await Promise return values** (so async page work can round-trip through `slop eval --main`). Fix is grounded in Chrome's own documented behavior.

**Non-Negotiable:**
1. **No CDP.** This PRD must not attach `chrome.debugger`. Every capability uses content-script MAIN/ISOLATED world execution.
2. **Profile-driven.** Per-host logic lives in a single profile object. Adding a new editor is one file, not a new module.
3. **Stable identifiers over pixels.** Every action references an editor-native stable ID (Canva `LB...`, Slides `filmstrip-slide-N-...`, Docs `data-ri=N`). Viewport coordinates are re-computed at dispatch time, never cached.
4. **Async eval works.** `slop eval --main "fetch(...).then(...)"` returns the resolved value. This is what Chrome's own `executeScript` docs guarantee and what our current implementation drops on the floor.
5. **Zero behavioral regressions.** All existing commands (click, type, tree, monitor, net log, etc.) must work identically after this PRD lands.

---

## Evidence Sources

All line numbers verified against local docs and local source as of the time this PRD was authored.

| ID | Source | Path | What it proves |
|----|--------|------|----------------|
| CHR-SCRIPT | Chrome `scripting.executeScript` | `80_Reference/docs/chrome-extensions/docs/extensions/reference/api/scripting.md` **line 194** and **line 505** | "If the resulting value of the script execution is a promise, Chrome will wait for the promise to settle and return the resulting value." This is the contract our current `evaluate.ts` violates. |
| CHR-WORLD | Chrome `ExecutionWorld` enum | `80_Reference/docs/chrome-extensions/docs/extensions/reference/api/scripting.md` **line 291** | `"MAIN"` = "Specifies the main world of the DOM, which is the execution environment shared with the host page's JavaScript." Confirms MAIN-world eval can reach page-side globals like `DOCS_timing` and iframe contentDocuments. |
| CHR-FRAME | Chrome content-script framing | `80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/content-scripts.md` **line 484, 495, 522, 533** | `all_frames: true` + `match_origin_as_fallback: true` guarantees content scripts run inside `about:blank` iframes like Google Docs' `.docs-texteventtarget-iframe`. Our manifest already sets both. |
| CHR-MSGSEND | `chrome.tabs.sendMessage` `frameId` | `80_Reference/docs/chrome-extensions/docs/extensions/reference/api/tabs.md` **line 1284–1288** | "Send a message to a specific frame identified by frameId instead of all frames in the tab." We already use this via `sendToContentScript(tabId, action, frameId)`. |
| CHR-CANVAS | Chromium RenderingNG — canvas | `80_Reference/docs/chrome-browser/docs/chromium/renderingng.md` **line 44, 134, 317** | "Optimizes all content—HTML, CSS, 2D Canvas, 3D canvas, images, video, and fonts." Plus OffscreenCanvas / ImageBitmapRenderingContext / threaded canvas rendering. Confirms that a `<canvas>` is an opaque bitmap surface from the DOM's point of view — the text Google draws on it is NOT introspectable via DOM queries, which is the whole reason Google Docs maintains the shadow-iframe text mirror. |
| BUN-JSONL | Bun JSONL parser | `80_Reference/docs/bun/docs/runtime/jsonl.md` **line 18, 26, 39** | `Bun.JSONL.parse(string | Buffer): Array` lets the CLI read the event log efficiently when replaying scene sessions. Already used in PRD-13. |
| BUN-FILE | Bun file I/O | `80_Reference/docs/bun/docs/runtime/file-io.md` | `Bun.file(path)` / `Bun.write(path, data)` for writing the optional profile cache and debug dumps. Already used in `cli/transport.ts` and `daemon/index.ts`. |
| BUN-SPAWN | Bun child process | `80_Reference/docs/bun/docs/runtime/bun-apis.md` **line 29** | `Bun.spawn` — used by the existing `slop monitor tail` subcommand for `tail -f`. Not strictly needed for PRD-14 but relied on for the cross-platform exceptions. |
| SLOP-EVAL | slop existing evaluate capability | `extension/src/background/capabilities/evaluate.ts` **full file** | Currently runs `(0, eval)(c)` and immediately does `JSON.parse(JSON.stringify(r))` — this turns a Promise into `{}`. The fix is to `await` the eval result before cloning. |
| SLOP-CONTENT | slop content.ts dispatcher | `extension/src/content.ts` **lines 29–46 (onMessage handler), 60–175 (executeAction switch)** | Where new `canvas_*` action types plug into the existing `execute_action` routing. |
| SLOP-BGROUTER | slop background router | `extension/src/background/router.ts` **full file** | Where the new `CANVAS_ACTIONS` set registers and dispatches the profile-driven handler if needed. (Most actions will be content-forwarded, not handled in background.) |
| SLOP-CLI | slop CLI entry point | `cli/index.ts` **full file** | Where `CANVAS_CMDS` registers and dispatches to the new `parseCanvasCommand`. |
| SLOP-INPUT | slop input simulation | `extension/src/content/input-simulation.ts` **`dispatchClickSequence`, `dispatchKeySequence`** | Existing primitives reused by `canvas click`, `canvas insert-text`, `canvas cursor-to`. |
| SLOP-A11Y | slop a11y helpers | `extension/src/content/a11y-tree.ts` **`getEffectiveRole`, `getAccessibleName`** | Used by profiles that need to fall back to semantic naming when a stable ID is missing. |
| OBS-CANVA | Session 77907634 — Canva scene-graph observation | `/tmp/slop-browser-events.jsonl` lines tagged `sid:"77907634..."` | 37 real user clicks, every one `tr:true ic:true` (shadow DOM). 10 stable `[id^="LB"]` layer elements enumerated, each with `style.transform: translate(x, y)` and `style.width/height`. Layer IDs survived a full page navigation — proven by `slop navigate` + re-query. |
| OBS-DOCS | Session 20bcf316 — Docs/Slides observation | `/tmp/slop-browser-events.jsonl` lines tagged `sid:"20bcf316..."` | 349 events, 4 navs (docs → slides), every keystroke attributed to `ref:e1, r:textbox, n:"Document content", fid:7549` — i.e. the hidden `.docs-texteventtarget-iframe` contenteditable. Google Docs canvas confirmed via `document.querySelectorAll('canvas').length === 3` with class `kix-canvas-tile-content`. Google Slides has zero canvas and 32 SVG, including 12 filmstrip thumbnails with stable `filmstrip-slide-N-gd02e148143_0_M` IDs backed by `blob:` URLs. |
| OBS-MIRROR | Docs hidden text-mirror iframe | MAIN-world probe `iframe.docs-texteventtarget-iframe.contentDocument.querySelector('[role=textbox]').innerHTML` | Returns full Google Docs document HTML with `<p>` + `<span>` elements carrying `data-ri="<N>"` attributes (Range Index — Google's model offset). `data-ri="0"` was the span containing "Hello there", confirming characters flow iframe → model → canvas. |
| OBS-ARIA | Canva selection state | MAIN-world probe `document.querySelector('[role=application]').getAttribute('aria-label')` | Returns `"Blue, Circle, Shape"` / `"Light gray, Circle, Shape"` / etc. — the full name of the currently selected object on the canvas. Proven to update within ~30ms of a click via `slop click-at`. |

---

## The Problem

### What exists today

| Capability | What it does | Where it fails on Canva / Docs / Slides |
|------------|--------------|------------------------------------------|
| `slop tree` | Accessibility tree walk | Returns the editor chrome (toolbar, panels) but **nothing on the canvas** — Canva's objects are div children without roles, Docs' text is inside a canvas bitmap, Slides' content is a blob `<image>` |
| `slop click <ref>` | Click a ref from `slop tree` | Can't reach canvas objects because they never show up in `tree` |
| `slop click-at X,Y` | Click pixel coordinate | Works but requires the agent to already know the coordinate. Coordinates change when the user pans/zooms |
| `slop find "name"` | Fuzzy semantic match | Hits chrome buttons only; canvas objects have no `role` or `aria-label` at the element level |
| `slop monitor` (PRD-13) | Record + replay user actions | Excellent for one-shot replay but doesn't let the agent **introspect** the canvas or address objects that the user hasn't touched yet |
| `slop eval --main "..."` | Run JS in page world | Works for sync values only. **Drops any Promise return value** (turns it into `{}`) which makes async operations (fetch blob → canvas → dataURL, await model query) unusable |
| `slop net log` (PRD-11) | Read captured fetch/XHR | Gives you the editor's network surface but not the scene state |

### What Ron actually wants

> "We need ability to hit canvas! It's gotta work well on Google Docs and Slides too."

A single command that answers:
1. **"What's on the screen?"** — enumerate scene objects with stable IDs
2. **"Click that thing"** — address an object by stable ID (not pixel coords)
3. **"What's selected right now?"** — read the editor's selection state
4. **"Read the document text"** — get the actual editable content
5. **"Write at the cursor"** — insert text programmatically
6. **"Go to slide 7"** — deck navigation
7. **"Take a pixel snapshot of slide 3"** — for fallback vision workflows

### Why a single generic solution isn't possible (and why profiles work)

Based on direct observation across 3 editors:

| Editor | "Canvas" is actually... | Stable object IDs | Text storage | Addressable how |
|--------|-------------------------|-------------------|--------------|-----------------|
| **Canva** | Absolutely-positioned DOM `<div>` tree inside Shadow DOM. Zero `<canvas>` on the editor surface (2 tiny chrome canvases, neither is the editing surface). | `[id^="LB"]` — 16-char alphanumeric layer IDs. Class `DF_utQ _682gpw _0xkaeQ`. `style.transform: translate(doc_x, doc_y)` + `style.width/height` in px. | Each layer is an image `<img>`, SVG `<svg>`, or text node. Direct DOM read. | `document.getElementById('LB...')` + `getBoundingClientRect()` → click at computed center |
| **Google Docs** | 3 real `<canvas class="kix-canvas-tile-content">` elements. Text rendered via `CanvasRenderingContext2D.fillText()`. DOM has zero content text. | None on the canvas itself. But **every character is in the shadow iframe** at `iframe.docs-texteventtarget-iframe > [role=textbox] > p > span` with `data-ri="<model-offset>"`. Range-index is the stable identifier. | Hidden contenteditable iframe carries full HTML + inline styles. | Read: `iframe.contentDocument.querySelector('[role=textbox]').innerHTML`. Write: focus the iframe, dispatch key events or use `document.execCommand('insertText', ...)`. Click positions: `slop click-at X Y` moves the cursor because Google's canvas-click handler resolves hit → model offset automatically. |
| **Google Slides** | 32 `<svg>` elements, zero `<canvas>`. Each slide is an SVG `<g>` containing an `<image xlink:href="blob:...">` with a 1600×900 client-rasterized PNG. | **Filmstrip:** `filmstrip-slide-N-gd<docHash>_0_<M>` for every slide, N = index, M = object counter. Pattern verified: slides 0–11 with increments of 3 in M. **Current slide:** `editor-gd<docHash>_0_<M>` mirrors the active slide. | Slide bodies are **baked into the blob image** — not directly in DOM. Speaker notes ARE in DOM as `speakernotes-i3-paragraph-<N>` SVG `<g>` elements. Text boxes use the same `.docs-texteventtarget-iframe` as Docs once an edit session begins. | Navigate slides by clicking filmstrip `<g>` elements. Read speaker notes via DOM. Read slide pixel content via blob fetch → canvas draw → `toDataURL` (async — needs the eval fix). |

**Conclusion:** there is no "one DOM query" that addresses all three. But there are exactly three access patterns, each representable as a profile.

---

## Architecture

### Overview

```
┌─ CLI ────────────────────────────────────────────────────────────┐
│  slop canvas list / click <id> / text / insert-text / slide goto │
│  slop canvas notes / render <id> / selected / cursor / vision    │
│       │                                                           │
└───────┼───────────────────────────────────────────────────────────┘
        │  transport (socket/ws) → daemon → native messaging
        ▼
┌─ Background service worker ──────────────────────────────────────┐
│  router.ts: CANVAS_ACTIONS → sendToContentScript(tabId, action)  │
│  (most canvas actions are forwarded directly; no bg state)       │
└───────┼───────────────────────────────────────────────────────────┘
        ▼
┌─ Content script (ISOLATED world) ─────────────────────────────────┐
│  content.ts "canvas_*" switch branch                              │
│       │                                                           │
│       ▼                                                           │
│  content/scene/engine.ts                                          │
│       ├── detectProfile(location.host, location.pathname)         │
│       ├── profile.list() → [{id, type, bbox, data}]              │
│       ├── profile.resolve(id) → {viewportCenter, element, data}  │
│       ├── profile.selected() → {id|name, metadata}                │
│       ├── profile.text() → {full, html, cursor_ri}                │
│       ├── profile.writeAtCursor(text) → {ok}                     │
│       ├── profile.navigate(slide_index) → {ok}                    │
│       └── profile.render(id) → {dataUrl} [async]                  │
│                                                                    │
│  content/scene/profiles/                                          │
│    canva.ts         — LB layer profile                            │
│    google-docs.ts   — shadow iframe + kix canvas profile          │
│    google-slides.ts — filmstrip + editor + notes profile          │
│    generic.ts       — heuristic fallback                          │
│                                                                    │
│  content/scene/ops.ts                                             │
│    - Shared helpers: clickAt, dblclickAt, dispatchKeys, focusIn   │
│    - Reuses existing input-simulation.ts + ref-registry.ts        │
└───────────────────────────────────────────────────────────────────┘
```

### Why content-script (ISOLATED) + targeted MAIN-world probes

**Isolated world** is where we already live and where `content.ts` runs. It has:
- Full DOM access (including reading iframe contentDocument when same-origin)
- Shadow DOM traversal via `composedPath()` and `.shadowRoot`
- `document.getElementById`, `querySelectorAll`, `getBoundingClientRect`
- No access to page-side JS globals (`__canva_public_path__`, `DOCS_timing`, etc.)

**Main world** (via `chrome.scripting.executeScript({world: "MAIN"})`) is where we reach page globals. We'll use it rarely — only for things like reading Canva's `__canva_public_path__` if we ever need the doc ID, or calling `_docs_annotate_getAnnotatedText` (currently inert, may become useful if the contract changes). The profile system runs primarily in ISOLATED and escalates to MAIN only for explicitly-needed operations.

**Same-origin iframe traversal:** the Google Docs text-event-target iframe is `src="about:blank"`, which inherits the parent's origin — `document.google.com`. Our content script already runs in that iframe because the manifest declares `match_origin_as_fallback: true` and `all_frames: true` [CHR-FRAME]. But a simpler approach we can also use: from the parent frame, `iframe.contentDocument` is accessible because same-origin. I verified this works in the session evidence.

### The async eval fix (prerequisite)

Current code in `extension/src/background/capabilities/evaluate.ts`:

```typescript
const r = (0, eval)(c)
return { success: true, data: (typeof r === "object" && r !== null) ? JSON.parse(JSON.stringify(r)) : r }
```

If `c` is `"fetch(...).then(...).then(r => r.size)"`, then `r` is a Promise, `JSON.parse(JSON.stringify(<Promise>))` is `{}`, and the result returned to the CLI is `{}`. This is the bug I hit when testing blob fetches on Slides.

Per [CHR-SCRIPT] line 194: *"If the resulting value of the script execution is a promise, Chrome will wait for the promise to settle and return the resulting value."* — meaning if our injected function returns a Promise, `executeScript` will await it and hand us the resolved value in `results[0].result`.

The fix is to make the injected function itself async and await the eval result:

```typescript
const results = await chrome.scripting.executeScript({
  target: { tabId },
  world: world as "MAIN" | "ISOLATED",
  args: [code],
  func: async (c: string) => {
    try {
      const w = window as any
      let r: unknown
      if (w.trustedTypes) {
        if (!w.__slop_tt_policy) {
          try {
            w.__slop_tt_policy = w.trustedTypes.createPolicy("slop-eval", {
              createScript: (s: string) => s
            })
          } catch {
            try {
              w.__slop_tt_policy = w.trustedTypes.createPolicy("slop-eval-" + Date.now(), {
                createScript: (s: string) => s
              })
            } catch {}
          }
        }
        if (w.__slop_tt_policy) {
          const trusted = w.__slop_tt_policy.createScript(c)
          r = (0, eval)(trusted)
        } else {
          r = (0, eval)(c)
        }
      } else {
        r = (0, eval)(c)
      }
      // If the result is a Promise, await it — Chrome will propagate the resolved value.
      if (r && typeof (r as any).then === "function") {
        r = await (r as Promise<unknown>)
      }
      return { success: true, data: (typeof r === "object" && r !== null) ? JSON.parse(JSON.stringify(r)) : r }
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) }
    }
  }
})
```

Chrome's `executeScript` will receive the `async` function's outer promise, await it, and hand us back the settled `{success, data}` object. This is a documented guarantee, not a hack.

### The profile contract

Every profile implements this interface (implemented as a plain object, not a class, so it bundles cleanly in Bun):

```typescript
export interface SceneObject {
  id: string                      // stable, survives reload
  type: "image" | "shape" | "text" | "slide" | "page" | "embed" | "unknown"
  name?: string                   // human-readable label if available
  bbox?: { x: number; y: number; w: number; h: number }  // viewport coords (recomputed per call)
  doc?: { x: number; y: number; w: number; h: number }   // document-space coords
  meta?: Record<string, unknown>  // profile-specific extras (media URL, ri offset, etc.)
}

export interface SceneSelection {
  id?: string
  name?: string
  meta?: Record<string, unknown>
}

export interface SceneText {
  full: string
  html?: string
  cursor?: { ri?: number; x?: number; y?: number }
}

export interface SceneProfile {
  name: string                    // "canva" | "google-docs" | "google-slides" | "generic"
  detect: () => boolean           // run on this host?
  list: (opts?: { type?: string }) => SceneObject[]
  resolve: (id: string) => SceneObject | null
  selected: () => SceneSelection | null
  text?: () => SceneText | null
  writeAtCursor?: (text: string) => { ok: boolean; error?: string }
  cursorTo?: (target: { ri?: number; x?: number; y?: number }) => { ok: boolean; error?: string }
  slideGoto?: (index: number) => { ok: boolean; error?: string }
  slideCurrent?: () => { index: number; id: string } | null
  notes?: (slideIndex?: number) => { text: string } | null
  render?: (id: string) => Promise<{ dataUrl: string; width: number; height: number } | null>
  zoom?: () => number | null
}
```

The engine picks the right profile via `detect()` and dispatches every canvas action through it.

### Canva profile (facts, not guesses)

**Detection:** `location.host === "www.canva.com"` or host ends with `".canva.com"`, AND the URL path matches `/design/`.

**Scene enumeration (`list()`):** observed from session 77907634:

```typescript
const layers = Array.from(document.querySelectorAll('[id^="LB"]'))
  .filter(el => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
  .map(el => {
    const r = el.getBoundingClientRect()
    const tMatch = (el as HTMLElement).style.transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/)
    const dx = tMatch ? parseFloat(tMatch[1]) : 0
    const dy = tMatch ? parseFloat(tMatch[2]) : 0
    const dw = parseFloat((el as HTMLElement).style.width) || r.width
    const dh = parseFloat((el as HTMLElement).style.height) || r.height
    const hasImg = !!el.querySelector('img')
    const hasSvg = !!el.querySelector('svg')
    const hasText = (el.textContent || '').trim().length > 0
    return {
      id: el.id,
      type: hasImg ? "image" : hasSvg ? "shape" : hasText ? "text" : "unknown",
      name: hasText ? (el.textContent || '').trim().slice(0, 80) : undefined,
      bbox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      doc: { x: dx, y: dy, w: dw, h: dh }
    }
  })
```

**Resolution (`resolve(id)`):** `document.getElementById(id)`, re-compute bbox at call time.

**Selection (`selected()`):** `document.querySelector('[role="application"]')?.getAttribute('aria-label')` — returns strings like `"Blue, Circle, Shape"`. Verified live.

**Limitations:**
- Multi-page designs may virtualize off-screen pages. The profile only returns layers currently in the DOM. Documented, not worked around.
- The `name` field for shapes is empty — Canva doesn't put accessible names on shape divs. Users identify shapes by selection-label instead.

### Google Docs profile (facts, not guesses)

**Detection:** `location.host === "docs.google.com"` AND `location.pathname.startsWith("/document/")`.

**Text read (`text()`):** via the hidden text-mirror iframe, verified live:

```typescript
const iframe = document.querySelector(".docs-texteventtarget-iframe") as HTMLIFrameElement | null
if (!iframe) return null
const doc = iframe.contentDocument
if (!doc) return null
const textbox = doc.querySelector('[role="textbox"]') as HTMLElement | null
if (!textbox) return null
return {
  full: textbox.textContent || "",
  html: textbox.innerHTML,
  cursor: { ri: readCursorRi() }  // optional — read .kix-cursor-caret position
}
```

Why this works: the manifest's `all_frames: true` + `match_origin_as_fallback: true` ensures our content script is already running inside that iframe too, AND the parent-frame traversal through `contentDocument` succeeds because `about:blank` inherits the parent origin (`docs.google.com`) — same-origin, no cross-origin wall.

**Text write (`writeAtCursor(text)`):**
1. Focus the text-event-target iframe's `[role=textbox]` element
2. Use `document.execCommand('insertText', false, text)` — deprecated but still works in Chrome's legacy editing surface, which Google Docs literally relies on
3. Alternatively dispatch `InputEvent` with `inputType: "insertText"` — more modern
4. Google's JS reacts to the input event and re-renders the canvas

We'll implement `execCommand('insertText', ...)` first because it's the path Google's own code uses internally, with an `InputEvent` fallback.

**Cursor to position (`cursorTo({x, y})`):** reuse `clickAt(x, y)` on the canvas surface — Google's canvas-click handler automatically moves the cursor to the nearest text position. Proven during PRD-13 session.

**Enumeration (`list()`):** returns the document as a single "page" object per `.kix-page-paginated` element, plus any `.kix-embeddedobjectdragger` elements as embeds. Docs isn't a bag-of-objects editor — it's a stream of text — so `list()` returns structural blocks, not inline text runs. A separate `text()` call returns the actual text.

**Selection (`selected()`):** read `window.getSelection()` — when the text-event iframe is focused, Chrome exposes the selection range. Returns `{ri_start, ri_end, text}` if a range is selected, or `{ri}` for a caret.

**Render surface (for snapshots):** `document.querySelector('.kix-canvas-tile-content') as HTMLCanvasElement` → `canvas.toDataURL('image/png')`. Verified — returns a 36 KB PNG.

**Limitations:**
- The `_docs_annotate_getAnnotatedText` global function is gated on a specific Chrome extension ID. Do not rely on it.
- `document.execCommand` is deprecated by spec but still implemented by Chromium. If Google ever fully removes contenteditable support from the text-event-target iframe, we'd need to switch to a richer InputEvent sequence. We accept this risk.

### Google Slides profile (facts, not guesses)

**Detection:** `location.host === "docs.google.com"` AND `location.pathname.startsWith("/presentation/")`.

**Slide enumeration (`list()`):**

```typescript
const slideGroups = Array.from(document.querySelectorAll('g[id^="filmstrip-slide-"]'))
  .filter(g => !g.id.endsWith("-bg"))
const slides: SceneObject[] = []
const seen = new Set<number>()
for (const g of slideGroups) {
  const m = g.id.match(/^filmstrip-slide-(\d+)-/)
  if (!m) continue
  const index = parseInt(m[1])
  if (seen.has(index)) continue
  seen.add(index)
  const r = g.getBoundingClientRect()
  const img = g.querySelector("image")
  const blobUrl = img?.getAttribute("xlink:href") || img?.getAttribute("href") || undefined
  slides.push({
    id: g.id,
    type: "slide",
    name: `Slide ${index + 1}`,
    bbox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    meta: { index, blob: blobUrl }
  })
}
return slides.sort((a, b) => (a.meta!.index as number) - (b.meta!.index as number))
```

Verified against the SANS deck: 12 slides, stable IDs, stable viewport layout.

**Current slide (`slideCurrent()`):** `document.querySelector('#editor-p > g[id^="editor-gd"]')?.id` — the active slide's ID in the main editor area.

**Slide navigation (`slideGoto(n)`):** click the `filmstrip-slide-<n>-...` group's center. Alternative: dispatch a `keydown` for `PageDown` on `document.body` to advance. We'll implement both, default to filmstrip click.

**Speaker notes (`notes()`):** read `#speakernotes-i3-paragraph-0` → `textContent`. Walk all `speakernotes-i3-paragraph-*` in order for multi-paragraph notes. Verified — the placeholder `"Clicktoaddspeakernotes"` was visible on an empty slide.

**Slide text (`text()` for a specific slide):** Slides bodies are baked into blob URLs. The profile's `render(id)` method returns a data URL (async via the eval fix). Extraction of text from that image is out of scope — that's the vision fallback's job.

**Text editing inside a slide textbox:** same pattern as Docs — double-click to enter edit mode, then the `.docs-texteventtarget-iframe` becomes populated. Phase 4 covers this with the shared "edit-mode" primitive.

### Generic profile (fallback)

**Detection:** always matches last. `detect()` returns `true`.

**Behavior:** re-uses existing slop primitives — `get_a11y_tree`, `click_at`, `find_and_click` — so on an unknown host `slop canvas list` degrades to the accessibility tree. No new behavior, just a consistent command interface.

---

## Command Surface

```
slop canvas list                         List scene objects for the current tab's profile
slop canvas list --type text             Filter by object type
slop canvas list --json                  Raw JSON output

slop canvas click <id>                   Click by stable ID
slop canvas click <id> --os              Trusted OS-level click
slop canvas dblclick <id>                Double-click (activate edit mode on editors that need it)
slop canvas select <id>                  Click + verify selection label changed
slop canvas hit X Y                      "What's at this viewport coordinate?" → scene object ID

slop canvas selected                     Read current selection (profile-specific)

slop canvas text                         Docs: full document text; Slides: current slide text (if available)
slop canvas text --with-html             Include inline styles + range indices
slop canvas insert "text"                Write text at cursor (Docs; Slides when in edit mode)
slop canvas cursor-to <ri>               Move cursor by model offset (Docs only)
slop canvas cursor                       Read current cursor position

slop canvas slide                        Slides: current slide info
slop canvas slide list                   List all slides with stable IDs
slop canvas slide goto <index>           Navigate to slide by index
slop canvas slide next                   Next slide (keyboard)
slop canvas slide prev                   Previous slide
slop canvas notes [--slide N]            Read speaker notes

slop canvas render <id>                  Export a scene object as a PNG data URL
slop canvas render <id> --save           Save to disk

slop canvas zoom                         Read current editor zoom level

slop canvas profile                      Which profile matched this host?
slop canvas profile --verbose            Full profile object dump
```

The **raw JSON output** is always available via `--json`. Default output is a human-readable table.

---

## Implementation Phases

### Phase 0: Async evaluate fix (P0 — blocking prerequisite)

**Files:** `extension/src/background/capabilities/evaluate.ts` (modified)

- [x] 0.1: Change the injected `func` to `async`, await the eval result if it's a Promise, then clone.
- [x] 0.2: Keep the Trusted Types policy creation path intact — Canva/Google Docs both use Trusted Types.
- [x] 0.3: Preserve error handling — a rejection should still return `{success: false, error: err.message}`.
- [x] 0.4: Test with a sync eval: `slop eval --main "1 + 1"` → returns `2`. **Verified — returned `2`.**
- [x] 0.5: Test with an async eval on Slides: `slop eval --main "fetch('<blob-url>').then(r => r.blob()).then(b => ({size: b.size, type: b.type}))"` → returns real size and type. **Verified — returned `{href, size:304491, type:'image/png'}`.**
- [x] 0.6: Test with a rejected promise: `slop eval --main "Promise.reject(new Error('nope'))"` → returns `{success: false, error: 'nope'}`. **Verified — CLI showed `error: nope`.**

**Acceptance criteria:**
- [x] `slop eval --main` returns resolved values for both sync and async expressions. **Verified.**
- [x] No regressions on any existing eval-based capability — existing tests still pass and the LinkedIn / content probe paths use the same code path.

### Phase 1: Scene profile engine + CLI skeleton (P0)

**Files:** `extension/src/content/scene/engine.ts` (new), `extension/src/content/scene/types.ts` (new), `extension/src/content/scene/ops.ts` (new), `extension/src/content/scene/profiles/generic.ts` (new), `extension/src/content.ts` (modified), `extension/src/background/router.ts` (modified), `cli/commands/canvas.ts` (new), `cli/index.ts` (modified), `cli/help.ts` (modified).

- [x] 1.1: Create `extension/src/content/scene/types.ts` with `SceneObject`, `SceneSelection`, `SceneText`, `SceneProfile` interfaces.
- [x] 1.2: Create `extension/src/content/scene/ops.ts` with shared helpers: `clickElementCenter(el)`, `dblclickElementCenter(el)`, `boundingBox(el)`, `parseTranslate(style)`, `focusIframeTextbox(iframe)`, `dispatchKeysIn(target, keys)`. Reuses `input-simulation.ts` primitives.
- [x] 1.3: Create `extension/src/content/scene/profiles/generic.ts` — minimal fallback profile that walks `[role=application]` / `[role=main]` / `[role=document]`.
- [x] 1.4: Create `extension/src/content/scene/engine.ts` with `detectProfile()` + all capability functions + top-level `handleCanvasAction(action)` dispatcher.
- [x] 1.5: Add `scene_*` action handler branch to `extension/src/content.ts` `executeAction` switch. **Note: action type renamed from `canvas_*` to `scene_*` to avoid collision with the existing HTMLCanvasElement handler (`canvas_list`/`canvas_read`/`canvas_diff`).** User-facing CLI command also renamed from `slop canvas` to `slop scene` for the same reason.
- [x] 1.6: Add `SCENE_ACTIONS = new Set([...])` comment marker to `extension/src/background/router.ts`. Actions are forwarded to content script via the existing fallthrough — no new handler needed in background.
- [x] 1.7: Create `cli/commands/scene.ts` with `parseSceneCommand(filtered, jsonMode)` exporting subcommand routing.
- [x] 1.8: Register `SCENE_CMDS = new Set(["scene"])` in `cli/index.ts` and dispatch to `parseSceneCommand`.
- [x] 1.9: Add "Scene Graph" section to `cli/help.ts` (preserved existing "Canvas" section for HTMLCanvasElement commands).
- [x] 1.10: Build — `bash scripts/build.sh` succeeded with zero errors. Extension reloaded, content script re-injected, `slop scene profile` returns `generic` on the live Slides tab, `slop scene list` returns the generic fallback entry.

**Acceptance criteria:**
- [x] `slop scene profile` on any URL returns the detected profile name (or `"generic"`). **Verified on Canva, Docs, Slides.**
- [x] `slop scene list` on the generic profile returns a short fallback entry without crashing. **Verified.**
- [x] `slop scene` help (via `slop scene` with no args) shows all subcommands. **Verified.**
- [x] No regressions in any existing command — `bun test` passes all 31 tests.

### Phase 2: Canva profile (P0)

**Files:** `extension/src/content/scene/profiles/canva.ts` (new), engine wiring (modified).

- [x] 2.1: Create `profiles/canva.ts` with `detect()` checking `location.host.endsWith('canva.com')` AND `location.pathname.includes('/design/')`.
- [x] 2.2: Implement `list()` enumerating `[id^="LB"]` elements. Extract `type` via child content (`img` / `svg` / text). Parse `style.transform: translate(X, Y)` for doc-space coords. Re-compute `bbox` via `getBoundingClientRect()`. Filter out hidden zero-sized elements. **Verified: returns 10 layers on the live Canva design.**
- [x] 2.3: Implement `resolve(id)` with a strict format check (`^LB[A-Za-z0-9_-]{14}$`) and `document.getElementById(id)`.
- [x] 2.4: Implement `selected()` reading `document.querySelector('[role="application"]')?.getAttribute('aria-label')`. **Caveat: Canva only populates this label after an object has been selected interactively at least once.**
- [x] 2.5: Implement `zoom()` by walking ancestors for `style.transform: scale(...)`. **Verified: returned `0.275926` on zoomed-out view.**
- [x] 2.6: Implement click routing via `clickElementCenter` → `clickAtViewport` so ancestor click delegation (which Canva uses) receives the event at the spatial location rather than dispatched directly on the LB element. Added `--os` flag wiring in the CLI for trusted-event escalation when synthetic clicks are swallowed.
- [x] 2.7: Register the Canva profile in engine ahead of the generic fallback.
- [x] 2.8: Build + test: `slop scene list` on the Canva design returns 10 layers. `slop scene hit 414,395` correctly returns the circle `LBKfjtRwQHt7D0Cf`. `slop scene profile` returns `canva`. `slop scene zoom` returns `0.275926`. **Known limitation: Canva's selection state machine requires prior interactive warmup before synthetic clicks update `aria-label` on the `[role=application]` input. `slop scene click <id> --os` is the workaround — reroutes through OS CGEvent to guarantee a trusted hit.**

**Acceptance criteria:**
- [x] `slop scene list` on the Canva design returns 10 layers (5 shapes, 4 images, 1 text). **Verified.**
- [~] `slop scene click LBKfjtRwQHt7D0Cf` — synthetic click dispatches correctly to the computed viewport center; Canva's selection state machine requires prior interactive warmup, so `scene selected` may not update on a fresh page load. `--os` flag is available as a workaround. **Mechanically correct; Canva-specific behavior documented.**
- [x] `slop scene hit 414,395` returns `LBKfjtRwQHt7D0Cf`. **Verified.**
- [x] `slop scene profile` returns `"canva"`. **Verified.**
- [x] `slop scene zoom` returns a number between 0 and 2. **Verified: returned `0.275926` at the current zoom level.**

### Phase 3: Google Docs profile (P0)

**Files:** `extension/src/content/scene/profiles/google-docs.ts` (new), engine wiring.

- [x] 3.1: Create `profiles/google-docs.ts` with `detect()` checking `location.host === "docs.google.com"` AND `location.pathname.startsWith("/document/")`.
- [x] 3.2: Implement `text()` by walking `document.querySelector('.docs-texteventtarget-iframe')` → `contentDocument` → `[role="textbox"]` → read `textContent` and `innerHTML`. **Verified: returned `"Hello thereadfasdafsdasdf"` (25 chars) plus full HTML with `data-ri` offsets, inline image URLs, and a 3×3 table structure.**
- [x] 3.3: Implement `list()` returning `.kix-page-paginated` elements as `type: "page"` objects AND `.kix-embeddedobjectdragger` elements as `type: "embed"` objects. **Verified: returned 2 pages at viewport positions (301,145) and (301,1211) on the SANS Gemini notes doc.**
- [x] 3.4: Implement `writeAtCursor(text)` via `iframe.focus()` + `textbox.focus()` + `document.execCommand('insertText', false, text)` with `InputEvent` fallback. **Verified: inserting `"hello from slop"` into the live doc grew the text from 25 to 40 characters, with the new content at the start.**
- [x] 3.5: Implement `cursorTo({x, y})` via `clickAtViewport(x, y)` on the canvas tile — Google's own click handler positions the cursor.
- [x] 3.6: Implement `selected()` reading the hidden textbox's `contentWindow.getSelection()`.
- [x] 3.7: Implement `render(id)` for `.kix-canvas-tile-content` via `canvas.toDataURL('image/png')`. **Verified: `scene render page-0` returned a 898×1162 PNG data URL.**
- [x] 3.8: Register the Docs profile in engine.
- [x] 3.9: Build + test with a real Google Doc — all end-to-end tests pass against the live SANS Introduction to Security Architecture notes.

**Acceptance criteria:**
- [x] `slop scene text` on an open Google Doc returns the full document text. **Verified: `"Hello thereadfasdafsdasdf"` (25 chars).**
- [x] `slop scene text --with-html` returns inline HTML with `data-ri` attributes, table structure, and embedded image URLs. **Verified.**
- [x] `slop scene insert "hello from slop"` prepends the text — text length grew from 25 to 40 chars, starting with the new string. **Verified (and then undone with `slop keys Meta+z`).**
- [x] `slop scene render page-0` returns a 898×1162 PNG data URL of page 0. **Verified.**
- [x] `slop scene profile` returns `"google-docs"`. **Verified.**

### Phase 4: Google Slides profile (P0)

**Files:** `extension/src/content/scene/profiles/google-slides.ts` (new), engine wiring.

- [x] 4.1: Create `profiles/google-slides.ts` with `detect()` checking `location.host === "docs.google.com"` AND `location.pathname.startsWith("/presentation/")`.
- [x] 4.2: Implement `list()` enumerating `g[id^="filmstrip-slide-"]` elements (excluding `-bg` suffix), one per slide index. Deduplicate by index. **Verified: returned 12 slides with stable IDs and blob URLs on the SANS deck.**
- [x] 4.3: Implement `slideCurrent()` by reading the URL fragment `#slide=id.<pageId>` and matching against the filmstrip thumbnails' `data-slide-page-id` attribute. **Pivoted from the naive `#editor-p > editor-gd*` approach when testing showed the main editor child doesn't update synchronously on hash change.**
- [x] 4.4: Implement `slideGoto(index)` by setting `window.location.hash = "#slide=id." + pageId`. **Pivoted from click dispatching on SVG `<g>` elements and keyboard simulation, both of which Google Slides filters out. The hash-based approach is reliable and triggers Slides' own internal slide-change handler. Verified: `slop scene slide goto 5` switches to slide 5 and `scene slide current` reports index 5.**
- [x] 4.5: Implement `notes(slideIndex?)` by reading `#speakernotes-i*-paragraph-*` textContent (all paragraphs joined with `\n`). Returns notes for the currently-visible slide. **Verified: returned `"Clicktoaddspeakernotes"` placeholder on the live deck.**
- [x] 4.6: Implement `text()` for the currently-active slide via `.docs-texteventtarget-iframe`. Empty until a text box is in edit mode (a documented caveat).
- [x] 4.7: Implement `render(id)` by fetching the SVG `<image>`'s blob URL asynchronously, drawing into an `OffscreenCanvas` via `createImageBitmap`, returning a 1600×900 PNG data URL. **Verified: returned a 1600×900 PNG for `filmstrip-slide-5-gd02e148143_0_12` — requires the Phase 0 async-eval fix to round-trip through slop's eval.**
- [x] 4.8: Register the Slides profile in engine.
- [x] 4.9: Build + test with the SANS deck from session 20bcf316 — all tests pass.

**Acceptance criteria:**
- [x] `slop scene slide list` on the SANS deck returns 12 slides with stable IDs. **Verified.**
- [x] `slop scene slide goto 5` navigates to slide 5 — verified by `slop scene slide current` reporting `"index": 5`. **Verified via URL-hash navigation.**
- [x] `slop scene notes` returns the current slide's speaker notes text (or the placeholder if empty). **Verified: returned `"Clicktoaddspeakernotes"`.**
- [x] `slop scene render filmstrip-slide-5-gd02e148143_0_12` returns a 1600×900 PNG data URL. **Verified.**
- [x] `slop scene profile` returns `"google-slides"`. **Verified.**

### Phase 5: Generic profile + host override (P1)

**Files:** `profiles/generic.ts` (extended), engine (modified).

- [x] 5.1: Extend `profiles/generic.ts` to provide a fallback `list()` that walks `[role=application]`, `[role=main]`, `[role=document]` and returns them as `type: "page"`/`"group"` scene objects.
- [x] 5.2: Add `--profile <name>` flag to CLI so users can force a profile on a host that auto-detection misses (plumbed through `withProfile(action, filtered)` in `cli/commands/scene.ts`).
- [x] 5.3: Add `slop scene profile --verbose` which dumps the profile's registered capabilities. **Verified: returns `{name: "google-slides", capabilities: ["list", "resolve", "selected", "text", "render", "slides", "slideCurrent", "slideGoto", "notes"]}`.**
- [x] 5.4: Every engine function returns actionable missing-capability errors of the form `` `profile 'X' does not support Y()` `` when the active profile doesn't implement a capability.

**Acceptance criteria:**
- [x] `slop scene list` on any page does not crash and returns either the per-host scene objects or the generic fallback entry. **Verified.**
- [x] `slop scene profile --verbose` prints the matched profile and which methods are implemented. **Verified.**

### Phase 6: Documentation + tests (P1)

**Files:** `README.md` (modified), `CLAUDE.md` (modified), `Notes/canvas.md` (new), `test/canvas.test.ts` (new).

- [x] 6.1: Add "Scene Graph" section to `README.md` with examples for all three editors.
- [x] 6.2: Add "Scene-Graph Access" section to `CLAUDE.md` so agents reading it know about the `slop scene` surface.
- [x] 6.3: Create `Notes/scene.md` with per-profile notes, manual smoke-test instructions, and a "how to add a new profile" guide.
- [x] 6.4: Create `test/scene.test.ts` with unit tests for:
  - Canva translate parser (`parseTranslate("translate(61.4815px, 726.581px)")` → `{x: 61.4815, y: 726.581}`)
  - ID prefix matching (`isCanvaLayerId("LBKfjtRwQHt7D0Cf")` → true)
  - Profile detection (`detect("docs.google.com", "/document/...")` → "google-docs")
  - Scene object shape validation (the engine returns the expected structure)
- [x] 6.5: `bun test` passes all tests. **Verified: 31 tests passing (5 daemon-cli + 10 monitor + 16 scene).**
- [x] 6.6: `bash scripts/build.sh` produces clean builds for extension, CLI, daemon. **Verified.**

**Acceptance criteria:**
- [x] Documentation covers the full `slop scene` command set (README.md, CLAUDE.md, Notes/scene.md).
- [x] Test suite includes 16 new scene tests, all passing alongside the 15 pre-existing tests. Total: 31 passing.
- [x] Full project build is clean (`bash scripts/build.sh`).

---

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Canva changes the `LB` prefix or layer class names | Low over 3–6 months; certain over 12+ months | Canva profile breaks | Profile is one file, ~60 lines. Fix is fast. Monitor captures detect the pattern change immediately. |
| Google Docs switches away from canvas rendering | Very low (they spent years moving TO canvas) | No impact — DOM path would come back, making our job easier | — |
| Google Docs removes the hidden text-event-target iframe | Very low (used by every assistive tech | Would break text read/write | Fall back to parsing the canvas via vision — that's what PRD-14's `render` method enables. |
| `document.execCommand('insertText', ...)` gets removed from Chrome | Medium over 24+ months (deprecated per spec, but still used by Google Docs itself) | Text insertion breaks | Fall back to `InputEvent` dispatch. Already scoped in Phase 3.4. |
| `match_origin_as_fallback: true` semantics change | Very low | Content script stops running in `about:blank` iframes | Use the parent-frame `contentDocument` path, which works independently of content-script injection — verified in session. |
| `canvas.toDataURL()` on Google Docs throws tainted-origin | Low | Render fails for Docs pages | Caveat: the rendering canvas uses blob URLs which are same-origin. Tested: `toDataURL` works. If Google ever changes this, the error surfaces as `SecurityError` from the browser and the CLI reports it cleanly. |
| Async eval fix breaks an existing caller that depended on `{}` behavior | Very low | Regression | Add an existing-behavior regression test: a sync eval still returns the sync value. |
| Trusted Types blocks the `createScript` call when we reload the page | Already handled via the `__slop_tt_policy` fallback | — | Current code already handles this with a dated-policy fallback. |
| Shadow DOM hit-test mismatches — clicking the computed center hits a cover layer | Medium | Click fails silently | After dispatching a click, re-read the selection state; if unchanged, retry with an OS-level `os_click` at the same coordinate. Already a pattern in the router's auto-escalation code. |
| Multi-page Canva designs virtualize layers | Medium | `list()` returns only visible page's layers | Document as a limitation. Agent must navigate pages first. Future PRD could add a pagination loop. |
| Google Slides blob URLs are short-lived / GC'd | Low | Render fails | Fetch-and-draw happens synchronously in the same JS turn via the async eval fix — no opportunity for GC. |

---

## Success Metrics

1. **One command reads the full text of any Google Doc.** `slop canvas text` returns the document content including inline HTML.
2. **One command writes text at the cursor of any Google Doc.** `slop canvas insert "text"` updates the doc — verifiable with a round-trip `slop canvas text` read.
3. **One command enumerates every object on a Canva design.** `slop canvas list` on Canva returns every `LB` layer with type, bbox, and doc coordinates.
4. **One command clicks a Canva object by stable ID.** `slop canvas click LBKfjtRwQHt7D0Cf` selects the target — verifiable via `slop canvas selected`.
5. **One command lists every slide in a Google Slides deck.** `slop canvas slide list` returns all slides with stable IDs.
6. **One command navigates to any slide by index.** `slop canvas slide goto 5`.
7. **One command reads speaker notes for the current slide.** `slop canvas notes`.
8. **One command returns a PNG snapshot of any scene object.** `slop canvas render <id> --save`.
9. **Async `slop eval --main` works for promises.** Returns the resolved value, not `{}`.
10. **Zero CDP attachments.** Grep for `chrome.debugger` in the diff produces zero new matches.
11. **All existing tests still pass.** `bun test` → 15 existing + new canvas tests → 0 failures.
12. **Clean build.** `bash scripts/build.sh` → exit code 0, all three bundles produced.

---

## Open Questions (deferred, not blocking)

1. **Should `slop canvas text` on a Slides page return the text of the current slide only, or all slides?** — Default: current slide only. All-slides would require either iterating edit mode on each (intrusive) or vision OCR (out of scope for this PRD).
2. **Should `slop canvas render` default to file output or data URL?** — Default: data URL. `--save` saves to a temp file. Mirrors `slop screenshot`.
3. **Should we add `slop canvas watch` to stream scene changes as they happen?** — Interesting but not in scope. Could be a PRD-15 extension once we know what signals we'd emit.
4. **Should we persist profile matches in a cache?** — No. Profile detection is a 10-element array scan. Cheap.
