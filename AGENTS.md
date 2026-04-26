# Interceptor Agent Manual

Interceptor is an AI-agent control surface for the user's real browser and native macOS apps. It is not primarily a human CLI product. Treat this file as the operating manual for agents that need to inspect pages, act in browser sessions, observe network traffic, work with canvas or scene-based editors, and control native apps through the Interceptor CLI.

For user-facing overview material, see [README.md](README.md). For implementation details, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Core Rules

- Use `./dist/interceptor ...` when working inside this repository and the binary is not on `PATH`.
- Prefer compound commands first: `open`, `read`, `act`, and `inspect`.
- Prefer structured reads over screenshots unless the task is explicitly visual, pixel-based, or image-based.
- Use the user's existing browser/session state. Do not assume a clean profile, isolated browser, or synthetic automation profile unless the user asks for that.
- Use the CLI plus native-host route for setup, validation, and development.
- Do not default to debugging Interceptor itself unless the task is specifically about Interceptor.
- Use `--json` when another tool or script will consume the output.
- Treat `eN` and framed refs such as `e2_7` as short-lived. Re-run `read` or `find` after navigation, rerenders, or DOM mutations.
- Do not use `--any-tab` unless the user explicitly wants to operate outside Interceptor's tracked tab group.
- Prefer passive observation before invasive instrumentation. For network work, start with `inspect` or `net`, not CDP debugger attachment.

## Command Selection

| Goal | Start With | Escalate When Needed |
| --- | --- | --- |
| Open a page and understand it | `interceptor open <url>` | Add `--full`, `--include-frames`, or `inspect` |
| Read current page | `interceptor read` | Use `read <ref>` for a subtree or `--include-frames` for iframes |
| Find an element | `interceptor find "text"` | Add `--role <role>` or run `read --tree-only` |
| Click or type | `interceptor act <ref>` | Use low-level `click`, `type`, `keys`, or `select` only for special flags |
| Inspect page plus network | `interceptor inspect` | Use `inspect --net-only` or `net log --filter <text>` |
| Work with iframes | `read --include-frames` | Act on framed refs like `e2_7` |
| Work with canvas | `canvas status`, `canvas log`, `canvas objects` | Use `canvas read`, `canvas model`, `canvas routes`, or experimental `canvas ocr` |
| Work with rich editors | `scene profile` | Use `scene list`, `scene click`, `scene text`, or slide commands |
| Control native apps | `interceptor macos open/read/act/inspect` | Use lower-level `macos click/type/keys` |
| Observe a human workflow | `monitor start --instruction "..."` | Export with `monitor export <sid> --plan` |

## Browser Workflow

Use `open` instead of manually combining tab creation, sleeps, tree reads, and text reads.

```bash
interceptor open https://example.com
interceptor open https://example.com --full
interceptor open https://example.com --tree-only
interceptor open https://example.com --text-only
interceptor open https://example.com --timeout 15000
```

Use `read` for current state. Use a ref to limit the read to a subtree.

```bash
interceptor read
interceptor read e12
interceptor read e12 --tree-only
interceptor read e12 --text-only
interceptor read --include-style
interceptor read --include-frames
interceptor read e2_7 --include-frames --tree-only
```

Use `find` to recover after stale refs or to avoid scanning a large tree manually.

```bash
interceptor find "Submit"
interceptor find "Email" --role textbox
```

Use `act` as the default interaction command. It resolves refs, performs the action, and reads after the action unless told not to.

```bash
interceptor act e7
interceptor act e9 "hello@example.com"
interceptor act e11 --keys "Enter"
interceptor act e15 --os
interceptor act e20 --no-read
```

Use low-level actions only when the compound `act` command does not expose the control you need.

```bash
interceptor click e7
interceptor type e9 "hello@example.com"
interceptor keys "Meta+K"
interceptor select e12 "Option label"
interceptor hover e3
interceptor drag e4 e8
interceptor dblclick e5
interceptor rightclick e5
```

