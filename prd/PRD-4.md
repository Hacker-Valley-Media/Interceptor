# PRD-4: Accessibility Tree & Semantic DOM Intelligence

**Goal:** Transform slop-browser's flat interactive-element list into a semantic accessibility tree with stable element references, computed accessible names, ARIA state capture, landmark navigation, fuzzy search, snapshot diffing, and shadow DOM traversal — without introducing CDP or detectable fingerprints.

**Scope:** Content script redesign (`content.ts`), new CLI commands, updated action types in `types.ts`, daemon message buffering. No new Chrome permissions except `dom`. No architecture changes. No CDP.

**Motivation:** slop-browser's current `getInteractiveElements()` produces a flat, index-numbered list of interactive elements. This has four critical limitations that degrade agent effectiveness on real-world websites:

1. **No semantic context.** The agent sees `[3]<button>Submit</button>` but not that it's inside a `<form>` within the `<main>` landmark. On complex pages (dashboards, SPAs, enterprise apps), the agent cannot orient itself without structural context.
2. **Fragile element references.** Numeric indices `[0]...[N]` are reassigned on every `getPageState()` call. Any DOM mutation between `slop state` and `slop click 5` invalidates every index. Multi-step workflows (fill form → submit → verify) require re-reading state after every action.
3. **Missing accessibility semantics.** The agent doesn't see ARIA states (`expanded`, `pressed`, `disabled`, `checked`, `selected`), computed accessible names (from `aria-labelledby`, `<label for>`, `alt`, `title`), or implicit roles (`<nav>` → `navigation`, `<main>` → `main`). These are the signals that tell an agent what an element *does* and whether it's *actionable*.
4. **Invisible elements.** Shadow DOM components (Google products, Salesforce Lightning, Shopify, any Web Component-based UI) are completely invisible to the current `TreeWalker`, which cannot cross shadow boundaries.

These limitations were identified by comparing slop-browser against Anthropic's Claude in Chrome extension (v1.0.47), specifically its `accessibility-tree.js` content script and `read_page` MCP tool, and by studying the accessibility instrumentation patterns in SwiftUIDebugKit-Conversift's `AccessibilityBridge` and `RefIDRegistry`.

---

## Evidence Sources

| ID | Source | Path |
|----|--------|------|
| CHR-DBG | Chrome debugger API | `docs/chrome-extensions/docs/extensions/reference/api/debugger.md` |
| CHR-DOM | Chrome dom API | `docs/chrome-extensions/docs/extensions/reference/api/dom.md` |
| CHR-CS | Chrome content scripts | `docs/chrome-extensions/docs/extensions/develop/concepts/content-scripts.md` |
| CHR-MSG | Chrome messaging | `docs/chrome-extensions/docs/extensions/develop/concepts/messaging.md` |
| CHR-TABS | Chrome tabs API | `docs/chrome-extensions/docs/extensions/reference/api/tabs.md` |
| CHR-SCR | Chrome scripting API | `docs/chrome-extensions/docs/extensions/reference/api/scripting.md` |
| CHR-SW | Chrome service worker migration | `docs/chrome-extensions/docs/extensions/develop/migrate/to-service-workers.md` |
| CHR-LIFE | Chrome SW lifecycle | `docs/chrome-extensions/docs/extensions/develop/concepts/service-workers/lifecycle.md` |
| CC-CHR | Claude Code Chrome integration | `docs/claude-code/docs/en/chrome.md` |
| CC-BP | Claude Code best practices | `docs/claude-code/docs/en/best-practices.md` |
| CC-DESK | Claude Code desktop | `docs/claude-code/docs/en/desktop.md` |
| BUN-STR | Bun streams / ArrayBufferSink | `docs/bun/docs/runtime/streams.md` |
| BUN-TCP | Bun TCP socket docs | `docs/bun/docs/runtime/networking/tcp.md` |
| BUN-GC | Bun benchmarking / GC | `docs/bun/docs/project/benchmarking.md` |
| BUN-WEB | Bun Web APIs | `docs/bun/docs/runtime/web-apis.md` |
| REF-SYS | Claude extension system | `research/ClaudeExtension/07_Extension_System.md` |
| REF-API-RP | Claude extension read_page | `research/ClaudeExtension/09_API/03_read_page.md` |
| REF-API-FD | Claude extension find tool | `research/ClaudeExtension/09_API/04_find.md` |
| REF-EXEC | Claude extension executive summary | `research/ClaudeExtension/01_Executive_Summary.md` |
| REF-ARCH | Claude extension architecture | `research/ClaudeExtension/06_Core_Architecture.md` |
| REF-TS | Claude extension troubleshooting | `research/ClaudeExtension/12_Troubleshooting.md` |
| SDK-AB | SwiftUIDebugKit AccessibilityBridge | `conversift/SwiftUIDebugKit-Conversift/Sources/SwiftUIDebugMCP/Bridges/AccessibilityBridge.swift` |
| SDK-REF | SwiftUIDebugKit RefIDRegistry | `conversift/SwiftUIDebugKit-Conversift/Sources/SwiftUIDebugMCP/Session/RefIDRegistry.swift` |
| SDK-FMT | SwiftUIDebugKit HierarchyFormatter | `conversift/SwiftUIDebugKit-Conversift/Sources/SwiftUIDebugMCP/Formatters/HierarchyFormatter.swift` |
| SDK-SNAP | SwiftUIDebugKit SnapshotCache | `conversift/SwiftUIDebugKit-Conversift/Sources/SwiftUIDebugMCP/Session/SnapshotCache.swift` |
| SDK-HIER | SwiftUIDebugKit HierarchyTools | `conversift/SwiftUIDebugKit-Conversift/Sources/SwiftUIDebugMCP/Tools/HierarchyTools.swift` |

