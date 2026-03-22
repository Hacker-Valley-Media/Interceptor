# PRD-6: Agent-Speed Interaction — Batch Execution, Smart Waits, and Resilient Targeting

**Goal:** Transform slop-browser from an atomic-action CLI into an agent-speed interaction layer — batch commands in single IPC round trips, replace blind sleeps with event-driven readiness signals, and make element targeting resilient to SPA DOM mutations — so that complex multi-step workflows (like designing in Canva) take 40-50 commands instead of 368.

**Scope:** Changes to `content.ts` (batch execution, smart waits, resilient targeting, input detection, focus tracking, SVG discovery, state hints), `background.ts` (batch routing, iframe targeting, navigation readiness), `cli/index.ts` (new commands, connection reuse), `daemon/index.ts` (session-mode persistent connections), `types.ts` (new action types). No new permissions. No CDP. No architecture changes.

**Motivation:** Session `ce33c009` exposed catastrophic inefficiency: an agent needed 368 CLI calls, 241 sleeps (209.7 seconds of blind waiting), 74 state re-queries, and 27 screenshots to place 8 shapes in Canva — and the artwork was destroyed twice. Each shape required 15-20 IPC round trips because every action (click, type, keypress, state read) is a separate CLI invocation. The agent had no readiness signals (it guessed with `sleep 10`), no stale-element recovery (7 `stale element` errors with no auto-retry), and no way to type into `contenteditable` elements (`Illegal invocation` error). These are not edge cases — they are fundamental gaps that make the tool unusable for any complex SPA interaction.

---

## Evidence Sources

| ID | Source | Path |
|----|--------|------|
| CHR-SCR | Chrome scripting API | `docs/chrome-extensions/docs/extensions/reference/api/scripting.md` |
| CHR-CS | Chrome content scripts | `docs/chrome-extensions/docs/extensions/develop/concepts/content-scripts.md` |
| CHR-DOM | Chrome dom API | `docs/chrome-extensions/docs/extensions/reference/api/dom.md` |
| CHR-MSG | Chrome messaging | `docs/chrome-extensions/docs/extensions/develop/concepts/messaging.md` |
| CHR-NAV | Chrome webNavigation API | `docs/chrome-extensions/docs/extensions/reference/api/webNavigation.md` |
| CHR-TABS | Chrome tabs API | `docs/chrome-extensions/docs/extensions/reference/api/tabs.md` |
| CHR-NM | Chrome native messaging | `docs/chrome-extensions/docs/extensions/develop/concepts/native-messaging.md` |
| CHR-MP | Chrome match patterns / content script manifest | `docs/chrome-extensions/docs/extensions/reference/manifest/content-scripts.md` |
| RNG-ARCH | RenderingNG architecture | `docs/chrome-browser/docs/chromium/renderingng-architecture.md` |
| RNG-DS | RenderingNG data structures | `docs/chrome-browser/docs/chromium/renderingng-data-structures.md` |
| RNG | RenderingNG overview | `docs/chrome-browser/docs/chromium/renderingng.md` |
| BLK | BlinkNG | `docs/chrome-browser/docs/chromium/blinkng.md` |
| BUN-TCP | Bun TCP sockets | `docs/bun/docs/runtime/networking/tcp.md` |
| BUN-WS | Bun WebSockets | `docs/bun/docs/runtime/http/websockets.md` |
| BUN-FETCH | Bun fetch / networking | `docs/bun/docs/runtime/networking/fetch.md` |
| BUN-UDP | Bun UDP sockets | `docs/bun/docs/runtime/networking/udp.md` |
| BUN-HTTP | Bun HTTP server | `docs/bun/docs/runtime/http/server.md` |
| BUN-EXEC | Bun compiled executables | `docs/bun/docs/bundler/executables.md` |
| CC-BP | Claude Code best practices | `docs/claude-code/docs/en/best-practices.md` |
| CC-COST | Claude Code costs & context | `docs/claude-code/docs/en/costs.md` |
| CC-MCP | Claude Code MCP | `docs/claude-code/docs/en/mcp.md` |
| CC-HOW | Claude Code how it works | `docs/claude-code/docs/en/how-claude-code-works.md` |
| CC-HL | Claude Code headless mode | `docs/claude-code/docs/en/headless.md` |
| SESSION | Conversation ce33c009 | Canva design session analysis (368 CLI calls, 241 sleeps) |

All doc paths are relative to `/Volumes/VRAM/80-89_Resources/80_Reference/`.

---

## Design Decision: Batch-First Architecture

The core constraint exposed by session `ce33c009` is **IPC round-trip overhead**. Each `slop` CLI invocation:

1. Spawns a Bun process (~50ms cold start for compiled binary)
2. Connects to Unix socket (`/tmp/slop-browser.sock`)
3. Sends 4-byte length-prefixed JSON
4. Daemon wraps in native messaging format and forwards to Chrome
5. Chrome routes to content script
6. Content script executes, returns result
7. Result flows back through the same 5-hop path
8. CLI prints and exits

For a single action, this is fast enough (~100-200ms end-to-end). For 15-20 actions per shape × 8 shapes = 120-160 sequential round trips, the overhead is catastrophic. The agent compounds this with `sleep` calls between each invocation because it has no readiness signal.

**Why batch execution in the content script is the right solution:**

1. **Content scripts share the page's DOM.** **[CHR-CS]**: "Although the execution environments of content scripts and the pages that host them are isolated from each other, they share access to the page's DOM." A batch of DOM actions can execute sequentially in a single content script call with zero IPC between steps.

2. **`chrome.scripting.executeScript` returns results and is promise-aware.** **[CHR-SCR]**: "If the resulting value of the script execution is a promise, Chrome will wait for the promise to settle and return the resulting value." Batch execution can return all results as an array.

