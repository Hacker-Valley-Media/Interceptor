# PRD-11: Generic Passive Network Capture — Inject-Script Architecture

**Goal:** Replace the CDP-based network capture (`chrome.debugger` + `Network.enable`) with a generic, zero-detection, passive network capture layer that intercepts all `fetch()` and `XMLHttpRequest` traffic from any page. This enables reliable data extraction from any SPA without race conditions, debugger infobars, or per-site coupling.

**Scope:** New `extension/src/inject-net.ts` (MAIN world script), modifications to `extension/src/content.ts` and `extension/src/background.ts`, build system updates. The LinkedIn extraction pipeline migrates to consume the new generic capture layer instead of CDP logs.

**Non-Negotiable:** The capture layer must be site-agnostic. It intercepts all network traffic, not just LinkedIn. LinkedIn is the first consumer, not the architecture's purpose.

---

## Evidence Sources

| ID | Source | Path | How to access |
|----|--------|------|---------------|
| LI-EXT | Hacker Valley LinkedIn Extension | `https://github.com/ronaldeddings/linkedin-extension/` | `git clone` into `/tmp/linkedin-extension` |
| LI-INJECT | LI Extension inject script | `src/inject.ts` in LI-EXT | Monkey-patches `fetch()` + `XHR` in page context |
| LI-CONTENT | LI Extension content script | `src/pages/Content/index.ts` in LI-EXT | Listens for `CustomEvent` from inject, forwards to background |
| LI-EVENTS | LI Extension event details API | `src/utils/Events/GetEventDetailsByID.ts` in LI-EXT | Direct voyager API with CSRF from intercepted headers |
| LI-ATTENDEES | LI Extension event attendees API | `src/utils/Events/GetEventAttendeesByID.ts` in LI-EXT | Paginated graphql search endpoint |
| CHR-CS | Chrome content scripts | `80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/content-scripts.md` | Isolated world, `world: "MAIN"`, static/dynamic/programmatic injection |
| CHR-SCRIPTING | Chrome scripting API | `80_Reference/docs/chrome-extensions/docs/extensions/reference/api/scripting.md` | `ExecutionWorld.MAIN`, `registerContentScripts`, `executeScript` |
| CHR-MSG | Chrome message passing | `80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/messaging.md` | Content script ↔ background communication |
| CHR-SW-LIFE | Service worker lifecycle | `80_Reference/docs/chrome-extensions/docs/extensions/develop/concepts/service-workers/lifecycle.md` | 30s idle termination, alarm-based persistence |
| BUN-BUNDLER | Bun bundler docs | `80_Reference/docs/bun/docs/bundler.md` | `--target browser`, `--format esm\|iife` |
| SLOP-BG | slop-browser background.ts | `extension/src/background.ts` | CDP network capture, `enableNetworkCapture()`, `buildLinkedInEventExtraction()` |
| SLOP-CONTENT | slop-browser content.ts | `extension/src/content.ts` | DOM extraction, action execution |
| SLOP-LI | slop-browser LinkedIn modules | `extension/src/linkedin/` (29 files) | Event/post/attendee extraction pipeline |
| SLOP-BUILD | slop-browser build system | `scripts/build.sh` | `bun build` commands for extension, CLI, daemon |

---

## The Problem

### Observed Failure

During a live LinkedIn event extraction on 2026-04-04, slop's CDP-based network capture (`chrome.debugger` + `Network.enable`) captured **0 requests** on the first attempt and **only 1 tracking POST** on the second. The LinkedIn voyager API responses containing the UGC post URN, reaction counts, and comment data were never captured. This caused `likes`, `reposts`, `comments`, and `posterFollowerCount` to all return `null`.

**Root cause:** The CDP debugger must be attached and `Network.enable` must complete BEFORE the page's JavaScript fires its first API call. LinkedIn's SPA pre-fetches data aggressively during navigation, creating an unwinnable race condition.

### Why CDP Network Capture Fails for SPAs

1. **Race condition** — `chrome.debugger.attach()` → `Network.enable` takes 50-200ms. LinkedIn's JS fires voyager API calls within the first 100ms of navigation. If the debugger isn't ready, those calls are invisible.

2. **Already-loaded pages** — If the tab is already on the target URL, no navigation occurs. The SPA's API calls fired during the initial load are gone. CDP only sees future traffic.

