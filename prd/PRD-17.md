# PRD-17: Restore Real TypeScript Coverage Across Bun Host Code and Chrome Extension Surfaces

**Goal:** Make `slop-browser` actually type-check under TypeScript so that the repo's strictness claims match reality, and regressions in CLI, daemon, background, and content-script code are caught before shipping.

**Scope:** Fix the type-checking architecture behind the current `bunx tsc --noEmit` failure by separating host and browser runtimes where necessary, loading the correct ambient types for each surface, and cleaning up the concrete type errors that remain after the config is corrected. Add a first-class `typecheck` verification path for local development and CI.

**Status:** Implemented in this repo revision.

## Implementation Checklist

- [x] Expand this checklist into an executable internal todo list.
- [x] Reproduce and categorize the current `tsc` failures by root cause instead of treating them as one blob.
- [x] Introduce a runtime-aware TypeScript project layout for host and extension code.
- [x] Load the correct Bun, DOM, Web Worker, and Chrome ambient types for the files that actually use them.
- [x] Fix the remaining host-side type errors in CLI parsing, transport, and daemon networking after config is corrected.
- [x] Fix the remaining extension-side type errors in background, content, scene, and network-capture code after config is corrected.
- [x] Add an explicit `typecheck` command to the repo and document it alongside build/test.
- [x] Gate completion on passing type-check, build, and existing tests.

## Non-Negotiable

1. **Do not hide the problem by excluding extension code.** The browser-side code in `extension/src/**` must remain part of the verified type surface.
2. **Do not weaken strictness to get green output.** No solution that "passes" by turning off `strict`, broadly adding `any`, or papering over runtime boundaries with `skip`-style escapes.
3. **Respect runtime boundaries.** Bun host code, content scripts, and the MV3 service worker do not run in the same ambient environment and must not share a fake one-size-fits-all type layer.
4. **Preserve current behavior.** This PRD is about restoring static guarantees, not changing the command surface or browser architecture.
5. **Keep the verification path simple.** A contributor should have one obvious command to run to verify types locally.

## Evidence Sources

| ID | Source | Path / Reference | Finding |
|----|--------|------------------|---------|
| CODE-TSCONFIG | Current TypeScript config | `tsconfig.json:2-15` | The repo includes `extension/src/**/*.ts`, but only loads `lib: ["ESNext"]` and `types: ["bun-types"]`, which is insufficient for browser globals and Chrome extension APIs. |
| CODE-PKG | Current dev dependencies | `package.json:13-16` | `@types/chrome` is installed, but the current tsconfig does not load it. |
| CODE-EXT-BG | Extension background entry | `extension/src/background.ts:1-19` | Background code uses `chrome.*` globals directly. |
| CODE-EXT-CONTENT | Content script entry | `extension/src/content.ts:1-180` | Content code uses `document`, `window`, `HTMLElement`, `PointerEvent`, and many DOM APIs directly. |
| CODE-CLI-TRANSPORT | Host transport layer | `cli/transport.ts:15-107` | Host code depends on Bun socket APIs and currently has unresolved generic/type mismatches under `tsc`. |
| CODE-DAEMON | Daemon networking | `daemon/index.ts:339-516` | Daemon code mixes TCP/Unix socket shapes and WebSocket upgrade/server types in ways that currently fail strict typing. |
| LIVE-TSC | Local verification during review | `bunx tsc --noEmit` run in this repo on 2026-04-09 | TypeScript currently reports hundreds of diagnostics across CLI, daemon, and extension code. |
| BUN-TS | Bun TypeScript guidance | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/bun/docs/typescript.md:17-44,60-62` | Bun recommends explicit compiler options and `types: ["bun"]` for Bun globals. |
| BUN-TEST | Bun test runner docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/bun/docs/test.md:7-24` | `bun test` is a runtime test surface, not a substitute for TypeScript static checking. |
| CHR-CONTENT | Chrome Extensions content scripts docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/content-scripts.md:1-25,79-117` | Content scripts run in browser pages and use DOM APIs, with messaging to the extension as the bridge. |
| CHR-SW | Chrome Extensions service worker docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/service-workers.md:10-14` | Extension service workers are event-driven background scripts with different capabilities than DOM-bearing pages. |
| CHR-TABS | Chrome tabs API docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/reference/api/tabs.md:13-18,185-190` | `chrome.tabs` lives in extension pages/service workers, not in generic Bun/Node code. |
| CHR-OFFSCREEN | Chrome offscreen API docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/reference/api/offscreen.md:1-32` | Offscreen documents are browser DOM contexts with tightly scoped extension API access, reinforcing that extension runtime surfaces are heterogeneous. |

