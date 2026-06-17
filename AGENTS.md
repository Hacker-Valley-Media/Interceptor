# Interceptor Agent Manual

Agent operating manual for the `interceptor` CLI: drive a real browser session and native macOS apps. For user-facing overview see [README.md](README.md). For implementation details see [ARCHITECTURE.md](ARCHITECTURE.md). For deep references, command catalogs, and per-task workflows, see [`.agents/skills/interceptor-browser/`](.agents/skills/interceptor-browser/) and [`.agents/skills/interceptor-macos/`](.agents/skills/interceptor-macos/). For deep web research — investigating a topic across many sources with breadth + verification — see [`.agents/skills/interceptor-research/`](.agents/skills/interceptor-research/) or run `interceptor research` for the playbook.

## Install Modes

Two install modes, same CLI binary. Check yours with `interceptor status` and read the `mode:` line:

- **`mode: browser-only`** — CLI + daemon + extension. All browser commands work. `interceptor macos *` returns a structured "requires full computer-use install" error in under one second. Smallest footprint; no macOS TCC prompts.
- **`mode: full`** — Browser-only plus the Swift bridge `.app`, the LaunchAgent, and the macOS subcommands. Adds AX tree, OS-level input, ScreenCaptureKit, Vision / Speech / NLP. macOS only.

| Install channel | How `mode:` lands |
|---|---|
| `Interceptor-Browser-<v>.pkg` (signed installer) | `mode: browser-only` |
| `Interceptor-Full-<v>.pkg` (signed installer) | `mode: full` |
| `bash scripts/install.sh --browser-only` (dev path) | `mode: browser-only` |
| `bash scripts/install.sh --full` (dev path) | `mode: full` |
| `interceptor upgrade --full` (promote any browser-only install) | `mode: full` |

Operating rules:
- The `interceptor macos *` preflight short-circuits in browser-only mode with an actionable error. Read it. Do not loop on the 15-second timeout.
- If the user asks for something native and `interceptor status` reports `mode: browser-only`, respond: "I'm on a browser-only install. Run `interceptor upgrade --full` to enable that command." Don't run the macos command anyway "to see what happens."
- Downgrade: `bash scripts/uninstall.sh --bridge-only` (or for pkg installs, `sudo bash "/Library/Application Support/Interceptor/uninstall.sh" --bridge-only`).

## Core Rules