All doc paths are relative to `/Volumes/VRAM/80-89_Resources/80_Reference/`.
SDK paths are relative to `/Volumes/VRAM/00-09_System/01_Tools/`.

---

## Design Decision: Content Script ARIA Extraction (No CDP)

Before specifying changes, this PRD must justify the core technical choice: extracting accessibility semantics via content script DOM traversal rather than the Chrome Debugger API's `Accessibility.getFullAXTree()` CDP command.

**Option A — Content Script ARIA Extraction (chosen):**
- Content script reads ARIA attributes, computes accessible names, maps implicit roles from HTML semantics
- No new permissions beyond `dom` (for shadow root access)
- Undetectable by websites — no CDP fingerprint, no debugger banner
- Available in content script isolated world without background script involvement

**Option B — CDP Accessibility Domain (rejected):**
- `chrome.debugger.sendCommand(target, "Accessibility.getFullAXTree")` returns the full computed AX tree
- Requires `debugger` permission — **[CHR-DBG, line 44]**: The Accessibility domain is whitelisted: "The available domains are: Accessibility, Audits, CacheStorage, Console, CSS, Database, Debugger, DOM..."
- **[CHR-DBG, lines 240-245]**: `chrome.debugger.attach(target, requiredVersion)` must be called first, which shows a yellow "debugging this tab" banner in Chrome — immediately detectable
- **[REF-SYS, line 313]**: Claude in Chrome uses its own content script (`accessibility-tree.js`) for DOM serialization rather than CDP Accessibility, despite having the `debugger` permission. This validates that content-script extraction is sufficient for production browser automation.

**Why Option A wins:** slop-browser's core differentiator is undetectability. CDP detection is a solved problem for anti-bot systems (Cloudflare, DataDome, PerimeterX). The debugger banner is visible to users. And Anthropic's own implementation chose content-script extraction over CDP for the same DOM reading task, which is strong evidence that Option A provides sufficient accessibility data for agent workflows.

---

## Phase 1: Computed Accessible Names

### 1.1 W3C-Derived Accessible Name Resolution

**Problem:** `getRelevantAttrs()` at `content.ts:142-175` captures `aria-label` as a raw attribute string but does not compute the element's accessible name. Elements labeled via `aria-labelledby` (referencing other elements), `<label for="id">` (HTML form association), `alt` (images), or `title` (fallback) are reported with their raw `textContent` instead of their semantic name. This means the agent sees `[5]<input type="text" placeholder="Email">` instead of `[5] textbox "Email Address"` (where "Email Address" comes from a `<label>` element).

**Evidence:**
- **[REF-SYS, lines 264-275]**: Claude in Chrome implements a 10-step label extraction cascade in its `accessibility-tree.js` content script: (1) `<select>` selected option text, (2) `aria-label`, (3) `placeholder`, (4) `title`, (5) `alt`, (6) associated `<label for="id">` text, (7) input value for submit buttons (<50 chars), (8) direct text content for buttons/links/summary, (9) full text content for headings (truncated to 100 chars), (10) first text node content ≥3 chars (truncated to 100 chars). This is not the W3C Accessible Name Computation spec — it's a pragmatic cascade optimized for agent comprehension.
- **[SDK-AB, lines 46-57]**: SwiftUIDebugKit's `AccessibilityBridge` resolves accessible names by prioritizing `kAXTitleAttribute`, falling back to `kAXDescriptionAttribute`. Same pattern — prioritized cascade, not spec-compliant computation.
- **[CHR-CS, line 10]**: "Using the standard Document Object Model (DOM), they are able to read details of the web pages the browser visits" — content scripts have full DOM read access, which means `aria-labelledby` resolution (reading referenced elements by ID) is fully supported.
- **[CC-DESK, lines 78-83]**: Claude Code "inspects the DOM, clicks elements, fills forms, and fixes issues it finds" — the agent needs semantic names to identify which element to click, not raw HTML attributes.

