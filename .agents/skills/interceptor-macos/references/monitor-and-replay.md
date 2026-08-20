# Monitor And Replay (macOS)

## Record native flows

```bash
interceptor macos monitor start --instruction "Show me how you file expenses"
# user works across native apps
interceptor macos monitor stop                  # Summary: events, duration, app switches
interceptor macos monitor export <sid>          # Pretty timeline with timestamps
interceptor macos monitor export <sid> --plan   # Replayable interceptor macos commands
```

- Use the macOS monitor when the goal is to learn a native-app workflow and replay it later.
- Same sparse JSON format as the browser monitor: short keys (`t`, `s`, `k`, `app`, `bundle`, `ref`, `r`, `n`, `cause`), session-monotonic `seq` on user actions, `cause: <seq>` on follow-on events.
- Each event is annotated with the AX element that received it (role, name, identifier when present), so the replay plan can re-resolve targets even when the AX tree changes between record and replay.

## Session lifecycle

```bash
interceptor macos monitor start                 # Begin recording (frontmost app at start, follows app switches)
interceptor macos monitor pause                 # Stop emitting without ending
interceptor macos monitor resume                # Resume a paused session
interceptor macos monitor stop                  # End and emit summary
interceptor macos monitor status                # Active session(s)
interceptor macos monitor list                  # All historical sessions
interceptor macos monitor tail                  # Live event stream (pretty)
interceptor macos monitor tail --raw            # Raw JSONL
```

- A session captures clicks, keystrokes, scrolls, and app switches. App switches generate `app_change` events so the replay plan knows which app each subsequent event belongs to.
- Input Monitoring permission is required for global key/click capture. Run `interceptor macos trust` before recording.

## Task envelopes and speech

```bash
interceptor macos monitor start --task "Teach Slack triage" --mode human-teach --app Slack --include speech
interceptor macos monitor stop --task "Teach Slack triage"   # snapshot + transcript synthesis + quality grade
interceptor monitor task quality "Teach Slack triage"        # name or task-<id>; synthesizes a missing transcript first
```

- Stop a task with `--task`, not `--sid`. A sid stop ends the session only; it prints the owning task and the `task snapshot` / `task quality` commands that finish the job.
- Speech finals are real: `speech_segment` events arrive as throttled partials (`isFinal: false`) and one utterance-final (`isFinal: true`, with text) per utterance — at recognition metadata, ~3 s of silence, the periodic restart, or stop. Grade on the finals.

## Use replay plans correctly

- Prefer the exported semantic replay commands over raw event streams.
- The replay plan emits `interceptor macos app activate "X"` lines around app switches, then `act`/`click`/`type`/`keys` against AX selectors that re-resolve at replay time. Refs are not preserved verbatim.
- Treat `--plan` output as the highest-value artifact. A 2-minute recorded native workflow turns into ~30–60 lines of `interceptor macos ...` commands that survive UI churn.

## Verify what was really captured

- Check whether the exported plan includes the actions you care about, not just background churn.
- Check whether app-switch events landed where you expect — if the user briefly tabbed to a different app mid-flow, the plan will activate that app before continuing.
- Save proven plans as live recipes; treat them as documentation of the workflow.

## Note on the browser monitor

`interceptor monitor *` (no `macos` prefix) is the parallel surface for browser sessions. It records DOM events, network traffic, and SPA navigation; the macOS monitor records AX events and app switches. They share the JSON shape and the `--plan` export model but are otherwise independent.
