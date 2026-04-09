# PRD-16: Adaptive Editor Surfaces - Capability-Driven Discovery, Trusted Interaction, and Focused Text Entry

**Goal:** Make `slop` interact with rich browser editors the way a human does: by using the browser's real hit-testing, focus, keyboard, and writable editing surfaces, instead of depending on product-specific DOM ids or vendor-specific assumptions.

**Scope:** Replace brittle editor-specific discovery assumptions in the scene system with a capability-driven discovery pipeline, make trusted OS-level interaction a first-class generic path for `scene` actions, and add a generic focused-editor text-entry path that works across rich editors when a real writable surface is present.

**Status:** Implemented in this repo revision.

## Implementation Checklist

- [x] Expand the implementation checklist into an executable internal todo list.
- [x] Audit the current scene/interaction codepaths and identify the shared-engine, CLI, router, and test changes required.
- [x] Implement capability-driven scene strategy reporting and normalized scene object resolution.
- [x] Implement generic scene trusted-input routing for explicit and auto-escalated OS clicks.
- [x] Implement focused-editor text insertion for active writable surfaces.
- [x] Refactor brittle editor-specific assumptions into optional adapter behavior only where still necessary.
- [x] Update the repo markdown docs to match the adaptive scene model.
- [x] Build and run focused tests plus live smoke verification on the supplied rich-editor page.
- [x] Resolve verification issues uncovered during implementation and complete cleanup.

## Non-Negotiable

1. **No product-specific assumptions in the core path.** The core `scene` engine must not depend on vendor ids like `LB...`, vendor hostnames, or product-named command branches.
2. **No CDP.** The implementation must continue using content scripts, page-context evaluation where needed, and the existing daemon/native-messaging path. No `chrome.debugger`.
3. **Trusted input must be generic.** `scene click --os` and trusted text entry must work for any scene object, not only for one site.
4. **Write only through a real editing surface.** Text insertion must target a focused editable/input surface owned by the page. No blind mutation of guessed DOM nodes.
5. **Capability-first, adapters last.** If a site-specific adapter is still needed, it must be a thin optional layer selected by runtime capability probes, not by hard-coded command logic.
6. **Preserve existing command surface.** `scene list`, `scene click`, `scene selected`, and `scene insert` remain the user-facing primitives unless a command change is strictly necessary.

## Evidence Sources