**Fix:** Add `getAccessibleName(el: Element): string` function implementing a pragmatic name resolution cascade:

1. `aria-label` attribute (direct label)
2. `aria-labelledby` attribute → resolve each ID reference → concatenate text
3. `<label for="id">` association (form elements only)
4. Parent `<label>` wrapping (form elements only)
5. `alt` attribute (images only)
6. `title` attribute (universal fallback)
7. `textContent` truncated to 80 chars (final fallback)

Replace all `e.text` assignments in `getInteractiveElements()` with `getAccessibleName(el)`.

**Files:** `extension/src/content.ts`

**Acceptance Criteria:**
- [x] `aria-label` resolved as primary name
- [x] `aria-labelledby` resolves referenced element IDs and concatenates their text content
- [x] `<label for="id">` associates label text with corresponding input/select/textarea
- [x] Parent `<label>` element provides name when input is nested inside it
- [x] `<img alt="...">` uses alt text as accessible name
- [x] `title` attribute used as fallback when no other name source exists
- [x] `textContent` used as final fallback, truncated to 80 chars
- [x] Empty/whitespace names fall through to the next cascade step

---

## Phase 2: ARIA State Capture

### 2.1 Interactive State Attributes

**Problem:** `getRelevantAttrs()` captures `aria-label` and a handful of HTML attributes but ignores ARIA states entirely. The agent cannot determine whether a dropdown is expanded, a toggle is pressed, a checkbox is checked, a section is disabled, or a live region is announcing updates. On modern SPAs (React, Vue, Angular), these states drive the entire UI — a menu button with `aria-expanded="false"` looks identical in raw HTML to one with `aria-expanded="true"`, but the agent needs to know whether clicking it will open or close the menu.

**Evidence:**
- **[CHR-CS, lines 14-26]**: Content scripts can access the `dom` extension API directly. Standard DOM `getAttribute()` reads all ARIA attributes without restriction from the content script's isolated world.
- **[CHR-CS, lines 31-35]**: "Content scripts live in an isolated world, allowing a content script to make changes to its JavaScript environment without conflicting with the page" — ARIA attribute reads are side-effect-free and cannot be detected by the page.
- **[REF-SYS, lines 313-316]**: Claude in Chrome's accessibility tree format includes attributes like `href`, `type`, `placeholder`, and selected state for `<option>` elements. It captures interactive state implicitly through the role/label extraction, but does not explicitly output `aria-expanded`, `aria-pressed`, etc. as separate fields.
- **[SDK-AB, lines 86-92]**: SwiftUIDebugKit captures `kAXHiddenAttribute` as a boolean. Lines 309-314 capture `kAXEnabledAttribute` (defaults to true) and `kAXFocusedAttribute` (defaults to false). These are the native macOS equivalents of ARIA states.
- **[SDK-AB, lines 317-322]**: SwiftUIDebugKit captures `AXUIElementCopyActionNames()` — the set of available actions (e.g., "AXPress") — which tells the agent what an element *can do*, not just what it is.

**Fix:** Expand `getRelevantAttrs()` to capture ARIA states that affect agent decision-making:

| Attribute | Output | Why |
|-----------|--------|-----|
| `role` | `role="menu"` | Explicit semantic role |
| `aria-expanded` | `expanded=true/false` | Menus, dropdowns, accordions, disclosures |
| `aria-pressed` | `pressed=true/false/mixed` | Toggle buttons |
| `aria-checked` | `checked` | Custom checkboxes (native `checked` already captured) |
| `aria-selected` | `selected` | Tabs, listbox options, tree items |
| `aria-disabled` / `disabled` | `disabled` | Unactionable elements |
| `aria-hidden` | `aria-hidden` | Elements hidden from assistive technology |
| `aria-live` | `live="polite/assertive"` | Dynamic content regions |
| `aria-required` / `required` | `required` | Form validation |
| `aria-invalid` | `invalid` | Form error state |

**Files:** `extension/src/content.ts`

**Acceptance Criteria:**
- [x] `role` attribute included in output when explicitly set
- [x] `aria-expanded` captured for elements that have it (buttons, details, comboboxes)
- [x] `aria-pressed` captured for toggle buttons
- [x] `aria-selected` captured for tab/option/treeitem elements
- [x] `disabled` state captured from both `aria-disabled="true"` and native `disabled` property
- [x] `aria-hidden="true"` captured (agent should know element is AT-hidden but DOM-visible)
- [x] `aria-live` captured when not `"off"` (agent needs to know about announcement regions)
- [x] `aria-required` and `aria-invalid` captured for form fields
- [x] States only included when present (no `expanded=undefined` noise)

---

## Phase 3: Semantic Accessibility Tree

### 3.1 Hierarchical Tree with Landmarks, Headings, and Roles

