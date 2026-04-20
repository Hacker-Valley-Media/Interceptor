---
name: interceptor
description: Use when Codex should use the `interceptor` CLI to operate a live signed-in browser or macOS app: inspect pages, navigate flows, extract data, read passive network traffic, automate rich editors, or drive native apps. Prefer compound commands and structured read surfaces over screenshots. This skill is for getting work done through Interceptor, not for troubleshooting Interceptor itself unless the user explicitly asks for that.
---

# Interceptor

This is an agent-operator skill. Use Interceptor as the control surface for a real browser or native app. Do not default to explaining, installing, or debugging Interceptor unless the task is specifically about Interceptor itself.

## Fast Path

1. Run `interceptor status`.
2. Fall back to `./dist/interceptor ...` when working inside the Interceptor repo and the binary is not on `PATH`.
3. Prefer the compound commands first:

```bash
interceptor open "https://example.com"
interceptor read
interceptor act e5
interceptor act e7 "hello"
interceptor inspect
```

4. Treat `eN` refs as short-lived. Re-read or `find` again after DOM-changing actions.

## Speed Rules

- Prefer one compound command over multiple legacy commands.
- Ask Interceptor for the narrowest surface that answers the question: `--tree-only`, `--text-only`, `read <ref>`, `text <ref>`, `inspect --filter <pattern>`, `net log --filter <pattern> --limit <n>`.
- Prefer `find` or semantic selectors to recover after refs go stale.
- Use `wait-stable` only when the DOM should settle. Avoid blind sleeps when built-in waits already apply.
- Use `act --no-read` only when you intentionally do not need the updated tree.

## Read Hierarchy

- Browser default: `open`, `read`, `act`, `inspect`
- Narrow reads: `tree`, `find`, `text`, `html`, `diff`, `state`
- Network: `net log`, `net headers`, `override`, `sse`
- Rich editors: `scene profile`, then `scene list`, `scene text`, `scene insert`, `scene slide goto`, `scene render`
- Native apps: `interceptor macos open`, `read`, `act`, `inspect`
- Escape hatch: `eval --main` only when the built-in command surface is not enough

## Screenshot Policy

- Do not use screenshots for routine navigation, extraction, or understanding.
- Prefer tree, text, network, scene, or macOS AX data first.
- Use screenshots only when pixels are the task: explicit visual evidence is requested, a layout or color issue cannot be confirmed from structured surfaces, or a specific render artifact must be captured.
- In editors, prefer `scene render` or `canvas read` before a page screenshot.

## Choose The Workflow

### Use browser control

- Start with `open`, `read`, `act`, and `inspect`.
- Use `tree`, `find`, `text`, `html`, `diff`, and `state` only when the compound commands do not give enough detail.
- Use `inspect` or filtered `net` reads when the page is an SPA or hides the real data behind API calls.
- Clear request rewrite rules with `interceptor override clear` after extraction or pagination work.
- Use `eval --main` only when the built-in browser surface is insufficient. On strict-CSP sites, the first attempt may trigger an automatic reload/retry path.

### Use rich-editor control

- Run `interceptor scene profile` before assuming scene support.
- Prefer accessible menus and toolbars before scene clicks.
- Use `scene list`, `scene selected`, `scene text`, `scene insert`, `scene slide goto`, and `scene render` only after confirming the profile and capability fit.
- Treat Google Docs as the strongest structured editor target.
- Treat Google Slides as partly structured: navigation and selection are good, but text insertion and table growth can still require `eval --main`.

### Use teach-and-replay

- Record trusted user behavior with `interceptor monitor start`.
- Treat `interceptor monitor export <sid> --plan` as the highest-value artifact.
- Use replay plans when the fastest path is learning a real user flow instead of rediscovering it manually.

### Use macOS control

- Start with `interceptor macos open`, `read`, `act`, and `inspect`.
- Prefer AX tree actions first and trusted OS input second.
- Run `interceptor macos trust` before claiming screen capture, speech, or trusted-input features work.

## Escalate Carefully

- Use `--os` for browser actions when the site checks `isTrusted` or synthetic input fails.
- Use `interceptor macos` instead of browser automation when the target is a native app or browser chrome.
- Use `eval --main` only when the native command surface is not expressive enough and the DOM or page context is the narrowest viable place to finish the task.
- Avoid `interceptor network on` unless raw CDP interception is explicitly needed. Passive capture already sees fetch/XHR traffic without debugger fingerprints.

## Do Not Default To Troubleshooting

- If the user wants a browser or app task completed, run Interceptor commands.
- If the user wants Interceptor fixed, installed, or explained, that is a separate task.
- When working inside the Interceptor repo, use this skill mainly for live validation of browser or macOS behavior, not as the primary source of repo-development instructions.

## Open References

- Open [references/browser-and-network.md](references/browser-and-network.md) for command selection, SPA extraction, request overrides, SSE, LinkedIn, and ChatGPT bridge flows.
- Open [references/rich-editors.md](references/rich-editors.md) for Canva, Google Docs, and Google Slides behavior and caveats.
- Open [references/monitor-and-replay.md](references/monitor-and-replay.md) for monitor usage, replay-plan generation, and current cross-tab/focus-follow behavior.
- Open [references/macos.md](references/macos.md) for native-app workflows and permission-sensitive capabilities.
