# PRD-5: Pixel-Perfect Capture & Canvas Intelligence

**Goal:** Give slop-browser pixel-perfect screenshots (viewport + full-page), canvas/WebGL element inspection, and accurate coordinate-based input on canvas applications — without CDP, without the debugger permission, and without detection.

**Scope:** Changes to `background.ts` (screenshot return path, new `canvas` and `screenshot_full` actions), `content.ts` (drag sequences, canvas element discovery), `cli/index.ts` (new commands), `types.ts` (new action types), a new offscreen document for image stitching. One new manifest permission (`offscreen`). No CDP. No `debugger` permission.

**Motivation:** slop-browser captures screenshots by downloading them to disk and discarding the data URL. Canvas elements are invisible to the agent. Full-page capture doesn't exist. Drag operations on canvas apps silently fail. These four gaps prevent slop-browser from being used for visual QC, canvas-based applications (Figma, Google Sheets, game UIs), and any workflow that needs the agent to *see* what's on screen and compare it against expectations.

These gaps were identified by comparing slop-browser against Anthropic's Claude in Chrome extension (v1.0.47), which uses CDP (`Page.captureScreenshot`, `Input.dispatchMouseEvent`) to solve the same problems. This PRD achieves the same outcomes using only content scripts, `chrome.tabs.captureVisibleTab()`, `chrome.scripting.executeScript()`, `chrome.tabCapture`, and offscreen documents — APIs that produce zero detectable fingerprint.

---

## Evidence Sources

| ID | Source | Path |
|----|--------|------|
| CHR-TABS | Chrome tabs API | `docs/chrome-extensions/docs/extensions/reference/api/tabs.md` |
| CHR-SCR | Chrome scripting API | `docs/chrome-extensions/docs/extensions/reference/api/scripting.md` |
| CHR-OFF | Chrome offscreen API | `docs/chrome-extensions/docs/extensions/reference/api/offscreen.md` |
| CHR-TC | Chrome tabCapture API | `docs/chrome-extensions/docs/extensions/reference/api/tabCapture.md` |
| CHR-SC | Chrome screen capture guide | `docs/chrome-extensions/docs/extensions/how-to/web-platform/screen-capture.md` |
| CHR-CS | Chrome content scripts | `docs/chrome-extensions/docs/extensions/develop/concepts/content-scripts.md` |
| CHR-NM | Chrome native messaging | `docs/chrome-extensions/docs/extensions/develop/concepts/native-messaging.md` |
| CHR-DOM | Chrome dom API | `docs/chrome-extensions/docs/extensions/reference/api/dom.md` |
| BUN-FILE | Bun file I/O | `docs/bun/docs/runtime/file-io.md` |
| BUN-WEB | Bun Web APIs | `docs/bun/docs/runtime/web-apis.md` |
| BUN-STR | Bun streams | `docs/bun/docs/runtime/streams.md` |
| CC-CHR | Claude Code Chrome integration | `docs/claude-code/docs/en/chrome.md` |
| CC-BP | Claude Code best practices | `docs/claude-code/docs/en/best-practices.md` |
| CC-TS | Claude Code troubleshooting | `docs/claude-code/docs/en/troubleshooting.md` |
| REF-ARCH | Claude extension architecture | `research/ClaudeExtension/06_Core_Architecture.md` |
| REF-EXT | Claude extension system | `research/ClaudeExtension/07_Extension_System.md` |

All doc paths are relative to `/Volumes/VRAM/80-89_Resources/80_Reference/`.

---

## Design Decision: No CDP for Capture or Input

Before specifying changes, this PRD justifies the core constraint: no `chrome.debugger` for screenshots, canvas reading, or input simulation.

**Why CDP is unnecessary:**

1. **`captureVisibleTab()` IS pixel-perfect.** It captures Chrome's actual composited output — the GPU-rendered frame, including canvas, WebGL, video, SVG, and all CSS effects. **[CHR-TABS, line 566]**: "Captures the visible area of the currently active tab." This is the same composited frame that `Page.captureScreenshot` provides via CDP. The only functional difference is that CDP supports `captureBeyondViewport` (full-page) and `clip` (region) parameters. Both can be replicated via scroll+stitch and crop.

