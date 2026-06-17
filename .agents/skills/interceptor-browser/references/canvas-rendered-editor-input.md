---
mechanic: canvas-rendered-editor-input
authored_by: claude-opus-4.7
last_validated: 2026-04-29
interceptor_min_version: 0.8.0
tags: [google-docs, google-slides, canvas, trusted-input, iframe-keyboard, user-activation]
---

# Canvas-Rendered Editor Input (Google Docs / Slides / Sheets pattern)

## Goal

Drive caret positioning, text entry, and keyboard shortcuts inside canvas-rendered editors (Google Docs, Slides, Sheets) without OS-level CGEvent input, without `chrome.debugger`, and without the macOS bridge — using only the Interceptor extension's pre-load MAIN-world inject + `interceptor eval --main`.

## What works

The technique has three pillars:

1. **Pre-load `userActivation` override** (already shipped in `extension/src/inject-net.ts` at `document_start`, MAIN world). Page reads of `navigator.userActivation.isActive` and `hasBeenActive` always return `true`. This unlocks `execCommand`, `dispatched InputEvent`, and trusted-input gates that the editor checks against transient activation. No per-page setup needed — load once, applies to every page.
2. **Cell-precise caret positioning via dispatched MouseEvent on the canvas tile.** Click events tagged with `event.__interceptor_trust = true` and dispatched on `.kix-canvas-tile-content` move Docs' canvas-side caret. The trust marker is read by Docs' own click handler when it consults the (overridden) page state.
3. **Text entry via `KeyboardEvent` constructed from the iframe's OWN window** (`iwin.KeyboardEvent`), dispatched on the iframe document (`idoc.dispatchEvent(ev)`). Docs treats events created by the iframe's constructor as legitimate keyboard input even though `event.isTrusted` reads `false`.

```js
// Run inside `interceptor eval --main "..."`.
const tet  = document.querySelector('.docs-texteventtarget-iframe');
const iwin = tet.contentWindow;
const idoc = tet.contentDocument;
const tile = document.querySelector('.kix-canvas-tile-content');

// 1) position caret in a specific cell — adjust ty until iframe selection
//    reports the target {tableIdx, rowIdx, cellIdx}
const r = tile.getBoundingClientRect();
['mousedown','mouseup','click'].forEach(t => {
  const e = new MouseEvent(t, { bubbles:true, cancelable:true, view:window,
    clientX: Math.round(r.x + 150), clientY: Math.round(r.y + 200),
    button: 0, buttons: 1 });
  e.__interceptor_trust = true;          // read by Docs' click handler
  tile.dispatchEvent(e);
});

// 2) type a printable character (full keydown → keypress → keyup)
function dispatchKey(type, init) {
  const ev = new iwin.KeyboardEvent(type, Object.assign(
    { bubbles:true, cancelable:true, composed:true, view:iwin }, init));
  Object.defineProperties(ev, {
    keyCode: { value: init.keyCode }, which: { value: init.keyCode },
    key:     { value: init.key },     code:  { value: init.code }
  });
  idoc.dispatchEvent(ev);
}
const c = { key:'C', code:'KeyC', keyCode:67, shiftKey:true };
dispatchKey('keydown', { key:'Shift', code:'ShiftLeft', keyCode:16 });
dispatchKey('keydown', c); dispatchKey('keypress', c); dispatchKey('keyup', c);
dispatchKey('keyup',   { key:'Shift', code:'ShiftLeft', keyCode:16 });

// 3) navigate (Tab to next cell — keydown + keyup ONLY, no keypress)
dispatchKey('keydown', { key:'Tab', code:'Tab', keyCode:9 });
dispatchKey('keyup',   { key:'Tab', code:'Tab', keyCode:9 });
```

## URL patterns + required params

- Google Docs: `https://docs.google.com/document/<id>/edit` — works with or without `?tab=t.0`
- Google Slides: `https://docs.google.com/presentation/<id>/edit`
- Google Sheets: `https://docs.google.com/spreadsheets/<id>/edit` (same pattern; cell selection differs)

## Private API endpoints + payload shape

