# Monitor And Replay

## Record real workflows

```bash
interceptor monitor start --instruction "search for bun docs and open the first result"
# user works
interceptor monitor stop
interceptor monitor export <session-id> --plan
```

- Use monitor when the goal is to learn a human workflow and replay it later.
- Treat `--plan` output as the highest-value artifact. It converts event traces into reusable `interceptor ...` commands.

## Understand session behavior

- Monitor attaches to the current interceptor-managed tab unless `--tab` is set.
- A session follows focus across the interceptor tab group.
- Child tabs opened by trusted actions on the monitored page use the dedicated child-tab handoff path.
- Tabs outside the interceptor tab group are never auto-attached.
- Use `monitor tail` or `monitor tail --raw` for live inspection.
- Use `monitor list` to recover older sessions stored in the event log.

## Use replay plans correctly

- Prefer the exported semantic replay commands over raw event streams.
- Rebuild context from the live DOM when replaying. Do not assume old `eN` refs still exist.
- Use `--include-synthetic` when the recorded session was agent-driven and trusted user events are sparse.

## Verify what was really captured

- Check whether the exported plan includes the actions you care about, not just background churn.
- Check whether the session crossed tabs via focus-follow or child-tab handoff when reviewing the replay.
- Save or copy the plan into a stable workflow doc or repo use-case when it proves reliable.