3. **Each tool call costs agent context.** **[CC-COST]**: "LLM performance degrades as context fills. When the context window is getting full, Claude may start 'forgetting' earlier instructions or making more mistakes." **[CC-BP]**: "Most best practices are based on one constraint: Claude's context window fills up fast, and performance degrades as it fills." Reducing 15 tool calls to 1 saves 14× the context overhead per shape.

4. **CLI tools are already recommended over MCP for context efficiency.** **[CC-COST]**: "Prefer CLI tools when available: Tools like gh, aws, gcloud, and sentry-cli are more context-efficient than MCP servers because they don't add persistent tool definitions." slop-browser's CLI architecture is validated; batch commands extend this advantage by reducing the number of invocations.

5. **The agent operates in a gather-act-verify loop.** **[CC-HOW]**: "Each tool use gives Claude new information that informs the next step." When the tool returns rich, actionable state alongside action results, the agent makes better decisions with fewer turns.

6. **TCP sockets don't buffer small writes.** **[BUN-TCP]**: "TCP sockets do not buffer data. Multiple small socket.write() calls perform significantly worse than a single concatenated write." A batch of actions sent as one payload avoids per-message framing overhead.

---

## Phase 1: Batch Command Pipeline

### 1.1 Content Script Batch Executor

**Problem:** Every DOM action (click, type, keypress, state read) requires a separate CLI invocation → daemon → native messaging → content script round trip. In session `ce33c009`, adding a single colored, positioned shape in Canva required 15-20 sequential round trips. The agent had no way to say "do all of these in order and tell me what happened."

**Evidence:**
- **[SESSION]**: 368 CLI calls, 74 state queries, 241 sleeps across a single Canva design session. Each shape required: Escape → key shortcut → state → click color → state → click searchbox → Ctrl+A → type hex → Enter → state → click swatch → click Position → click Arrange → eval set values → Escape. That is 15-20 IPC round trips per shape.
- **[CHR-CS]**: "Content scripts can read details of the web pages the browser visits, make changes to them." A content script has full DOM access to execute multiple sequential actions in a single invocation.
- **[CC-COST]**: "Each MCP server adds tool definitions to your context, even when idle." While slop-browser is CLI (not MCP), each CLI invocation produces tool output that consumes context. Fewer invocations = less context consumed.
- **[CC-BP]**: "Claude's context window fills up fast, and performance degrades as it fills." 368 tool calls × ~200 tokens average output = ~73,600 tokens of context consumed by tool results alone.
- **[BUN-UDP]**: Bun's `sendMany()` API batches multiple sends into a single syscall to avoid per-message overhead. The same principle applies: batch actions to avoid per-action IPC overhead.

**Fix:** Add a `batch` action type to the content script's `executeAction` handler. The action accepts an array of sub-actions. The content script executes them sequentially, collecting results. Between each sub-action, an optional `waitStable` pause waits for DOM stability (see Phase 2). Returns an array of results, one per sub-action. If any sub-action fails, the batch continues (unless `stopOnError: true`) and marks the failed step.

The CLI command:
```bash
slop batch '[
  {"type":"key","key":"Escape"},
  {"type":"key","key":"r"},
  {"type":"wait_stable","ms":300},
  {"type":"click","ref":"e613"},
  {"type":"wait_stable","ms":200},
  {"type":"find_and_click","role":"textbox","name":"search"},
  {"type":"input_text","text":"#1B2A4A","clear":true},
  {"type":"key","key":"Enter"},
  {"type":"wait_stable","ms":500},
  {"type":"state"}
]'
```

This collapses 10+ IPC round trips into 1.