3. **Debugger side effects** — Attaching `chrome.debugger` shows a yellow infobanner [CHR-CS: "the user will see a warning bar"], shifts viewport coordinates by ~35px, and can trigger anti-automation detection on some sites.

4. **Session fragility** — If the user opens DevTools, `chrome.debugger.onDetach` fires with `reason: "canceled_by_user"` and all capture stops.

### How linkedin-extension Solves This

LI-EXT uses a fundamentally different approach that avoids all four problems:

**From LI-INJECT (`src/inject.ts`):**
```javascript
// Monkey-patch XHR
XHR.open = function(method, url, ...) {
  this._url = url.toString();
  return open.apply(this, arguments);
};

XHR.send = function(body) {
  this.addEventListener('load', function() {
    if (url && url.includes('api')) {
      document.dispatchEvent(new CustomEvent('LINKEDIN_API', { detail: [text, url] }));
    }
  });
  return send.apply(this, arguments);
};

// Monkey-patch fetch
window.fetch = function(input, init) {
  return originalFetch.call(this, input, init).then((response) => {
    response.clone().text().then((text) => {
      document.dispatchEvent(new CustomEvent('LINKEDIN_API', { detail: [text, eventUrl] }));
    });
    return response;
  });
};
```

This runs in the page's **MAIN world** — it sees every API call the SPA makes because it wraps the actual `fetch` and `XHR` objects the page uses. No debugger. No race condition. No infobanner.

**From LI-CONTENT (`src/pages/Content/index.ts`):**
```javascript
document.addEventListener('LINKEDIN_API', function(e) {
  storeLinkedInAPIResponse(e.detail);
  saveFeedUpdates(e.detail[0]);
});
```

The content script (ISOLATED world) listens for `CustomEvent`s dispatched by the inject script, then forwards data to the background via `chrome.runtime.sendMessage`.

**The bridge works** because `CustomEvent`s dispatched on `document` cross the MAIN↔ISOLATED world boundary — the DOM is shared, only JavaScript variables are isolated [CHR-CS: "Content scripts live in an isolated world... A practical consequence of this isolation is that JavaScript variables in an extension's content scripts are not visible to the host page"].

### How linkedin-extension Gets the CSRF Token

**From LI-INJECT:**
```javascript
XHR.setRequestHeader = function(header, value) {
  this._requestHeaders[header] = value;
  return setRequestHeader.apply(this, arguments);
};

// In XHR.send listener:
if (this._requestHeaders && this._requestHeaders['csrf-token']) {
  document.dispatchEvent(new CustomEvent('LINKEDIN_CSRF', { detail: this._requestHeaders['csrf-token'] }));
}
```

The CSRF token is passively captured from the page's own XHR headers. No `chrome.cookies.get()` needed. This is more reliable because it uses the exact token the page is using, not a cookie value that may need unquoting.

---

## Architecture: Generic Passive Network Capture

### Design Principles

1. **Site-agnostic** — The inject script captures ALL fetch/XHR traffic. Filtering happens in the content script or background, not in the hook.
2. **Zero detection surface** — No CDP, no debugger, no infobanner.
3. **No race condition** — Hooks are installed before the page's JS runs (`document_start` + MAIN world).
4. **Passive** — The page's behavior is unchanged. Responses are cloned, not consumed.
5. **Structured** — Each captured entry includes URL, method, status, headers, and body (cloned).

### Data Flow

```
Page JS calls fetch()/XHR
  → inject-net.ts (MAIN world) intercepts, clones response
    → CustomEvent('__slop_net', { detail: { url, method, status, body, headers } })
      → content.ts (ISOLATED world) listens, buffers entries
        → background.ts requests buffer via sendMessage when needed
          → extraction pipeline consumes entries (LinkedIn, or any future site)
```

### Three Components

| Component | File | World | Purpose |
|-----------|------|-------|---------|
| **Inject script** | `extension/src/inject-net.ts` | MAIN | Monkey-patches `fetch()` + `XHR.prototype`. Fires `CustomEvent` for each response. |
| **Content script listener** | Added to `extension/src/content.ts` | ISOLATED | Listens for `__slop_net` events. Buffers entries. Responds to background queries. |
| **Background consumer** | Modified `extension/src/background.ts` | Service Worker | Queries content script for captured entries. Passes to extraction pipeline. |

### Inject Script Design (`inject-net.ts`)