- Use `./dist/interceptor ...` inside this repo when the binary isn't on `PATH`.
- Prefer compound commands (`open`, `read`, `act`, `inspect`) over low-level verbs.
- Prefer structured reads (DOM tree, AX tree, scene graph) over screenshots — see `.agents/skills/interceptor-browser/references/screenshot-policy.md` for budgets and the agent-default recipe.
- Use the user's existing browser session. No clean profiles, no isolated automation contexts, no synthetic fingerprint profile unless the user asks for that.
- When multiple browser profiles are connected, use `interceptor contexts` to list available context IDs and `--context <id>` to route a command to the right profile. Without `--context`, browser commands only auto-route when exactly one context is connected; zero or multiple contexts fail fast.
- **Output is plain text by default** — that is the format the LLM consumes. Use `--json` only when piping into a script or another tool that needs a machine-parseable contract. Do not default to `--json` for your own context; structured JSON costs more tokens and reduces model comprehension on prose-trained models.
- `eN` and framed refs like `e2_7` are short-lived. They survive transient layout flicker (CSS transitions, scroll, an ancestor briefly toggling `display`) but **not** navigation, rerender that recreates the node, or removal. If `act <ref>` returns "stale element," the element was removed from the DOM — re-run `read` or `find` for a fresh ref.
- Prefer passive observation before invasive instrumentation. For network work, start with `inspect` or `net`, not CDP debugger attach. (This rule governs the **browser** surface — driving the user's real Chrome/Brave, where zero-CDP fingerprint matters. The `interceptor macos cdp` surface is CDP-native *by design*: it drives your own Electron/Chromium apps, where there is no anti-bot adversary. See `.agents/skills/interceptor-macos/references/cdp-app.md`.)
- Do not use `--any-tab` unless the user explicitly authorizes operating outside Interceptor's tracked tab group.

## Background First (Browser + macOS)

The whole product is **background-first by contract.** Both surfaces share the same rule: routine work never moves the user's focus; focus changes only happen on explicitly named opt-in verbs.

**Browser surface:** `interceptor open <url>` and `interceptor tab new <url>` create tabs in the background by default. The user's currently-active tab stays active. The only verbs that move the active tab or focused window are: `open --activate`, `tab new --activate`, `tab switch <id>`, and `window focus <id>`. The reuse path (`open --reuse`) preserves the reused tab's current focus state — call `open --reuse --activate` to also foreground it. Every other browser verb (`click`, `type`, `read`, `tree`, `text`, `inspect`, `screenshot`, `net`, `cookies`, `scroll`, etc.) operates on the target tab without disturbing the user's active tab.

**macOS surface:** Only two commands move focus: `interceptor macos app activate <app>` and `interceptor macos open <app> --activate`. Everything else stays invisible — `open` (without `--activate`), all input verbs (`click`, `type`, `keys`, `drag`, `scroll`), all reads, capture, AX, menu, intent dispatch, vision, and overlays. If you call any other command and the user's frontmost app changes, that is a bug — file it.

When the user names a specific app ("screenshot of Brave", "scroll Signal", "open a tab in Brave"), do the work without bringing it forward unless the task strictly requires focus. Never reach for `app activate`, never insert `activate` into AppleScript blocks, never `--mode display`-screenshot a backgrounded app's window. The bridge's CGS capture / AX read / Apple Events / `postToPid` scroll paths all work without focus change.

When the user explicitly says "bring it forward / show me / switch to X": respect that. Activate, do the work, restore previous frontmost if asked.

Full contract + verb inventory + worked examples + pitfalls: [`.agents/skills/interceptor-macos/references/background-first.md`](.agents/skills/interceptor-macos/references/background-first.md).

## Surface Decision

| Task | Surface |
|---|---|
| Page content (DOM, network, scene graph, browser monitor, screenshot of current tab) | `interceptor-browser` |
| Native apps, OS dialogs, browser chrome (URL bar, menus), occluded/minimized windows, cross-app routing | `interceptor-macos` |
| **Electron / Chromium desktop apps** (Slack, VS Code, Descript, …): read DOM, run JS, capture network, screenshot *inside the app's web content* | `interceptor macos cdp` / `interceptor macos cdp app` |
| **Native app runtime internals** (AppKit/SwiftUI): read the live view/object graph, run selectors, **rewrite rendered text**, intercept/redirect — via an injected in-process agent (no Frida, no SIP-off) | `interceptor macos runtime` |
| Deep web research: investigate a topic across many sources (planner loop, source ledger, verification) | `interceptor-research` (run `interceptor research`) |
| User said "open in Brave / Mail / X" (any specific named app) | `interceptor-macos` (Apple Events) |
| Visual overlays / HUDs above all apps | `interceptor-macos` (overlay via NSPanel above compositor) |

**The user's words win.** "Open in Brave" = *that* browser. "Don't bring it up" = stay in the background. "Show me X" = focus is OK. Defaults:

- Page content → browser extension (`open`, `read`, `act`, `inspect`, `scene`, `net`, `eval --main`)
- Anything outside the page → macOS bridge (`interceptor macos *`)
- App-level operation on a backgrounded app → macOS bridge in background mode (do not activate)

## Input Layer Priority (browser)

| Layer | Use For | Avoid For |
|---|---|---|
| **Synthetic** (`act`, `click`, `type`, `keys`, dispatched events via `eval --main` with `event.__interceptor_trust = true`) | DEFAULT for all browser content. Rich-editor typing, canvas pan/zoom/click, design-tool layer select, form fills, button clicks. | Native macOS apps; OS-mediated dialogs that escape the page. |
| **`--os`** (CGEvent) | ESCALATION ONLY when synthetic is proven not enough — sites with anti-automation that checks beyond `event.isTrusted`, IME composition, OS dialogs. | Default browser interaction — the pre-load `userActivation` override already satisfies the activation gate. |
| **`interceptor macos`** | Native macOS apps. Browser chrome (URL bar, menu, Save/Open dialog). System notifications. Cross-app workflows. | Content inside a browser page — synthetic layer instead. |
| **`eval --main`** (with `__interceptor_trust` marker on dispatched events) | Canvas-rendered surfaces (Docs/Slides/Sheets cell input, WebGL pan/zoom, design-tool exports), monkey-patching for protocol sniffing. | Tasks a built-in compound command already covers — prefer named commands first. |

The historical reflex of "site checks `isTrusted` → use `--os`" is no longer correct on most sites. `userActivation.isActive` reads `true` because the pre-load override forces it; dispatched events tagged with `__interceptor_trust` satisfy the per-event check on sites that read `isTrusted` via the prototype. Try synthetic first.

Deep mechanic notes (the `userActivation` override + `__interceptor_trust` marker, canvas-rendered editor input, blob export capture): [`.agents/skills/interceptor-browser/references/rich-editors.md`](.agents/skills/interceptor-browser/references/rich-editors.md).

## Recovery Reflexes

- Stale ref → `read` or `find` again.
- Missing iframe element → `read --include-frames`.
- Canvas page has no DOM text → `canvas status`, `canvas log`, `canvas objects`.
- Rich editor exposes no usable DOM refs → `scene profile`.
- Action did nothing → `inspect` before retrying.
- Network behavior unclear → `inspect --net-only` or `net log --filter <term>`.
- Native control failed → `interceptor macos trust` to check permissions.
- Interceptor itself unavailable → see install routes in repository scripts.

## Repository Maintenance

- This file is agent-facing. Keep it rule-shaped. No internal planning IDs, no command catalogs, no deep mechanic explanations.
- Per-task procedures live in `.agents/skills/*/workflows/`. Reference content lives in `.agents/skills/*/references/`. Not here.
- Update this file when an agent-facing **rule** changes, not when a CLI command is added or renamed (that's a `references/command-catalog.md` change).
- Conventions for skills, frontmatter, sizes, and names are codified in `.agents/rules/README.md` and enforced in review.