**Files:** `extension/src/content.ts`, `extension/src/types.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] `slop batch '<json_array>'` executes actions sequentially in a single content script call
- [x] Returns `{ results: [{action, success, data?, error?}, ...], elapsed: <ms> }`
- [x] Failed sub-action reported with error but batch continues by default
- [x] `--stop-on-error` flag halts batch on first failure
- [x] `wait_stable` sub-action available (see Phase 2) to pause between actions
- [x] State/diff sub-actions return inline results the agent can inspect
- [x] Batch size limited to 100 sub-actions (safety cap)
- [x] Total batch timeout: 30 seconds (configurable via `SLOP_BATCH_TIMEOUT`)

---

### 1.2 Find-and-Act Sub-Actions

**Problem:** The agent must run `slop state` to discover element refs, then run `slop click eXXX` as a separate call. This is the single biggest source of redundant round trips — 74 state queries in session `ce33c009`. The agent should be able to say "click the button named Position" without first querying element IDs.

**Evidence:**
- **[SESSION]**: 74 state queries in the Canva session. Most were immediately followed by a click on a discovered element. The state query existed solely to get the ref ID for the next click.
- **Current code, content.ts**: `find_element` function already does fuzzy matching by name, role, ID, placeholder, and value. It returns scored results. This logic exists but is not usable as a targeting strategy for click/type/etc.
- **[CC-HOW]**: "Each tool use gives Claude new information that informs the next step." If find-and-click returns both the match result AND the click result in one call, the agent gets all the information it needs in a single turn.

**Fix:** Add compound sub-actions that resolve elements inline:

| Sub-Action | Behavior |
|-----------|----------|
| `find_and_click` | `find_element(query)` → click best match → return match + click result |
| `find_and_type` | `find_element(query)` → type into best match → return match + type result |
| `find_and_check` | `find_element(query)` → toggle checkbox/radio → return match + result |

Parameters: `{ role?: string, name?: string, text?: string }` for targeting. Reuses existing `find_element` scoring logic.

**Files:** `extension/src/content.ts`, `extension/src/types.ts`

**Acceptance Criteria:**
- [x] `find_and_click` with `{name: "Position"}` finds and clicks the best match
- [x] `find_and_type` with `{role: "textbox", name: "Search"}` finds and types into the best match
- [x] Returns `{ matched: {ref, role, name, score}, actionResult: {...} }`
- [x] If no match found (score < 30), returns error without clicking
- [x] Works both standalone and as batch sub-actions

---

## Phase 2: Smart Wait System

### 2.1 DOM Stability Wait

**Problem:** The agent uses blind `sleep` calls between every action because it has no signal for "the UI has finished updating." In session `ce33c009`, there were 141 micro-sleeps (0.2-0.5s) and 72 one-second sleeps — a cargo-cult approach to waiting for Canva's React re-renders.

**Evidence:**
- **[SESSION]**: 241 total sleep calls, 209.7 cumulative seconds of blind waiting. The agent had no way to know when Canva finished rendering a panel, color swatch, or shape.
- **[BLK]**: "There are now only two points of entry into the rendering pipeline... (1) All rendering data need to be updated — for example, when generating new pixels for display or doing a hit test for event targeting. (2) We need an up-to-date value for a specific query which can be answered without updating all rendering data. This includes most JavaScript queries, for example, node.offsetTop." DOM mutations trigger the rendering pipeline; once the pipeline settles, the page is visually stable.
- **Current code, content.ts**: A MutationObserver already sets `domDirty = true` on any child/subtree change. This flag exists but is only used to attach a warning to action responses. It is not used as a readiness signal.
- **Current code, content.ts**: `wait_for` action already implements MutationObserver-based CSS selector polling with configurable timeout. The mechanism exists but is not integrated into the batch pipeline.

**Fix:** Add `wait_stable` action. Uses the existing `domDirty` flag as a debounce trigger:

1. Reset `domDirty = false`
2. Set up a debounce timer (default 200ms, configurable)
3. Each time `domDirty` fires, reset the timer
4. When the timer expires without any DOM mutations, the page is "stable" — return
5. Hard timeout at 5 seconds to prevent infinite waits on pages with continuous animations

This replaces ALL blind sleeps. In batch mode, `wait_stable` between actions lets the content script wait for React/Vue/Angular to finish re-rendering before proceeding to the next action.

**Files:** `extension/src/content.ts`, `extension/src/types.ts`

**Acceptance Criteria:**
- [x] `slop wait-stable` returns when DOM hasn't changed for 200ms
- [x] `slop wait-stable --ms 500` configures debounce duration
- [x] `slop wait-stable --timeout 3000` configures hard timeout
- [x] Returns `{ stable: true, elapsed: <ms>, mutations: <count> }` or `{ stable: false, timeout: true }`
- [x] Available as batch sub-action: `{"type":"wait_stable","ms":200}`
- [x] Uses per-call MutationObserver for precise debouncing (same childList+subtree pattern as existing domDirty observer)

---

### 2.2 Navigation Readiness

**Problem:** `waitForTabLoad` in `background.ts` waits for Chrome's `tabs.onUpdated` status `"complete"`. SPA navigations (React Router, Next.js, Canva) often don't fire `"complete"` because they update the DOM without a full page load. The agent resorted to `sleep 10` after opening Canva because the `"complete"` event never fired or fired before the app was interactive.

**Evidence:**
- **[SESSION]**: Two `sleep 10` calls after opening Canva tabs. One `sleep 8` after opening Google Docs. `waitForTabLoad` timed out at 30 seconds for Google Docs.
- **[CHR-TABS]**: `tabs.onUpdated` fires with `status: "loading"` and `status: "complete"`. But `"complete"` only reflects the document's `readyState`, not whether the SPA has finished rendering its initial view.
- **[CHR-NAV]**: `onDOMContentLoaded`: "Fired when the page's DOM is fully constructed, but the referenced resources may not finish loading." `onCompleted`: "Fired when a document, including the resources it refers to, is completely loaded and initialized." `onHistoryStateUpdated`: "Fires on history.pushState()" — critical for SPA navigation detection.
- **[RNG-ARCH]**: "The rendering event loop scheduler and runner decides what to run on the event loop and when. It schedules rendering to happen at a cadence matching the device display." The browser's own rendering pipeline provides the authoritative signal for when a page is visually ready.
- **[BLK]**: "If the DocumentLifecycle state is kStyleClean or later, then NeedsStyleRecalc() must return false for any attached node." Once style, layout, and paint are complete, the page is in a stable visual state.

**Fix:** Replace `waitForTabLoad` with a two-stage readiness check:

1. **Stage 1 (background):** Wait for `tabs.onUpdated` status `"complete"` OR `webNavigation.onCompleted` (whichever fires first). Timeout: 10 seconds.
2. **Stage 2 (content script):** After stage 1, inject a readiness probe into the content script that checks: `document.readyState === "complete"` AND no pending `fetch`/`XMLHttpRequest` (tracked via PerformanceObserver for `resource` entries with `responseEnd === 0`) AND DOM stable for 500ms (via `wait_stable`).

If stage 1 times out (SPA), skip directly to stage 2 — inject the content script and wait for DOM stability. This handles the Canva case where `"complete"` never fires but the content script can observe that the DOM has settled.

**Files:** `extension/src/background.ts`, `extension/src/content.ts`

**Acceptance Criteria:**
- [x] `slop tab new <url>` returns only after page is interactive (not just `"complete"`)
- [ ] SPA navigations detected via `onHistoryStateUpdated` trigger readiness check
- [x] Content-script-side readiness probe: readyState + no pending fetches + DOM stable
- [x] Total timeout: 15 seconds (not 30, not 10-second sleep)
- [x] Returns `{ ready: true, elapsed: <ms> }` or `{ ready: false, reason: "timeout" }`
- [x] Backward-compatible: existing `waitForTabLoad` callers get the improved behavior

---

## Phase 3: Resilient Element Targeting

### 3.1 Auto-Retry on Stale References

**Problem:** When a ref resolves to a disconnected DOM element (GC'd by React/Vue re-render), the content script returns `error: stale element [undefined] -- run slop state to refresh`. The agent must then manually run `slop state`, find the new ref, and retry. This happened 7 times in session `ce33c009` with zero auto-recovery.

**Evidence:**
- **[SESSION]**: 7 stale element errors. Each required a manual `slop state` + retry, adding 2 extra round trips per stale hit. In a batch context, this would halt the entire sequence.
- **Current code, content.ts**: `resolveRef` checks the WeakRef in `refRegistry`. If the element is GC'd or disconnected from the DOM, it returns null. `pruneStaleRefs` exists but only removes disconnected refs — it doesn't try to re-resolve them.
- **Current code, content.ts**: `find_element` does fuzzy matching by role, name, ID, value with scored results. This scoring logic can be used to find the "most similar" element when a ref goes stale.

**Fix:** When `resolveRef` returns null (stale ref), before returning an error:

1. Look up the stale ref's last-known metadata (role, name, aria attributes) from a `refMetadata` cache populated on every state read
2. Run `find_element` with that metadata as the query
3. If the best match scores ≥ 70, auto-resolve to the new ref
4. Return the action result with an advisory: `"warning": "stale ref e613 re-resolved to e847 (button 'Position', score: 92)"`
5. If no good match (score < 70), return the stale error as today

**Files:** `extension/src/content.ts`

**Acceptance Criteria:**
- [x] Stale refs auto-resolve to the best matching element when score ≥ 70
- [x] `refMetadata` cache stores `{role, name, value, tag}` per ref on state read
- [x] Re-resolution reported via `warning` field (not silent)
- [x] If no match found, existing `stale element` error returned unchanged
- [x] Auto-retry does NOT trigger a full state rebuild (targeted search only)

---

### 3.2 Semantic Element Selectors

**Problem:** Element refs (`e5`, `e613`) are assigned sequentially and change whenever the DOM tree is rebuilt. The agent must constantly re-query state to discover new refs. A semantic selector like `button:Position` survives DOM re-renders because it targets the element's accessibility semantics, not its position in the tree.

**Evidence:**
- **[SESSION]**: The "Position" button had refs `e613`, `e847`, and at least 3 other IDs across the session. The agent re-discovered it every time by running `slop state` and scanning the output.
- **[CHR-CS]**: "Content scripts share access to the page's DOM." Standard DOM queries (`querySelectorAll('[role="button"][aria-label="Position"]')`) work from content scripts. The Accessibility Object Model (`element.computedRole`, `element.computedName`) provides the semantic identity that survives re-renders.
- **Current code, content.ts**: `getEffectiveRole` maps 20+ HTML tags to implicit ARIA roles. `getAccessibleName` resolves aria-label, aria-labelledby, label-for, alt text, title, and textContent. Both functions already compute the semantic identity — they just aren't used for targeting.

**Fix:** Accept semantic selectors in element targeting: `role:name` format. The content script resolves `"button:Position"` by scanning all visible elements for `computedRole === "button"` AND `computedName` containing "Position". First exact match wins; if no exact match, fuzzy match with score threshold.

CLI usage: `slop click "button:Position"`, `slop type "textbox:Search" "hello"`.

The `parseElementTarget` function in `cli/index.ts` already differentiates numeric indices from `eN` refs. Add a third case: if the target contains `:`, treat it as `role:name` semantic selector.

**Files:** `extension/src/content.ts`, `cli/index.ts`, `extension/src/types.ts`

**Acceptance Criteria:**
- [x] `slop click "button:Position"` resolves and clicks the button named "Position"
- [x] `slop type "textbox:Search" "circle"` resolves and types into the textbox named "Search"
- [x] Semantic resolution uses `computedRole` + `computedName` (not DOM attributes alone)
- [x] Exact name match preferred; contains match as fallback
- [x] Returns matched ref in response: `{ matched: "e847", role: "button", name: "Position" }`
- [x] Works in batch sub-actions

---

## Phase 4: Smart Input Handling

### 4.1 Input Type Detection and Dispatch

**Problem:** `input_text` at `content.ts` uses the native setter trick (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set`) which only works for `<input>` and `<textarea>` elements. `contenteditable` divs return `Illegal invocation`. `role="textbox"` custom elements built with web component frameworks silently fail.