## Reading Strategy

- Start with `read` or `open`, not a screenshot.
- Use `read --tree-only` when you need actionable refs.
- Use `read --text-only` or `text` when you only need prose.
- Use `read <ref>` when the relevant area is already identified.
- Use `read --include-frames` on pages with embedded apps, auth widgets, docs, dashboards, or cross-frame content.
- Use framed refs such as `e2_7` directly with `read` and `act`.
- Use `--full` when summaries omit details needed for the task.
- Re-read after every action that can rerender, navigate, submit, open a modal, or replace content.

## Inspection And Network

`inspect` is the default diagnostic command because it combines page structure, text, and passive network context.

```bash
interceptor inspect
interceptor inspect --net-only
interceptor inspect --filter api
```

Passive network capture is always preferable before debugger-based capture.

```bash
interceptor net log
interceptor net log --filter graphql
interceptor net log --since 30s
interceptor net log --limit 100
interceptor net headers
interceptor net headers --filter api
interceptor net clear
```

Use overrides only when the task requires controlled response or request mutation.

```bash
interceptor override "*api/search*" status=500
interceptor override "*api/search*" delay=1000
interceptor override clear
```

CDP network commands attach the browser debugger. Use them only when passive `net` and `inspect` are insufficient.

```bash
interceptor network on
interceptor network log
interceptor network override "*api*" status=500
interceptor network off
```

For server-sent events:

```bash
interceptor sse streams
interceptor sse log
interceptor sse tail
```

## Canvas Workflow

Canvas pages often hide meaningful state from the DOM. Start with observer-backed canvas commands before screenshots.

```bash
interceptor canvas list
interceptor canvas status
interceptor canvas log
interceptor canvas log 1
interceptor canvas log 1 --kind fillText
interceptor canvas objects
interceptor canvas objects 1
interceptor canvas objects 1 --kind text
interceptor canvas model
interceptor canvas routes
```

Use `canvas read` for pixels only when observer data is insufficient.

```bash
interceptor canvas read 1
interceptor canvas read 1 --format png
interceptor canvas read 1 --region 10,20,300,120
interceptor canvas read 1 --webgl
interceptor canvas diff 1
```

`canvas ocr` is experimental. Use it as a fallback, not as the primary truth source.

```bash
interceptor canvas ocr 1
interceptor canvas ocr 1 --region 10,20,300,120
```

Canvas indexes in `canvas log <N>` and `canvas objects <N>` are DOM canvas indexes and should scope observer results to that canvas.

## Scene Workflow

Scene commands are for rich editors and apps where DOM refs are not enough, including Canva, Google Docs, Google Slides, and similar canvas or editor surfaces. Run `scene profile` before guessing how to interact.

```bash
interceptor scene profile
interceptor scene profile --verbose
interceptor scene list
interceptor scene list --type text
interceptor scene hit 400 300
interceptor scene click <scene-ref>
interceptor scene dblclick <scene-ref>
interceptor scene select <scene-ref>
interceptor scene selected
interceptor scene text <scene-ref>
interceptor scene text <scene-ref> --with-html
interceptor scene insert "New text"
interceptor scene cursor-to <scene-ref>
```

For slide-like editors:

```bash
interceptor scene slide list
interceptor scene slide current
interceptor scene slide goto 3
interceptor scene notes
interceptor scene render
interceptor scene zoom 100
```

## Navigation And Tabs

Use navigation commands when preserving tab/session state matters.

```bash
interceptor navigate https://example.com
interceptor back
interceptor forward
interceptor scroll down
interceptor wait 1000
interceptor wait-stable
```

Tab commands normally operate within Interceptor's managed tab group.

```bash
interceptor tabs
interceptor tab new https://example.com
interceptor tab switch <tab-id>
interceptor tab close <tab-id>
interceptor window list
interceptor window new
```

Use `--tab <id>` when targeting a specific known tab. Use `--any-tab` only when the user explicitly authorizes acting outside managed tabs.

