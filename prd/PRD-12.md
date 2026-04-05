# PRD-12: Codebase Decomposition — Capability-Based Module Architecture

**Goal:** Break the three monolith files (`background.ts` 2082 lines, `content.ts` 1796 lines, `cli/index.ts` 1126 lines) into small, single-capability modules. Each module maps to one Chrome API surface or one interaction domain. An AI agent editing the codebase should be able to find, read, and modify a capability without loading 2000+ lines of unrelated code.

**Scope:** All TypeScript source files in `extension/src/`, `cli/`, and `daemon/`. No behavior changes. Pure structural refactor with the same build output.

**Non-Negotiable:** Zero behavioral changes. Every CLI command, extension action, and daemon behavior must work identically before and after. Tests must pass. The build output (`extension/dist/background.js`, `content.js`, `inject-net.js`) is still three bundled files — Bun resolves imports at build time.

---

## The Problem

### background.ts — 2082 lines, 76 action cases, 80+ functions

One file contains:

| Concern | Lines (approx) | Functions |
|---------|----------------|-----------|
| Transport (native messaging, WebSocket, reconnect) | ~200 | `connectToHost`, `connectWsChannel`, `sendToHost`, `drainMessageQueue` |
| Message dispatch + request tracking | ~100 | `handleDaemonMessage`, `pendingRequests`, `needsTab` |
| Slop tab group management | ~50 | `ensureSlopGroup`, `addTabToSlopGroup`, `isTabInSlopGroup` |
| Offscreen document management | ~30 | `ensureOffscreen`, `resetOffscreenTimer`, `sendToOffscreen` |
| CDP debugger helpers | ~50 | `cdpCommand`, `cdpAttachActDetach`, `cdpInjectSourceCapabilitiesMock` |
| CDP network capture (types, log, overrides) | ~180 | 15+ functions for capture config, pattern matching, override rules, Fetch interception |
| LinkedIn data extraction helpers (DUPLICATED) | ~280 | `walkValues`, `collectStringCandidates`, `pickBestParsedResponse`, `fetchLinkedInJson`, `fetchLinkedInEventDetailsById`, `fetchLinkedInReactionsByPostId`, etc. — copies of what's already in `extension/src/linkedin/` |
| LinkedIn event extraction orchestration | ~80 | `buildLinkedInEventExtraction`, `buildLinkedInAttendeesExtraction` |
| Passive net capture actions | ~30 | `net_log`, `net_clear`, `net_headers` cases |
| OS-level input routing | ~50 | `os_click`, `os_key`, `os_type`, `os_move` cases |
| Screenshot + capture | ~120 | `screenshot`, `screenshot_background`, `capture_start/frame/stop`, `canvas_*` |
| Tab/window CRUD | ~120 | 15 tab cases + 6 window cases |
| Cookie/storage/history/bookmark CRUD | ~100 | 12 data API cases |
| Navigation | ~30 | `navigate`, `go_back`, `go_forward`, `reload` |
| Misc (evaluate, frames, headers, sessions, downloads, search, notifications) | ~80 | 15+ cases |
| Content script communication | ~30 | `sendToContentScript`, `sendNetDirect`, `waitForTabLoad`, `probeContentReady` |
| Keepalive + lifecycle | ~30 | alarm handler, tab removal, startup listeners |

The `routeAction` switch statement alone is ~800 lines.

### content.ts — 1796 lines, 65 action cases, 50+ functions

| Concern | Lines (approx) | Functions |
|---------|----------------|-----------|
| Passive net buffer + header store | ~60 | Buffer declarations, event listeners, message handlers |
| Element ref system (registry, resolution, staleness) | ~80 | `getOrAssignRef`, `resolveRef`, `pruneStaleRefs`, `refRegistry`, `elementToRef` |
| DOM observer + dirty tracking | ~20 | `domObserver`, `domDirty` |
| Interactive element discovery | ~100 | `getInteractiveElements`, `isInteractive`, `isVisible`, `walkWithShadow`, `getShadowRoot` |
| Accessibility tree | ~80 | `getEffectiveRole`, `getAccessibleName`, `buildA11yTree`, landmark/heading roles |
| Element tree rendering | ~30 | `buildElementTree`, `getRelevantAttrs` |
| Selector building | ~20 | `buildSelector` |
| Snapshot + diff | ~60 | `cacheSnapshot`, `computeSnapshotDiff`, `lastSnapshot` |
| Semantic element matching | ~40 | `findBestMatch` |
| Click simulation | ~30 | `dispatchClickSequence`, `scrollIntoViewIfNeeded` |
| Keyboard simulation | ~20 | `dispatchKeySequence` |
| Input handling (type, select, check) | ~80 | `input_text`, `select_option`, `check` with contenteditable, shadow DOM, React-compatible value setting |
| Scroll + wait | ~30 | `scroll`, `scroll_to`, `wait`, `wait_for`, `waitForMutation`, `waitForElement` |
| Data extraction (text, html, query, forms, links, images, meta, table) | ~80 | 10+ cases |
| Storage/clipboard | ~30 | `storage_read/write/delete`, `clipboard_read/write` |
| Element inspection (rect, exists, count, what_at, regions, modals, panels) | ~60 | 8+ cases |
| Focus management | ~20 | `focus`, `blur`, `get_focus` |
| LinkedIn DOM extraction (forwarded) | ~10 | `linkedin_event_dom`, `linkedin_attendees_*` |
| Drag + hover | ~50 | Duration-based drag, path-based hover |