**Evidence:**
- **[SESSION]**: `slop type e249 "circle"` on Canva's Elements search box (a `role="textbox" contenteditable` div) returned `error: Illegal invocation`. The agent fell back to `eval --main` with direct DOM manipulation.
- **Current code, content.ts**: `input_text` calls `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, text)` — this throws when `el` is not an `HTMLInputElement` or `HTMLTextAreaElement`.
- **[CHR-CS]**: Content scripts share the page's DOM and can call `document.execCommand('insertText', false, text)` for contenteditable elements. This is the standard web platform approach.
- **[CHR-SCR]**: MAIN world execution (`world: "MAIN"`) is available for framework-specific state updates (React `dispatchEvent(new Event('input'))`, Vue `$emit`).

**Fix:** Detect element type and dispatch input using the correct strategy:

```
1. Is it <input> or <textarea>?
   → Native setter + input/change events (current behavior)
2. Is it contenteditable?
   → Focus element → select all → document.execCommand('insertText', false, text)
   → Dispatch input event
3. Is it a web component with shadow DOM?
   → Pierce shadow root via chrome.dom.openOrClosedShadowRoot()
   → Find the actual input inside and recurse
4. None of the above but has role="textbox"?
   → Try execCommand first, fall back to textContent + input event
```

Add `--clear` flag that selects all text and deletes before typing, since this is needed for virtually every SPA input interaction (the agent had to manually send `Ctrl+A` before every type command in session `ce33c009`).

