# `slop scene` — Adaptive Rich-Editor Access

## What it is

`slop scene` is the command surface for interacting with rich browser editors without CDP and without relying on brittle product-specific DOM ids in the core path.

The core model is now:

1. Discover editor surfaces from browser-visible capabilities.
2. Resolve scene ids to geometry and optional underlying elements.
3. Click by browser hit-testing first, escalate to trusted OS input when needed.
4. Read and write through the editor-owned writable surface that currently has focus.

Site-specific profiles still exist where they provide materially better capabilities, but they are treated as optional thin adapters instead of the foundation.

## Strategy Model

### Generic

The generic strategy is the fallback for modern editors and is capability-driven. It discovers scene objects from:

- semantic roots such as `role=application`, `role=document`, and `role=main`
- structural page surfaces such as `data-page-id`, large SVG/canvas surfaces, and large transformed containers
- focused writable surfaces such as `input`, `textarea`, `contenteditable`, `role=textbox`, and hidden proxy inputs
- viewport hit-testing through `document.elementFromPoint()`

Generic scene ids are synthetic and session-stable. They are cached and re-resolved against the live DOM at dispatch time.

### Google Docs

Google Docs still benefits from a dedicated profile because it exposes a hidden text-event-target iframe that provides full text read/write even though the visible page is canvas-backed.

### Google Slides

Google Slides still benefits from a dedicated profile because it exposes stable filmstrip slide objects, hash-based navigation, and DOM-readable speaker notes.

### Canva

`canva` remains available only as an optional adapter alias. It delegates to the adaptive discovery path rather than depending on vendor-specific layer ids in the core path.

## Command Surface

```bash
slop scene profile [--verbose]           Detect active profile/strategy + capabilities
slop scene list [--type <t>]             Enumerate scene objects on the current editor surface
slop scene click <id> [--os]             Click by scene id; `--os` forces trusted input
slop scene dblclick <id>                 Double-click a scene object
slop scene hit <x>,<y>                   Identify the scene object at viewport X,Y
slop scene selected                      Read the current selection / focused editor surface
slop scene zoom                          Read editor zoom factor when supported

slop scene text [--with-html]            Read editor text when the active surface supports it
slop scene insert "<text>"               Insert text into the focused editor-owned writable surface
slop scene cursor <x>,<y>                Move cursor by clicking at viewport X,Y

slop scene slide list                    List all slides (Slides profile)
slop scene slide current                 Show current slide (Slides profile)
slop scene slide goto <n>                Navigate via URL fragment (Slides profile)
slop scene notes [--slide <n>]           Read speaker notes (Slides profile)

slop scene render <id> [--save]          Render scene object to PNG when supported
slop scene ... --profile <name>          Force a profile/strategy
```

## Manual smoke test

### Generic rich editor

```bash
slop tab new "https://example-editor.invalid/"
sleep 8
slop scene profile --verbose             # strategy + capabilities
slop scene list                          # scene ids from semantics / structure / focus
slop scene click <id>                    # synthetic click at resolved center
slop scene click <id> --os               # trusted OS click at resolved center
slop scene selected                      # focused writable/editor surface
slop scene insert "hello from slop"      # if a writable surface is focused
```

### Google Docs

```bash
slop tab new "https://docs.google.com/document/d/<id>/edit"
sleep 8
slop scene profile --verbose
slop scene text
slop scene text --with-html
slop scene insert "hello from slop"
slop scene render page-0 --save
```

### Google Slides

```bash
slop tab new "https://docs.google.com/presentation/d/<id>/edit"
sleep 8
slop scene profile --verbose
slop scene slide list
slop scene slide goto 5
slop scene slide current
slop scene notes
slop scene render <slide-id> --save
```

## Adding a thin adapter

Only add a site-specific adapter if the adaptive path cannot provide enough addressability.

1. Start by checking whether semantics, structure, focus, and hit-testing are already sufficient.
2. If not, create `extension/src/content/scene/profiles/<name>.ts`.
3. Keep the adapter thin and capability-focused.
4. Do not make the adapter the only path the command surface depends on.

## Architecture notes

- Real mouse and keyboard input enter Chrome through the browser process and are routed to the appropriate render process. This is why `--os` is the trusted path when synthetic DOM dispatch is ignored.
- `document.elementFromPoint()` performs browser hit-testing and respects `pointer-events`, which makes it a sound primitive for coordinate-based scene interaction.
- `contenteditable` and standard input elements remain the browser's core writable primitives for rich editor text entry.
- `chrome.scripting.executeScript()` awaits promise return values, which keeps async page-context probing viable without CDP.

## References

- `prd/PRD-14.md`
- `prd/PRD-16.md`
- `extension/src/content/scene/`
- `cli/commands/scene.ts`
