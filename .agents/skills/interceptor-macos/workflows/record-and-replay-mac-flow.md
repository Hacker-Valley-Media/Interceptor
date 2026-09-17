# RecordAndReplayMacFlow

You are learning a real macOS user workflow (or replaying one) instead of rediscovering it via AX reads and synthesized input. Use this when:
- The user just demonstrated a native flow (a multi-step Mail action, a Finder rearrange, a Cursor refactor) and you need to repeat it programmatically
- A native workflow is complex enough that observation beats step-by-step interaction
- You need a replay plan for regression testing or handoff to another agent

This mirrors the browser RecordAndReplay workflow, but records AX events instead of DOM events.

## Record

1. **Start the session.** Optionally include an instruction so the export carries intent.
   ```bash
   interceptor macos monitor start --instruction "Watch how the user files an email"
   ```

2. **Hand control to the user.** Tell them they can drive macOS normally now. **Do NOT issue synthesized input during recording** (`click`, `type`, `keys`, `drag`) — synthesized events land in the trace and pollute it.

3. **Watch progress.**
   ```bash
   interceptor macos monitor status                       # Active sessions + counts
   interceptor macos monitor list                         # All sessions, active + ended
   interceptor macos monitor tail <sid>                   # Live pretty stream
   interceptor macos monitor tail <sid> --raw             # Raw JSONL
   ```

4. **Pause / resume / stop.**
   ```bash
   interceptor macos monitor pause <sid>
   interceptor macos monitor resume <sid>
   interceptor macos monitor stop <sid>
   ```

## Scope: which apps get recorded

The monitor records the frontmost app's events. **If the user changes frontmost mid-flow, the monitor switches with them.** That's by design — most real flows cross app boundaries (Mail → Finder → Slack).

Scope flags:
- `--app "X"` — record events from one specific app, ignore frontmost changes.
- `--apps "A,B,C"` — record events only when frontmost is one of these.
- `--all-apps` — record every app, no filter.

Optional event sources:
- `--include clipboard|files|network|log|notifications|speech` — add non-AX event channels.
- `--frames N` — capture N screenshots per second alongside events (requires Screen Recording TCC).
- `--vision-text` — OCR captured frames inline.
- `--watch-path <p>` — watch a filesystem path for changes (filesystem events).
- `--log-predicate "<NSPredicate>"` — pull OSLog entries matching the predicate.

## Export

After stop, pick the right shape:

```bash
interceptor macos monitor export <sid>                   # Aligned-text default, human-readable
interceptor macos monitor export <sid> --plan            # Replay-plan (highest-value artifact)
interceptor macos monitor export <sid> --with-bodies     # Include event bodies (clipboard content, file diffs)
interceptor macos monitor export <sid> --json            # Raw JSONL (for piping into a script)
```

**The `--plan` export is the most useful artifact.** It collapses raw events into the minimum steps needed to reproduce the flow — app activations, AX refs, key strokes, waits — without the noise of mousemove tracks and intermediate AX read events.

## Replay

For now, replay is human-readable rather than fully automated. Read the `--plan` output as a checklist:
1. Identify each step's target app, ref, and action.
2. Map to `interceptor macos` commands (`open`, `act`, `type`, `keys`, `scroll`, `intent dispatch`).
3. Re-execute as a sequence. Background-first wherever possible — only foreground when the plan says the user did.

## Permissions

- Accessibility TCC — required (this is how the monitor sees AX events at all).
- Screen Recording — required only for `--frames`.
- Microphone — required only for `--include speech`.
- Input Monitoring — required for global keystroke capture in the monitor.

Check with `interceptor macos trust` before starting a long session.

## Sessions on disk

Sessions persist NDJSON to `${INTERCEPTOR_MONITOR_SESSIONS_DIR:-$TMPDIR/interceptor-monitor-sessions}/<sid>/` and auto-stop after 24h with 100 MiB rotation. If you see runaway counts in `monitor status`, stop the orphan.

## Pitfalls

- **Synthesized input pollutes the trace.** Hand off to the user; do not "help" by clicking yourself.
- **Forgetting to stop.** Auto-stops are a safety net, not a workflow.
- **Re-using a sid.** Each `monitor start` gets a fresh `sid`. `resume` only works on `paused` sessions, not `stopped`.
- **Cross-Space drift.** If the user switches Spaces mid-flow, AX continues recording — but `--frames` may capture the wrong Space's compositor output. Test before relying on it.

## Output format

Report:
- The `sid` of the recording
- Duration and event count
- The path or content of the `--plan` export
- Any TCC requirement that wasn't satisfied (with the deep link from `trust`)

More on session lifecycle, AX event format, and replay-plan generation: [`../references/monitor-and-replay.md`](../references/monitor-and-replay.md).