**Files:** `extension/src/content.ts`, `extension/src/types.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] `slop type <ref> "text"` works on `<input>`, `<textarea>`, `contenteditable`, and `role="textbox"` elements
- [x] `slop type <ref> "text" --clear` selects all + deletes before typing
- [x] `contenteditable` input uses `execCommand('insertText')` + `input` event
- [x] Error message indicates element type when input fails: `"error: element is <div contenteditable> — unsupported input type"`
- [x] Web component shadow DOM inputs discovered via `chrome.dom.openOrClosedShadowRoot()` **[CHR-DOM]**
- [x] Returns `{ typed: true, elementType: "contenteditable", method: "execCommand" }`

---

## Phase 5: Spatial Awareness

### 5.1 Viewport Coordinate Actions

**Problem:** Canvas elements, WebGL surfaces, and complex SPAs render content that has no DOM representation. The agent cannot "click at pixel 500,300 on the page" without first finding a DOM element at those coordinates. `click --at X,Y` exists but is relative to an element's bounding rect — there's no absolute viewport coordinate click.

**Evidence:**
- **[SESSION]**: Canvas elements in Google Docs (`kix-canvas-tile-content`) were not in the interactive element index. The agent had to use `eval` with `dispatchEvent` to click on them. Canva's design surface is not a `<canvas>` at all — it's a custom rendering layer with no interactive DOM children.
- **[RNG-ARCH]**: "An input and hit test handler performs input processing and hit testing at the resolution of composited layers, to determine if scrolling gestures can be run on the compositor thread, and which render process hit tests should target." The browser resolves clicks via composited-layer hit testing. Extensions can replicate this with `document.elementFromPoint(x, y)`.
- **[RNG-ARCH]**: "A synthetic event injected via DOM APIs like dispatchEvent() skips the browser process and compositor thread entirely — it only exists on the main thread." Content script synthetic events are architecturally separate from the browser's input pipeline, which is why they work on canvas elements.
- **[RNG-DS]**: "Canvas content becomes a texture draw quad in the compositor frame, composited alongside regular tile content." Canvas is opaque to the DOM — the only way to target within it is via coordinates.

**Fix:** Add three viewport-coordinate commands:

1. **`slop click-at X,Y`** — Absolute viewport coordinate click. Uses `document.elementFromPoint(x, y)` to find the element at those coordinates, then dispatches the existing 7-event click sequence on that element with the exact coordinates. If the element is a `<canvas>`, dispatches directly with canvas-relative offsets.

2. **`slop what-at X,Y`** — Returns what element is at a viewport coordinate: `{ ref, tag, role, name, rect }`. Lets the agent reason about spatial layout without a full state refresh.

3. **`slop regions`** — Returns a spatial map of all interactive elements: `[{ref, role, name, x, y, w, h}, ...]`. Gives the agent a "visual" understanding of the layout. Sorted by visual position (top-to-bottom, left-to-right).

**Files:** `extension/src/content.ts`, `extension/src/types.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] `slop click-at 500,300` clicks at absolute viewport coordinates (500, 300)
- [x] Uses `document.elementFromPoint(x, y)` for target resolution
- [x] Canvas elements receive the click with correct canvas-relative offsets
- [x] `slop what-at 500,300` returns the element at those coordinates with ref, role, name, rect
- [x] `slop regions` returns spatial map of interactive elements sorted by position
- [x] Coordinates are CSS pixels (matching `getBoundingClientRect()`)

---

### 5.2 Focus Awareness

**Problem:** The agent has no way to know which element has keyboard focus. In session `ce33c009`, pressing `r` (Canva shortcut for rectangle) typed "r" into the Elements search box because the search box had focus. The agent didn't know this and wasted multiple commands diagnosing why no rectangle appeared.

**Evidence:**
- **[SESSION]**: Keyboard shortcuts captured by focused search box — 2 occurrences. Each cost 3-4 extra commands (screenshot, diagnosis, click to blur, retry).
- **[RNG-ARCH]**: "The input event hit testing and dispatching component executes hit tests to find out which DOM element is targeted by an event." Keyboard events go to the focused element, not the clicked element. The agent needs focus state to predict where keyboard events will land.
- **Current code, content.ts**: `getPageState` does not include focus information. No `document.activeElement` reference in the state output.

**Fix:**

1. **`slop focus`** — Returns the currently focused element: `{ ref, tag, role, name, type, editable }`. If `document.activeElement` is `<body>` or `null`, returns `{ focused: null }`.

2. **`slop blur`** — Calls `document.activeElement.blur()`. Removes focus from any element. Simpler and more reliable than clicking empty space to deselect.

3. **Focus in state output** — Add `focused` field to `getPageState` output: `"focused: e249 textbox 'Search Elements'"`. The agent always knows focus state without a separate query.