## Problem

### Root issue

The repository currently presents itself as a strict TypeScript project, but the configured type-checking surface does not model the environments the code actually runs in.

The result is a split-brain workflow:

- `bun test` passes,
- `bash scripts/build.sh` passes,
- but `bunx tsc --noEmit` fails heavily.

That means contributors can change extension code, see green build/test output, and still ship type regressions that static analysis should have caught.

### Why this is happening

There are two different problems layered together:

1. **The config is wrong for the repo shape.**
   - The repo mixes Bun host code (`cli/`, `daemon/`, `shared/`) with Chrome extension browser code (`extension/src/**`).
   - Those files do not share the same ambient globals.
   - The current `tsconfig.json` applies one environment to all of them.

2. **The code contains real strict-mode typing debt.**
   - Some of the current errors are just missing DOM/Chrome ambient types.
   - Others are genuine typing mistakes in unions, generic socket signatures, and response shapes.

The first problem hides the second. Once the environment model is corrected, the remaining real errors need to be fixed intentionally.

### Why this matters now

This repo has grown beyond a tiny Bun-only CLI. It now spans:

- a compiled Bun CLI,
- a Bun daemon,
- an MV3 extension service worker,
- content scripts,
- MAIN-world injection code,
- and offscreen-document/browser-side processing.

That architecture is valid, but it requires explicit typing boundaries. Without them, strict mode becomes performative rather than protective.

## Product Requirements

### 1. Introduce runtime-aware TypeScript projects

The repo must stop pretending that all files run in the same environment.

#### Required project layout

At minimum, introduce:

- `tsconfig.base.json`
  - shared strict compiler rules
  - no runtime-specific ambient globals
- `tsconfig.host.json`
  - includes `cli/**`, `daemon/**`, `shared/**`, and any Bun-only scripts
  - loads Bun ambient types
  - does not load DOM/Chrome globals by default
- `tsconfig.extension.json`
  - includes `extension/src/**`
  - loads the browser/DOM/Chrome ambient layer needed by MV3 extension code

If background service-worker typing and content-script typing cannot be modeled cleanly in one extension config, it is acceptable to split the extension project further, but only if that reduces ambiguity rather than adding ceremony.

#### Required outcome

A contributor must be able to run one top-level typecheck command that checks all relevant projects in a predictable way.

### 2. Load the correct ambient types for each runtime

#### Host requirements

Host-side TypeScript configuration must follow Bun's documented typing model closely enough that Bun globals and socket APIs are type-checked correctly.

This includes:

- using the Bun ambient type package in the supported way,
- aligning compiler options with Bun's TypeScript guidance where applicable,
- and avoiding fake DOM globals in host code.

#### Extension requirements

Extension-side TypeScript configuration must load the globals used by:

- content scripts,
- browser pages/offscreen documents,
- and the extension service worker / Chrome APIs.

The goal is not theoretical purity. The goal is that references like `document`, `window`, `HTMLElement`, `PointerEvent`, and `chrome.tabs` are checked in the project where they are real.

### 3. Fix the remaining real type errors after config correction

Config cleanup alone is not sufficient. The repo must also address the strict-mode issues that remain once the correct ambient types are loaded.

#### Known error classes to resolve

1. **Action object widening in CLI parsers**
   - Several parser branches build `Record<string, unknown>` objects and return them as `Action`, causing `type` property loss under strict inference.

2. **Daemon and CLI Bun socket typing mismatches**
   - The current `Bun.connect` / `Bun.listen` usage mixes incompatible option shapes and listener types.

3. **Daemon response typing drift**
   - Some CLI callers assume response shapes that are looser than the declared `DaemonResponse`.

4. **Implicit `any` leakage**
   - Particularly in callback parameters and Chrome API mapping code.

5. **Browser API narrowing issues**
   - Canvas, DOM, and scene code currently relies on values inferred as `{}` or `unknown` in places where proper narrowing should exist.

#### Non-goal

This PRD does not require every local helper type to become elegant. It does require the code to pass strict checking without broad unsafe escapes.

