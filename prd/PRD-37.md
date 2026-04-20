# PRD-37: Make `interceptor eval --main` Work On CSP-Locked Sites (OpenStreetMap Proof)

**Status:** Implemented
**Author:** Codex (via Ron)
**Date:** 2026-04-20
**Priority:** P1-High
**Effort:** S
**Platform:** Browser extension / MV3 / runtime injection
**Category:** Runtime / CSP / Reliability

---

## Goal

Make `interceptor eval --main "<js>"` succeed on strict-CSP pages such as `https://www.openstreetmap.org/`, where the existing implementation failed with:

```text
Evaluating a string as JavaScript violates the following Content Security Policy directive ...
script-src 'self' ... 'wasm-unsafe-eval' ...
```

After this PRD, Interceptor must be able to:

1. detect that page-world eval was blocked by page CSP,
2. automatically install a tab-scoped CSP-bypass rule,
3. reload the tab once,
4. retry the same `--main` execution,
5. return the evaluated result to the CLI.

OpenStreetMap is the proof target because it is a real, public, strict-CSP site that previously failed and now succeeds.

---

## Summary

The bug was **not** that Interceptor lacked browser control. Browser control on OpenStreetMap already worked.

The bug was specifically in the `evaluate` path:

- Interceptor used `chrome.scripting.executeScript()` to inject a wrapper into the page.
- That wrapper then executed the user payload with `(0, eval)(code)`.
- On strict-CSP sites, that inner eval was governed by the page's `script-src`, so it failed.

The minimal fix that actually made OpenStreetMap work was:

- add a CSP-error detector to `handleEvaluateActions()`,
- on CSP failure, install a tab-scoped **session** `declarativeNetRequest` rule that removes:
  - `content-security-policy`
  - `content-security-policy-report-only`
- reload the tab,
- retry the original `MAIN`-world evaluation once.

This is the change that mattered.

The parallel `userScripts` work was useful exploration and should remain documented, but it was **not required** for the successful OpenStreetMap proof in the live browser. At time of validation, the active extension still did not have `userScripts` available.

---

## Evidence

### Before

Running:

```bash
interceptor open "https://www.openstreetmap.org/#map=3/38.01/-95.84" --text-only
interceptor eval --main "document.title"
```

returned a page CSP failure.

### After

The same command returned:

```json
{
  "value": "OpenStreetMap",
  "cspBypassApplied": true,
  "originalError": "Evaluating a string as JavaScript violates ..."
}
```

Then a live overlay was injected onto OpenStreetMap successfully using `eval --main`.

Validation screenshot:

- `/Volumes/VRAM/00-09_System/01_Tools/Interceptor/interceptor-screenshot-1776685735079.jpg`

---

## Root Cause

### Existing behavior

`extension/src/background/capabilities/evaluate.ts` executed the user payload like this:

1. inject a function with `chrome.scripting.executeScript({... world: "MAIN" ...})`
2. pass the user code string as an argument
3. call `eval(code)` inside the injected function

That meant:

- the wrapper itself entered page world correctly,
- but the payload execution still relied on `eval`,
- and the page's CSP blocked it.

### Why this matters

Interceptor's own README/use-case story depends on page-world DOM/CSS injection:

- banners
- overlays
- HUDs
- page repainting
- site-aware anchored visual effects

If `eval --main` breaks on strict-CSP sites, those use cases become unreliable exactly on the kinds of real production pages users care about.

---

## Non-Root-Cause Noise Discovered During Debugging

Two separate issues complicated validation but were not the product fix itself:

### 1. Wrong extension instance

The browser was initially running a different/live packaged extension bundle than the repo build being edited. That caused repeated confusion because:

- repo code changed,
- browser behavior did not,
- `capabilities` output did not reflect new instrumentation.

This was a validation problem, not the runtime design bug.

### 2. `chrome.userScripts` not active in the live extension

The manifest and code were prepared to explore a `userScripts`-first path, but live validation showed:

```json
{
  "manifest_permission": false,
  "api_present": false,
  "enabled": false
}
```

So `userScripts` was not the path that made OpenStreetMap succeed during this PRD's proof.

---

## Proposed / Implemented Design

### Runtime behavior