**Files:** `extension/src/content.ts`, `extension/src/types.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] `slop focus` returns the currently focused element with ref, role, name
- [x] `slop blur` removes focus from the active element
- [x] `slop state` output includes `focused:` line
- [x] If no element has focus (body/null), `focused: none` reported
- [x] `editable` field indicates whether the focused element accepts text input

---

## Phase 6: iframe Support

### 6.1 Cross-Frame Element Targeting

**Problem:** Content script only sees the top frame. Google Docs uses iframes for spell-check, suggestion panels, and comment threads. Notion, Figma, and many SPAs use iframes for embedded content. The `frames_list` command enumerates frames but no action can target elements inside them.

**Evidence:**
- **[CHR-MP]**: "allFrames: If set to true, it will inject into all frames, even if the frame is not the topmost frame in the tab. Each frame is checked independently for URL requirements. Defaults to false, meaning that only the top frame is matched."
- **[CHR-SCR]**: `executeScript` supports `target: { tabId, frameIds: [id] }` for specific frame targeting and `target: { tabId, allFrames: true }` for all frames. "A single result is included per-frame."
- **[CHR-NAV]**: `getAllFrames()`: "Retrieves information about all frames of a given tab." Frame IDs: "The frame ID of the main frame is always 0, the ID of child frames is a positive number. Once a document is constructed in a frame, its frame ID remains constant during the lifetime of the document." `documentId` (Chrome 106+) provides stable per-document identifiers.
- **[CHR-MSG]**: `chrome.tabs.sendMessage` supports `frameId` and `documentId` (Chrome 106+) targeting: "Send a single message to the content script(s) in the specified tab." This enables routing actions to specific frames.
- **[RNG-ARCH]**: "Different sites always end up in different render processes." Cross-origin iframes run in separate render processes with independent content scripts.
- **[RNG-DS]**: "A frame rendered in a different process is represented as a remote frame. A remote frame holds the minimum information needed to act as a placeholder in rendering, such as its dimensions." Frame dimensions are available for coordinate mapping.

**Fix:**

1. Register content script with `all_frames: true` in the manifest to inject into all frames automatically.

2. Add `--frame` parameter to all commands: `slop state --frame 3`, `slop click --frame 3 e5`. The background script routes the message to the correct frame using `chrome.tabs.sendMessage(tabId, message, { frameId })`.

3. `slop frames` enriches the existing `frames_list` with element counts per frame (obtained by querying each frame's content script).

**Files:** `extension/manifest.json`, `extension/src/background.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] Content script injected into all frames via `all_frames: true`
- [x] `slop state --frame 3` returns elements from frame ID 3
- [x] `slop click --frame 3 e5` clicks element e5 in frame 3
- [x] `slop frames` returns all frames with URL, frameId, element count
- [x] Cross-origin iframes supported (separate content script instances)
- [x] Default (no `--frame`) targets the top frame (frameId 0) — backward compatible

---

## Phase 7: Non-HTML Element Discovery

### 7.1 SVG Interactive Element Detection

**Problem:** SVG elements (`<svg>`, `<path>`, `<circle>`, `<rect>`, `<text>`, `<a>`) with click handlers or interactive attributes are invisible to the element discovery system. D3.js charts, icon buttons wrapped in SVG, and interactive data visualizations use SVG elements as primary interaction targets.

**Evidence:**
- **Current code, content.ts**: `isInteractive` checks tag names (`A, BUTTON, INPUT, SELECT, TEXTAREA, DETAILS, SUMMARY`), ARIA roles, `onclick`, `contenteditable`, and `tabindex`. No SVG tags are in this list. An `<svg><circle onclick="..." />` would not be discovered.
- **[RNG]**: "SVG animations are now composited (hardware-accelerated)." SVG elements are first-class rendering primitives, but from the DOM perspective they are standard elements queryable with `document.querySelectorAll('svg')`.
- **[RNG-DS]**: SVG content is rasterized into the same tile-based compositing pipeline as HTML. SVG elements support standard DOM event listeners (`addEventListener`), `getBBox()`, `getCTM()`, and `getScreenCTM()` for geometry.

**Fix:** Extend `isInteractive` to detect interactive SVG elements:

1. Check SVG namespace elements (`<a>` with `href`/`xlink:href`, any SVG element with `onclick`/`tabindex`/`role`/cursor style)
2. Walk `<svg>` subtrees for interactive children
3. Use `getBBox()` for SVG element geometry (instead of `getBoundingClientRect()` which may not account for SVG transforms)
4. Map SVG elements to appropriate roles: `<a>` → `link`, `<text>` with click → `button`

**Files:** `extension/src/content.ts`

**Acceptance Criteria:**
- [x] SVG `<a>` elements with `href` discovered as `link` role
- [x] SVG elements with `onclick`, `tabindex > -1`, or interactive `role` discovered
- [x] SVG element geometry reported via `getBoundingClientRect()` (standard for all elements)
- [x] SVG elements get ref IDs and appear in `slop state` output
- [x] Clicking SVG elements dispatches events with correct coordinates

---

## Phase 8: Application State Intelligence

### 8.1 Modal and Dialog Detection

**Problem:** When a modal dialog is open, the agent should interact with the modal — not click elements behind it. In session `ce33c009`, multiple panel interactions failed because the agent clicked elements that were visually occluded by Canva's side panels. The agent had no awareness of overlays.

**Evidence:**
- **[SESSION]**: Position panel opening to wrong tab (Layers instead of Arrange). Color picker panel occluding other elements. The agent clicked through panels without knowing they were open.
- **[RNG-DS]**: "Layerize step trades GPU memory vs re-rasterization cost." Elements with high z-index get their own composited layers. Modals and overlays are composited on top of page content.
- **Current code, content.ts**: `isVisible` checks `visibility`, `display`, `offsetParent`, and bounding rect. It does NOT check whether the element is occluded by a higher-z-index overlay.

**Fix:** Add `slop modals` command that detects open modals, dialogs, and overlays:

1. Find all `<dialog open>`, `[role="dialog"]`, `[aria-modal="true"]` elements
2. Find elements with `position: fixed/absolute` + high z-index + covering significant viewport area (>25%)
3. Report each with ref, role, name, dimensions, and containment info (what interactive elements are inside)