2. **`executeScript({ world: "MAIN" })` gives full canvas access.** **[CHR-SCR, lines 299-303]**: `ExecutionWorld "MAIN"` — "Specifies the main world of the DOM, which is the execution environment shared with the host page's JavaScript." This means `canvas.toDataURL()`, `canvas.getContext('2d').getImageData()`, and `gl.readPixels()` are all callable. slop-browser already has this wired up via the `evaluate` action at `background.ts:628`.

3. **Synthetic DOM events work on canvas applications.** Canvas apps bind event listeners to the `<canvas>` DOM element via `addEventListener()`. Content script synthetic events (`new MouseEvent(...)`, `new KeyboardEvent(...)`) fire on the same element and are received by those listeners. The `event.clientX/clientY` coordinates are computed from `getBoundingClientRect()`, which is identical to how canvas apps resolve click positions internally.

4. **CDP triggers the debugger infobar.** **[REF-ARCH]**: Claude in Chrome requires `debugger` permission and `chrome.debugger.attach()` which shows a yellow "debugging this tab" banner. Anti-bot systems (Cloudflare, DataDome) detect CDP attachment. slop-browser's core differentiator is undetectability.

**What this PRD does NOT solve (and doesn't need to):**
- Pointer lock (FPS games using `requestPointerLock()`) — rare use case, out of scope
- GPU shader inspection (reading individual shader outputs) — requires WebGL debug contexts, out of scope

---

## Phase 1: Screenshot Data Return

### 1.1 Return Data URL from Screenshot

**Problem:** `screenshot` action at `background.ts:242-268` calls `captureVisibleTab()`, gets a data URL, then immediately downloads it to disk via `chrome.downloads.download()`. The data URL — the useful part for agent visual analysis — is discarded. The agent receives only a file path, which it cannot use for pixel comparison, diff detection, or any visual intelligence.

**Evidence:**
- **[CHR-TABS, lines 559-587]**: `captureVisibleTab()` returns `Promise<string>` — the string is a data URL (`data:image/png;base64,...` or `data:image/jpeg;base64,...`). This is the full pixel-perfect image in a format the agent can reason about.
- **[CC-BP, lines 33-41]**: Claude Code best practices: "Claude performs dramatically better when it can verify its own work, like run tests, compare screenshots, and validate outputs." — The agent needs the image data, not a file path.
- **[CHR-NM, line 108]**: "The maximum size of a single message from the native messaging host is 1 MB" — however, the limit for messages *to* the native host is 64 MiB. The 1 MB limit is from host → Chrome. Since our data flows Chrome → daemon → CLI (not through native messaging outbound limit), and our daemon uses Unix domain sockets (no message size limit), this is not a constraint. The extension → daemon direction uses native messaging where the response goes extension → Chrome → daemon stdout. The 1 MB limit applies here. A 1920×1080 JPEG at quality 50 is ~100-200 KB base64. PNG is larger (~2-4 MB). For safety, JPEG should be the default.

**Fix:** Return the data URL directly in the response. Optionally save to disk when `--save` flag is passed. JPEG quality 50 (default) keeps responses well under the 1 MB native messaging limit.

**Files:** `extension/src/background.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] `slop screenshot` returns `{ data: "<data_url>", format: "jpeg", size: <bytes> }` in the response
- [x] `slop screenshot --save` additionally downloads to disk and returns the file path
- [x] `slop screenshot --format png` returns PNG (with warning if size exceeds 800 KB)
- [x] `slop screenshot --quality 80` controls JPEG quality (0-100)
- [x] Default format is JPEG at quality 50 to stay under native messaging 1 MB limit

---

### 1.2 Screenshot Region Crop

**Problem:** No way to capture a specific region of the page. The agent must capture the entire viewport and has no way to isolate a specific element or coordinate region.

**Evidence:**
- **[CHR-TABS, lines 559-587]**: `captureVisibleTab()` captures the entire visible viewport. There is no `clip` parameter (unlike CDP's `Page.captureScreenshot`).
- **[CHR-SCR, lines 106-152]**: `executeScript({ func, args })` can pass arguments to injected functions and return results. This enables running crop logic in an offscreen document.
- **[CHR-OFF, lines 36-47]**: Offscreen documents provide DOM access including `<canvas>`, `<img>`, and `URL.createObjectURL()` — everything needed for image manipulation without a visible window.

**Fix:** After `captureVisibleTab()`, if a `clip` region is specified, load the data URL into an `<img>` in an offscreen document, draw the specified region onto a `<canvas>`, and export the cropped result via `canvas.toDataURL()`. The offscreen document provides a DOM (canvas, img) that the service worker lacks.

**Files:** `extension/src/background.ts`, new `extension/offscreen.html`, new `extension/offscreen.js`

**Acceptance Criteria:**
- [x] `slop screenshot --clip 100,200,500,300` captures a 500×300 region starting at (100,200)
- [x] `slop screenshot --element 5` captures the bounding rect of element at index 5
- [x] Offscreen document created with `BLOBS` reason, closed after crop completes
- [x] Crop coordinates are in CSS pixels (matching `getBoundingClientRect()`)
- [x] If clip extends beyond viewport, returns available region without error

---

## Phase 2: Full-Page Screenshot

### 2.1 Scroll + Stitch Capture

**Problem:** `captureVisibleTab()` captures only the visible viewport. For pages taller than one screen (virtually all real web pages), there is no way to capture the full page content. Agents performing visual QC, design verification, or content extraction need the entire page.

**Evidence:**
- **[CHR-TABS, line 517-525]**: `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` is 2. "captureVisibleTab is expensive and should not be called too often." This means a 5-viewport page takes ~2.5 seconds to capture — acceptable for a full-page screenshot operation.
- **[CHR-OFF, lines 162-207]**: Offscreen document reasons include `BLOBS` ("needs to interact with Blob objects including URL.createObjectURL()") and `DOM_PARSER`. `BLOBS` is sufficient for canvas image stitching.
- **[CHR-CS, lines 10]**: "Content scripts can read details of the web pages the browser visits, make changes to them" — the content script can read `document.body.scrollHeight`, `window.innerHeight`, and programmatically scroll the page.
- **[CC-BP, lines 39-41]**: "Verify UI changes visually... take a screenshot of the result and compare it to the original. list differences and fix them." — This workflow requires full-page capture for pages with scrollable content.

**Fix:**
1. Content script reports page dimensions: `{ scrollHeight, scrollWidth, viewportHeight, viewportWidth, devicePixelRatio }`
2. Background script calculates viewport chunks: `Math.ceil(scrollHeight / viewportHeight)` strips
3. For each strip: content script scrolls to position → `captureVisibleTab()` → store data URL
4. All data URLs sent to offscreen document
5. Offscreen document creates a canvas (`scrollWidth × scrollHeight` pixels), loads each strip as an `<img>`, draws at correct y-offset, exports final stitched image
6. Rate-limited at 2 captures/sec per `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`

**Files:** `extension/src/background.ts`, `extension/src/content.ts`, `extension/offscreen.html`, `extension/offscreen.js`, `cli/index.ts`, `extension/src/types.ts`

**Acceptance Criteria:**
- [x] `slop screenshot --full` captures entire scrollable page
- [x] Scroll position restored to original after capture completes
- [ ] Fixed-position elements (navbars, sticky headers) handled: captured only in first strip, masked in subsequent strips via CSS `position: relative` override
- [x] Rate-limited to 2 `captureVisibleTab()` calls per second
- [ ] Progress reported: `"capturing strip 3/7..."`
- [x] Result returned as data URL (JPEG) or saved to disk with `--save`
- [ ] Horizontal scrolling supported for wide pages
- [x] `devicePixelRatio` respected for retina displays

---

### 2.2 TabCapture Stream Mode (Optional, High-Performance)

**Problem:** The scroll+stitch approach is limited to 2 frames/sec by `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`. For live monitoring, visual regression testing, or recording workflows, higher framerate capture is needed.

**Evidence:**
- **[CHR-TC, lines 21-22]**: "Use the chrome.tabCapture API to interact with tab media streams." The API provides a continuous `MediaStream` containing video of the tab's rendered content.
- **[CHR-TC, lines 37-66]**: `getMediaStreamId({ targetTabId })` returns a stream ID. In the offscreen document: `getUserMedia({ video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: id } } })` produces a `MediaStream`.
- **[CHR-SC, lines 34-67]**: Full working example: service worker gets stream ID → sends to offscreen document → offscreen document calls `getUserMedia()` → receives live MediaStream. The offscreen document has a DOM and can render to `<video>` + `<canvas>`.
- **[CHR-OFF, lines 184-185]**: `USER_MEDIA` reason: "needs to interact with media streams from user media (e.g. getUserMedia())." This is the correct reason for tabCapture stream consumption.
- **[CHR-TC, line 25]**: "When a MediaStream is obtained for a tab, audio in that tab will no longer be played to the user." Must re-route audio to prevent silence: `new AudioContext() → createMediaStreamSource(stream) → connect(destination)`.

**Fix:** Add `tabCapture` permission. Background script gets stream ID via `chrome.tabCapture.getMediaStreamId()`. Offscreen document (`USER_MEDIA` reason) consumes the stream. Renders `<video>` frames to `<canvas>`. The `canvas.getImageData()` call provides pixel data at any framerate the browser can deliver (~30-60 fps). Audio re-routed to prevent silence.

**Files:** `extension/manifest.json`, `extension/src/background.ts`, `extension/offscreen.html`, `extension/offscreen.js`

**Acceptance Criteria:**
- [x] `slop capture start` begins continuous tab capture
- [x] `slop capture frame` returns current frame as data URL (no 2/sec limit)
- [x] `slop capture stop` stops capture and releases MediaStream
- [x] Audio continues playing to user during capture
- [x] Stream ID obtained from service worker, consumed in offscreen document
- [x] Offscreen document created with `USER_MEDIA` reason
- [x] Tab capture indicator (Chrome's built-in blue recording icon) is visible to user

---

## Phase 3: Canvas Intelligence

### 3.1 Canvas Element Discovery

**Problem:** The agent has no way to discover canvas elements on a page, determine their type (2D, WebGL, WebGL2), or read their dimensions. Canvas elements are often the primary interaction surface on modern web applications (Figma, Canva, Google Sheets charts, game UIs, data visualizations).

**Evidence:**
- **[CHR-SCR, lines 299-303]**: `ExecutionWorld "MAIN"` allows execution in the page's JavaScript context, which is required to call `canvas.getContext()` (returns the existing context, not a new one, when one already exists).
- **[CHR-CS, lines 31-35]**: Content scripts run in an isolated world — "JavaScript variables in an extension's content scripts are not visible to the host page." This means the content script CANNOT access canvas rendering contexts directly. The MAIN world execution via `chrome.scripting.executeScript()` is required.
- **Current code, background.ts:628-656**: The `evaluate` action already supports `world: "MAIN"`. Canvas discovery is a wrapper around this capability.

**Fix:** Add a `canvas_list` action that runs in MAIN world. For each `<canvas>` element on the page: report index, dimensions (`width`, `height`), bounding rect, context type (inspected via `canvas.__slop_ctx_type` tag or `getContext()` probe), and whether it has event listeners (via `getEventListeners()` if available, or checking `onclick`/`onmousedown` attributes).

**Files:** `extension/src/background.ts`, `cli/index.ts`, `extension/src/types.ts`

**Acceptance Criteria:**
- [x] `slop canvas list` returns all `<canvas>` elements with index, dimensions, context type, bounding rect
- [x] Context type detection: "2d", "webgl", "webgl2", "bitmaprenderer", or "none" (no context created)
- [x] Elements with zero dimensions or `display: none` marked as hidden
- [x] Shadow DOM canvases discovered via `chrome.dom.openOrClosedShadowRoot()` (**[CHR-DOM, lines 21-27]**)
- [ ] Each canvas assigned a stable ref ID (consistent with existing element ref system)

---

### 3.2 Canvas Pixel Reading

**Problem:** The agent cannot read pixel data from canvas elements. This is required for visual verification (does the canvas render correctly?), data extraction (reading chart values), and comparison (did the canvas change between actions?).

**Evidence:**
- **[CHR-SCR, lines 299-303]**: MAIN world execution required — canvas contexts are page-global state.
- **[CHR-SCR, lines 440-484]**: `executeScript({ func, args, world: "MAIN" })` — `func` is serialized and deserialized. Arguments must be JSON-serializable. Return values must be JSON-serializable. This means `getImageData()` (which returns `ImageData` with a `Uint8ClampedArray`) must be converted to a serializable format before return.
- **[CHR-NM, line 108]**: Native messaging 1 MB response limit. A full 1920×1080 canvas `getImageData()` is 8.3 MB raw RGBA. Must use `toDataURL()` (JPEG compression) for full-canvas reads, or `getImageData()` for small regions only.
- **[BUN-WEB, line 21]**: Bun supports `atob` and `btoa` for base64 encoding/decoding — the CLI can decode data URLs returned from the extension.

**Fix:** Add `canvas_read` action. For 2D canvases: `canvas.toDataURL(format, quality)` returns a compressed data URL. For pixel-level reads of small regions: `ctx.getImageData(x, y, w, h)` with the RGBA data converted to a base64 string. For WebGL: inject a `requestAnimationFrame` callback that calls `gl.readPixels()` within the same frame as the render (required because WebGL clears the backbuffer after compositing unless `preserveDrawingBuffer: true`).

**Files:** `extension/src/background.ts`, `cli/index.ts`, `extension/src/types.ts`

**Acceptance Criteria:**
- [x] `slop canvas read 0` returns `toDataURL()` of canvas at index 0 (JPEG default)
- [x] `slop canvas read 0 --format png` returns PNG data URL
- [x] `slop canvas read 0 --region 10,20,100,50` returns `getImageData()` for specified region as base64
- [x] `slop canvas read 0 --webgl` handles WebGL canvases via `requestAnimationFrame` + `readPixels()`
- [x] Response size stays under 1 MB (JPEG compression, warn if exceeding)
- [x] Error returned if canvas has no context or is tainted (cross-origin)

---

### 3.3 Canvas Visual Diff

**Problem:** The agent cannot compare two canvas states. After performing an action on a canvas application, the agent has no way to determine what changed visually.

**Evidence:**
- **[CC-BP, lines 39-41]**: "take a screenshot of the result and compare it to the original. list differences and fix them" — This is the visual verification pattern Claude Code recommends.
- **[CHR-OFF, lines 178-179]**: `BLOBS` reason for offscreen documents allows `URL.createObjectURL()` and canvas manipulation — sufficient for pixel diffing.

**Fix:** Add `canvas_diff` action. Takes two data URLs (or captures before/after from a specified canvas), loads both into an offscreen document, draws onto two canvases, and computes a per-pixel diff. Returns: changed pixel count, changed percentage, bounding box of changed region, and optionally a diff image (pixels that changed highlighted in red).

**Files:** `extension/src/background.ts`, `extension/offscreen.html`, `extension/offscreen.js`, `cli/index.ts`, `extension/src/types.ts`

**Acceptance Criteria:**
- [x] `slop canvas diff <dataUrl1> <dataUrl2>` computes pixel diff
- [ ] `slop canvas diff 0 --before-after "slop click 5"` captures canvas 0 before and after an action
- [x] Returns `{ changedPixels, totalPixels, changedPercent, boundingBox: { x, y, w, h } }`
- [x] `--threshold 10` sets per-channel tolerance (0-255) for "same" vs "changed"
- [x] `--image` flag returns a diff visualization as data URL
- [x] Uses offscreen document for canvas comparison (service worker has no DOM)

---

## Phase 4: Canvas Input Accuracy

### 4.1 Coordinate-Based Click

**Problem:** Current `dispatchClickSequence()` at `content.ts:914-928` computes click coordinates as the center of the element's bounding rect. For canvas applications, the agent needs to click at specific pixel coordinates within the canvas — not the center of the canvas element.

**Evidence:**
- **[CHR-CS, lines 10]**: Content scripts can "read details of the web pages the browser visits, make changes to them" — this includes dispatching events with arbitrary coordinates.
- **Current code, content.ts:914-918**: `const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;` — hardcoded center. No way to pass target coordinates.

**Fix:** Add `x` and `y` optional parameters to click actions. When present, the content script dispatches the click event at `rect.left + x` and `rect.top + y` (canvas-relative coordinates converted to viewport-relative). When absent, existing center-click behavior preserved.

**Files:** `extension/src/content.ts`, `extension/src/types.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] `slop click 3 --at 150,200` clicks canvas at index 3 at coordinates (150, 200) relative to the canvas
- [x] Coordinates are canvas-relative (0,0 = top-left of canvas element)
- [x] Content script converts to viewport coordinates: `canvasRect.left + x`, `canvasRect.top + y`
- [x] Works for all click types: click, dblclick, rightclick
- [x] Without `--at`, existing center-click behavior unchanged

