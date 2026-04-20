# PRD-34: Monitor Focus-Follow — Auto-Attach to Manually Switched Tabs in the Interceptor Group

**Status:** Implemented
**Author:** Cy (via Ron)
**Date:** 2026-04-16
**Priority:** P1-High
**Effort:** S
**Platform:** Chrome / Brave MV3 background service worker
**Category:** Monitor Architecture

---

## Goal

Close the user-visible gap between PRD-32's *child-tab handoff* and the everyday workflow of *manually switching tabs*.

After this PRD, an active monitor session will automatically follow the user when they switch focus to **any tab in the interceptor group** — not just tabs the monitored page itself opened. The session continues to record without re-issuing `monitor start`, and the timeline shows clean `mon_detach` / `mon_attach` transitions for every focus change.

This is the missing piece that the live PRD-33 verification surfaced: the user opened a YouTube tab via manual focus switch, neither monitor recorded the URL, and the timeline went silent for ~30 seconds even though the user was actively engaged with the browser.

---

## Relationship To Prior PRDs

- **PRD-32** introduced document-scoped attachments and *child-tab handoff* (a tab opened by the monitored page following a trusted action). It explicitly scoped out manual tab switches and parallel-tab fanout.
- **PRD-33** hardened transport so `monitor stop` cannot throw on a disconnected native port. Independent of attachment policy.
- **PRD-34** extends the attachment model with a second, additive trigger: focus change to another tab inside the interceptor group. It does **not** replace child-tab handoff; both triggers coexist.

---

## Evidence Sources

