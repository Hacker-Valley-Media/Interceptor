---
author: agent
generated_by: Codex
created: 2026-11-18
status: active
reviewed: false
source: Interceptor tab lifecycle implementation and browser CLI contract
---

# Job-scoped browser tabs

Give the job and its cleanup step the same live, group-capable context and unique label. Before opening a tab, verify the label is free. This Bash example uses Bun and jq.

```bash
set -o pipefail
export INTERCEPTOR_CONTEXT="${JOB_BROWSER_CONTEXT:?set the browser context for this job}"
INTERCEPTOR_GROUP="job-$(bun -e 'console.log(crypto.randomUUID().replaceAll("-", "").slice(0, 28))')" || exit 1
export INTERCEPTOR_GROUP
group_absent() {
  interceptor --json group list | jq -es --arg g "$INTERCEPTOR_GROUP" \
    'length == 1 and (.[0] | .success == true and (.data | type == "array") and all(.data[]; .label != $g))'
}
group_absent || exit 1
```

In the job owner's finalization hook or CI cleanup step, wait for the browser-using child processes to exit. Then close the group's tabs and verify the result with the same environment.

```bash
interceptor group close "$INTERCEPTOR_GROUP" || true
group_absent
```

Preserve the job's exit status if it failed. Report cleanup failures and fail an otherwise successful job if cleanup cannot be verified. If the job created no tabs or the idle sweep already closed them, confirm that the label and the recorded tab IDs are gone in the original context.

By default, ten idle minutes make a group eligible for cleanup. The guarded sweep keeps pinned, audible, focused active and last-window tabs. A trusted input or change, a successful Interceptor edit, or a page-assigned `window.onbeforeunload` property also protects a tab. An edit stays recorded for that document's lifetime, including after undo. A listener registered only with `addEventListener("beforeunload", ...)` is invisible to the sweep. A quiet job can reach its idle limit before the child exits.

## A group the idle timer closed

If the idle timer closed a named group you were still using, the next read in that group reopens its last page in a background tab and says so in a `warning:` line. An input (click, type, keys) stops instead and asks you to read first, because refs from before the closure are gone. A group you closed yourself with `interceptor group close` stays closed.