**Problem:** `buildElementTree()` at `content.ts:177-183` produces a flat, unstructured list. The agent sees:

```
[0]<a href="/">Home</a>
[1]<button class="primary">Submit</button>
[2]<input type="text" placeholder="Search">
```

It does not see that `[0]` is inside a `<nav>` landmark, `[1]` is inside a `<form>` within `<main>`, and `[2]` is in a `<header>` search region. On a page with 50+ interactive elements, the agent has no way to navigate by section — it must read every element linearly to find the one it wants.

**Evidence:**
- **[REF-SYS, lines 318-327]**: Claude in Chrome's `read_page` returns an indented accessibility tree:
  ```
  link "Home" [ref_1] href="/"
    heading "Welcome" [ref_2]
  ```
  Format: `[indent][role] "[label]" [ref_N] [attributes]`. Children at increasing indentation.
- **[REF-API-RP, lines 11-19]**: `read_page` accepts parameters: `filter` (`"interactive"` or `"all"`), `depth` (default 15), `ref_id` (focused subtree), `max_chars` (default 50000). The `filter` parameter is critical — it lets the agent choose between a compact interactive-only tree and a full semantic tree.
- **[SDK-FMT]**: SwiftUIDebugKit's `HierarchyFormatter.formatTree()` produces the same pattern: `Role "Label" [refID] (dimensions) value:"..." HIDDEN`. Indented plain text, one element per line, refID in brackets. This format is 3-5x more token-efficient than JSON for LLM consumption.
- **[SDK-HIER, lines 107-129]**: SwiftUIDebugKit stores child refIDs in `CachedElement` for structural navigation, enabling the agent to walk up/down the tree by reference.
- **[CC-BP, lines 27-45]**: "Claude performs dramatically better when it can verify its own work" — structural context (landmarks, headings) gives the agent orientation for verification, not just interaction.

**Fix:** Add a new `get_a11y_tree` action type that builds a hierarchical, indented accessibility tree. The tree includes:

1. **Landmark elements** — `<nav>`, `<main>`, `<header>`, `<footer>`, `<aside>`, `<form>`, `<section>`, and any element with an explicit landmark `role`
2. **Heading elements** — `<h1>`-`<h6>` and `role="heading"`
3. **Interactive elements** — everything currently captured by `getInteractiveElements()`, plus elements with ARIA widget roles
4. **Structural output** — indented plain text, two spaces per depth level

Output format:
```
navigation
  [e1] link "Home"
  [e2] link "Dashboard"
  [e3] combobox "Search" placeholder="Search..."
main
  heading "Account Settings"
  [e4] textbox "Email" value="ron@hvm.com"
  [e5] textbox "Name" value="Ron Eddings"
  [e6] checkbox "Newsletter" checked
  [e7] button "Save Changes"
  region "Danger Zone"
    [e8] button "Delete Account" expanded=false
contentinfo
  [e9] link "Privacy Policy"
```