Add `slop panels` command for expanded/collapsed state:
1. Find all `[aria-expanded="true"]` elements and their associated `[role="tabpanel"]`/`[role="menu"]`/etc.
2. Report which panels are open and what they contain

**Files:** `extension/src/content.ts`, `extension/src/types.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] `slop modals` detects `<dialog open>`, `[role="dialog"]`, `[aria-modal="true"]`, viewport-covering overlays
- [x] Returns `{ modals: [{ref, role, name, rect, children: <count>}] }`
- [x] `slop panels` detects expanded sections via `aria-expanded="true"`
- [x] Returns `{ panels: [{ref, role, name, expanded: true, contentRef}] }`
- [x] Both available as batch sub-actions for pre-action context gathering

---

### 8.2 DOM Change Summary on Action Response

**Problem:** After clicking a button, the agent has no idea what changed. It must run `slop state` or take a screenshot to understand the effect. The existing `diff` action exists but requires two explicit calls — it's not automatic.

**Evidence:**
- **[SESSION]**: 27 screenshots taken to verify whether individual actions succeeded. Each screenshot = 1 CLI call + 1 file read = 2 extra tool calls per verification.
- **[CC-HOW]**: "Each tool use gives Claude new information that informs the next step." If every action response includes what changed, the agent can act immediately without verification round trips.
- **Current code, content.ts**: `diff` action computes additions, removals, value changes, state changes, and name changes from a cached snapshot. The infrastructure exists — it just needs to be attached to action responses.

**Fix:** After every action that modifies the DOM (click, type, key, check), automatically run a mini-diff and attach the result:

```json
{
  "success": true,
  "changes": {
    "added": ["e850 dialog 'Color Picker'"],
    "removed": [],
    "changed": ["e613 button aria-expanded: false→true"],
    "count": 2
  }
}
```

This is opt-in via `--changes` flag or `"changes": true` in batch sub-actions. Not always-on to avoid overhead for simple actions.

**Files:** `extension/src/content.ts`, `extension/src/types.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] `slop click e613 --changes` returns action result + DOM change summary
- [x] Change summary includes: added elements, removed elements, attribute changes
- [x] In batch mode: `{"type":"click","ref":"e613","changes":true}` attaches changes to that sub-action
- [x] Changes computed via existing diff infrastructure (snapshot before → snapshot after)
- [x] Overhead < 50ms for typical pages (only scans elements in current viewport)

---

## Phase 9: IPC Performance

### 9.1 Session-Mode Persistent Connection

**Problem:** Each `slop` CLI invocation creates a new Unix socket connection, sends one message, receives one response, and disconnects. For 368 commands, that is 368 socket connect/disconnect cycles plus 368 Bun process spawns (~50ms each = ~18 seconds of process startup alone).

**Evidence:**
- **[BUN-TCP]**: "Handlers are declared once per server, not per socket. This avoids GC pressure from allocating callback functions per connection." Bun's socket design favors persistent connections with shared handlers.
- **[BUN-TCP]**: "TCP sockets do not buffer data. Multiple small socket.write() calls perform significantly worse than a single concatenated write." Persistent connections avoid per-message connection overhead.
- **[BUN-FETCH]**: "Bun automatically reuses connections (HTTP keep-alive) — no configuration needed. Default simultaneous connection limit: 256." If the daemon exposed an HTTP server over Unix socket, Bun's built-in connection pooling would apply automatically.
- **[BUN-HTTP]**: `Bun.serve({ unix: "/tmp/my-socket.sock" })` is a first-class API. The daemon could serve HTTP over UDS, getting routing, WebSocket upgrade, and keep-alive for free.
- **[BUN-WS]**: Bun WebSocket benchmark: "~700,000 messages/sec" vs Node.js "~100,000 messages/sec" — 7x faster. WebSocket `cork()` method batches multiple sends into a single TCP frame.
- **[BUN-EXEC]**: Compiled Bun binaries include the full runtime with all built-in APIs (TCP, HTTP, WebSocket, IPC). No feature loss from compilation.

**Fix:** Add session-mode persistent connection:

1. `slop session start` — CLI connects to the daemon and holds the socket open. Writes a session PID file.
2. Subsequent `slop` commands detect the session PID file and send commands through the existing connection via a lightweight IPC pipe (or named socket pair), avoiding process spawn + connect for each command.
3. `slop session end` — Closes the persistent connection and removes the PID file.

For the batch case (Phase 1), session mode is optional since batch already collapses multiple actions into one round trip. Session mode is most valuable for interactive workflows where the agent sends sequential non-batchable commands.

**Files:** `cli/index.ts`, `daemon/index.ts`

**Acceptance Criteria:**
- [x] `slop session start` establishes session marker
- [ ] Subsequent `slop` commands reuse the connection (no new process per command) — deferred: batch executor provides equivalent throughput
- [x] `slop session end` closes the session cleanly
- [x] Session PID file at `/tmp/slop-browser-session.pid`
- [x] Fallback: if no session active, each command creates its own connection (current behavior)
- [ ] Session timeout: 5 minutes idle auto-disconnect — deferred: requires daemon changes

---

### 9.2 Incremental State Updates

**Problem:** `slop state` rebuilds the entire element tree on every call. For pages with thousands of elements (Canva has ~800 interactive elements), this is wasteful when only a few elements changed between calls.

**Evidence:**
- **[SESSION]**: 74 state queries in the Canva session. Each rebuilt the entire tree. Most were needed only to discover what changed after a single click.
- **Current code, content.ts**: `getInteractiveElements` walks the entire DOM tree including shadow roots. `buildElementTree` serializes every element. No caching or incremental update.
- **Current code, content.ts**: `diff` action already caches a snapshot and computes deltas. The infrastructure for incremental updates exists in the diff mechanism.
- **[BLK]**: "During style and layout, content can be marked with a simple boolean flag as 'possibly needs paint invalidation.' During the pre-paint tree walk, we check these flags and issue invalidations as necessary." Chrome's own rendering pipeline uses dirty-flag-based incremental updates — the same principle applies to element tree construction.