Grounded in LI-INJECT patterns, generalized:

```typescript
// Patch fetch
const originalFetch = window.fetch;
window.fetch = function(input, init) {
  const url = /* resolve URL from input */;
  const method = init?.method || 'GET';
  return originalFetch.call(this, input, init).then(response => {
    const clone = response.clone();
    clone.text().then(body => {
      document.dispatchEvent(new CustomEvent('__slop_net', {
        detail: { url, method, status: response.status, body, type: 'fetch', timestamp: Date.now() }
      }));
    }).catch(() => {});
    return response;
  });
};

// Patch XHR
const origOpen = XHR.prototype.open;
const origSend = XHR.prototype.send;
const origSetHeader = XHR.prototype.setRequestHeader;
// ... same pattern as LI-INJECT but emitting '__slop_net' events
```

**Key differences from LI-INJECT:**
- Event name is `__slop_net` (not LinkedIn-specific)
- Every response is captured (not filtered to `api` URLs)
- Status code, method, and timestamp are included
- Request headers (including CSRF) are forwarded in a separate `__slop_headers` event
- Full response bodies captured — no truncation, no per-body size limits

### Content Script Buffer

The content script maintains a ring buffer of captured entries:

```typescript
const NET_BUFFER_CAP = 500;
const netBuffer: CapturedEntry[] = [];

document.addEventListener('__slop_net', (e: CustomEvent) => {
  if (netBuffer.length >= NET_BUFFER_CAP) netBuffer.shift();
  netBuffer.push(e.detail);
});
```

The background queries this buffer via `chrome.tabs.sendMessage(tabId, { type: 'get_net_log' })`.

### Injection Method

**From CHR-CS:** Content scripts can declare `"world": "MAIN"` in the manifest to run in the page's execution context. This is the cleanest approach:

