# Browser And Network

## Prefer the high-yield path

1. Run `interceptor open "<url>"`.
2. Read the returned tree and text.
3. Use `interceptor act <ref>` or `interceptor act <ref> "<value>"`.
4. Use `interceptor inspect` when the page is an SPA or hides the real data behind API calls.

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
- Use `wait-stable` only when the DOM should settle. Avoid it as a blind delay on continuously streaming pages.

## Use page-world code sparingly

- Use `eval --main` only when the structured command surface is not enough.
- On strict-CSP sites, the first `eval --main` attempt may trigger an automatic reload/retry path before succeeding.
- Prefer staged injections over one giant payload when cooking or building page overlays.

## Use specialized flows when they already exist

- Use `interceptor linkedin event` and `interceptor linkedin attendees` for LinkedIn event extraction instead of rebuilding the workflow by hand.
- Use `interceptor chatgpt send`, `read`, `status`, and `switch` when the task is to drive ChatGPT's web UI through the browser session.

## Avoid common mistakes

- Avoid screenshots when tree, text, inspect, scene, or macOS AX data can answer the question.
- Avoid CDP commands unless the user explicitly needs debugger-backed interception.
- Avoid acting outside the interceptor tab group unless `--any-tab` is intentional.