Parameters (matching Claude in Chrome's `read_page`):
- `depth` (default: 15) — max traversal depth
- `filter` (`"interactive"` | `"all"`, default: `"interactive"`) — interactive-only or full semantic tree
- `maxChars` (default: 50000) — output size cap to prevent token overflow

**CLI command:** `slop tree [--depth N] [--filter all|interactive] [--max-chars N]`

**Implicit role mapping** (HTML → ARIA):

| HTML Element | Implicit Role |
|-------------|---------------|
| `<a href>` | `link` |
| `<button>` | `button` |
| `<input>` | `textbox` / `checkbox` / `radio` / `slider` / `searchbox` / `spinbutton` (by type) |
| `<select>` | `combobox` |
| `<textarea>` | `textbox` |
| `<nav>` | `navigation` |
| `<main>` | `main` |
| `<header>` | `banner` (when not inside `<article>` or `<section>`) |
| `<footer>` | `contentinfo` (when not inside `<article>` or `<section>`) |
| `<aside>` | `complementary` |
| `<form>` | `form` |
| `<section>` | `region` (when it has an accessible name) |
| `<h1>`-`<h6>` | `heading` |
| `<img>` | `img` |
| `<ul>`, `<ol>` | `list` |
| `<li>` | `listitem` |
| `<table>` | `table` |
| `<tr>` | `row` |
| `<td>` | `cell` |
| `<th>` | `columnheader` |
| `<details>` | `group` |
| `<summary>` | `button` |

**Files:** `extension/src/content.ts`, `extension/src/types.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] New `get_a11y_tree` action type returns indented semantic tree
- [x] Landmark elements included as structural containers (not indexed unless interactive)
- [x] Headings included for orientation (not indexed unless interactive)
- [x] Interactive elements indexed with ref IDs (see Phase 4)
- [x] `depth` parameter limits traversal depth
- [x] `filter` parameter switches between interactive-only and full semantic modes
- [x] `maxChars` parameter truncates output with `... (truncated)` suffix
- [x] Implicit role mapping covers all standard HTML elements
- [x] Explicit `role` attribute overrides implicit role
- [x] `slop tree` CLI command added with `--depth`, `--filter`, `--max-chars` flags
- [x] Output is plain text, not JSON (token-efficient for LLM consumption)

---

## Phase 4: Stable Element References

### 4.1 WeakRef-Based Ref ID Registry

**Problem:** `selectorMap` at `content.ts:50` maps numeric indices to CSS selectors. Indices are reassigned from zero on every `getPageState()` call. Between two `slop state` calls, the same button might be `[5]` then `[8]` because a DOM mutation added three elements before it. The agent's multi-step plans (`click [5]`, `type [3] "hello"`, `click [12]`) become invalid after any DOM change. This forces the agent to re-read state after every single action, consuming tokens and adding latency.

**Evidence:**
- **[REF-SYS, lines 339-359]**: Claude in Chrome assigns stable ref IDs using `WeakRef`:
  ```javascript
  ref_id = "ref_" + (++window.__claudeRefCounter);
  window.__claudeElementMap[ref_id] = new WeakRef(element);
  ```
  Format: `ref_N` (e.g., `ref_1`, `ref_42`). Global counter auto-increments. `WeakRef` allows garbage collection of detached DOM nodes. Refs survive across multiple tree reads within the same page — the agent can read the tree once and issue multiple actions against stable refs.
- **[SDK-REF]**: SwiftUIDebugKit's `RefIDRegistry` uses the same pattern adapted for Swift: `ObjectIdentifier` for pointer-based identity, bidirectional `idToElement`/`elementToID` maps, monotonically increasing IDs (`e1`, `e2`, `e3`...). Actor isolation ensures thread safety. The `register()` method reuses existing IDs when the same element is encountered again.
- **[BUN-GC, lines 72, 100, 106]**: Bun's heap statistics confirm `WeakRef` (line 106) and `WeakMap` (line 72) are first-class supported types with GC integration. `FinalizationRegistry` (line 100) is also available for cleanup callbacks.
- **[BUN-GC, lines 147, 152-154]**: "JavaScript is a garbage-collected language, not reference counted." `Bun.gc(true)` forces synchronous collection. This confirms `WeakRef` deref semantics work correctly in Bun's runtime — though the ref registry lives in the content script (Chrome's V8), not Bun.

**Fix:** Replace the `selectorMap: Map<number, string>` with a `WeakRef`-based ref ID registry:

```typescript
const refRegistry = new Map<string, WeakRef<Element>>()
const elementToRef = new WeakMap<Element, string>()
let nextRefId = 1

function getOrAssignRef(el: Element): string
function resolveRef(refId: string): Element | null
function pruneStaleRefs(): void
```

Behavior:
- `getOrAssignRef(el)` returns existing ref if element was previously registered, otherwise assigns `eN` and increments counter
- `resolveRef(refId)` returns the element if it's still connected and visible, `null` otherwise
- `pruneStaleRefs()` iterates the registry and removes entries where `WeakRef.deref()` returns `undefined` or `el.isConnected` is false
- Refs are stable within a page lifecycle — navigating to a new page resets the registry (content script is destroyed and re-injected)
- Format: `e1`, `e2`, `e3`... (shorter than Claude in Chrome's `ref_1`, `ref_2` — saves tokens)

**Migration:** All existing actions that accept `index: number` must also accept `ref: string`. If `ref` is provided, resolve via `resolveRef()`. If `index` is provided, resolve via legacy `selectorMap` (backward compatible). CLI accepts both `slop click 5` (legacy index) and `slop click e5` (ref ID).

**Files:** `extension/src/content.ts`, `extension/src/types.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] `getOrAssignRef()` assigns monotonically increasing `eN` ref IDs
- [x] Same DOM element always receives the same ref ID within a page lifecycle
- [x] `resolveRef()` returns `null` for elements removed from DOM
- [x] `resolveRef()` returns `null` for elements that are no longer visible
- [x] `WeakRef` prevents ref registry from retaining garbage-collected DOM nodes
- [x] `pruneStaleRefs()` cleans up stale entries (called during tree generation)
- [x] All action types accept `ref` field alongside `index`
- [x] CLI detects `eN` pattern and routes to `ref` field, bare numbers route to `index`
- [x] Legacy `index`-based resolution still works for backward compatibility
- [x] Page navigation resets the registry (content script lifecycle)
- [x] Tree output uses ref IDs: `[e5] button "Save"` instead of `[5]<button>Save</button>`

---

## Phase 5: Snapshot Diffing

### 5.1 Element State Diff Between Reads

