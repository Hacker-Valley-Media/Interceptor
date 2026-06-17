---
mechanic: blob-export-capture
authored_by: claude-opus-4.7
last_validated: 2026-04-30
interceptor_min_version: 0.8.0
tags: [blob, url-create-object-url, download-suppression, native-export, webapp-render]
---

# Blob-Export Capture (capture native client-side renders without download dialogs)

## Goal

Capture the exact bytes any modern webapp produces when it offers "Export as PNG/PDF/SVG/etc." — without ever showing the user a Save dialog, without the file landing in the Downloads folder, and without using the OS clipboard. Works on any app that renders client-side (browser-based design tools, slide editors, diagramming apps, photo editors) where the export pipeline is `render → Blob → URL.createObjectURL → <a download>.click()`.

Companion to `canvas-rendered-editor-input.md` and `canvas-camera-overlays.md`. Same `userActivation` foundation, but instead of dispatching events, this one **intercepts the app's own output**.

## What works

Three pillars:

1. **Patch `URL.createObjectURL`** to record every `Blob` the app stages for download. The patch runs in MAIN world via `interceptor eval --main` and survives the rest of the session.
2. **Patch `HTMLAnchorElement.prototype.click`** to suppress auto-downloads. Most webapps trigger downloads programmatically with `<a download href="blob:...">.click()` — gating that single method in MAIN world prevents the OS Save UI from ever appearing while still letting the blob exist (it's already been staged before `.click()` runs).
3. **Read the blob via `fetch(blobUrl).then(r => r.arrayBuffer())`** — the URL stays valid until `URL.revokeObjectURL` is called or the document is unloaded. Fetching it returns the same bytes the browser would have written to disk.

```js
// Run inside `interceptor eval --main "..."` once per tab.
(()=>{
  if(window.__interceptor_export_patches)return{already:true};
  window.__interceptor_export_patches=true;
  window.__interceptor_blobs=[];        // every blob URL created in this tab
  window.__interceptor_suppressed=0;    // count of suppressed downloads

  // 1. Capture every blob URL the app creates
  const origCreate=URL.createObjectURL;
  URL.createObjectURL=function(obj){
    const url=origCreate.apply(this,arguments);
    if(obj instanceof Blob){
      window.__interceptor_blobs.push({url, type:obj.type, size:obj.size, t:Date.now()});
    }
    return url;
  };

  // 2. Suppress the auto-download click that would pop the Save dialog
  const origClick=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){
    if(this.hasAttribute('download')||(this.href&&this.href.startsWith('blob:'))){
      window.__interceptor_suppressed++;
      return;        // swallow it
    }
    return origClick.apply(this,arguments);
  };

  // 3. Bonus: block the File System Access Save picker if the app uses it
  if(window.showSaveFilePicker){
    window.showSaveFilePicker=function(){
      window.__interceptor_suppressed++;
      return Promise.reject(new DOMException('AbortError','AbortError'));
    };
  }

  return{installed:true};
})()
```

After install, trigger the app's export UI (button click, keyboard shortcut, menu item — whatever the app exposes). The blob URL appears in `window.__interceptor_blobs` within milliseconds. Read its bytes:

```js
(async()=>{
  const blob=window.__interceptor_blobs[window.__interceptor_blobs.length-1];
  const resp=await fetch(blob.url);
  const ab=await resp.arrayBuffer();
  const bytes=new Uint8Array(ab);
  // Stash as base64 for chunked retrieval via interceptor eval (eval result is capped ~50KB)
  let bin='';for(let i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);
  window.__interceptor_last_export=btoa(bin);
  return{size:bytes.length, type:blob.type, b64Length:window.__interceptor_last_export.length};
})()
```

Then pull the base64 out from the shell side in chunks:

```bash
out=/tmp/export.b64; > "$out"; chunkSize=40000; i=0
while :; do
  start=$((i * chunkSize))
  resp=$(./dist/interceptor eval --main "window.__interceptor_last_export.slice($start,$start+$chunkSize)")
  chunk=$(echo "$resp" | sed -n '2,$p' | tr -d '"\n')
  if [ -z "$chunk" ]; then break; fi
  printf "%s" "$chunk" >> "$out"
  i=$((i+1))
  if [ ${#chunk} -lt $chunkSize ]; then break; fi
done
base64 -D < "$out" > /tmp/export.png
file /tmp/export.png
```

## URL patterns + state

- **Blob URLs** look like `blob:https://<origin>/<uuid>` and are only valid in the document that created them.
- They survive across tab focus changes and idle time but **die on page reload** or explicit `URL.revokeObjectURL(url)`.
- For long-running captures, fetch and stash bytes immediately — don't trust that a captured URL will still be valid 10 seconds later if the app's UI does a "render again" cycle.

## Private API endpoints + payload shape

Not relevant — this mechanic operates one layer below the app's wire layer. The render runs in the page's own JS (WebGL, Canvas2D, SVG-to-PNG), and the resulting bytes are produced as a `Blob` before ever hitting the network. No HTTP request is involved in the capture path.

For apps that DO render server-side (return a PNG over HTTP), the existing `extension/src/inject-net.ts` `fetch`/`XHR` patches already capture the response bytes — use `interceptor net log --filter <render-endpoint>` instead of this mechanic.

## Stable hooks

- `URL.createObjectURL` — defined in the WHATWG File API, present in every browser since 2011. Stable name, stable signature.
- `HTMLAnchorElement.prototype.click` — defined in HTML Living Standard. Stable.
- `Blob.prototype.size` and `Blob.prototype.type` — used to filter to specific output types (e.g. only `image/png`).

## Selectors that look right but break

- ❌ `URL.createObjectURL.bind(URL)` — binding the original loses the chance to wrap. Always reassign through the prototype-style pattern: `const orig = URL.createObjectURL; URL.createObjectURL = function(...){ ... orig.apply(this, arguments) }`.
- ❌ Patching `HTMLAnchorElement.prototype.click` AFTER the app has already cached a reference to it — install the patch before any export interaction. Most apps grab `click` lazily on each export, so install in MAIN world via `interceptor eval --main` immediately after page load is fine.
- ❌ Reading `Blob` bytes with `FileReader.readAsDataURL(blob)` — works but is slower than `fetch(blobUrl).arrayBuffer()` and produces an extra base64 conversion roundtrip.
- ❌ Suppressing via `event.preventDefault()` on a `click` listener — many apps don't go through DOM events, they call `el.click()` directly which bypasses listener-level prevention. The prototype patch is the only reliable choke point.

## Waits + reasons

- After triggering the export UI → wait **300 ms to ~5 s** depending on render complexity. Small frames render in <500 ms; large frames or vector-heavy designs can take 2–5 s.
- Poll `window.__interceptor_blobs.length` until it grows past the pre-trigger snapshot, with a timeout cap (~6 s).
- For batch exports (loops), wait at least 800 ms between iterations to avoid the app coalescing rapid-fire clicks.

## Traps

1. **Eval result is capped at ~50 KB.** Big PNGs (1 MB+) won't return through a single `eval --main`. Stash on `window.__interceptor_*` first, then chunk-extract via `slice(start, start+40000)` calls in a shell loop.
2. **Blob URLs can be revoked.** Some apps call `URL.revokeObjectURL` immediately after `.click()`. To survive revocation, also patch `revokeObjectURL` to defer (or just fetch the blob bytes within the same async tick).
3. **The download-suppression patch hides downloads from the USER too.** If you want some legitimate user-driven downloads to still work, gate the suppression on a flag (`window.__interceptor_suppress_enabled = false` by default; flip it on only during automated exports).
4. **`<a download>` without `href.startsWith('blob:')` is sometimes a real link** — the bundled suppression check covers both, which can over-suppress. Tighten to `this.href && this.href.startsWith('blob:')` only if you want non-blob downloads to pass through.
5. **Two blobs in flight at once** (the app re-renders before the previous blob is read) can race. Track blobs by index from a snapshot taken before each trigger: `const before = __interceptor_blobs.length; ...trigger... const newBlobs = __interceptor_blobs.slice(before);`.
6. **Programmatic clicks via `dispatchEvent(new MouseEvent('click'))` bypass `prototype.click`** but still produce the blob. The capture still works; only the suppression part may need to also stop dispatched-click events via a capture-phase document listener if the app uses that path. Most apps use direct `.click()` — test both per app.
7. **Cross-origin blobs**: some apps create blobs whose origin differs from the document. Those still appear in `URL.createObjectURL` and are still fetchable from the same document. No CORS issue because the app's own code created the blob.

## Why this works (architecture)

`URL.createObjectURL` is the universal staging point for **any** client-side-produced binary asset destined for either a `<a download>`, an `<img src=...>`, or a `<video src=...>` reference. Every modern webapp that renders without a server roundtrip lands at this function. By patching it once in MAIN world, you get a complete inventory of every binary output the page produces — exports, thumbnails, image processing results, generated audio clips — all without touching the app's specific render code.

The download suppression is mechanically separate but logically paired. The browser's "Save As" UI is triggered by user-initiated `<a download>.click()`. Webapps that auto-download replace the user click with a programmatic one, but they still go through `HTMLAnchorElement.prototype.click`. Patching that single method swallows every programmatic auto-download globally without affecting genuine user clicks elsewhere on the page (those go through the browser's internal click pipeline, not the prototype method).

