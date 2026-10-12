# Monitor And Replay (Browser)

## Record real workflows

```bash
interceptor monitor start --instruction "search for bun docs and open the first result"
# user works
interceptor monitor stop
interceptor monitor export <session-id> --plan
```

- Use monitor when the goal is to learn a human web workflow and replay it later.
- Treat `--plan` output as the highest-value artifact. It converts event traces into reusable `interceptor ...` commands.
- Add `--capture page-comm` when WebSocket, Beacon, or BroadcastChannel rows
  must be preserved in the session; add `--reload` when startup sockets matter.

## Understand session behavior

- Monitor attaches to the current interceptor-managed tab unless `--tab` is set.
- A session follows focus across the interceptor tab group (`mon_detach reason: focus_switch_handoff` then `mon_attach reason: focus_switch`).
- Child tabs opened by trusted actions on the monitored page use the dedicated child-tab handoff path (`reason: child_tab`).
- Tabs outside the interceptor tab group are never auto-attached.
- Reloads and SPA history/fragment navigations create new document-scoped attachments on the same tab (`reason: reload` / `history` / `fragment`).
- Use `monitor tail` or `monitor tail --raw` for live inspection.
- Use `monitor list` to recover older sessions stored in the event log.

## Use replay plans correctly

- Prefer the exported semantic replay commands over raw event streams.
- Rebuild context from the live DOM when replaying. Do not assume old `eN` refs still exist — the replay plan uses semantic selectors (`button:Search`, `textbox:Query`) that re-resolve at replay time.
- Use `--include-synthetic` when the recorded session was agent-driven and trusted user events are sparse.
- Use `--with-bodies` to inline persisted correlated net-body context (capped at 64 KiB per body, redacts `Authorization` / `Cookie` / token-shaped strings, JSON / text only).

## Verify what was really captured

- Check whether the exported plan includes the actions you care about, not just background churn.
- Check whether the session crossed tabs via focus-follow or child-tab handoff when reviewing the replay.
- Save or copy the plan into a stable workflow doc or repo use-case when it proves reliable.

## Note on the macOS monitor <!-- os:darwin -->
## Note on the native monitor <!-- os:win32,linux -->

`interceptor macos monitor *` is the parallel surface for native-app sessions. It uses the same sparse JSON format and the same `--plan` export pattern, but operates on AX events rather than DOM events. Load the `interceptor-macos` skill when teaching/replaying native-app workflows. <!-- os:darwin -->
`interceptor desktop monitor *` is the parallel surface for native-app sessions. It uses the same sparse JSON format and the same `--plan` export pattern, but operates on accessibility events rather than DOM events. Load the `interceptor-desktop` skill when teaching/replaying native-app workflows. <!-- os:win32,linux -->