**Problem:** After the agent performs an action (click a button, fill a form, navigate), it must run `slop state` or `slop tree` to see what changed. On a complex page, the full tree can be 20K-50K characters. Most of it is unchanged — only the affected elements are different. The agent wastes tokens re-reading the entire tree when it only needs to know "button [e5] is now expanded=true" or "new modal appeared with [e12] textbox 'Name'".

**Evidence:**
- **[SDK-SNAP]**: SwiftUIDebugKit's `SnapshotCache` stores element state after each tree read and computes structural diffs:
  ```swift
  enum ElementChange: Sendable, Equatable {
      case added(CachedElement)
      case removed(String)
      case modified(refID: String, changes: [String])
  }
  ```
  The `diff()` method compares old and new element arrays by refID, detecting additions, removals, and per-field modifications (role, label, value, children, hidden state). This is exactly the pattern needed.
- **[CC-CHR, line 205]**: "The Chrome extension's service worker can go idle during extended sessions, which breaks the connection." Diffing reduces the amount of data that must flow through a potentially fragile connection after each action.
- **[BUN-TCP, lines 188-200]**: "Currently, TCP sockets in Bun do not buffer data." Smaller diff payloads reduce backpressure risk on the Unix socket transport.
- **[BUN-STR, lines 166-184]**: `ArrayBufferSink` with `stream: true` supports incremental buffer management — useful for assembling diff output without allocating a full tree buffer.

**Fix:** Add snapshot tracking and a `diff` action type:

1. After each `get_a11y_tree` or `get_state` call, cache the current element set (refId, role, name, value, states)
2. New `diff` action compares current DOM against cached snapshot
3. Returns only changes: additions, removals, modifications

Output format:
```
+ e12 textbox "Name" (new)
+ e13 button "Cancel" (new)
~ e5 expanded: false → true
~ e7 value: "" → "ron@hvm.com"
- e3 (removed)
```

**CLI command:** `slop diff`