### 4. Add a first-class repo typecheck command

The repository must define and document a standard type-check entry point.

#### Required behavior

- Add a `typecheck` script to `package.json`.
- The command must verify every relevant TypeScript project.
- The command must be appropriate for both local development and CI.

#### Acceptable implementation shapes

- `tsc --noEmit -p tsconfig.host.json` plus `tsc --noEmit -p tsconfig.extension.json`
- or project references / build mode,
- or another equivalent approach that stays transparent.

### 5. Update repo docs to reflect the real verification story

The current repo guidance emphasizes build and test. After this PRD, docs must clearly distinguish:

- build verification,
- runtime tests,
- and static type verification.

At minimum, update the local workflow docs or README so contributors know:

1. when to run `typecheck`,
2. when `bun test` is enough,
3. and when a cross-surface change requires all three: typecheck, build, and tests.

## Acceptance Criteria

### Functional

1. A single documented top-level typecheck command exists and succeeds.
2. `extension/src/**` remains inside the checked type surface.
3. Host code is checked with Bun-aware ambient types, not browser globals.
4. Extension code is checked with browser/Chrome-aware ambient types.
5. The current strict-mode diagnostics are reduced to zero for the checked projects, or to a deliberately documented residual list with explicit ownership if a staged rollout is used.

### Regression

1. `bash scripts/build.sh` still succeeds.
2. `bun test` still succeeds.
3. No user-facing CLI command or browser feature is removed as a side effect of typing cleanup.

### Quality bar

1. No solution that passes by excluding `extension/src/**` from checking.
2. No solution that passes by disabling strict mode.
3. No broad `// @ts-ignore` sweep or global `any` fallback used as the primary remediation strategy.

## Implementation Plan

### Phase 0: Establish the real failure inventory

- Capture the current `bunx tsc --noEmit` failure set.
- Group failures into:
  - config/environment errors,
  - host typing errors,
  - extension typing errors,
  - and response/modeling drift.
- Decide whether a two-project or three-project TypeScript layout is the cleanest fix.

### Phase 1: Split the repo by runtime

- Create a shared base tsconfig with strict rules only.
- Create a Bun host tsconfig for CLI/daemon/shared code.
- Create an extension tsconfig for browser-side code.
- Wire a top-level typecheck command that runs both.

### Phase 2: Fix host-side type debt

- Normalize `Action` builder typing in CLI parsers.
- Correct Bun socket/listener typings in `cli/transport.ts` and `daemon/index.ts`.
- Tighten daemon response types so CLI callers stop reaching through undeclared shapes.

### Phase 3: Fix extension-side type debt

- Load Chrome ambient types and the required DOM/worker libs.
- Add explicit narrowing where `unknown` or `{}` currently leaks into DOM/canvas/scene code.
- Clean up implicit-`any` callback parameters and Chrome API mapping code.

### Phase 4: Make the typecheck path part of normal development

- Add `typecheck` to `package.json`.
- Update docs/workflows to mention it next to build/test.
- If this repo has CI workflows that already run build/test, extend them to run typecheck as well.

## Risks

### Risk 1: One extension tsconfig may still be too coarse

The extension bundle mixes content-script DOM code, service-worker code, and offscreen document code. A single config may technically work but still blur runtime boundaries.

**Mitigation:** Start with one extension project only if it stays readable. Split further only when a concrete type conflict remains.

### Risk 2: Bun and TypeScript disagree on edge-case APIs

Some Bun socket/runtime types may require code adjustments even though the code works at runtime.

**Mitigation:** Prefer small modeling fixes and explicit narrowings over unsafe casts. If a Bun typing limitation is the blocker, isolate the cast to the narrowest possible boundary and document why.

### Risk 3: Contributors may keep using build/test only

If the repo adds a correct typecheck command but does not document or run it routinely, the project will regress back into the same state.

**Mitigation:** Make `typecheck` visible in both docs and CI.

## Out of Scope

- Rewriting the build pipeline.
- Migrating the repo away from Bun.
- Converting the project to a different testing framework.
- Refactoring unrelated runtime behavior under the guise of typing cleanup.

## Definition of Done

This PRD is complete when:

1. The repo has a runtime-aware TypeScript configuration layout.
2. `bunx tsc`-equivalent verification passes across the intended host and extension surfaces.
3. The verified command is documented and easy to run.
4. Build and tests still pass afterward.