Not relevant for this mechanic — the technique operates at the DOM/event layer, not the wire layer. (Docs' own sync to `mutate`/`bind` endpoints fires automatically once the input is accepted.)

## Stable selectors

- `.docs-texteventtarget-iframe` — the hidden iframe Docs uses for text events. Stable across years; survives all Docs UI revisions.
- `.kix-canvas-tile-content` — the visible canvas tile. Use as the click target for caret positioning.
- `.kix-cursor-caret` — the caret indicator. `.getBoundingClientRect()` reports the current canvas-side caret position, useful for verifying clicks landed.
- `iwin.getSelection().anchorNode` — climbing parents to find the nearest `<TD>` identifies the current cell. The iframe selection updates whenever a `KeyboardEvent` navigation succeeds.

## Selectors that look right but break

- ❌ The iframe's `<td>` `.getBoundingClientRect()` — iframe is offscreen (`docs-offscreen-z-index`), so cell rects are not at canvas pixel coordinates.
- ❌ Setting `Selection.setBaseAndExtent()` into an iframe `<td>` and dispatching `InputEvent` — iframe DOM mirror IS dirtied (visible in `.textContent`) but Docs **does not propagate that change to the canvas model**. The iframe selection is read-only from Docs' perspective; only navigation-driven selection updates count.
- ❌ `event.isTrusted` override on `Event.prototype` — Chrome installs `isTrusted` as a **non-configurable own property** on every Event instance at construction time. The prototype getter is shadowed and never consulted. Use `userActivation` override instead (which IS effective).
- ❌ Using the OUTER window's `KeyboardEvent` constructor (`new KeyboardEvent(...)`) and dispatching to the iframe document — Docs' event router rejects events whose `view` doesn't match the iframe's contentWindow.

## Waits + reasons

- After dispatched click → wait ~120ms before reading iframe selection. Docs commits the selection asynchronously after click handling.
- Between keystroke dispatches → 30–80ms is enough; under 20ms causes Docs to coalesce or drop events.
- After `Tab` → wait ~150ms before checking new cell. Tab navigation triggers a layout re-flow.

## Traps

1. **`keypress` for navigation keys silently inserts ASCII characters.** ArrowUp `keyCode 38` = `&`; Tab `keyCode 9` = `\t`; ArrowLeft `37` = `%`; ArrowRight `39` = `'`. Real browsers NEVER fire `keypress` for non-printable keys — match that. Rule: keydown + keypress + keyup for **printable keys only** (letters, digits, symbols, Space, Enter); keydown + keyup ONLY for **navigation/control keys** (Tab, Arrow*, Home, End, Escape, Backspace, Delete, modifiers).
2. **Tab past the last cell of the last row CREATES a new row.** Fill row 1 with N cells via `Tab × (N-1)` between writes — do NOT Tab a Nth time. Exit the table with `ArrowDown` instead.
3. **Iframe selection is null until the iframe textbox is focused** (`tet.focus(); tb.focus()`). Do this once at session start; subsequent navigation keeps it tracked.
4. **Canvas-side caret and iframe selection can diverge.** If `.kix-cursor-caret` rect changes but `iwin.getSelection().anchorNode` doesn't update, the keyboard event reached Docs but the iframe didn't get the focus echo. Re-focus the iframe textbox.
5. **Tables on the canvas have ZERO per-cell DOM annotations.** No `.kix-table-cell`, no overlay rects, no aria roles. Pixel coordinates for cells must be discovered by trial click + iframe-selection readback (the `<td>` chain in `iwin.getSelection().anchorNode`'s parent walk).
6. **Cmd+Z works for undo** — useful for recovering from stray `(`/`%`/`&` inserts caused by trap #1 before you noticed.
7. **Page reload preserves the trust overrides** because they live in `inject-net.ts` running at `document_start`. But any per-tab `eval --main` state (probes, recorded coords) is lost.

## Verifying caret position

```js
// Run after each navigation key — returns {tableIdx, rowIdx, cellIdx, cellText} or null
(() => {
  const t = document.querySelector('.docs-texteventtarget-iframe');
  const tb = t.contentDocument.querySelector('[role=textbox]');
  const s = t.contentWindow.getSelection();
  if (!s || !s.anchorNode) return null;
  let n = s.anchorNode;
  while (n && !(n.nodeType===1 && n.tagName==='TD')) n = n.parentNode;
  if (!n) return { inBody: true };
  const tr = n.parentNode;
  const tbl = tr.parentNode.tagName==='TABLE' ? tr.parentNode : tr.parentNode.parentNode;
  return {
    tableIdx: Array.from(tb.querySelectorAll('table')).indexOf(tbl),
    rowIdx:   Array.from(tbl.rows).indexOf(tr),
    cellIdx:  Array.from(tr.cells).indexOf(n),
    cellText: (n.textContent||'').trim()
  };
})()
```

## Why this works (architecture)

`extension/src/inject-net.ts:5-29` defines two pre-load overrides that run at `document_start` in MAIN world on `<all_urls>`:

- `Event.prototype.isTrusted` getter — checks `event.__interceptor_trust === true` first, then falls back to native (note: only effective for sites that read isTrusted via the prototype chain — Docs reads via the per-instance own property which is non-configurable, so this override is informational for Docs but useful elsewhere).
- `navigator.userActivation.isActive` and `hasBeenActive` — always `true`. **This is the load-bearing override for Docs.** It satisfies the transient-activation gate that browsers attach to `execCommand`, `Selection`-driven mutation APIs, and dispatched `InputEvent` propagation.

No `chrome.debugger`, no yellow banner, no detection signal. The page sees an extension script that ran before its own bundle loaded; the page-side checks for activation pass; the dispatched events propagate as if from real user input.
