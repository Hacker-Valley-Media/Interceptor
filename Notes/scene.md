# `slop scene` — Scene-Graph Access

## What it is

`slop scene` is a profile-driven command surface for reading and manipulating objects inside DOM-rendered visual editors — **without CDP, without screenshots, without vision models**.

The key insight: most editors that look like they render to `<canvas>` actually maintain a shadow DOM (Canva), SVG scene graph (Google Slides), or hidden text-mirror iframe (Google Docs) that an agent can address directly. Each editor gets a **profile** — one file under `extension/src/content/scene/profiles/` — that knows how to enumerate, click, read, and write its scene objects.

## Supported profiles (today)

| Profile | Host | Path match | What works |
|---|---|---|---|
| `canva` | `canva.com` | `/design/*` | `list`, `click`, `selected`, `zoom`, `hit` |
| `google-docs` | `docs.google.com` | `/document/*` | `text`, `text --with-html`, `insert`, `list` (pages + embeds), `render` |
| `google-slides` | `docs.google.com` | `/presentation/*` | `list` (slides), `slide current/goto/list`, `notes`, `render`, `text` (in edit mode) |
| `generic` | fallback | any | `list` (role=application/main/document), `selected` |

## Command surface

```
slop scene profile [--verbose]           Detect active profile + capabilities
slop scene list [--type <t>]             Enumerate scene objects
slop scene click <id> [--os]             Click by stable id
slop scene dblclick <id>                 Double-click
slop scene hit <x>,<y>                   What scene object is at viewport X,Y
slop scene selected                      Read current selection
slop scene zoom                          Read editor zoom factor

slop scene text [--with-html]            Read document text (Docs hidden iframe mirror)
slop scene insert "<text>"               Insert text at cursor (Docs execCommand insertText)
slop scene cursor <x>,<y>                Move cursor by clicking on the canvas tile

slop scene slide list                    List all slides
slop scene slide current                 Show current slide
slop scene slide goto <n>                Navigate via URL fragment
slop scene slide <n>                     Shorthand
slop scene notes [--slide <n>]           Read speaker notes

slop scene render <id> [--save]          Render scene object to PNG
slop scene ... --profile <name>          Force a profile
```

## Manual smoke test

### Canva

```bash
slop tab new "https://www.canva.com/design/<docId>/edit"
sleep 8
slop scene profile                       # → canva
slop scene list                          # → array of LB… layer objects
slop scene zoom                          # → 0.x (editor zoom factor)
slop scene click LB<id>                  # dispatches click at viewport center
slop scene selected                      # reads [role=application] aria-label
```

Known limitation: Canva's selection machine sometimes requires prior interactive warmup. If `scene selected` doesn't update after a scene click, re-run with `--os` to force a CGEvent trusted click.

### Google Docs

```bash
slop tab new "https://docs.google.com/document/d/<docId>/edit"
sleep 8
slop scene profile                       # → google-docs
slop scene text                          # full document text (textContent)
slop scene text --with-html              # includes HTML + data-ri offsets
slop scene insert "hello from slop"      # insert at cursor
slop scene text                          # verify the insert landed
slop keys Meta+z                         # undo the insert
slop scene render page-0 --save          # renders a canvas tile PNG
```

### Google Slides

```bash
slop tab new "https://docs.google.com/presentation/d/<docId>/edit"
sleep 8
slop scene profile                       # → google-slides
slop scene slide list                    # all slides with blob URLs
slop scene slide goto 5                  # navigate (URL-hash method)
slop scene slide current                 # → index 5
slop scene notes                         # speaker notes of current slide
slop scene render filmstrip-slide-5-gd<hash>_0_12
```

Known limitation: Slides filmstrip thumbnails filter synthetic clicks AND synthetic keys. `slideGoto` uses URL-hash navigation instead. Slide content text (`scene text`) only appears when a text box is actively being edited — the hidden iframe is empty in view mode.

## Adding a new profile

1. Create `extension/src/content/scene/profiles/<name>.ts`:
    ```ts
    import type { SceneProfile } from "../types"
    export const myProfile: SceneProfile = {
      name: "my-editor",
      detect() { return location.host.endsWith("myeditor.com") },
      list() { /* enumerate addressable objects */ return [] },
      resolve(id) { return document.getElementById(id) },
      selected() { return { has: false } },
      // add other capabilities as needed
    }
    ```
2. Register the profile in `extension/src/content/scene/engine.ts`:
    ```ts
    import { myProfile } from "./profiles/my-editor"
    // inside ensureBuiltins:
    profiles.push(myProfile)
    ```
3. Rebuild (`bash scripts/build.sh`), reload the extension (`slop reload`), test.

A profile only needs to implement the capabilities it supports. The engine returns actionable errors (`profile 'X' does not support Y()`) for missing methods.

## Architecture notes (grounded evidence)

- **Canva layer IDs** — Empirically observed on session 77907634 via `document.querySelectorAll('[id^="LB"]')`. 10 layers detected. Survived a full `slop navigate` reload. Format: `^LB[A-Za-z0-9_-]{14}$`.
- **Docs text-mirror iframe** — Documented at `.docs-texteventtarget-iframe > [role=textbox]`. Confirmed via `iframe.contentDocument.querySelector('[role=textbox]').innerHTML` on session 20bcf316: full document HTML with `data-ri="<N>"` spans.
- **Slides filmstrip pattern** — 12 slides on the SANS deck, IDs `filmstrip-slide-<index>-gd02e148143_0_<M>`. Real slide page IDs carried on `data-slide-page-id` attribute of `.punch-filmstrip-thumbnail` ancestor. URL fragment `#slide=id.<pageId>` is the authoritative navigation mechanism.
- **Async eval prerequisite** — `chrome.scripting.executeScript` awaits promise return values natively, per `chrome-extensions/docs/extensions/reference/api/scripting.md` line 194. PRD-14 Phase 0 fixes slop's evaluate handler to preserve this semantic, which unlocks `scene render` for Slides (async `fetch` + `createImageBitmap` + `toDataURL`).

## References

- PRD-14 — full design + checklist in `prd/PRD-14.md`
- `extension/src/content/scene/` — profile implementations
- `cli/commands/scene.ts` — CLI parsing
- `extension/src/background/capabilities/evaluate.ts` — Phase 0 async fix
