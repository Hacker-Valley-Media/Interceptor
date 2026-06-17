---
site: docs.google.com
flow: fill-empty-table-cells
authored_by: claude-opus-4.7
last_validated: 2026-04-29
interceptor_min_version: 0.8.0
tags: [google-docs, tables, mirror-row, canvas-input]
---

# Google Docs — Fill empty table cells (mirror row above)

## Goal

For each empty cell in a Docs table, write the text of the cell directly above it — proven on a 3-table doc (4-col + 3-col + 3-col) with no `chrome.debugger`, no OS keyboard, no synthetic clicks visible to detection.

## What works

```bash
# 1. Open the doc — pre-load trust overrides install automatically.
interceptor open "https://docs.google.com/document/d/<id>/edit?tab=t.0"

# 2. Read every table to compute the fill data.
interceptor eval --main "(()=>{const tb=document.querySelector('.docs-texteventtarget-iframe').contentDocument.querySelector('[role=textbox]');return JSON.parse(JSON.stringify(Array.from(tb.querySelectorAll('table')).map(t=>Array.from(t.rows).map(r=>Array.from(r.cells).map(c=>(c.textContent||'').trim())))))})()"

# 3. For each table:
#    a. Click on the canvas at a Y inside the empty row to position the caret.
#    b. Read iframe selection to confirm {tableIdx, rowIdx, cellIdx}.
#    c. Type the source value (one keydown+keypress+keyup sequence per char).
#    d. Tab to the next cell (keydown+keyup ONLY — no keypress).
#    e. After the last cell of row N, do NOT Tab again (would create row N+1).
```

Per-cell click + type pattern (single inline `eval --main`):

```js
const tile = document.querySelector('.kix-canvas-tile-content');
const r = tile.getBoundingClientRect();
['mousedown','mouseup','click'].forEach(t => {
  const e = new MouseEvent(t, { bubbles:true, cancelable:true, view:window,
    clientX: Math.round(r.x + 150), clientY: Math.round(r.y + 200),  // tune Y per table
    button: 0, buttons: 1 });
  e.__interceptor_trust = true;
  tile.dispatchEvent(e);
});
```

Tuned Y offsets observed in practice (canvas-relative; canvas tile starts at viewport ~94, 145):
- Table 0 row 1 cell 0: canvas y ≈ 200
- Table 1 row 1 cell 0: canvas y ≈ 340
- Table 2 row 1 cell 0: canvas y ≈ 490

These vary per doc — always verify by reading `iwin.getSelection()` after the click.

## URL patterns

- Editor: `https://docs.google.com/document/d/<docId>/edit`
- Tabs feature: `?tab=t.0` is supported; detect via `pathname.startsWith('/document/')`.

## Private APIs

Not consumed directly. Docs auto-syncs accepted edits via:
- `navigator.sendBeacon` to `https://play.google.com/log?...` (telemetry; size grows with edit volume)
- Internal `mutate` POSTs to the doc backend (visible in `interceptor net log`)
- No WebSocket frames observed for this flow (Docs uses long-poll / fetch for live edits, not WS)

## Stable selectors

- `.docs-texteventtarget-iframe` → `.contentDocument.querySelector('[role=textbox]')` — the doc model mirror; iterate `.querySelectorAll('table')` then `t.rows[i].cells[j]`
- `.kix-canvas-tile-content` — click target for caret positioning
- `.kix-cursor-caret` — caret indicator; `.getBoundingClientRect()` shows current position
- `iwin.getSelection().anchorNode` parent chain — find the `<TD>` to identify current cell

## Anti-pattern selectors

- ❌ Iframe `<td>.getBoundingClientRect()` — iframe is offscreen, rects are not viewport-aligned
- ❌ Setting `Selection.setBaseAndExtent()` into an iframe `<td>` then dispatching InputEvent — dirties the mirror but does NOT propagate to canvas model
- ❌ Per-instance `Object.defineProperty(event, 'isTrusted', ...)` — Chrome's own property is non-configurable; can't redefine

## Waits

- ~120ms after click for iframe selection to commit
- ~30–80ms between keystroke dispatches (under 20ms causes coalescing/drops)
- ~150ms after Tab before reading new cell (table layout reflow)

## Traps

- **`keypress` for navigation keys** inserts ASCII chars: ArrowUp(38)=`&`, Tab(9)=`\t`, ArrowLeft(37)=`%`, ArrowRight(39)=`'`. Rule: keydown+keypress+keyup for printable, keydown+keyup ONLY for navigation.
- **Tab past last cell of last row creates a new row.** Fill row 1 with N writes and N-1 Tabs; exit with `ArrowDown`.
- **Iframe selection null until textbox focused.** Run `tet.focus(); tb.focus()` once at session start.
- **Tables on canvas have zero per-cell DOM annotations.** Computing cell pixel coords requires trial-click + iframe-selection readback.
- **Cmd+Z works** if you accidentally insert a stray character before noticing the dispatch bug.

## Companion paragraph-style change

Apply Heading 1 to a body paragraph (e.g. a "Table 3" label) by setting the iframe selection into the `<p>` and dispatching `Cmd+Option+1`:

```js
// Position caret in the target paragraph
const tb = document.querySelector('.docs-texteventtarget-iframe').contentDocument.querySelector('[role=textbox]');
const p = Array.from(tb.querySelectorAll('p,h1,h2,h3,h4,h5,h6')).find(x => x.textContent.trim() === 'Table 3');
const sel = p.ownerDocument.defaultView.getSelection();
const r = p.ownerDocument.createRange();
r.selectNodeContents(p); r.collapse(true);
sel.removeAllRanges(); sel.addRange(r);

// Dispatch Cmd+Option+1
const iwin = p.ownerDocument.defaultView;
const idoc = p.ownerDocument;
const dk = (et, init) => {
  const e = new iwin.KeyboardEvent(et, Object.assign({ bubbles:true, cancelable:true, composed:true, view:iwin }, init));
  Object.defineProperties(e, { keyCode:{value:init.keyCode}, which:{value:init.keyCode}, key:{value:init.key}, code:{value:init.code} });
  idoc.dispatchEvent(e);
};
dk('keydown', { key:'Meta', code:'MetaLeft', keyCode:91 });
dk('keydown', { key:'Alt',  code:'AltLeft',  keyCode:18, metaKey:true });
dk('keydown', { key:'1',    code:'Digit1',   keyCode:49, metaKey:true, altKey:true });
dk('keyup',   { key:'1',    code:'Digit1',   keyCode:49, metaKey:true, altKey:true });
dk('keyup',   { key:'Alt',  code:'AltLeft',  keyCode:18, metaKey:true });
dk('keyup',   { key:'Meta', code:'MetaLeft', keyCode:91 });
```

Verify: `tb.querySelectorAll('h1')` should now include the converted paragraph.

## See also

- [canvas-rendered-editor-input.md](../references/canvas-rendered-editor-input.md) — the underlying mechanic, applies to Slides/Sheets/Canva equivalently.
