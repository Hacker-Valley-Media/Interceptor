# OverrideXhr

You are mutating an HTTP request before it hits the server, or rewriting a response before the page sees it. Use this workflow when:
- The page does the right thing, but you need to test what happens when the API returns 500 / 404 / slow
- You need to change request parameters without rebuilding the UI
- You need to inject test data the backend can't produce

## Command Budget

This workflow should complete in **5 commands**:
1. `interceptor net log --filter <pattern>` (observe real traffic first; don't override blind) → 1 command
2. `interceptor override "<pattern>" --status ...` (install the override) → 1 command
3. Trigger the request (`act`, `click`, `type`, or `navigate`) → 1 command
4. `interceptor net log --filter <pattern> --since 30s` (verify the override fired — **NOT** a fresh `read`; the response data lives in the network log, not the DOM) → 1 command
5. `interceptor override clear` (always clear; an override stays on the page until cleared or the page navigates) → 1 command

If verification at step 4 shows the override didn't fire, the pattern probably missed — refine the pattern and retry steps 2-4 once. Do not reach for a fresh `read` to "check the page" before confirming the network override fired.

## Steps

1. **Open the page.**
   ```bash
   interceptor open <url>
   ```

2. **Observe the real traffic first.** Don't override blind.
   ```bash
   interceptor net log --filter <pattern>           # See what's flying
   interceptor net headers --filter <pattern>       # Confirm exact URL shape
   ```
   Pick a unique substring of the URL — that's your override key.

3. **Install the override.**
   ```bash
   interceptor override "*api/search*" --status 500         # Force a status (answered locally, never sent)
   interceptor override "*api/search*" --delay 1000         # Add latency to the real request
   interceptor override "*api/search*" --status 200 --body '{"results":[]}'   # Custom response
   interceptor override "*api/items*" count=5               # Mutate query param
   ```

4. **Trigger the request** — click, type, navigate, whatever causes the page to make the call.

5. **Verify the override fired.**
   ```bash
   interceptor net log --filter <pattern> --since 30s
   ```
   The response should match what you forced, with `"mocked": true` on a forced response. If it doesn't, your pattern probably missed.

6. **Clear when done.** An override stays on the page until cleared and can poison later steps on that page.
   ```bash
   interceptor override clear
   ```

## When to use CDP `network` instead

`interceptor override` runs in the page's own fetch and XMLHttpRequest wrapper: no debugger banner, no DevTools UI fingerprint. It covers fetch and XHR made by the page and its frames. Reach for `interceptor network on` + `interceptor network override on '<json>'` only when:
- You need request-header or request-body rewriting
- The request is not fetch or XHR (images, scripts, navigations), or fires while the page loads
- You need to observe raw bytes pre-decode

CDP attach shows a "DevTools is debugging this tab" banner. Pages that watch for it will behave differently. Default to extension overrides.

For WebSocket, Beacon, or BroadcastChannel observation, use
`interceptor net page-comm log` or
[`capture-page-communication.md`](capture-page-communication.md) before CDP.

## Pitfalls

- **Pattern too broad.** `*` alone overrides everything including your own extension traffic — pages can hang. Use a substring that uniquely identifies the request.
- **Forgetting `override clear`.** The rule stays on the page until it is cleared or the page navigates. A check that "passed" may be reading a stale override.
- **Navigating after setting it.** A navigation or reload drops the override. Set it after the page has loaded, then trigger the request in the page.
- **`status=500` instead of `--status 500`.** A `key=value` pair always rewrites the query string; the CLI prints a note when the key is `status`, `delay`, or `body`.
- **`--delay` is a minimum.** Chromium rounds a background tab's timers up to the next second, so `--delay 1500` measures about 2.4 s there.
- **One rule at a time.** Each `override` call replaces the previous rule; combine query pairs and flags in one call.

## Output format

Report:
- The override key used (URL pattern + what was changed)
- The observed response after triggering
- Whether the page's behavior matched expectations under the forced state
- Whether `override clear` was called at the end