| ID | Source | Path / Reference | Finding |
|----|--------|------------------|---------|
| CODE-HARDCODE | Current scene implementation | `extension/src/content/scene/profiles/canva.ts:4-52` | The current scene system contains a brittle vendor-specific assumption: discovery and resolution are hard-coded to `id^="LB"` elements. |
| CODE-SCENE-OS | Scene CLI parser | `cli/commands/scene.ts:46-52` | `scene click --os` is already parsed and attached to the action payload. |
| CODE-SCENE-ENGINE | Scene click engine | `extension/src/content/scene/engine.ts:206-231` | Scene click currently ignores the parsed `os` flag and dispatches synthetic clicks only. |
| CODE-ROUTER | Background router | `extension/src/background/router.ts:106-131` | Synthetic-to-OS escalation currently exists only for plain `click`, not for `scene_click`. |
| CODE-TYPE | Generic typing path | `cli/commands/actions.ts:35-46` | Current `type` behavior assumes a concrete target or semantic selector; there is no generic "focused editor" write path. |
| LIVE-RICH-EDITOR | Live rich-editor smoke probe on the supplied document | local `slop` probes during this session | The editor exposes a hidden `input[role=application][data-hidden-input=true]` accessibility surface and a visible page container, but no stable semantic descendants in the sampled page subtree. This demonstrates that hard-coded DOM-object ids are not a reliable core strategy. |
| CHR-SCRIPT-PROMISE | Chrome Extensions docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/reference/api/scripting.md:194` | If injected script execution yields a promise, Chrome waits for it to settle and returns the resolved value. |
| CHR-SCRIPT-WORLD | Chrome Extensions docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/reference/api/scripting.md:300-303` | `ISOLATED` and `MAIN` worlds are distinct. `MAIN` shares the page's JS environment. |
| CHR-CONTENT | Chrome Extensions docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/content-scripts.md:31-35` | Content scripts run in an isolated world, so page-side model access must be treated explicitly. |
| CHR-NATIVE | Chrome Extensions docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/native-messaging.md:118-124` | Native messaging is only available from extension pages/service worker, not from content scripts. |
| CHR-INPUT | Chrome browser docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-browser/docs/chromium/renderingng-architecture.md:24-27,79-80,250-271` | Real mouse/keyboard input enters the browser process and is routed into the appropriate render process. This validates trusted OS input as the closest browser-equivalent to human interaction. |
| CUI-EFP | CanIUse | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/CanIUse/docs/features/element-from-point.md:5-14,132-146` | `document.elementFromPoint()` performs browser hit-testing and respects `pointer-events`. |
| CUI-PE | CanIUse | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/CanIUse/docs/features/pointer-events.md:5-16` | `pointer-events: none` passes pointer input through to underlying elements. |
| CUI-CE | CanIUse | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/CanIUse/docs/features/contenteditable.md:5-18` | `contenteditable` is a broadly supported browser primitive for in-page text editing. |
| CUI-EXEC | CanIUse | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/CanIUse/docs/features/document-execcommand.md:5-18` | `document.execCommand()` is unofficial/non-standard but still broadly supported for editing operations. |
| BUN-BUILD-TEST | Bun docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/bun/docs.md:67-108` | `bun build` and `bun test` are the repo-standard build/test surfaces. |
| BUN-TEST-CFG | Bun docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/bun/docs/runtime/bunfig.md:156-185` | Bun test behavior is configurable and is the intended local verification path. |

## Problem

### Root issue

The current scene system is too dependent on a previously observed DOM shape. That works until a site changes its internal markup. A human using the browser is not blocked by that kind of implementation drift because the browser still provides:

- viewport hit-testing,
- focus management,
- real pointer and keyboard routing,
- and whichever editing surface the app currently owns.

`slop` should be built on those primitives first.

### What the current system gets wrong

1. **Discovery is too brittle.**
   - The current scene implementation assumes a specific object-identity convention from one previously observed editor surface.
   - The live rich-editor document used in this session does not expose that shape, so discovery collapses even though the page is visibly editable to a human.

2. **Trusted interaction is treated as a fallback for some commands, not as a generic scene capability.**
   - `click --os` has a working generic path.
   - `scene click --os` is parsed but not actually routed.

3. **Text entry is target-centric instead of editor-centric.**
   - Current typing assumes a stable DOM target.
   - Rich editors frequently use hidden inputs, focus proxies, contenteditable surfaces, or page-owned model bridges.
   - A human types into whichever surface currently owns focus. `slop` should be able to do the same.

### What this PRD is not proposing

- It is not proposing a separate product-specific command surface.
- It is not proposing a per-site pile of selectors as the primary design.
- It is not claiming that no site-specific logic will ever be needed. It is saying that site-specific logic must be the last mile, not the foundation.

## Product Requirements

### 1. Replace static object assumptions with capability-driven discovery

The scene system must discover editor surfaces from browser-visible capabilities, not from vendor names or hard-coded ids.

#### Required discovery layers

The engine must try these layers in order:

1. **Semantic editor roots**
   - `role=application`
   - `role=document`
   - `role=main`
   - visible `contenteditable`
   - focused hidden inputs that proxy editing state

2. **Structural page surfaces**
   - large transformed containers
   - page-like containers
   - large SVG or canvas regions
   - visually central positioned surfaces

3. **Runtime interaction probes**
   - viewport hit-testing via `elementFromPoint()`
   - focus walk / tab walk where permitted
   - selected/focused surface readback
   - page-context probes in `MAIN` world when the page exposes model/state useful for addressability

4. **Optional thin adapters**
   - only when the generic discovery layers cannot produce sufficient addressability
   - selected by runtime capability probes, not by hostname alone

#### Required output

The scene engine must produce a normalized scene inventory with synthetic ids when necessary. A scene id does not need to be a vendor-native id as long as it is:

- deterministic within the current page state,
- re-resolvable at dispatch time,
- and grounded in geometry, semantics, or model identity.

### 2. Add a generic scene strategy report

`scene profile --verbose` should not merely identify a product profile. It should explain which strategy is active.

#### Required data

- active discovery strategy or strategies,
- whether the current editor is:
  - geometry-addressable,
  - focus-addressable,
  - text-writable,
  - model-probe-enhanced,
- whether trusted input is available,
- whether insertion uses:
  - focused input,
  - contenteditable,
  - `execCommand`,
  - or OS typing.

This is required so the agent can understand how the current page is being driven.

### 3. Make trusted interaction a first-class generic scene capability

#### Required behavior

- `slop scene click <id> --os` must route through OS-level trusted input for any resolved scene object.
- `slop scene click <id>` may start synthetically, but if the page does not respond, the router may auto-escalate using the same resolved coordinates.
- The scene engine must return enough coordinate data for both synthetic and trusted paths.

#### Design intent

This makes scene interaction match browser-level human interaction more closely and removes a product-specific special case.

### 4. Add focused-editor text entry

`scene insert` should become a generic "write into the currently active editor-owned writable surface" operation.

#### Required behavior

- `slop scene insert "<text>"` must work when the page currently exposes a real writable surface, including:
  - focused input/textarea,
  - focused hidden proxy input,
  - focused contenteditable,
  - or other verified page-owned insertion surface.
- If no writable surface is active, the command must fail with an actionable error.
- The insertion strategy must be chosen by capability, not by site name.

#### Allowed insertion mechanisms

- OS-level typing into the focused surface.
- Standard input events when a normal input/textarea is focused.
- `execCommand('insertText')` when the active surface is genuinely editable and this path is verified.

#### Disallowed insertion mechanisms

- Writing into arbitrary anonymous DOM nodes without a verified editing contract.
- Returning success without a page-state confirmation step.

### 5. Add session-level capability caching

To stay efficient, the editor discovery pipeline should cache what it learns during the current tab/session.

#### Required behavior

- Cache the chosen discovery strategy and relevant editor roots per tab/page lifecycle.
- Invalidate cache on substantial DOM/navigation/editor root changes.
- Prefer reusing a proven strategy rather than reproving the entire pipeline on every command.

This keeps the system closer to human efficiency while avoiding brittle hard-coding.

### 6. Keep optional site-specific logic isolated

If a site truly requires a thin adapter, it must follow these rules:

- it is selected by runtime capability probes,
- it does not change the user-facing command surface,
- it is isolated from the core scene engine,
- it is documented as an optimization layer, not as the only way the feature works.

## Acceptance Criteria

### Functional

1. `scene` no longer depends on a single vendor-specific DOM-id convention for core discovery.
2. On a modern rich editor that does not expose ordinary DOM inputs as page objects, `scene` can still either:
   - produce a non-empty actionable inventory, or
   - explicitly report a fallback focus/interaction strategy that remains usable.
3. `slop scene click <id> --os` works generically for scene objects.
4. `slop scene insert "<text>"` works generically when a writable editor surface is active, regardless of whether that surface is a normal input, hidden proxy input, or contenteditable.
5. `scene profile --verbose` reports active strategy/capability information, not only a product label.

### Regression

1. Existing Docs and Slides scene workflows remain intact.
2. `bun test test/scene.test.ts` passes after updating tests for the new scene behavior.
3. `bash scripts/build.sh` completes successfully.

## Implementation Plan

### Phase 0: Remove brittle assumptions from the design

- Audit the scene engine for product-specific discovery assumptions in the core path.
- Move those assumptions out of the foundation and into optional capability modules if they are still needed.
- Update `Notes/scene.md` to document the new capability-first model.

### Phase 1: Build adaptive editor discovery

- Add an editor-surface discovery pipeline based on semantics, geometry, focus, and runtime probes.
- Introduce normalized scene objects with synthetic ids when vendor-native ids are absent.
- Make `scene list`, `resolve`, and `hitTest` all use the same inventory source.

### Phase 2: Generalize trusted scene interaction

- Thread `action.os` through the generic scene action path.
- Extend the background router so `scene_click` can use or auto-escalate to `os_click`.
- Ensure coordinate-based trusted input works for any scene object.

### Phase 3: Add focused-editor text entry

- Introduce a shared writable-surface resolver:
  - active element,
  - focused proxy input,
  - focused contenteditable,
  - verified editor insertion bridge.
- Rework `scene insert` around that resolver.
- Add explicit verification/error behavior when no writable surface is active.

### Phase 4: Add capability reporting and caching

- Extend verbose scene output to describe the active strategy and writable/interactive capabilities.
- Add session-level caching of proven discovery strategies.

### Phase 5: Add optional thin adapters only if needed

- If some editors still require site-specific last-mile logic, add it only as an isolated optimization layer chosen by runtime probes.

## Files Expected To Change

- `extension/src/content/scene/engine.ts`
- `extension/src/content/scene/profiles/*` or successor capability modules if any optional adapters remain necessary
- `extension/src/background/router.ts`
- `cli/commands/scene.ts`
- `cli/commands/actions.ts`
- `test/scene.test.ts`
- `Notes/scene.md`

## Open Questions

1. Should `scene profile --verbose` evolve into a capability report rather than a product label?
2. Is a new generic `type --focused` command useful, or should focused insertion live only under `scene insert`?
3. What is the smallest acceptable adapter surface if a generic discovery pipeline still cannot fully inventory a given editor?

## Verification Plan

1. Rebuild with `bash scripts/build.sh`.
2. Reload the extension with `slop reload`.
3. Verify generic scene behavior on at least:
   - one DOM-addressable editor,
   - one focus-proxy or canvas-backed rich editor,
   - Google Docs / Google Slides regressions.
4. Verify:
   - `slop scene profile --verbose`
   - `slop scene list`
   - `slop scene click <id>`
   - `slop scene click <id> --os`
   - `slop scene selected`
   - `slop scene insert "<text>"`
5. Run `bun test test/scene.test.ts`.
