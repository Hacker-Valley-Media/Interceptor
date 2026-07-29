# Browser And Network

## Prefer the high-yield path

1. Run `interceptor open "<url>"`.
2. Read the returned tree and text.
3. Use `interceptor act <ref>` or `interceptor act <ref> "<value>"`.
4. Use `interceptor inspect` when the page is an SPA or hides the real data behind API calls.

Before assuming browser control is available:

- Run `interceptor status`.
- If `tab_create` or `open` times out, confirm the browser is open with the Interceptor extension actually loaded in the active profile.
- A healthy packaged install can still fail browser commands if the extension is missing or the wrong browser profile is active.
- For a single-command debugging snapshot (daemon pid/execPath, binary mismatches, per-context extension reachability, active tab, interactive element count, monitor sessions), run `interceptor diagnose` instead of chaining several probe commands. This is the fastest way to root-cause "no extensions connected" — it directly compares the running daemon's binary against each browser's native-messaging manifest.

## Use the right read surface

- Use `open`, `read`, and `inspect` first.
- Use `tree --filter all` when headings or landmarks matter.
- Use `find "<query>" --role <role>` to rediscover controls after refs go stale.
- Use `text <ref>` or `html <ref>` when only one subtree matters.
- Use `diff` and `state` when the page changes subtly.

## Extract SPA data without CDP

```bash
interceptor open "https://app.example.com/dashboard"
interceptor inspect --filter api
interceptor net headers --filter api
interceptor net log --filter api --limit 20
```

- Read passive `net log` first. It captures fetch/XHR automatically.
- Read `net headers` when CSRF or auth headers matter.
- Use `override "*pattern*" key=value` to change pagination or filters before the page sends the request.
- Run `override clear` after the workflow so later tasks are not contaminated.

## Handle long-lived or streaming pages

- Use `sse streams`, `sse log`, and `sse tail` for `text/event-stream` traffic.
- Use `net page-comm log` for WebSocket, Beacon, and BroadcastChannel activity.
  Use `net monitor on --reload` first when startup sockets must be covered from
  the beginning of the document.
- Use `wait-stable` only when the DOM should settle. Avoid it as a blind delay on continuously streaming pages.

## Use page-world code sparingly

- Use `eval --main` only when the structured command surface is not enough.
- On strict-CSP sites, the first `eval --main` attempt may trigger an automatic reload/retry path before succeeding.
- Prefer staged injections over one giant payload when cooking or building page overlays.


## Avoid common mistakes

- Avoid screenshots when tree, text, inspect, or scene data can answer the question.
- Avoid CDP commands unless the user explicitly needs debugger-backed interception.
- Avoid acting outside the interceptor tab group unless `--any-tab` is intentional.
- For anything outside the page (native dialogs, browser chrome, OS notifications, other apps), switch to the `interceptor-macos` skill — the browser surface cannot see those targets.