### cli/index.ts — 1126 lines, 101 case branches

| Concern | Lines (approx) |
|---------|----------------|
| IPC transport (socket + WebSocket) | ~100 |
| Daemon auto-spawn | ~50 |
| Help text | ~100 |
| Format helpers (state, tabs, cookies) | ~30 |
| Command parsing (101 cases) | ~700 |
| Output formatting + screenshot save | ~50 |
| Utility (`parseElementTarget`, `parseTabFlag`) | ~30 |

---

## Target Architecture

### Extension: background capabilities as modules

```
extension/src/
  background.ts                  # Entry point — imports + registers all capability modules
  background/
    transport.ts                 # Native messaging, WebSocket, reconnect, keepalive, sendToHost
    message-dispatch.ts          # handleDaemonMessage, request tracking, pendingRequests, timeout
    tab-group.ts                 # ensureSlopGroup, addTabToSlopGroup, isTabInSlopGroup
    offscreen.ts                 # ensureOffscreen, sendToOffscreen, idle timer
    content-bridge.ts            # sendToContentScript, sendNetDirect, waitForTabLoad, probeContentReady
    router.ts                    # routeAction — delegates to capability modules, no inline logic
    capabilities/
      os-input.ts                # os_click, os_key, os_type, os_move
      screenshot.ts              # screenshot, screenshot_background, page_capture
      capture-stream.ts          # capture_start, capture_frame, capture_stop
      canvas.ts                  # canvas_list, canvas_read, canvas_diff
      tabs.ts                    # tab_create, tab_close, tab_switch, tab_list, tab_duplicate, etc.
      windows.ts                 # window_create, window_close, window_focus, window_resize, window_list
      navigation.ts              # navigate, go_back, go_forward, reload
      cookies.ts                 # cookies_get, cookies_set, cookies_delete
      history.ts                 # history_search, history_visits, history_delete, history_delete_range
      bookmarks.ts               # bookmark_tree, bookmark_search, bookmark_create, bookmark_delete
      downloads.ts               # downloads_start, downloads_search, downloads_cancel, downloads_pause
      sessions.ts                # session_list, session_restore
      notifications.ts           # notification_create, notification_clear
      search.ts                  # search_query
      browsing-data.ts           # browsing_data_remove
      headers.ts                 # headers_modify (declarativeNetRequest)
      evaluate.ts                # evaluate (JS execution in page)
      frames.ts                  # frames_list
      meta.ts                    # status, reload_extension, capabilities
      passive-net.ts             # net_log, net_clear, net_headers
      cdp-network.ts             # network_intercept, network_log, network_override + all CDP helpers
      linkedin-orchestration.ts  # buildLinkedInEventExtraction, buildLinkedInAttendeesExtraction
  linkedin/                      # (already decomposed — 29 files, keep as-is)
  content.ts                     # Entry point — imports + registers all content modules
  content/
    net-buffer.ts                # Passive net buffer, header store, __slop_net listener, message handlers
    ref-registry.ts              # Element ref system, getOrAssignRef, resolveRef, pruneStaleRefs
    dom-observer.ts              # MutationObserver, domDirty flag
    element-discovery.ts         # getInteractiveElements, isInteractive, isVisible, walkWithShadow
    a11y-tree.ts                 # getEffectiveRole, getAccessibleName, buildA11yTree, landmark roles
    element-tree.ts              # buildElementTree, getRelevantAttrs, buildSelector
    snapshot-diff.ts             # cacheSnapshot, computeSnapshotDiff
    semantic-match.ts            # findBestMatch
    input-simulation.ts          # dispatchClickSequence, dispatchKeySequence, dispatchHoverSequence
    actions/
      click.ts                   # click, dblclick, rightclick, click_at
      type.ts                    # input_text, select_option, check
      scroll.ts                  # scroll, scroll_to, scroll_absolute
      wait.ts                    # wait, wait_for, wait_stable, waitForMutation, waitForElement
      drag.ts                    # drag (with duration support)
      hover.ts                   # hover (with path support)
      focus.ts                   # focus, blur, get_focus
    data/
      extract.ts                 # extract_text, extract_html
      query.ts                   # query, query_one, exists, count
      forms.ts                   # forms, links, images, meta, table_data
      storage.ts                 # storage_read, storage_write, storage_delete
      clipboard.ts               # clipboard_read, clipboard_write
      selection.ts               # selection_get, selection_set
    inspection/
      rect.ts                    # rect, what_at, regions
      modals.ts                  # modals, panels
      page-info.ts               # page_info, get_page_dimensions
    find.ts                      # find_element, find_and_click, find_and_type, find_and_check
    state.ts                     # getPageState, get_state
  inject-net.ts                  # (already standalone — keep as-is)
```