```json
{
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["inject-net.js"],
      "world": "MAIN",
      "run_at": "document_start"
    },
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

**From CHR-SCRIPTING:** `"MAIN"` — "Specifies the main world of the DOM, which is the execution environment shared with the host page's JavaScript."

**Alternative** (used by LI-EXT): Inject via script tag from the content script:
```javascript
const s = document.createElement('script');
s.src = chrome.runtime.getURL('inject.js');
s.onload = function() { this.remove(); };
(document.head || document.documentElement).appendChild(s);
```
This requires the file to be in `web_accessible_resources`. The manifest `world: "MAIN"` approach is cleaner and doesn't require `web_accessible_resources`.

### Trusted Types Compatibility

**From LI-INJECT:** LinkedIn uses Trusted Types, which block dynamic `eval()` and script creation. The inject script must create a Trusted Types policy:

```typescript
if (window.trustedTypes?.createPolicy) {
  try {
    window.trustedTypes.createPolicy('default', {
      createHTML: (input) => input,
      createScriptURL: (input) => input,
      createScript: (input) => input,
    });
  } catch {}
}
```

Our existing content.ts already handles this with `__slop_tt_policy` in the `evaluate` action. The inject-net script needs its own policy since it runs in MAIN world (separate policy namespace).

### Build System

**From BUN-BUNDLER:** `bun build --target browser` produces browser-compatible bundles.

**From SLOP-BUILD:** Current build commands:
```bash
bun build extension/src/background.ts --outdir=extension/dist --target=browser
bun build extension/src/content.ts --outdir=extension/dist --target=browser
```

New addition:
```bash
bun build extension/src/inject-net.ts --outdir=extension/dist --target=browser
```

The `--target browser` flag ensures no Node.js/Bun APIs leak into the output [BUN-BUNDLER: "Targets: `--target browser|bun|node`"].

---

## Implementation Phases

### Phase 1: Generic Inject Script (P0)

**Files:** `extension/src/inject-net.ts` (new)

**Work items:**
- [x] 1.1: Create `extension/src/inject-net.ts` with Trusted Types policy initialization
- [x] 1.2: Implement `window.fetch` monkey-patch — intercept all fetch calls, clone response, emit `__slop_net` CustomEvent with `{ url, method, status, body, type: 'fetch', timestamp }`
- [x] 1.3: Implement `XMLHttpRequest.prototype.open/send/setRequestHeader` monkey-patch — same event emission pattern
- [x] 1.4: Emit `__slop_headers` CustomEvent with request headers (captures CSRF tokens, auth headers passively)
- [x] 1.5: Capture full response bodies — no size limits, no truncation
- [x] 1.6: Guard against re-entry — if `window.__slop_net_installed` is set, skip patching (prevents double-injection)
- [x] 1.7: All patches must preserve original function behavior — `return originalFn.apply(this, arguments)` pattern, errors in capture must never break the page's network calls

**Acceptance criteria:**
- [x] Inject script patches `fetch` and `XHR` without breaking any page functionality
- [x] Every API call the page makes fires a `__slop_net` event with full response body
- [x] CSRF tokens are captured from request headers via `__slop_headers`
- [x] Full response bodies are captured without truncation
- [x] Double-injection is prevented

### Phase 2: Content Script Buffer & Bridge (P0)

**Files:** `extension/src/content.ts` (modified)

**Work items:**
- [x] 2.1: Add `__slop_net` event listener in content script — push entries into ring buffer (cap 500)
- [x] 2.2: Add `__slop_headers` event listener — store latest headers by URL pattern (keeps CSRF tokens)
- [x] 2.3: Handle `get_net_log` message from background — return buffered entries, optionally filtered by URL pattern or since-timestamp
- [x] 2.4: Handle `clear_net_log` message — flush buffer
- [x] 2.5: Handle `get_captured_headers` message — return stored headers (for CSRF token retrieval)
- [x] 2.6: Buffer entries include `{ url, method, status, body, type, timestamp, tabUrl }` for downstream filtering

**Acceptance criteria:**
- [x] Content script receives and buffers network events from inject script
- [x] Background can query the buffer via `chrome.tabs.sendMessage`
- [x] Buffer respects cap, oldest entries evicted
- [x] Filtering by URL pattern and since-timestamp works

### Phase 3: Background Integration (P0)

**Files:** `extension/src/background.ts` (modified)

**Work items:**
- [x] 3.1: Add `net_log` action type — returns captured entries from content script buffer (replaces CDP `network_log` for passive capture)
- [x] 3.2: Add `net_clear` action type — clears the content script buffer
- [x] 3.3: Add `net_headers` action type — returns captured request headers (CSRF, auth)
- [x] 3.4: Modify `buildLinkedInEventExtraction()` — query content script net buffer instead of CDP network logs
- [x] 3.5: Modify `buildLinkedInEventExtraction()` — get CSRF token from captured headers instead of `chrome.cookies.get()`
- [x] 3.6: Keep CDP network capture as a fallback — `slop network on/off/log` continues to work via debugger for explicit opt-in use cases
- [x] 3.7: The existing `slop network on` CLI command continues to use CDP (power-user feature). The passive inject capture is always-on and used by default for extraction commands.

**Acceptance criteria:**
- [x] `slop linkedin event` uses passive capture instead of CDP — no debugger attached
- [x] No infobanner appears during LinkedIn extraction
- [x] Captured entries include full response bodies from LinkedIn voyager API calls
- [x] CSRF token is retrieved from passively captured headers
- [x] `slop network on/off/log` still works via CDP for explicit debugging

### Phase 4: CLI & Manifest Updates (P0)

**Files:** `cli/index.ts`, `extension/manifest.json`, `scripts/build.sh`

**Work items:**
- [x] 4.1: Add `inject-net.ts` to manifest.json `content_scripts` with `"world": "MAIN"` and `"run_at": "document_start"`
- [x] 4.2: Add `bun build extension/src/inject-net.ts --outdir=extension/dist --target=browser` to build script
- [x] 4.3: Add `slop net log` CLI command — queries passive capture buffer (distinct from `slop network log` which uses CDP)
- [x] 4.4: Add `slop net log --filter <pattern>` — filter by URL substring
- [x] 4.5: Add `slop net log --since <timestamp>` — entries after timestamp
- [x] 4.6: Add `slop net clear` CLI command — flush buffer
- [x] 4.7: Add `slop net headers` CLI command — show captured request headers

**Acceptance criteria:**
- [x] `inject-net.js` is built and included in extension dist
- [x] Manifest correctly declares MAIN world injection at `document_start`
- [x] `slop net log` returns passively captured network entries
- [x] Filtering and timestamp queries work

### Phase 5: LinkedIn Extraction Migration (P1)

**Files:** `extension/src/background.ts`, `extension/src/linkedin/event-page-extraction-payload.ts`

**Work items:**
- [x] 5.1: `buildLinkedInEventExtraction()` no longer calls `enableNetworkCapture()` (no CDP debugger attach)
- [x] 5.2: Instead, query content script for `get_net_log` with filter `linkedin.com` after DOM stabilization
- [x] 5.3: Get CSRF token from `get_captured_headers` instead of `chrome.cookies.get()`
- [x] 5.4: Pass captured entries to `buildLinkedInEventExtractionPayload()` in the same format as before (the payload builder is already site-specific, no changes needed)
- [x] 5.5: Direct API calls (`fetchLinkedInEventDetailsById`, `fetchLinkedInEventAttendeesById`, reactions, comments) continue using `fetch()` from the extension context — these are NOT affected by the inject script (extension context is separate from page context)
- [x] 5.6: Remove the `waitMs` delay after navigation — passive capture eliminates the race condition, so we only need DOM stability, not extra time for CDP
- [x] 5.7: The `--wait` flag on `slop linkedin event` remains for edge cases but default wait drops from 2500ms to 500ms

**Acceptance criteria:**
- [x] `slop linkedin event <url>` extracts all fields without CDP debugger
- [x] No yellow infobanner during extraction
- [x] `derivedPostId` is found (the UGC post URN from voyager responses)
- [x] `likes`, `reposts`, `comments` are populated from reactions/comments APIs
- [x] `posterFollowerCount` is populated
- [x] Extraction works on already-loaded pages (no navigation needed)
- [x] Validation fields all return `true` where data exists

### Phase 6: Documentation (P1)

**Files:** `README.md`, `CLAUDE.md`, `SKILL.md`

**Work items:**
- [x] 6.1: CLAUDE.md documents the inject-net architecture and how passive capture works
- [x] 6.2: README adds `slop net log/clear/headers` to command reference
- [x] 6.3: README documents that network capture is always-on (no `slop network on` needed for extraction commands)
- [x] 6.4: Build verified — inject-net.js produced in extension/dist

**Acceptance criteria:**
- [x] Agent documentation reflects passive capture as default
- [x] CLI command reference is complete

---

## Architecture Decision: Why MAIN World Manifest Injection Over Script Tag

| Approach | LI-EXT uses | This PRD uses | Rationale |
|----------|-------------|---------------|-----------|
| Script tag injection | ✅ `document.createElement('script')` + `chrome.runtime.getURL()` | ❌ | Requires `web_accessible_resources`, exposes inject script URL to page |
| Manifest `world: "MAIN"` | ❌ | ✅ | Cleaner, no WAR needed, Chrome handles injection timing, `document_start` guaranteed |

**From CHR-CS:** Content scripts can declare `"world": "MAIN"` in the manifest. Combined with `"run_at": "document_start"`, the inject script is guaranteed to execute before the page's own JavaScript. This is critical — the `fetch`/`XHR` patches must be in place before the SPA makes its first API call.

**From CHR-SCRIPTING:** `ExecutionWorld.MAIN` — "Specifies the main world of the DOM, which is the execution environment shared with the host page's JavaScript." This means our inject script's `window.fetch` override IS the page's `window.fetch`.

---

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Site overwrites `window.fetch` after our patch | Low | Our hook bypassed | Chain patches: save `window.fetch` at `document_start`, restore if overwritten |
| Large response bodies cause memory pressure | Medium | Tab slowdown | Ring buffer cap at 500 entries evicts oldest; bodies are full but buffer is bounded |
| Trusted Types blocks CustomEvent creation | Low | Events not fired | Trusted Types policy created first (pattern proven by LI-INJECT) |
| `document_start` timing varies across browsers | Low | Race condition on some pages | Manifest-declared MAIN world scripts are first to run [CHR-CS] |
| Pages that detect monkey-patched fetch | Very Low | Page breaks | Our patch is transparent — `response.clone()` means we never consume the response; `apply(this, arguments)` preserves all original behavior |

---

## Success Metrics

1. **`slop linkedin event` returns `likes`, `reposts`, `comments` on first attempt** — no null fields from missing network data
2. **Zero CDP debugger attachments during extraction** — no infobanner, no coordinate shifts
3. **`slop net log` shows captured traffic on any page** — not LinkedIn-specific
4. **Extraction works on already-loaded pages** — no forced navigation needed
5. **Cold extraction latency < 8s** — down from 15s+ with CDP race condition retries
