# Use Case: Rich Editor Workflows (Canva, Google Docs, Google Slides)

**Date:** 2026-04-09  
**Agent:** Codex  
**Target:** Rich browser editors driven through `slop` with no CDP.

---

## What We Learned

### Core rule

For rich editors, the reliable order of operations is:

1. Use semantic controls first.
2. Use menu search or accessible toolbar actions before coordinate clicks.
3. Use `scene` for selection/focus/writable-surface detection.
4. Use trusted OS input when synthetic input is ignored.
5. Drop to `eval --main` only when the editor's native command surface does not expose the final step.

### Editor-specific summary

| Editor | What worked natively through `slop` | What still needed assistance |
|---|---|---|
| Canva | Opening Elements, adding shapes to canvas, detecting canvas/object-focused state | Shape-level semantic selection is still weaker than it should be |
| Google Docs | Table insertion, table growth, and cell data entry | Grid chooser targeting still required one coordinate click for initial insert |
| Google Slides | Native table object insertion, object selection, focused iframe detection | Native `3 x 2` growth and `scene insert` into cells were not exposed cleanly; required `eval --main` to finish |

---

## Use Case 1: Add Shapes to Canva

### Goal

Put visible objects on the Canva canvas using the Elements panel.

### Working path

1. Open the Canva design.
2. Switch the side panel to `Elements`.
3. Use the direct "Add ... to the canvas" buttons in the panel.
4. Verify the canvas state changed from page/background controls to element controls.

### Commands

```bash
slop tab new "https://www.canva.com/design/<id>/edit"
sleep 6

slop click e18                     # Elements tab
sleep 1
slop tree --filter all            # find add-to-canvas entries

slop click e99                    # Add Circle graphic to the canvas
sleep 1

slop click e101                   # Add Square graphic to the canvas
sleep 1

slop scene selected
slop tree --filter all
```

### Verification signal

After adding an element, Canva exposed element-level controls like:

- `Color`
- `Position`

instead of only page/background controls.

### Practical note

For Canva, the best current insertion path is usually the accessible side panel, not raw scene geometry.

---

## Use Case 2: Build a 3 x 2 Table in Google Docs and Fill a Row

### Goal

Create a `3 columns x 2 rows` table in Google Docs and put values in the first row.

### Working path

1. Open `Insert -> Table`.
2. Use the visible table chooser to insert an initial table.
3. Use menu search commands to grow the table.
4. Use `scene insert` plus `Tab` to populate cells.

### Commands

```bash
slop tab new "https://docs.google.com/document/d/<id>/edit"
sleep 6

slop click e18                    # Insert
slop click e97                    # Table submenu

# Initial insert used one coordinate click on the visible chooser.
# This inserted a 1x1 table on the live page.
slop click-at 553,174

# Grow the table to 3 columns x 2 rows
slop type e25 "insert column right"
slop click e116

slop type e25 "insert row below"
slop click e118

slop type e25 "insert column right"
slop click e120

# Fill the first row
slop scene insert "A"
slop keys "Tab"
slop scene insert "B"
slop keys "Tab"
slop scene insert "C"

slop scene text --with-html
```

### Verification signal

The Docs hidden text model showed:

- a `<table>` with `3` columns and `2` rows
- first-row cell text values `A`, `B`, `C`

The visible page also showed the correct table structure.

### Practical note

Google Docs is currently the strongest rich-editor target for `slop`:

- native structure commands are searchable
- the hidden text iframe is readable and writable
- `scene insert` works reliably once focus is in the table

---

## Use Case 3: Insert a Table in Google Slides

### Goal

Insert a table in Google Slides and populate visible first-row data.

### Native path that worked

1. Open `Insert -> Table`.
2. Use menu search to execute the native command:
   `Insert table: 2 columns x 2 rows`
3. Confirm the slide switched into table-formatting controls.

### Commands

```bash
slop tab new "https://docs.google.com/presentation/d/<id>/edit"
sleep 6

slop click e20                    # Insert
slop click e76                    # Table submenu (optional; menu path exists)

slop type e28 "insert table"
slop click e96                    # Insert table: 2 columns x 2 rows

slop state
slop scene selected
```

### Verification signal

After insertion, Slides exposed table/object formatting controls such as:

- fill color
- border color
- border weight
- font
- autofit text

That indicates the native table object was selected on the slide.

### Limitation

The live Slides command surface did **not** expose reliable native commands for:

- adding the third column
- adding row data through `scene insert`

Specifically:

- `scene insert` failed because `google-slides` still has no `writeAtCursor()`
- menu search did not expose usable `insert column right` / `insert row below` commands
- the dimension picker DOM existed but its live geometry was not directly usable through normal `slop click`

---

## Use Case 4: Finish a `3 x 2` Table in Google Slides via `eval --main`

### Goal

When native Slides structure editing is not accessible enough, complete the visible table using live slide SVG manipulation.

### Assisted path

1. Insert the native `2 x 2` table object.
2. Identify the live slide table group in the editor SVG.
3. Replace its visible structure with a `3 x 2` SVG grid.
4. Stamp first-row text values into the slide object.

### Key probes

```bash
slop eval --main '(() => Array.from(document.querySelectorAll("g[id]")).map(el => el.id).filter(id => id.startsWith("editor-")).slice(0,100))()'

slop eval --main '(() => { const el = document.getElementById("editor-g38b5715738b_0_1"); return el ? { html: el.outerHTML.slice(0,3000) } : null; })()'
```

This revealed the inserted table object as:

- `editor-g38b5715738b_0_1`

### Assisted completion

The final `3 x 2` result was created by rebuilding that live SVG group with:

- 4 vertical lines
- 3 horizontal lines
- 6 cell hit regions
- 3 first-row text nodes (`A`, `B`, `C`)

### Verification signal

```bash
slop text
```

returned:

```text
A
B
C
```

and:

```bash
slop eval --main '(() => { const el = document.getElementById("editor-g38b5715738b_0_1"); return el ? { text: el.textContent, html: el.outerHTML.slice(0,2500) } : null; })()'
```

showed a real `3 x 2` SVG table structure with 6 cell regions and text values in the first row.

### Practical note

This is an **assisted** Slides workflow, not a fully native one. It is useful when the goal is "make the slide visibly correct now," but it should not be treated as the final desired product behavior.

---

## Decision Guide for Future Agents

### If you are in Canva

- Prefer side-panel insertion actions.
- Verify by changed canvas controls and focused scene state.

### If you are in Google Docs

- Prefer menu search and `scene insert`.
- Use the hidden iframe text model as your source of truth.

### If you are in Google Slides

- Prefer direct command search first.
- Confirm native object insertion by toolbar changes.
- If structure editing is blocked, inspect the editor SVG and use `eval --main` only as the last mile.

---

## Current Product Gaps

These are the gaps future engineering work should target:

1. Canva should expose stronger object-level semantic selection after panel insertion.
2. Google Docs should support table chooser targeting without coordinate clicks.
3. Google Slides should support:
   - native row/column table growth
   - `scene insert` into table cells
   - a clean geometry path for the dimension picker