The `userActivation` override (in `extension/src/inject-net.ts`) isn't strictly required for THIS mechanic since blob creation doesn't gate on activation — but the export UI clicks that trigger the rendering DO often gate on it. So the load-bearing pre-load patch is still needed for the trigger half, even though the capture half stands alone.

## Generic flow (composable)

```
[install patches] (once per tab)
  ↓
[trigger app's export UI] (varies per app — button click, keyboard shortcut, menu walk)
  ↓
[poll window.__interceptor_blobs for new entry] (300ms–5s)
  ↓
[fetch blob URL → arrayBuffer → base64-stash on window]
  ↓
[chunk-extract base64 from shell side]
  ↓
[base64 -D > final.png/pdf/svg]
```

Each stage is independent. If a particular app needs a different trigger (right-click menu, drag-and-drop, paste a URL into a field), only the trigger stage changes — the capture/extract stages are universal.

## See also

- [canvas-rendered-editor-input.md](canvas-rendered-editor-input.md) — companion mechanic for driving canvas-rendered text editors via dispatched events.
- [canvas-camera-overlays.md](canvas-camera-overlays.md) — companion mechanic for canvas-rendered camera/map apps.
- Domain-skill examples that use this mechanic: see the `workflows/` directory for app-specific export trigger sequences.