### CLI: command modules

```
cli/
  index.ts                       # Entry point — parse args, dispatch to command modules
  transport.ts                   # sendCommand (socket), sendCommandWs (WebSocket)
  daemon-spawn.ts                # findDaemonBinary, auto-spawn logic
  format.ts                      # formatState, formatTabs, formatCookies, formatResult
  help.ts                        # HELP string
  parse.ts                       # parseElementTarget, parseTabFlag
  commands/
    state.ts                     # state, tree, diff, find, text, html
    actions.ts                   # click, type, select, hover, drag, keys, focus
    navigation.ts                # navigate, back, forward, scroll, wait
    tabs.ts                      # tabs, tab new/close/switch, window new/close/list
    network.ts                   # network on/off/log/override, net log/clear/headers
    screenshot.ts                # screenshot, canvas, capture
    linkedin.ts                  # linkedin event, linkedin attendees
    data.ts                      # cookies, storage, history, bookmarks, downloads
    meta.ts                      # status, reload, events, session, capabilities
    eval.ts                      # eval
    batch.ts                     # batch
```

### Daemon: already small (557 lines) — minor split

```
daemon/
  index.ts                       # Entry point — IPC server, native messaging, WebSocket bridge
  os-input-loader.ts             # (already separate)
  os-input.ts                    # (already separate)
  os-input-win.ts                # (already separate)
```

Daemon is fine. 557 lines for a server process is reasonable.

---

## Critical Fix: Remove Duplicated LinkedIn Code from background.ts

**~280 lines** in background.ts are copy-pasted versions of functions that already exist in `extension/src/linkedin/`:

| In background.ts | Already in | Module |
|------------------|------------|--------|
| `walkValues` | `linkedin-normalized-json-parsing.ts` | ✅ |
| `collectStringCandidates` | `linkedin-normalized-json-parsing.ts` | ✅ |
| `collectNumberCandidates` | `linkedin-normalized-json-parsing.ts` | ✅ |
| `pickBestString` | `linkedin-normalized-json-parsing.ts` | ✅ |
| `pickBestNumber` | `linkedin-normalized-json-parsing.ts` | ✅ |
| `pickBestParsedResponse` | `event-page-captured-response-scoring.ts` | ✅ |
| `extractEventDataFromParsed` | `event-page-captured-response-scoring.ts` | ✅ |
| `extractPostDataFromParsed` | `event-page-captured-response-scoring.ts` | ✅ |
| `validateValue` | `event-page-captured-response-scoring.ts` | ✅ |
| `extractFollowerCountFromText` | `ugc-post-social-api.ts` | ✅ |
| `extractPostIdFromLogs` | `ugc-post-social-api.ts` | ✅ |
| `fetchLinkedInReactionsByPostId` | `ugc-post-social-api.ts` | ✅ |
| `fetchLinkedInCommentsByPostId` | `ugc-post-social-api.ts` | ✅ |
| `fetchLinkedInEventDetailsById` | `professional-event-api.ts` | ✅ |
| `fetchLinkedInEventAttendeesById` | `professional-event-api.ts` | ✅ |
| `fetchLinkedInJson` | `voyager-api-client.ts` | ✅ |
| `getLinkedInCsrfToken` | `voyager-api-client.ts` | partially ✅ |
| `normalizeText` | `linkedin-shared-types.ts` | ✅ |
| `extractLinkedInEventId` | `linkedin-shared-types.ts` | ✅ |
| `isNoiseLinkedInUrl` | `linkedin-shared-types.ts` | ✅ |
| `stripJsonPrefix` / `tryParseJsonBody` | `json-parsing.ts` | ✅ |
| `toIsoTimestamp` / `collectIsoCandidates` | `linkedin-normalized-json-parsing.ts` | ✅ |