---

### 4.2 Drag Action

**Problem:** No drag action exists. `dispatchClickSequence()` fires `pointerdown` → `pointerup` → `click` with no intermediate `pointermove` events. Canvas applications that rely on drag gestures (drawing, selecting regions, moving objects, resizing) receive a click instead of a drag.

**Evidence:**
- **[CHR-CS, lines 10]**: Content scripts can dispatch any DOM event including PointerEvent with `movementX`/`movementY` properties.
- **Current code, content.ts:914-928**: Event sequence is over → down → focus → up → click. No moves between down and up.
- **[REF-EXT]**: Claude in Chrome implements drag via CDP `Input.dispatchMouseEvent` with a sequence of `mousePressed` → multiple `mouseMoved` → `mouseReleased`. The same logical sequence can be replicated with DOM synthetic events.

**Fix:** Add a `drag` action type. Parameters: element index (or start coordinates), end coordinates, optional intermediate waypoints, step count, and duration. The content script dispatches: `pointerdown` at start → N `pointermove` events interpolated between start and end (with correct `movementX`/`movementY` deltas) → `pointerup` at end. Steps distributed over the specified duration using `requestAnimationFrame` for smooth timing.

**Files:** `extension/src/content.ts`, `extension/src/types.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] `slop drag 3 --from 100,100 --to 300,200` drags from (100,100) to (300,200) on element 3
- [x] `slop drag 3 --from 100,100 --to 300,200 --steps 20` generates 20 intermediate pointermove events
- [x] Default step count: 10 (sufficient for most drag detection)
- [x] Each `pointermove` includes correct `movementX`, `movementY`, `clientX`, `clientY`
- [x] `pointerdown` at start, `pointerup` at end
- [x] Coordinates are element-relative (converted to viewport-relative internally)
- [x] `--duration 500` spreads moves over 500ms using setTimeout
- [x] Without `--duration`, moves are dispatched synchronously (instant drag)

---

### 4.3 Hover with Movement

**Problem:** `dispatchHoverSequence()` at `content.ts:930-940` dispatches `pointerover` → `mouseover` → `pointermove` → `mousemove` at the element center. Canvas applications that track continuous mouse movement (hover states, tooltips, highlight effects) need a sequence of `mousemove` events along a path to the target, not a single jump.

**Evidence:**
- **Current code, content.ts:930-940**: Single pointermove/mousemove at center coordinates. No path simulation.

**Fix:** Add optional `--from` parameter to hover. When present, dispatches a sequence of `pointermove`/`mousemove` events interpolated from the starting position to the target element center. Default: 5 intermediate moves.

**Files:** `extension/src/content.ts`, `extension/src/types.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] `slop hover 3 --from 0,0` simulates mouse movement from (0,0) to center of element 3
- [x] `slop hover 3 --from 0,0 --steps 10` generates 10 intermediate move events
- [x] Without `--from`, existing instant-hover behavior preserved
- [x] Each move event includes correct `clientX`, `clientY`, `movementX`, `movementY`