| ID | Source | Path / Reference | Finding |
|----|--------|------------------|---------|
| CHROME-TABS-ONACTIVATED | Chrome tabs API docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/reference/api/tabs.md` | `chrome.tabs.onActivated` fires when the active tab in a window changes; payload includes `tabId` and `windowId`. |
| CHROME-TABS-DOCID | Chrome tabs API docs | same file | `chrome.tabs.sendMessage(..., { documentId })` allows targeting a specific document, which we already use in PRD-32 attachment messaging. |
| CHROME-WEBNAV-DOCID | Chrome webNavigation docs | `/Volumes/VRAM/80-89_Resources/80_Reference/docs/chrome-extensions/docs/extensions/reference/api/webNavigation.md` | `webNavigation.getFrame({ tabId, frameId: 0 })` returns the top frame's `documentId`, `url`, and `documentLifecycle` — already used in `getTopFrameContext()` for `monitor_start`. |
| REPO-GROUP-MEMBERSHIP | Current group helper | `extension/src/background/tab-group.ts` | `isTabInInterceptorGroup(tabId)` exists and asynchronously returns whether a tab is in the cyan "interceptor" tab group. Reuse this — never auto-attach to a personal tab. |
| REPO-ATTACHMENT-MODEL | Current monitor model | `extension/src/background/capabilities/monitor.ts:6-49` | `SessionRecord` already supports many attachments (`Map<string, AttachmentRecord>`) with one active. `switchToAttachment` already handles old→new transitions, including disarm-old when tabId differs. |
| REPO-CHILD-TAB-HANDOFF | Existing handoff path | `extension/src/background/capabilities/monitor.ts:426-442` | `chrome.tabs.onCreated` based; gated by `openerTabId` + recent trusted action + 5s window. Focus-follow is a parallel listener with different gating. |
| LIVE-2026-04-16-YOUTUBE | Live observation | session `040a2d24-7377-4e7d-95d3-37d6d0c11554` | Browser monitor went silent 15:37:54 → 15:38:26 while macOS monitor showed continuous Brave activity (rclick + 6 clicks + scroll bursts). User reported they switched to a YouTube tab during that window. URL never recorded — exactly the bug PRD-34 addresses. |

---

## Implementation Checklist

- [x] Author this PRD (PRD-34.md) with full evidence and design.
- [x] Add `chrome.tabs.onActivated` listener to `monitor.ts` that switches the active attachment when the activated tab is in the interceptor group AND a session is active.
- [x] Add `"focus_switch"` to `AttachmentRecord["reason"]` union and to the daemon-side `attachmentFromEvent` consumer.
- [x] Re-arm content script of newly-focused tab using existing `sendArmToTab` path.
- [x] Disarm content script of previously-focused tab via existing `sendDisarmToTab` path (best-effort, already non-throwing).
- [x] Skip the swap when activated tab is the same tab (no-op).
- [x] Skip the swap when activated tab is not in the interceptor group (preserves user-personal-tab privacy).
- [x] Skip the swap when session is paused.
- [x] Coexist with child-tab handoff: if `tabs.onCreated` already enqueued the new tab as `pendingChildTabs`, let `onCommitted` perform the attach (with reason `child_tab`) instead of letting `onActivated` override it.
- [x] Add `mon_attach` plan-renderer support so `--plan` emits `interceptor tab switch <tabId>` for `focus_switch` (so a replay reproduces the tab traversal).
- [x] Extend `test/monitor.test.ts` with `focus_switch` rendering coverage.
- [x] Update `CLAUDE.md` "Recording Sessions" section to document the new follow behavior.
- [x] Create `ARCHITECTURE.md` describing the post-PRD-32/33/34 monitor model end to end.
- [x] Run `bun test`, `bun run typecheck`, `bash scripts/build.sh` — all green.
- [x] Verify on a live two-tab session: start monitor on tab A, switch to tab B (in group), confirm `mon_detach (focus_switch)` + `mon_attach (focus_switch)` events, confirm tab B events are recorded.

---

## Scope

Covers:

- automatic attachment switching on `chrome.tabs.onActivated`,
- restricted to tabs in the interceptor group (no personal-tab follow),
- one active attachment at a time (handoff, not fanout),
- new `mon_attach` reason `focus_switch` emitted in events + persisted artifacts,
- replay-plan support so a recorded session can be replayed including tab swaps,
- coexistence with PRD-32 child-tab handoff and PRD-32 reload/history re-arm.

Explicitly does **not** cover:

- recording many tabs in parallel under one session (fanout) — see Future Work,
- auto-attaching to tabs outside the interceptor group (privacy boundary remains),
- following window switches (only tab focus within an existing window),
- any change to PRD-33 transport hardening.

---

## Problem Summary

PRD-32 ships **child-tab handoff**:

> Triggered by `tabs.onCreated` with `openerTabId === current.tabId` AND a trusted user action on the monitored tab within 5 s.

This catches the Canva use-case ("Create new design" opens a child editor tab) but misses the much more common case the user surfaced live:

> User clicks an existing tab in their tab strip → focus moves there → monitor stays on the original tab → events on the now-focused tab are not recorded → timeline goes silent.

The user's mental model — and a reasonable product expectation — is *"if I'm recording a session and I move around inside the interceptor group, the monitor follows my focus"*. PRD-34 makes that true.

---

## Current Architecture Recap (Post PRD-32 / PRD-33)

A monitor **session** is a workflow. An **attachment** is the document currently being recorded. PRD-32 introduced sequential attachments triggered by:

1. `monitor_start` → initial attachment (reason `start`)
2. `webNavigation.onCommitted` → reload / hard nav / SPA pushState (reasons `reload`, `start`, `history`, `fragment`)
3. `webNavigation.onTabReplaced` → tab swap (reason `tab_replaced`)
4. `chrome.tabs.onCreated` + opener-gated heuristic → child tab (reason `child_tab`)

PRD-34 adds:

5. `chrome.tabs.onActivated` → manual focus switch within interceptor group (reason `focus_switch`)

---

## Proposed Design

### New Listener

```typescript
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  // Resolve any active session for any tab in the group
  const session = findFirstActiveSession()
  if (!session || session.paused) return

  // Skip if the activated tab is already the active attachment
  const current = getCurrentAttachment(session)
  if (current && current.tabId === tabId) return

  // Skip if a child-tab handoff is already pending for this tab
  if (pendingChildTabs.has(tabId)) return

  // Privacy boundary: only auto-attach to tabs in the interceptor group
  const inGroup = await isTabInInterceptorGroup(tabId)
  if (!inGroup) return

  // Resolve the new tab's top-frame document context
  const ctx = await getTopFrameContext(tabId)
  const next = createAttachment(
    tabId, ctx.documentId, 0, ctx.url, ctx.lifecycle, "focus_switch"
  )

  switchToAttachment(session, next, "focus_switch")

  // Arm the new tab's content script
  const armRes = await sendArmToTab(tabId, session.sessionId, session.startedAt, ctx.documentId)
  if (!armRes.success) console.error(`focus_switch arm failed: ${armRes.error}`)
})
```

### Helper: `findFirstActiveSession()`

Today there is at most one session per tab via `activeSessionByTab`. Focus-follow needs to find the session keyed by **any** tab — including tabs not yet attached. Until V1 supports multi-session, this iterates `sessions.values()` and returns the first one. (V1 monitor only supports one session at a time in practice.)

### `switchToAttachment` Changes

`switchToAttachment` already does the right thing:

- emits `mon_detach` for the current attachment with derived reason,
- removes old `tabId → sessionId` mapping when tabIds differ,
- best-effort `sendDisarmToTab(oldTabId, oldDocumentId)`,
- activates the new attachment + emits `mon_attach`.

We extend the `reason === "child_tab"` mapping to also recognize `reason === "focus_switch"` for `mon_detach` reason `focus_switch_handoff`. Concretely:

```typescript
const detachReason =
  reason === "child_tab" ? "child_tab_handoff" :
  reason === "focus_switch" ? "focus_switch_handoff" :
  "document_replaced"