When `action.type === "evaluate"` and `world === "MAIN"`:

1. run the initial evaluation attempt,
2. if it succeeds, return normally,
3. if it fails with a CSP-like eval error:
   - install a session-scoped DNR rule for the current tab,
   - remove CSP response headers for `main_frame` and `sub_frame`,
   - reload the tab with `bypassCache: true`,
   - wait for the tab to stabilize,
   - retry the same evaluation exactly once,
4. if retry succeeds, return:

```json
{
  "value": <result>,
  "cspBypassApplied": true,
  "originalError": <first csp error>
}
```

5. if retry still fails, return a clear failure including the original error and the fact that CSP bypass was attempted.

### Why session rules

Use `chrome.declarativeNetRequest.updateSessionRules()` instead of dynamic rules because:

- the rule is only needed for the current browser session,
- it should not persist across restarts,
- it is a tactical runtime workaround, not a permanent browsing policy.

### Why tab-scoped rules

The rule must target the active tab only, not all tabs, to avoid broad and surprising CSP stripping elsewhere.

---

## File Changes

### Required change

- [extension/src/background/capabilities/evaluate.ts](/Volumes/VRAM/00-09_System/01_Tools/Interceptor/extension/src/background/capabilities/evaluate.ts)

Adds:

- `isCspEvalError()`
- `buildCspBypassRule(tabId)`
- `installCspBypassForTab(tabId)`
- reload-and-retry flow in `handleEvaluateActions()`

### Supporting validation changes

- [extension/src/background/capabilities/meta.ts](/Volumes/VRAM/00-09_System/01_Tools/Interceptor/extension/src/background/capabilities/meta.ts)
  - exposes `userScripts` availability in `capabilities`
- [extension/manifest.json](/Volumes/VRAM/00-09_System/01_Tools/Interceptor/extension/manifest.json)
  - includes `"userScripts"` for future path exploration
- [test/evaluate-csp.test.ts](/Volumes/VRAM/00-09_System/01_Tools/Interceptor/test/evaluate-csp.test.ts)
  - validates CSP error detection and rule construction

---

## Success Criteria

This PRD is complete when all of the following are true:

1. `interceptor eval --main "document.title"` succeeds on OpenStreetMap.
2. The result clearly indicates when CSP bypass was applied.
3. A visible page-world overlay can be injected on OpenStreetMap after the bypass.
4. Existing non-CSP pages still behave normally.
5. The helper logic is covered by unit tests.

---

## Verification

### Automated

```bash
bunx tsc -p tsconfig.extension.json --noEmit
bun test test/evaluate-csp.test.ts
```

### Live

```bash
interceptor open "https://www.openstreetmap.org/#map=3/38.01/-95.84" --text-only
interceptor eval --main "document.title"
```

Expected outcome:

- returns `"OpenStreetMap"`
- indicates `cspBypassApplied: true`

Then inject a visible overlay via `eval --main` and capture a screenshot.

---

## Risks

### R1. CSP stripping is broad for the targeted tab

Removing CSP headers for a tab is a strong intervention. It is acceptable for an explicit agent command like `eval --main`, but should remain:

- tab-scoped,
- session-scoped,
- automatic only after an actual CSP failure.

### R2. Reload side effects

Reloading a page may reset some UI state. This is acceptable here because:

- the command is explicitly asking for page-world execution,
- the original command would otherwise fail completely,
- the fallback only triggers after the failure.

### R3. Future divergence between repo and shipped extension

Validation got significantly slower because the running browser extension was not the same artifact being edited. This should be cleaned up separately.

---

## Out of Scope

- replacing `evaluate` entirely with a full `userScripts`-only architecture,
- exposing CSP bypass as a standalone user-facing command,
- broad all-tabs CSP suppression,
- service-worker/cache edge-case handling beyond the current reload fallback,
- unifying repo extension output with the packaged/live profile copy.

---

## Decision

For strict-CSP sites, the minimal dependable fix is:

**detect CSP eval failure → strip tab-scoped CSP response headers for this session → reload → retry once**

That change was necessary even after discovering the wrong-extension confusion, because the old active extension still could not evaluate page-world code on OpenStreetMap until this fallback existed.
