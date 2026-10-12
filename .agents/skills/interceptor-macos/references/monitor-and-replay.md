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
- Mac recordings use a flat header: `sid`, increasing `s`, nondecreasing elapsed milliseconds `t`, `event`, and optional `timestamp`/`taskId`. Payload fields depend on the source. AX observations carry `pid` and available `r`, `sr`, `n` attributes; input may carry `v`, and secure input values are masked. Global pointer/key events carry `app`/`bundleId` and their input fields. These are Mac fields, distinct from browser payloads.
- Tail and every export route validate known Mac payloads before selecting or rendering events. A malformed archive is refused without rewriting its original bytes. Unknown extension event names retain opaque data within the existing header, row and archive limits. Optional AX values and missing workspace notification userInfo remain compatible.

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

- `pause`, `resume`, `stop`, and `status` honor an explicit `--sid` exactly. An unknown ID returns `no_active_session` and never acts on another recording. Missing, empty, flag-valued, and repeated `--sid` arguments are refused before dispatch. Without `--sid`, lifecycle commands select the sole active session and refuse an ambiguous selection; `status` lists active sessions or reports idle.
- A session captures clicks, keystrokes, scrolls, and app switches. Workspace activation emits `frontmost` with available app identity, and deactivation emits `app_deactivate`. Replay uses those identities when they are available.
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
- Both native and browser replay exports preserve shell-sensitive characters as literal arguments. Captured instruction, menu, network and other comment text stays inside comments, and browser ref fallbacks are quoted. A recorded focus-switch target must be a positive safe integer before it can become `--tab`.
- The replay plan never asks for focus. Where the recording changed apps it emits `interceptor macos open "X"` (a no-op on a running app, a background launch otherwise; an app that is not running can still come forward while it starts, so replay against apps that are already open), and every `click` / `type` / `keys` / `scroll` / `menu` line carries `--app "X"`, so the replay runs against each app in the background while the user keeps working. Refs are not preserved verbatim.
- Treat `--plan` output as the highest-value artifact. A 2-minute recorded native workflow turns into ~30–60 lines of `interceptor macos ...` commands that survive UI churn.

## Verify what was really captured

- Check whether the exported plan includes the actions you care about, not just background churn.
- Check whether app-switch events landed where you expect — if the user briefly tabbed to a different app mid-flow, the plan has lines addressed to that app. Delete them if they are not part of the workflow.
- Do not add `app activate` lines to a plan. If a step only works with the app in front, say so to the user instead.
- Save proven plans as live recipes; treat them as documentation of the workflow.

## Note on the browser monitor

`interceptor monitor *` (no `macos` prefix) is the parallel surface for browser sessions. It records DOM events, network traffic, and SPA navigation; the macOS monitor records AX events and app switches. They share the JSON shape and the `--plan` export model but are otherwise independent.