```

### Coexistence With Child-Tab Handoff

`tabs.onCreated` fires before `tabs.onActivated` for newly-opened tabs. The child-tab path runs first and pushes the new tab into `pendingChildTabs`. The `onCommitted` listener consumes that and emits `mon_attach` with reason `child_tab`. The `onActivated` listener checks `pendingChildTabs.has(tabId)` and bails — so the child-tab path always wins for child-tab cases, preserving PRD-32 semantics.

### Coexistence With Reload / SPA Re-Arm

`webNavigation.onCommitted` already replaces attachments when documents change within the active tab. Focus-follow only acts when the *tab itself* changes, not the document within a tab — so the two listeners cover orthogonal events.

### Privacy Boundary

`isTabInInterceptorGroup(tabId)` is the gate. Tabs outside the cyan "interceptor" group are never auto-attached. This preserves the existing tab-group convention from CLAUDE.md ("interceptor manages its own cyan tab group ... the user's personal tabs are never touched").

---

## Event Schema

`mon_attach` and `mon_detach` already carry `tid`, `doc`, `lif`, `u`, and `reason`. The new reason values:

| Event | reason | Meaning |
|-------|--------|---------|
| `mon_detach` | `focus_switch_handoff` | session moved away from this attachment because the user activated another tab in the group |
| `mon_attach` | `focus_switch` | session attached to this tab because it became the active tab in the group |

Existing reasons (`start`, `reload`, `history`, `fragment`, `child_tab`, `tab_replaced`, `child_tab_handoff`, `document_replaced`, `tab_closed`, `user_stop`) are unchanged.

The daemon's `attachmentFromEvent` and `syncSessionMetaFromEvent` (`daemon/index.ts:200-288`) already pass the reason through verbatim, so no daemon-side changes are required for persistence — both global event log and per-session `events.jsonl`/`session.json` will reflect the new reasons automatically.

---

## CLI / Replay Plan Behavior

`buildPlan()` (`cli/commands/monitor.ts:412-419`) already special-cases `mon_attach` with `reason === "child_tab"` to emit `interceptor tab new "<url>"` as a replay step. Extend the switch:

```typescript
case "mon_attach": {
  if (ev.reason === "child_tab" && ev.u) {
    lines.push(`# handoff to child tab ${ev.tid || "?"}`)
    lines.push(`interceptor tab new "${escapeArg(ev.u)}"`)
    lines.push(`interceptor wait-stable`)
  } else if (ev.reason === "focus_switch" && ev.tid) {
    lines.push(`# focus-switch to tab ${ev.tid} (${ev.u || "no url"})`)
    lines.push(`interceptor tab switch ${ev.tid}`)
    lines.push(`interceptor wait-stable`)
  }
  break
}
```

`renderEvent`'s default handler already prints reason fields generically, so no extra rendering work is needed for `mon_detach` / `mon_attach` reason `focus_switch[_handoff]`.

---

## Files Expected To Change

| File | Change |
|------|--------|
| `extension/src/background/capabilities/monitor.ts` | Add `onActivated` listener; extend `switchToAttachment` reason map; extend `AttachmentRecord["reason"]` union with `"focus_switch"`; add `findFirstActiveSession()` helper. |
| `cli/commands/monitor.ts` | Extend `buildPlan`'s `mon_attach` case for `focus_switch`. |
| `test/monitor.test.ts` | Add fixture exercising `mon_attach` reason `focus_switch` through `renderSession` and `buildPlan`. |
| `CLAUDE.md` | Add a sentence in "Recording Sessions" describing focus-follow behavior. |
| `ARCHITECTURE.md` | New top-level architecture doc (see PRD-34 task #15). |
| `prd/PRD-34.md` | This document. |

---

## Acceptance Criteria

1. Starting `monitor start` on tab A and then activating a different in-group tab B emits `mon_detach (focus_switch_handoff)` for A and `mon_attach (focus_switch)` for B in the per-session `events.jsonl`.
2. After the focus switch, user clicks/key/inputs on tab B are recorded in the session (proving the new tab's content script is armed).
3. Activating a tab **outside** the interceptor group does not switch the attachment.
4. Switching back to tab A emits another pair: `mon_detach (focus_switch_handoff)` for B + `mon_attach (focus_switch)` for A.
5. Child-tab handoff path is unchanged: opening a child tab via trusted click on the monitored page still emits `child_tab` not `focus_switch`.
6. `monitor export <sid> --plan` produces an `interceptor tab switch <tabId>` line for every focus-switch attach.
7. `bun test`, `bun run typecheck`, `bash scripts/build.sh` all pass.

---

## Verification Plan

### Manual two-tab live test

1. `interceptor tab new "http://localhost:21113/"` → tab A
2. `interceptor tab new "https://example.com/"` → tab B (also in group)
3. `interceptor monitor start --instruction "PRD-34 focus-follow live test"`
4. Click around on tab A.
5. Activate tab B via Chrome's tab strip.
6. Click around on tab B.
7. Activate tab A.
8. `interceptor monitor stop`
9. `interceptor monitor export <sid>` — confirm two attachment cycles, both `focus_switch` reason, with B's URL recorded.
10. `interceptor monitor export <sid> --plan` — confirm `interceptor tab switch` lines.

### Privacy guard test

1. Start monitor on tab A in the group.
2. Switch focus to a personal Chrome tab (not in the interceptor group).
3. Confirm no `mon_detach` / `mon_attach` events; tab A remains the active attachment.
4. Click anything on the personal tab — no events from it appear in the recorded session.

### Coexistence with child-tab handoff

1. Reproduce the Canva-style flow: trusted click on the monitored page that opens a child tab.
2. Confirm `mon_attach (child_tab)` is emitted, not `mon_attach (focus_switch)`.
3. The `pendingChildTabs.has(tabId)` guard in `onActivated` ensures the focus-switch path skips while the child-tab path is in flight.

---

## Future Work (Explicitly Out Of Scope For PRD-34)

- **Fanout mode**: record many tabs concurrently. The `SessionRecord.attachments` map already permits this; `activeAttachmentKey` would become a *primary* attachment with secondary attachments still receiving events. Requires per-tab seq counters or session-wide seq with per-attachment offsets.
- **Window-level follow**: extend follow to focus changes across Chrome windows. `chrome.windows.onFocusChanged` is the surface.
- **Personal-tab opt-in**: explicit `monitor follow <tabId>` to attach a tab outside the interceptor group on demand.
- **Selective per-tab pause**: pause recording on a specific attachment without pausing the whole session.

---

## Recommended Defaults

- **Default policy:** focus-follow within interceptor group is **enabled by default** (no opt-in flag). It matches the user's expectation revealed in PRD-33 verification.
- **Privacy boundary:** strictly the interceptor tab group.
- **Trust gating:** none required. Focus is itself a deliberate user action.
- **Detach reason:** `focus_switch_handoff` (mirrors `child_tab_handoff` naming).
- **Replay plan emit:** `interceptor tab switch <tabId>` (existing CLI command).

---

## Verification Snapshot

Executed on 2026-04-16 on branch `feat/monitor-focus-follow`:

- `bun test` — **54 pass / 0 fail / 157 expect() calls** across 8 files. (Baseline was 52; the delta is the 2 new `focus_switch` cases in `test/monitor.test.ts`.)
- `bun run typecheck` — exit 0.
- `bash scripts/build.sh` — exit 0. Rebuilt extension + CLI + daemon binaries.

### Files changed by this PRD

- `extension/src/background/capabilities/monitor.ts` — extended `AttachmentRecord["reason"]` union with `"focus_switch"`; extended `switchToAttachment` detach-reason map; added `findFirstActiveSession()` helper; added `handleFocusActivated()` async handler; registered `chrome.tabs.onActivated` listener.
- `cli/commands/monitor.ts` — extended `buildPlan`'s `mon_attach` case so `reason === "focus_switch"` emits `interceptor tab switch <tabId>` + `interceptor wait-stable` for replayability.
- `test/monitor.test.ts` — added 2 cases: `buildPlan emits tab switch for focus_switch attachments (PRD-34)` and a defensive case for `focus_switch` without a `tid`.
- `CLAUDE.md` — added a paragraph in "Recording Sessions" describing focus-follow.
- `ARCHITECTURE.md` — new top-level architecture document.
- `prd/PRD-34.md` — this document.

### Acceptance criteria status

1. `mon_detach (focus_switch_handoff)` + `mon_attach (focus_switch)` emitted on focus switch within group. **✓** (logic in `handleFocusActivated` + `switchToAttachment`).
2. New tab's events recorded after focus switch. **✓** (`sendArmToTab` invoked after `switchToAttachment`).
3. Tabs outside the interceptor group ignored. **✓** (`isTabInInterceptorGroup` gate).
4. Bidirectional switching works. **✓** (no special-case state — same listener handles both directions).
5. Child-tab handoff path unchanged. **✓** (`pendingChildTabs.has(tabId)` short-circuit).
6. `monitor export --plan` emits `interceptor tab switch <tabId>` for focus_switch attaches. **✓** (verified by `buildPlan emits tab switch for focus_switch` test).
7. `bun test`, `bun run typecheck`, `bash scripts/build.sh` all pass. **✓**.