**Fix:** `slop diff` as the primary state-update mechanism:

1. First `slop state` call builds the full tree and caches the snapshot
2. Subsequent `slop diff` calls return only changes since the last snapshot: added refs, removed refs, value changes, attribute changes
3. `slop state --full` forces a complete rebuild (escape hatch)
4. The MutationObserver already tracks `domDirty` — use it to short-circuit: if `domDirty === false`, `slop diff` returns `{ changes: 0 }` immediately without any DOM walking

**Files:** `extension/src/content.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] `slop diff` returns only elements that changed since last state/diff call
- [x] If `domDirty === false`, returns immediately with `{ changes: 0 }`
- [x] Returns `{ added: [...], removed: [...], changed: [...], total: <count> }`
- [x] `slop state` still returns full tree (backward compatible)
- [x] `slop state --full` forces rebuild even if cache exists

---

## Implementation Order

| Priority | Phase | Effort | Why |
|----------|-------|--------|-----|
| **P0** | 1.1 — Batch executor | Medium (3 hr) | Single highest-impact change: collapses 15-20 IPC round trips to 1 per shape |
| **P0** | 2.1 — DOM stability wait | Small (1 hr) | Eliminates 241 blind sleeps. Uses existing MutationObserver |
| **P0** | 2.2 — Navigation readiness | Medium (2 hr) | Eliminates 10-second sleeps on page load. Fixes SPA navigation |
| **P1** | 1.2 — Find-and-act | Small (1 hr) | Eliminates 74 state re-queries by combining find + action in one call |
| **P1** | 3.1 — Auto-retry stale | Small (1 hr) | Eliminates 7+ stale errors per session with zero agent intervention |
| **P1** | 3.2 — Semantic selectors | Medium (2 hr) | Stable element targeting that survives DOM re-renders |
| **P1** | 4.1 — Smart input handling | Medium (2 hr) | Fixes broken contenteditable + role="textbox" input |
| **P1** | 5.2 — Focus awareness | Tiny (30 min) | Prevents keyboard shortcut misdirection. Three simple commands |
| **P2** | 5.1 — Viewport coordinates | Small (1 hr) | Enables canvas and non-DOM interaction via absolute positioning |
| **P2** | 8.2 — Change summary | Small (1 hr) | Rich action responses eliminate post-action screenshot verification |
| **P2** | 9.2 — Incremental state | Medium (2 hr) | Faster state updates via diff-only. Uses existing snapshot infra |
| **P2** | 8.1 — Modal/panel detection | Small (1 hr) | Prevents clicking behind overlays. ARIA-based detection |
| **P3** | 6.1 — iframe support | Medium (2 hr) | Unlocks multi-frame apps. Requires manifest change + routing |
| **P3** | 7.1 — SVG discovery | Small (1 hr) | Unlocks D3.js charts, SVG icon buttons, data viz |
| **P3** | 9.1 — Session persistence | Medium (3 hr) | Eliminates per-command process spawn. Optional for batch users |

**Total estimated effort:** ~24 hours across 15 work items.

---

## What This PRD Does NOT Cover

| Topic | Why Excluded |
|-------|-------------|
| HTML5 Drag API (`dragstart`, `dragenter`, `drop`) | Distinct from pointer-based drag (PRD-5 4.2). Requires separate event dispatch model. Future PRD. |
| `event.isTrusted` bypass | Synthetic events are always `isTrusted: false`. Some sites reject untrusted events. No extension API solution exists — this is a browser security boundary. |
| WebSocket/SSE monitoring | Real-time data stream interception is a different domain (network layer, not DOM interaction). Future PRD. |
| Pointer lock (FPS games) | `requestPointerLock()` captures all mouse input. Synthetic events cannot replicate this. Out of scope. |
| Print/PDF generation | `window.print()` opens a system dialog that blocks the extension. Requires alternative approach. Future PRD. |
| File upload implementation | `file_upload` is declared in `types.ts` but unimplemented. Separate concern — requires native file system interaction. Future PRD. |
| Macro recording/playback | Named reusable action sequences. Builds on batch (Phase 1) but requires persistence layer. Future PRD. |

---

## Files Modified

| File | Changes |
|------|---------|
| `extension/src/content.ts` | Batch executor (#1.1), find-and-act (#1.2), wait_stable (#2.1), nav readiness probe (#2.2), auto-retry stale (#3.1), semantic selectors (#3.2), smart input (#4.1), viewport coords (#5.1), focus commands (#5.2), SVG detection (#7.1), modal/panel detection (#8.1), change summary (#8.2), incremental state (#9.2) |
| `extension/src/types.ts` | New action types: `batch`, `find_and_click`, `find_and_type`, `find_and_check`, `wait_stable`, `click_at`, `what_at`, `regions`, `focus`, `blur`, `modals`, `panels` |
| `extension/src/background.ts` | Batch routing, improved `waitForTabLoad` (#2.2), frame-targeted `sendMessage` (#6.1) |
| `extension/manifest.json` | `all_frames: true` for content script (#6.1) |
| `cli/index.ts` | New commands: `batch`, `wait-stable`, `click-at`, `what-at`, `regions`, `focus`, `blur`, `modals`, `panels`, `diff`. Semantic selector parsing. `--frame`, `--changes`, `--clear` flags. Session mode (#9.1) |
| `daemon/index.ts` | Session-mode persistent connection support (#9.1) |

No new files. No new permissions. No new dependencies. No CDP. No architecture changes.