---

## Phase 5: Manifest & Infrastructure

### 5.1 Offscreen Document

**Problem:** Service workers have no DOM. Image stitching (Phase 2), image cropping (Phase 1.2), and pixel diffing (Phase 3.3) all require `<canvas>`, `<img>`, and `<video>` elements that only exist in a DOM context.

**Evidence:**
- **[CHR-OFF, lines 36-41]**: "Service workers don't have DOM access... The Offscreen API allows the extension to use DOM APIs in a hidden document without interrupting the user experience."
- **[CHR-OFF, lines 44-47]**: "An installed extension can only have one open at a time." — Must manage lifecycle: create for image operations, close when done. Multiple operations must share the single document.
- **[CHR-OFF, lines 67-96]**: Lifecycle example using `runtime.getContexts()` to check for existing offscreen documents before creating.

**Fix:** Add `extension/offscreen.html` (static HTML bundled with extension) and `extension/offscreen.js`. The offscreen document accepts messages via `chrome.runtime.onMessage` and performs: image crop, image stitch, pixel diff, and tabCapture stream rendering. The background script manages lifecycle: creates the document before operations, reuses if already open, closes after a 30-second idle timeout.

**Files:** new `extension/offscreen.html`, new `extension/offscreen.js`, `extension/src/background.ts`, `extension/manifest.json`

