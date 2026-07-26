---
paths:
  - "cli/commands/tabs.ts"
  - "extension/src/background/message-dispatch.ts"
  - "extension/src/background/resolve-tab.ts"
  - "extension/src/background/capabilities/tabs.ts"
---

# Tab-target resolution contract

These four files implement one contract. Keep the invariants; extend the two
pinning test files whenever you touch this surface.

1. **Resolution goes through `resolveWorkingTabId` only** (`resolve-tab.ts`):
   well-formed explicit `action.tabId` > `--tab` override (`msg.tabId`) >
   undefined (auto-target/active fallback). NaN never counts as explicit. Do
   not add a second resolution path — the tab handlers act on `action.tabId`
   when present, so any divergence makes the group gate validate a different
   tab than the one acted on.
2. **Exactly one auto-target persist, after the group gate.** Never add a
   pre-gate `setActiveTabId` (the active-tab fallback used to have one: a
   gate-rejected request poisoned the stored target for every following
   command). Handlers must not write the auto-target either — `tab_switch`'s
   handler-side write clobbered the ungrouped key on grouped switches.
3. **CLI ids are strict digits, taken from the first non-flag argument.**
   `tab close --json` is a valid no-arg close; `12abc` is a hard error, not a
   `parseInt` partial parse.
4. **Auto-target storage goes through the session-or-local fallback**
   (`sessionArea()` in `capabilities/tabs.ts`, inline in `message-dispatch.ts`)
   — `chrome.storage.session` is MV3-only and the MV2 Electron package shares
   these handlers.
5. **Tab creation pins to a normal window and surfaces grouping failure.**
   `tab_create` resolves placement via `resolveNormalWindowPlacement` (a
   created window carries the url — its initial tab IS the requested tab; do
   not create a second one). Grouping tolerates failure but must stay
   visible: when the group API exists and the tab still couldn't be grouped,
   the result carries `groupWarning` (`groupWarningFor`). Never downgrade
   that to a console.warn — per-agent isolation consumers key off it.

Tests that pin this: `extension/src/background/resolve-tab.test.ts`
(resolution precedence) and `test/tab-id-args.test.ts` (CLI arg forms). A
change that flips any invariant above must update both the tests and the
"Tab group isolation" section of `ARCHITECTURE.md`.