## Native macOS Workflow

Use macOS commands when the task requires a native application or OS-level interaction.

```bash
interceptor macos open "Safari"
interceptor macos read
interceptor macos act <ref>
interceptor macos act <ref> "typed text"
interceptor macos inspect
```

Use lower-level commands only when compound native commands are not enough.

```bash
interceptor macos apps
interceptor macos app activate "Brave Browser"
interceptor macos tree
interceptor macos find "Save"
interceptor macos click <ref>
interceptor macos type "text"
interceptor macos keys "Meta+S"
interceptor macos app move "Brave Browser" 0 0
interceptor macos app resize "Brave Browser" 1440 900
```

For installation validation, check both:

```bash
interceptor status
interceptor macos trust
```

`macos trust` reports permission state. `status` confirms daemon, bridge, helper, and native-host health.

## Monitor Workflow

Use monitor commands when learning or replaying a human workflow matters more than immediate one-off interaction.

```bash
interceptor monitor start --instruction "Watch how the user completes checkout"
interceptor monitor status
interceptor monitor list
interceptor monitor tail <sid>
interceptor monitor tail <sid> --raw
interceptor monitor pause <sid>
interceptor monitor resume <sid>
interceptor monitor stop <sid>
interceptor monitor export <sid>
interceptor monitor export <sid> --json
interceptor monitor export <sid> --plan
interceptor monitor export <sid> --with-bodies
```

## ChatGPT Bridge

Use ChatGPT bridge commands only when the task explicitly involves controlling ChatGPT through the browser session.

```bash
interceptor chatgpt status
interceptor chatgpt send "Prompt text"
interceptor chatgpt send "Prompt text" --stream
interceptor chatgpt read
interceptor chatgpt conversations
interceptor chatgpt switch <conversation-id>
interceptor chatgpt model
interceptor chatgpt stop
```

## Evaluation And Escape Hatches

Use built-in command surfaces first. Use `eval --main` only when there is no appropriate Interceptor command.

```bash
interceptor eval --main "document.title"
```

On strict-CSP sites, page-world evaluation may require Interceptor's automatic reload/retry fallback before code succeeds. Prefer purpose-built commands over page-world evaluation to reduce this risk.

Use screenshots only when the task depends on rendered pixels, visual layout, chart appearance, image content, or screenshot output.

The default `interceptor screenshot` is a DOM render and does NOT require the browser to be focused or visible — it works from a backgrounded Chrome on a different macOS Space. Use `--selector <css>` for a single element, `--region X,Y,W,H` for an arbitrary rect, `--element <ref>` for a refRegistry-tracked element. Use `--pixel` only when you need pixel-accurate compositor output (e.g., visual regression of compositor effects, hardware video frames); the `--pixel` path requires the browser window to be visible and focused. `--pixel --full` scrolls + stitches and is throttled to clear Chrome's `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` quota.

## Recovery Rules

- If a ref fails, run `read` or `find` again and retry with the new ref.
- If an iframe element is missing, rerun `read --include-frames`.
- If a canvas page has no DOM text, run `canvas status`, `canvas log`, and `canvas objects`.
- If a rich editor does not expose usable DOM refs, run `scene profile`.
- If an action appears to do nothing, run `inspect` before retrying blindly.
- If network behavior is unclear, run `inspect --net-only` or `net log --filter <term>`.
- If native app control fails, check `interceptor macos trust` before assuming the app is broken.
- If Interceptor itself is unavailable, use the CLI/native-host install route documented in repository scripts.

## Repository Maintenance

- Keep this file agent-facing. Do not turn it into marketing copy or a user onboarding guide.
- Keep command examples current with `cli/help.ts`.
- Update this file when adding, removing, or changing agent-facing CLI commands.
- `CLAUDE.md` is retained only as a compatibility file for tools that still look for that filename. `AGENTS.md` is the source of truth.