**Acceptance Criteria:**
- [x] `offscreen` permission added to manifest
- [x] Offscreen document created with `BLOBS` reason (or `USER_MEDIA` for tabCapture)
- [x] Only one offscreen document open at a time (lifecycle managed)
- [x] 30-second idle timeout closes the document
- [x] Message passing via `chrome.runtime.sendMessage` / `chrome.runtime.onMessage`
- [x] Operations: `crop`, `stitch`, `diff`, `stream-frame`

---

### 5.2 CLI Command Surface

**Problem:** New capabilities need CLI commands that follow existing patterns.

**Evidence:**
- **Current code, cli/index.ts**: All 50+ commands follow the pattern: parse args → construct action object → send via socket → format response.
- **[BUN-FILE, lines 17-36]**: `Bun.file()` and `Bun.write()` for saving screenshot data to disk when `--save` is used. `BunFile` conforms to `Blob` interface with `.arrayBuffer()` and `.bytes()` for binary operations.
- **[BUN-WEB, line 21]**: `atob`/`btoa` available in Bun for base64 encode/decode of data URLs.

**Fix:** Add the following commands to `cli/index.ts`:

| Command | Action Type | Description |
|---------|------------|-------------|
| `slop screenshot` | `screenshot` | Viewport screenshot (returns data URL) |
| `slop screenshot --full` | `screenshot_full` | Full-page scroll+stitch |
| `slop screenshot --clip X,Y,W,H` | `screenshot` + `crop` | Region capture |
| `slop screenshot --element N` | `screenshot` + `crop` | Element bounding rect |
| `slop screenshot --save` | `screenshot` | Save to disk (existing behavior) |
| `slop canvas list` | `canvas_list` | Discover canvas elements |
| `slop canvas read N` | `canvas_read` | Read canvas as data URL |
| `slop canvas read N --region X,Y,W,H` | `canvas_read` | Read canvas region pixels |
| `slop canvas diff URL1 URL2` | `canvas_diff` | Pixel diff between two images |
| `slop capture start` | `capture_start` | Begin tabCapture stream |
| `slop capture frame` | `capture_frame` | Get current frame from stream |
| `slop capture stop` | `capture_stop` | Stop capture |
| `slop click N --at X,Y` | `click` | Coordinate-targeted click |
| `slop drag N --from X,Y --to X,Y` | `drag` | Drag gesture |

