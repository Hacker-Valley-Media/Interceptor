# PRD-31: Fix Native Transport Hangs, Compound Read False Success, and General Content-Script Recovery

**Status:** Implemented
**Author:** Codex
**Date:** 2026-04-16
**Priority:** P1-High
**Effort:** M
**Platform:** Chrome/Brave MV3
**Category:** Reliability

---

## Goal

Eliminate the intermittent Interceptor failures where the default CLI path times out even though the WebSocket path is healthy, compound read commands return empty success instead of surfacing errors, and ordinary content-script-backed actions do not recover from missing or disconnected content scripts.

---

## Problem Summary

Three distinct defects combine into the observed "sometimes fails" behavior:

1. `daemon/index.ts` prefers the native relay for all outbound extension traffic, even when the WebSocket channel is healthy and the relay/native path is wedged.
2. `cli/commands/compound.ts` converts subcommand failures into empty strings, so `interceptor read` and `interceptor open` can return success with empty data.
3. Generic content-script actions rely on one-shot `chrome.tabs.sendMessage()` and do not use the monitor-style reinject-and-retry recovery path.

---

## Implementation Checklist

- [x] Expand the internal todo list before implementation.
- [x] Create this PRD and keep the checklist current during execution.
- [x] Fix daemon outbound routing so normal action requests prefer WebSocket when available, while handshake/control messages still use the native relay/native path.
- [x] Preserve relay/native fallback behavior when WebSocket is unavailable.
- [x] Add generic content-script reinjection and retry for non-monitor actions.
- [x] Keep privileged-page failures explicit when reinjection is impossible.
- [x] Fix compound `open`/`read` error handling so empty success is no longer possible when requested reads fail.
- [x] Preserve successful partial output behavior only when at least one requested read succeeds.
- [x] Add tests for outbound transport selection.
- [x] Add tests for compound command failure surfacing.
- [x] Run targeted tests and typecheck.
- [x] Rebuild Interceptor artifacts.
- [x] Verify the original repro commands on the default transport and on WebSocket.
- [x] Update this checklist and final status when implementation is complete.

---

## Files Expected To Change

- `daemon/index.ts`
- `extension/src/background/content-bridge.ts`
- `cli/commands/compound.ts`
- `test/*`

---

## Verification Targets

- `interceptor tabs --json` works on the default path when `interceptor tabs --ws --json` already works.
- `interceptor text` / `tree` / `read` recover from content-script loss when recovery is possible.
- `interceptor read --json` fails explicitly instead of returning `{ success: true, data: {} }` when both underlying reads fail.
- `bun test`
- `bun run typecheck`
- `bash scripts/build.sh`

---

## Verification Snapshot

- `bun test` passed: 44 tests, 0 failures.
- `bun run typecheck` passed.
- `bash scripts/build.sh` passed and rebuilt `extension/dist`, `dist/interceptor`, and `daemon/interceptor-daemon`.
- Live sequential verification after restarting a single standalone daemon:
  - `./dist/interceptor tabs --json` succeeded on the default path.
  - `./dist/interceptor text --tab 1729164954` succeeded on the default path.
  - `./dist/interceptor tree --filter all --tab 1729164954` succeeded on the default path.
  - `./dist/interceptor read --json --tab 1729164954` succeeded on the default path and returned both tree and text.
- Failure surfacing verification:
  - Before stabilizing the daemon during validation, `./dist/interceptor read --json --tab 1729164954` returned an explicit error instead of false success when both subreads failed.
