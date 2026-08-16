---
name: interceptor-browser
description: "Drive a signed-in Chrome / Brave / Safari session via the interceptor CLI: open/read pages, click, type, inspect DOM/text/network, automate rich browser editors and scene graphs, capture WebSocket/Beacon/BroadcastChannel traffic, record/replay flows, take VLM-budgeted screenshots, compare pages, and route to specific browser contexts with --context. Use for browser page content, tabs, forms, SPA extraction, request overrides, page communication capture, and deployment checks. Not for native macOS apps, Electron desktop app web contents, OS dialogs, browser chrome, or large scraping."
metadata:
  short-description: Drive a real signed-in Chrome / Brave / Safari session via the interceptor CLI
---

# Interceptor Browser

Agent-operator skill for the Browser surface of Interceptor. Use the `interceptor` CLI (no prefix) to drive a live Chrome, Brave, or Safari session: pages, network, scene graph, monitor, screenshots. For native macOS apps load `interceptor-macos` instead.

This installed skill is self-contained. Source checkouts also have `AGENTS.md`, but packaged users may only have the skill directory below `/Library/Application Support/Interceptor/skills`.

## Core Rules

- Use compound commands (`open`, `websearch`, `read`, `act`, `inspect`) before low-level verbs.
- `websearch "<query>"` searches through the browser's configured default provider in an Interceptor-managed background tab and returns the provider page. It is not Google-specific. `find "<query>"` never navigates: it searches the current page's complete rendered-text snapshot plus accessible elements. Use `find --text-only` for passages and `find --elements-only`/`--role` for controls.
- Browser commands operate inside managed Interceptor tab groups. Do not use `--any-tab` unless the user explicitly authorizes acting outside those groups.
- Pick a stable `--group <label>` (your agent name or session id) at the start of browser work, or set `INTERCEPTOR_GROUP` once. A named label buys three things at once: your tabs live in their own colored group and resolution never leaves it (isolation from sibling agents), `open` reuses your group's most-recent tab instead of piling up new ones, and the idle sweeper has a clean unit to reap if you crash. `interceptor group list` shows what's running.
- Close your group with `interceptor group close <label>` the moment the job is done — tabs you leave open are tabs the user has to close by hand. The extension auto-closes idle groups (default: after 10 minutes without a command; configurable in the extension popup), but that is the crash-safety floor, not a substitute for cleaning up.
- In a named group, `open` navigates your group's most-recent tab by default (address-bar semantics; the reused tab stays in the background unless you add `--activate`). Pass `--no-reuse` when you need to keep the current page and open another — e.g. before comparing two pages or fanning out. `tab new` always creates (⌘T semantics). Ungrouped `open` always creates.
- `interceptor open <url>` and `interceptor tab new <url>` create background tabs by default. Only `open --activate`, `tab new --activate`, `tab switch <id>`, and `window focus <id>` intentionally move browser focus.
- If multiple browser profiles are connected, run `interceptor contexts` and pass `--context <id>`.
- Safari registers as the stable context `safari`; route with `interceptor --context safari <verb>`. If it is absent, verify the notarized Interceptor Safari extension is enabled before attempting page commands. Safari's enable switch is a protected user-present action; never try to bypass its Touch ID/password gate.
- Prefer structured reads (`read`, `tree`, `text`, `inspect`, `scene`) before screenshots. Open `references/screenshot-policy.md` before screenshot-heavy work.
- Default to plain text output. Use `--json` only when piping into scripts or when a downstream tool needs a machine-readable contract.
- If an already-loaded unpacked extension behaves stale after a package update, reload it from `chrome://extensions` or `brave://extensions`, or run `interceptor reload` once the extension is reachable.
- Safari package updates are loaded through the containing app/appex; do not look for a Chrome-style unpacked-extension reload button.
- Safari suspends its background worker when idle, so `--context safari` can briefly report "context 'safari' not found" between commands and then self-heal. Re-issue the command rather than treating one transient drop as failure. Note two Safari capability limits: `headers add` only modifies recognized standard headers (arbitrary `X-…` names are refused — use `override` instead), and passive `net` capture reflects genuine page traffic, not requests you originate from `eval` (its world is separate from the page's).

## Fast Path

```bash
interceptor status                        # 1. Confirm daemon + extension are alive
interceptor websearch "example docs"      # 2a. Default provider → managed background results tab
interceptor open "https://example.com"    # 2b. Or open a known URL → wait + tree + text
interceptor read                          # 3. Current state (re-read after any mutation)
interceptor act e5                        # 4. Click ref e5 (refs come from `read`)
interceptor act e7 "example user"         # 5. Type into ref e7
interceptor inspect                       # 6. Tree + text + network in one read
```

Inside this repo without `interceptor` on PATH, use `./dist/interceptor ...`.

## Workflows

Each workflow is a complete self-contained "you are doing X" procedure. Open the file when the task matches.

| Workflow | When to invoke |
|---|---|
| [`workflows/verify-deploy.md`](workflows/verify-deploy.md) | "Verify the deploy", "check that X works on the page", reproducing a bug before touching code |
| [`workflows/read-and-extract.md`](workflows/read-and-extract.md) | Compound page read + SPA state extraction — pull a specific value off a page |
| [`workflows/drive-rich-editor.md`](workflows/drive-rich-editor.md) | Canva, Google Docs, Google Slides, design-tool layer manipulation — anything where DOM refs aren't enough |
| [`workflows/rich-editor-workflows.md`](workflows/rich-editor-workflows.md) | Canva shape insertion, Docs table build+fill, Slides table insert — what works natively vs the `eval --main` last mile |
| [`workflows/google-docs-fill-empty-table-cells.md`](workflows/google-docs-fill-empty-table-cells.md) | Fill empty Docs table cells with the value above (canvas caret + per-char typing + Tab) |
| [`workflows/canva-custom-size-creation.md`](workflows/canva-custom-size-creation.md) | Create a custom-size Canva design from home (normalized semantic replay) + monitor launch/handoff pattern |
| [`workflows/cook-in-canvas.md`](workflows/cook-in-canvas.md) | Draw effects/markers directly through a page's own `CanvasRenderingContext2D` (Docs/Excalidraw), pixel-verified |
| [`workflows/cook-on-top-of-pages.md`](workflows/cook-on-top-of-pages.md) | "Cook" a live page in-place — banners, HUDs, overlays that track real DOM, full-screen takeovers, over the real session |
| [`workflows/override-xhr.md`](workflows/override-xhr.md) | Mutate a request before it hits the server — change params, force a status, throttle |
| [`workflows/capture-page-communication.md`](workflows/capture-page-communication.md) | Capture WebSocket, Beacon, and BroadcastChannel activity without CDP |
| [`workflows/record-and-replay.md`](workflows/record-and-replay.md) | Learn a real user flow, export a replay plan, run it back |
| [`workflows/screenshot-for-vlm.md`](workflows/screenshot-for-vlm.md) | Take a screenshot the model will actually understand — VLM-budgeted, WebP, on-disk |
| [`workflows/multi-page-compare.md`](workflows/multi-page-compare.md) | Compare facts across multiple pages (e.g. "who designed Python vs JavaScript") — sequential `open --text-only` per page |

## References

| File | Topic |
|---|---|
| [`references/browser-and-network.md`](references/browser-and-network.md) | Command selection, SPA extraction, request overrides, SSE capture, page-world `eval --main` cautions |
| [`references/page-communication-capture.md`](references/page-communication-capture.md) | P1 WebSocket, Beacon, and BroadcastChannel capture mechanics, commands, event shapes, and limits |
| [`references/rich-editors.md`](references/rich-editors.md) | Overview: Canva, Google Docs, Google Slides behavior, canvas-rendered editor input, WebGL camera apps, blob export capture (deep mechanics in the four `references/canvas-*`/`webgl-*`/`blob-*` files below) |
| [`references/canvas-rendered-editor-input.md`](references/canvas-rendered-editor-input.md) | Deep mechanic: caret / typing / key-nav inside canvas-rendered editors (Docs/Slides/Sheets) via dispatched events + iframe-window `KeyboardEvent`. The `eval --main` + `__interceptor_trust`/`userActivation` foundation lives here. |
| [`references/canvas-camera-overlays.md`](references/canvas-camera-overlays.md) | Deep mechanic: pan/zoom a WebGL map viewer + lat/lng DOM overlays (Web Mercator), URL-watcher pattern, CSS-filter restyle |
| [`references/webgl-camera-control.md`](references/webgl-camera-control.md) | Deep mechanic: generic, app-agnostic WebGL camera control + overlay anchoring |
| [`references/blob-export-capture.md`](references/blob-export-capture.md) | Deep mechanic: capture a webapp's client-side export bytes (PNG/PDF/SVG) with no Save dialog |
| [`references/monitor-and-replay.md`](references/monitor-and-replay.md) | Monitor session behavior, replay-plan generation, cross-tab/focus-follow notes |
| [`references/command-catalog.md`](references/command-catalog.md) | Full browser command surface with flags and examples |
| [`references/screenshot-policy.md`](references/screenshot-policy.md) | VLM-aware screenshot budget table; agent-default recipe |

## When To Switch Surfaces

If the target is **outside the page** - a native dialog, browser chrome (URL bar, profile picker), Save/Open file picker, OS notification, or any non-browser macOS app - load `interceptor-macos` instead.

If the target is an **Electron / Chromium desktop app's web contents** (Slack, VS Code, Notion, Descript, etc.), use the CDP/app reference from `interceptor-macos`: `references/cdp-app.md`.

If the task is **breadth research** — "investigate / go deep on / find everything about X" across many sources — load `interceptor-research`, which layers a planner loop, source ledger, and verification pass on top of this surface.

## Do Not Default To Troubleshooting

- User wants a browser task completed → run Interceptor commands.
- User wants Interceptor fixed, installed, or explained → that's a separate task; ask before diving into repo state.
- Inside the Interceptor repo, use this skill for live browser validation, not as the primary source of repo-development instructions.

## Completion

A browser job is complete only when:

- every claim about page state comes from a re-read (`read`/`inspect`) taken *after* the last mutation, not from the action's success alone;
- artifacts you produced (screenshots, saved files, captured payloads) are named by absolute path in the report;
- your tab group is closed (`interceptor group close <label>`) and `interceptor group list` no longer shows it — the list output is the proof, not the close command's exit code.

Report what failed or was skipped as prominently as what worked. Never report only the happy fields.