**Files:** `extension/src/content.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] Snapshot cached after each `get_a11y_tree` or `get_state` call
- [x] `diff` action returns additions (`+`), removals (`-`), modifications (`~`)
- [x] Modifications report specific field changes (value, states, name)
- [x] First `diff` call (no cached snapshot) returns error: `"no previous snapshot — run 'slop tree' first"`
- [x] Snapshot is per-tab (different tabs have independent snapshots)
- [x] Output is compact plain text (not JSON)
- [x] `slop diff` CLI command added

---

## Phase 6: Shadow DOM Traversal

### 6.1 Cross Shadow Boundary Element Discovery

**Problem:** Web Components and framework-based components (Google's Material Design, Salesforce Lightning, Shoelace, Ionic) render their internal DOM inside shadow roots. The current `document.createTreeWalker(document.body)` cannot cross shadow boundaries — elements inside shadow roots are invisible. On Google products, Salesforce, and any enterprise SPA using Web Components, this means the agent cannot see or interact with a significant portion of the UI.

**Evidence:**
- **[CHR-DOM, lines 21-27]**: `chrome.dom.openOrClosedShadowRoot(element: HTMLElement): object` — "Gets the open shadow root or the closed shadow root hosted by the specified element. If the element doesn't attach the shadow root, it will return null." This API is specifically designed for extensions to pierce shadow boundaries that standard DOM APIs cannot access.
- **[CHR-CS, lines 14-26]**: Content scripts can access the `dom` extension API directly — no message passing to background script required.
- **[REF-TS, lines 146-152]**: Claude in Chrome documents shadow DOM as a known limitation: "The page uses Shadow DOM (elements inside shadow roots may not be traversed)...For Shadow DOM: use `javascript_tool` to pierce shadow roots manually." This means Claude in Chrome's `accessibility-tree.js` does NOT automatically traverse shadow roots. slop-browser can surpass Claude in Chrome here.
- **[REF-API-FD, line 53]**: "Full Page Scanning: The tool scans the entire DOM including hidden elements, shadow DOM, and cross-origin iframes (due to `all_frames: true` content script)." There's a contradiction in the Claude in Chrome docs — the `find` tool claims shadow DOM scanning but the troubleshooting guide says it doesn't. This suggests partial/inconsistent support.
- **[CHR-SCR, lines 336-340]**: `allFrames: true` in content script registration injects into all frames, but this is for iframes, not shadow roots. Shadow roots require explicit traversal.

**Fix:** Modify the tree walker to recursively enter shadow roots:

```typescript
function walkWithShadow(root: Node, callback: (el: Element, depth: number) => void, depth: number = 0) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  let node: Node | null = walker.currentNode
  while (node) {
    const el = node as Element
    callback(el, depth)
    const shadow = (el as HTMLElement).shadowRoot
      || chrome.dom?.openOrClosedShadowRoot?.(el as HTMLElement)
    if (shadow) {
      walkWithShadow(shadow, callback, depth + 1)
    }
    node = walker.nextNode()
  }
}
```

Use `chrome.dom.openOrClosedShadowRoot()` to access both open and closed shadow roots. Open shadow roots are also accessible via `el.shadowRoot`, but closed roots require the Chrome API.

**Manifest change:** Add `"dom"` to `permissions` array.

**Files:** `extension/src/content.ts`, `extension/manifest.json`

**Acceptance Criteria:**
- [x] Tree walker enters open shadow roots via `el.shadowRoot`
- [x] Tree walker enters closed shadow roots via `chrome.dom.openOrClosedShadowRoot()`
- [x] Elements inside shadow roots are assigned ref IDs and appear in the tree
- [x] Shadow boundary indicated in tree output (e.g., `shadow-root` container node)
- [x] Nested shadow roots (shadow root inside shadow root) traversed recursively
- [x] `depth` parameter limits total traversal depth including shadow boundaries
- [x] `dom` permission added to `extension/manifest.json`
- [x] Graceful fallback if `chrome.dom` is unavailable (skip closed shadow roots)

---

## Phase 7: Fuzzy Element Search

### 7.1 Find by Role, Name, or Query

**Problem:** To click a button labeled "Save", the agent must: (1) run `slop tree`, (2) parse the entire tree output, (3) find the line containing "Save", (4) extract the ref ID, (5) run `slop click eN`. Steps 2-4 happen in the LLM's context window, consuming tokens and adding latency. A direct `slop find "Save" --role button` would return `e7` immediately, cutting the round-trip and token cost.

**Evidence:**
- **[REF-SYS, lines 691-696]**: Claude in Chrome implements a `find` tool: "Searches for elements matching a natural language description. Uses the accessibility tree data to find relevant elements and returns matching `ref_N` identifiers."
- **[REF-API-FD, lines 5-9]**: "Returns up to 20 matching elements with reference IDs...backed by the `accessibility-tree.js` content script which runs on all URLs and all frames."
- **[SDK-HIER, lines 145-271]**: SwiftUIDebugKit's `FindElementTool` implements a scoring system for fuzzy matching:
  - Identifier exact match: 100 points
  - Identifier contains: 50 points
  - Label exact match: 80 points
  - Label contains: 40 points
  - Query in label: 60 points
  - Query in identifier: 50 points
  - Query in value: 30 points
  Results sorted by score, returned as refIDs with role/label context.
- **[SDK-HIER, lines 191-198]**: Role-based filtering: agents can target "all buttons" without enumerating the full tree. The filter checks both the raw role string and the cleaned (AX-prefix-stripped) version.

**Fix:** Add a `find_element` action type with scoring-based search:

Parameters:
- `query` (string) — text to search for in accessible name, identifier, value, placeholder
- `role` (string, optional) — filter by effective role (e.g., `"button"`, `"link"`, `"textbox"`)
- `limit` (number, default: 10) — max results

Scoring (adapted from SwiftUIDebugKit):
- Accessible name exact match: 100
- Accessible name contains query: 60
- `id` attribute contains query: 50
- `placeholder` contains query: 40
- `value` contains query: 30
- Role match (when `role` filter provided): +50 bonus

Returns up to `limit` results sorted by score:
```
e7 button "Save Changes" (score: 100)
e12 link "Save Draft" (score: 60)
e19 button "Save & Exit" (score: 60)
```

**CLI command:** `slop find "Save" [--role button] [--limit N]`

**Files:** `extension/src/content.ts`, `cli/index.ts`

**Acceptance Criteria:**
- [x] `find_element` action searches by accessible name, id, placeholder, value
- [x] Results sorted by relevance score
- [x] Optional `role` filter restricts to matching roles
- [x] `limit` parameter caps result count (default 10)
- [x] Results include refId, role, accessible name, and score
- [x] Case-insensitive matching
- [x] Returns empty array (not error) when no matches found
- [x] `slop find` CLI command added with `--role` and `--limit` flags

---

## Phase 8: Daemon Buffering for Larger Payloads

### 8.1 ArrayBufferSink for Tree Payloads

**Problem:** Accessibility trees are significantly larger than flat element lists. A page with 200 interactive elements produces ~8KB in flat format but ~25-50KB as an indented tree with landmarks and headings. The daemon's current message handling writes responses directly to the socket. Large tree payloads may exceed the socket buffer, causing partial writes that the length-prefixed framing (PRD-2) handles correctly but inefficiently — multiple small writes through the drain handler.

**Evidence:**
- **[BUN-TCP, lines 188-200]**: "Currently, TCP sockets in Bun do not buffer data. For performance-sensitive code, it's important to consider buffering carefully." The docs recommend `ArrayBufferSink` for manual buffering.
- **[BUN-STR, lines 205-234]**: `ArrayBufferSink` API:
  ```typescript
  class ArrayBufferSink {
    start(options?: { asUint8Array?: boolean; highWaterMark?: number; stream?: boolean }): void;
    write(chunk: string | ArrayBufferView | ArrayBuffer): number;
    flush(): number | Uint8Array | ArrayBuffer;
    end(): ArrayBuffer | Uint8Array;
  }
  ```
  `stream: true` mode with `highWaterMark` enables incremental buffer accumulation. `flush()` returns accumulated data and resets the buffer.
- **[BUN-TCP, lines 44-46]**: "For performance-sensitive servers, assigning listeners to each socket can cause significant garbage collector pressure and increase memory usage." Shared handler model reduces GC pressure — relevant because tree serialization creates many intermediate strings.
- **[REF-API-RP, lines 11-19]**: Claude in Chrome caps `read_page` output at 50,000 characters by default (`max_chars` parameter). slop-browser should implement the same cap to prevent unbounded payloads.

**Fix:** Use `ArrayBufferSink` in the daemon for assembling large response payloads before writing to the socket. Set `highWaterMark: 65536` (64KB) to batch socket writes into fewer, larger chunks.

**Files:** `daemon/index.ts`

**Acceptance Criteria:**
- [x] Daemon uses `ArrayBufferSink` for response payloads > 16KB
- [x] `highWaterMark` set to 64KB for efficient batching
- [x] Small payloads (<16KB) still use direct `socket.write()` (no overhead)
- [x] Tree responses capped at 50,000 characters (matching Claude in Chrome's default)
- [x] Cap is configurable via `maxChars` parameter in the action

---

## Implementation Order

| Phase | Change | Impact | Effort | Priority |
|-------|--------|--------|--------|----------|
| 1.1 | Computed accessible names | Agent understands what elements ARE | Small | P0 |
| 2.1 | ARIA state capture | Agent knows what's expanded/checked/disabled | Small | P0 |
| 4.1 | Stable ref IDs | Multi-step workflows don't break | Medium | P0 |
| 3.1 | Semantic tree with landmarks | Structural navigation for complex pages | Medium | P1 |
| 6.1 | Shadow DOM traversal | Visibility into Web Component UIs | Small | P1 |
| 7.1 | Find by role/name | Faster element targeting, fewer tokens | Small | P1 |
| 5.1 | Snapshot diffing | Token savings on repeated reads | Small | P2 |
| 8.1 | Daemon buffering | Efficient transport for larger payloads | Small | P2 |

Phases 1.1 and 2.1 are surgical edits to existing functions — implement first.
Phase 4.1 is the most impactful refactor (replaces the index system) — implement alongside 3.1.
Phases 5-8 are additive features that build on the foundation of 1-4.

---

## What This PRD Does NOT Cover

| Topic | Why Excluded |
|-------|-------------|
| CDP Accessibility domain | Rejected in design decision — breaks undetectability |
| Visual annotation / overlay | New feature, not accessibility. Future PRD. |
| GIF recording | New feature. Future PRD. |
| Session recording / replay | New feature. Future PRD. |
| Natural language element search (LLM-powered) | Over-engineering. Scoring-based fuzzy search (Phase 7) is sufficient. |
| Accessibility audit / WCAG compliance checking | Different domain. slop-browser automates; it doesn't audit. |
| Cross-origin iframe traversal | Requires `allFrames: true` in content script manifest + complex message routing. Future PRD. |
| `aria-describedby` resolution | Low agent value — descriptions are supplementary, not identifying. Can add later. |

---

## Files Modified

| File | Changes |
|------|---------|
| `extension/src/content.ts` | Accessible name resolution (1.1), ARIA states (2.1), semantic tree builder (3.1), ref ID registry (4.1), snapshot diffing (5.1), shadow DOM walker (6.1), fuzzy search (7.1) |
| `extension/src/types.ts` | New action types: `get_a11y_tree`, `diff`, `find_element`. Updated action fields: `ref` alongside `index` |
| `cli/index.ts` | New commands: `tree`, `diff`, `find`. Updated element targeting: detect `eN` pattern for ref IDs |
| `daemon/index.ts` | ArrayBufferSink for large payloads (8.1) |
| `extension/manifest.json` | Add `"dom"` permission (6.1) |

One new Chrome extension permission (`dom`). No new dependencies. No CDP. No architecture changes.

---

## Backward Compatibility

All existing CLI commands continue to work unchanged:
- `slop state` returns the same flat element list format
- `slop click 5` resolves via legacy `selectorMap` (numeric index)
- `slop type 3 "hello"` resolves via legacy path

New capabilities are additive:
- `slop tree` is the new semantic alternative to `slop state`
- `slop click e5` uses stable ref IDs
- `slop find` and `slop diff` are new commands

The transition from indices to refs is opt-in per command. Agents can adopt ref IDs incrementally without breaking existing workflows.