**Files:** `cli/index.ts`, `extension/src/types.ts`

**Acceptance Criteria:**
- [x] All commands listed above functional
- [x] `--json` flag returns structured JSON (existing pattern)
- [x] Plain text output for human-readable default (existing pattern)
- [x] `slop help` updated with new commands
- [x] Data URLs returned inline in response (not downloaded unless `--save`)

---

## Implementation Order

| Priority | Phase | Effort | Why |
|----------|-------|--------|-----|
| **P0** | 1.1 — Return data URL | 30 min | One-line change, unlocks all visual intelligence |
| **P0** | 3.1 — Canvas list | 1 hr | Requires only MAIN world evaluate wrapper |
| **P0** | 3.2 — Canvas read | 1 hr | Same mechanism as 3.1 |
| **P0** | 4.1 — Coordinate click | 30 min | Add `x,y` params to existing click handler |
| **P1** | 4.2 — Drag action | 2 hr | New action type, interpolated moves |
| **P1** | 5.1 — Offscreen document | 2 hr | Infrastructure for Phases 1.2, 2, 3.3 |
| **P1** | 1.2 — Region crop | 1 hr | Depends on 5.1 |
| **P1** | 2.1 — Full-page screenshot | 3 hr | Depends on 5.1, complex scroll logic |
| **P2** | 3.3 — Canvas diff | 2 hr | Depends on 5.1 |
| **P2** | 4.3 — Hover with movement | 1 hr | Enhancement to existing hover |
| **P2** | 2.2 — TabCapture stream | 3 hr | New permission, complex offscreen lifecycle |
| **P2** | 5.2 — CLI commands | 2 hr | Depends on all above |

**Total estimated effort:** ~19 hours across 12 work items.

---

## New Permissions

| Permission | Required By | Justification |
|-----------|-------------|---------------|
| `offscreen` | Phase 1.2, 2.1, 3.3 | DOM access for canvas image operations in hidden document |
| `tabCapture` | Phase 2.2 only | Optional. Continuous MediaStream capture for high-framerate monitoring |

No `debugger` permission. No CDP. No detection surface.
