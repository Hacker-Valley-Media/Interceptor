# Rich Editors

## Start with detection

1. Run `interceptor scene profile`.
2. Run `interceptor scene profile --verbose` when capability support is unclear.
3. Prefer menu items, accessible toolbars, and searchable commands before scene geometry.

## Use Canva carefully

- Prefer the accessible side panel to add elements. It is more reliable than raw scene targeting.
- Use `scene list`, `scene hit`, `scene click`, and `scene selected` only after verifying the page reports a usable Canva profile.
- Treat stable `LB...` ids as document-local scene ids, not universal object handles.
- Verify selection by checking for element-level controls, not just the click result.
- Expect some live Canva editor states to fall back to `generic`.

## Use Google Docs as the strongest editor target

- Use `scene text` to read the hidden text model.
- Use `scene text --with-html` when table structure or range offsets matter.
- Use `scene insert "<text>"` once the cursor is inside the writable surface.
- Use menu search or native commands to create structure, then use `scene insert` and `Tab` to populate cells.

## Use Google Slides with stricter limits

- Use `scene slide list`, `scene slide current`, and `scene slide goto <n>` for navigation.
- Treat slide navigation as URL-fragment based. Do not rely on synthetic clicks on filmstrip thumbnails.
- Use `scene notes` and `scene render` for speaker notes and slide images.
- Expect missing write support in some edit flows. `scene insert` is not a general replacement for live slide editing.
- Use `eval --main` only when the native command surface and scene commands cannot finish the task.

## Verify with the right signal

- Verify Canva by changed selection controls.
- Verify Docs by changed hidden HTML/text output.
- Verify Slides by changed current slide, selected object state, or rendered output.