**Fix:** Delete all duplicates from background.ts. Import from the existing linkedin/ modules. The linkedin/ modules already export these functions. Bun bundles them into background.js at build time.

---

## Implementation Phases

### Phase 1: Delete duplicates from background.ts (P0 — highest impact, lowest risk)

**Work items:**
- [x] 1.1: Delete all duplicated LinkedIn functions from background.ts (~280 lines)
- [x] 1.2: Add imports from `./linkedin/` modules for all needed functions
- [x] 1.3: Move `getLinkedInCsrfTokenFromPassiveCapture` to `voyager-api-client.ts` (it's new, not duplicated)
- [x] 1.4: Move `buildLinkedInEventExtraction` + `buildLinkedInAttendeesExtraction` to `background/linkedin-orchestration.ts`
- [x] 1.5: Verify build produces identical behavior
- [x] 1.6: Run tests

**Expected reduction:** background.ts drops from ~2082 to ~1800 lines.

### Phase 2: Extract background capabilities into modules (P0)

**Work items:**
- [x] 2.1: Create `background/transport.ts` — move all native messaging, WebSocket, reconnect, keepalive, sendToHost
- [x] 2.2: Create `background/message-dispatch.ts` — move handleDaemonMessage, pendingRequests, needsTab, MESSAGE_QUEUE_CAP
- [x] 2.3: Create `background/tab-group.ts` — move slopGroupId, ensureSlopGroup, addTabToSlopGroup, isTabInSlopGroup
- [x] 2.4: Create `background/offscreen.ts` — move ensureOffscreen, resetOffscreenTimer, sendToOffscreen
- [x] 2.5: Create `background/content-bridge.ts` — move sendToContentScript, sendNetDirect, waitForTabLoad, probeContentReady
- [x] 2.6: Create `background/cdp-network.ts` — move ALL CDP types, state, and functions (debuggerAttached, networkCaptureConfigs, networkCaptureLogs, etc.)
- [x] 2.7: Create `background/router.ts` — move routeAction, but it delegates to capability modules instead of inline logic
- [x] 2.8: Create one file per capability group under `background/capabilities/`:
  - `os-input.ts`, `screenshot.ts`, `capture-stream.ts`, `canvas.ts`
  - `tabs.ts`, `windows.ts`, `navigation.ts`
  - `cookies.ts`, `history.ts`, `bookmarks.ts`, `downloads.ts`
  - `sessions.ts`, `notifications.ts`, `search.ts`, `browsing-data.ts`
  - `headers.ts`, `evaluate.ts`, `frames.ts`, `meta.ts`
  - `passive-net.ts`, `cdp-network-actions.ts` (the case handlers, separate from the CDP helpers)
- [x] 2.9: background.ts becomes thin entry point: imports + chrome.runtime.onInstalled/onStartup listeners
- [x] 2.10: Verify build, run tests

**Expected result:** background.ts drops to ~30 lines. Each capability file is 20-80 lines.

### Phase 3: Extract content capabilities into modules (P1)

**Work items:**
- [x] 3.1: Create `content/net-buffer.ts` — move passive net buffer, header store, event listeners, message handlers
- [x] 3.2: Create `content/ref-registry.ts` — move refRegistry, elementToRef, getOrAssignRef, resolveRef, pruneStaleRefs, refMetadata
- [x] 3.3: Create `content/dom-observer.ts` — move MutationObserver setup, domDirty
- [x] 3.4: Create `content/element-discovery.ts` — move getInteractiveElements, isInteractive, isVisible, walkWithShadow, getShadowRoot, INTERACTIVE_TAGS, INTERACTIVE_ROLES
- [x] 3.5: Create `content/a11y-tree.ts` — move getEffectiveRole, getAccessibleName, buildA11yTree, LANDMARK_ROLES, LANDMARK_TAGS
- [x] 3.6: Create `content/element-tree.ts` — move buildElementTree, getRelevantAttrs, buildSelector
- [x] 3.7: Create `content/snapshot-diff.ts` — move cacheSnapshot, computeSnapshotDiff, lastSnapshot
- [x] 3.8: Create `content/semantic-match.ts` — move findBestMatch
- [x] 3.9: Create `content/input-simulation.ts` — move dispatchClickSequence, dispatchKeySequence, dispatchHoverSequence, scrollIntoViewIfNeeded
- [x] 3.10: Create action modules under `content/actions/`:
  - `click.ts`, `type.ts`, `scroll.ts`, `wait.ts`, `drag.ts`, `hover.ts`, `focus.ts`
- [x] 3.11: Create data modules under `content/data/`:
  - `extract.ts`, `query.ts`, `forms.ts`, `storage.ts`, `clipboard.ts`, `selection.ts`
- [x] 3.12: Create inspection modules under `content/inspection/`:
  - `rect.ts`, `modals.ts`, `page-info.ts`
- [x] 3.13: Create `content/find.ts` — move find_element, find_and_click, find_and_type, find_and_check
- [x] 3.14: Create `content/state.ts` — move getPageState
- [x] 3.15: content.ts becomes thin entry point: imports, chrome.runtime.onMessage listener, handleAction dispatcher
- [x] 3.16: Verify build, run tests

**Expected result:** content.ts drops to ~50 lines. Each module is 20-80 lines.

### Phase 4: Extract CLI command modules (P1)

**Work items:**
- [x] 4.1: Create `cli/transport.ts` — move sendCommand, sendCommandWs
- [x] 4.2: Create `cli/daemon-spawn.ts` — move findDaemonBinary, daemon auto-start logic
- [x] 4.3: Create `cli/format.ts` — move formatState, formatTabs, formatCookies, formatResult
- [x] 4.4: Create `cli/help.ts` — move HELP string
- [x] 4.5: Create `cli/parse.ts` — move parseElementTarget, parseTabFlag
- [x] 4.6: Create command modules under `cli/commands/`:
  - `state.ts`, `actions.ts`, `navigation.ts`, `tabs.ts`, `network.ts`
  - `screenshot.ts`, `linkedin.ts`, `data.ts`, `meta.ts`, `eval.ts`, `batch.ts`
- [x] 4.7: cli/index.ts becomes: parse args → find command module → build action → send → format output
- [x] 4.8: Verify build, run tests

**Expected result:** cli/index.ts drops to ~100 lines. Commands are self-contained.

### Phase 5: Verify + document (P1)

- [x] 5.1: All tests pass
- [x] 5.2: Full extension build succeeds (background.js, content.js, inject-net.js)
- [x] 5.3: CLI build succeeds (dist/slop)
- [x] 5.4: Manual smoke test: slop tab new, tree, click, net log, linkedin event
- [x] 5.5: Update CLAUDE.md key files table
- [x] 5.6: Update README.md if needed

---

## Module Interface Convention

Every capability module exports a single handler function:

```typescript
// background/capabilities/tabs.ts
import type { ActionHandler } from "../router"

export const handleTabs: ActionHandler = async (action, tabId, ctx) => {
  switch (action.type) {
    case "tab_create": { ... }
    case "tab_close": { ... }
    case "tab_list": { ... }
    // ...
  }
}
```

The router imports all handlers and dispatches:

```typescript
// background/router.ts
import { handleTabs } from "./capabilities/tabs"
import { handleWindows } from "./capabilities/windows"
import { handleScreenshot } from "./capabilities/screenshot"
// ...

const CAPABILITY_MAP: Record<string, ActionHandler> = {
  tab_create: handleTabs, tab_close: handleTabs, tab_list: handleTabs, ...
  window_create: handleWindows, ...
  screenshot: handleScreenshot, screenshot_background: handleScreenshot, ...
}

export async function routeAction(action, tabId): Promise<Result> {
  const handler = CAPABILITY_MAP[action.type]
  if (handler) return handler(action, tabId, ctx)
  return sendToContentScript(tabId, action)  // fallback: forward to content script
}
```

Content script follows the same pattern:

```typescript
// content/actions/click.ts
export async function handleClick(action, resolveElement, dispatchClick): Promise<Result> { ... }
```

---

## Risk Analysis

| Risk | Mitigation |
|------|------------|
| Import cycles between modules | Each module imports from shared types/utils only, never from peer capability modules |
| Build output size increase from module overhead | Bun tree-shakes and inlines — bundle size stays the same or shrinks |
| Runtime behavior change from refactor | Zero logic changes — move code only. Compare build output hashes before/after |
| Merge conflicts with ongoing work | Do this as a single focused PR with no feature additions |

---

## Success Metrics

1. **No file exceeds 200 lines** (except router.ts which maps actions → handlers)
2. **Every capability is one file** — grep for a feature name, find exactly one file
3. **background.ts and content.ts are under 50 lines** — pure entry points
4. **All 5 existing tests pass**
5. **Build output is functionally identical** — same commands, same responses
6. **Zero duplicated functions** — every function has one canonical location
