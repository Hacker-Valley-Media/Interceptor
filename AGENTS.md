# Interceptor Agent Manual

Interceptor is an AI-agent control surface for the user's real browser and native macOS apps. It is not primarily a human CLI product. Treat this file as the operating manual for agents that need to inspect pages, act in browser sessions, observe network traffic, work with canvas or scene-based editors, and control native apps through the Interceptor CLI.

For user-facing overview material, see [README.md](README.md). For implementation details, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Install Modes

Interceptor ships in two install modes. Check yours with `interceptor status` and read the `mode:` line:

- **`mode: browser-only`** — CLI + daemon + extension. All browser commands work. `interceptor macos *` returns a structured "requires full computer-use install" error in under one second. Smallest footprint, no macOS TCC prompts (no Screen Recording / Accessibility / Apple Events).
- **`mode: full`** — Browser-only plus the Swift bridge `.app`, the LaunchAgent, and the macOS subcommands. Adds AX tree, OS-level input, ScreenCaptureKit capture, Vision / Speech / NLP. macOS only.

The `mode:` line reflects whichever distribution path the user took. Two distinct install channels feed into the same mode taxonomy:

| Install channel | How `mode:` lands |
|---|---|
| `Interceptor-Browser-<v>.pkg` (signed installer) | `mode: browser-only` |
| `Interceptor-Full-<v>.pkg` (signed installer) | `mode: full` |
| `bash scripts/install.sh --browser-only` (dev path) | `mode: browser-only` |
| `bash scripts/install.sh --full` (dev path) | `mode: full` |
| `interceptor upgrade --full` (promotion from any browser-only install) | `mode: full` |

Operating rules:
- Do not loop on the 15-second timeout. The `interceptor macos *` preflight short-circuits in browser-only mode with an actionable error — read it, do not retry.
- If the user asks for something native and `interceptor status` reports `mode: browser-only`, respond: "I'm on a browser-only install. Run `interceptor upgrade --full` (macOS only) to enable that command." Don't run the macos command anyway "to see what happens" — the preflight has already answered.
- The promotion command is `interceptor upgrade --full` (works for both pkg-installed and dev-installed browser-only). The downgrade command is `bash scripts/uninstall.sh --bridge-only` (or for pkg installs, `sudo bash "/Library/Application Support/Interceptor/uninstall.sh" --bridge-only`).
- `mode: unknown` (rare) means the bridge is alive but the LaunchAgent plist is missing. Surface the situation; do not paper over it.

## Core Rules

- Use `./dist/interceptor ...` when working inside this repository and the binary is not on `PATH`.
- Prefer compound commands first: `open`, `read`, `act`, and `inspect`.
- Prefer structured reads over screenshots unless the task is explicitly visual, pixel-based, or image-based.
- Use the user's existing browser/session state. Do not assume a clean profile, isolated browser, or synthetic automation profile unless the user asks for that.
- Use the CLI plus native-host route for setup, validation, and development.
- Do not default to debugging Interceptor itself unless the task is specifically about Interceptor.
- Use `--json` when another tool or script will consume the output.
- Treat `eN` and framed refs such as `e2_7` as short-lived: refs survive across calls as long as the underlying element stays connected to the document. They do **not** survive a navigation, a rerender that recreates the node, or a removal. They **do** survive a transient layout flicker (an ancestor briefly toggling `display`, a CSS transition, an offscreen scroll). If `act <ref>` returns "stale element", the element was removed from the DOM — not just hidden — re-run `read` or `find` to get a fresh ref. The `text:<query>` selector matches any visible element whose `textContent` contains the query, regardless of role; useful for clicking framework-style cards (`<div tabindex=0>...</div>`) where the role is not "button".
- Do not use `--any-tab` unless the user explicitly wants to operate outside Interceptor's tracked tab group.
- Prefer passive observation before invasive instrumentation. For network work, start with `inspect` or `net`, not CDP debugger attachment.
- For browser tasks, default to synthetic events (`act`, `click`, `type`, `keys`). The pre-load `userActivation` override + `__interceptor_trust` event marker handle most `isTrusted` and transient-activation gates. Reach for `--os` only when synthetic input is observed to fail; reach for `interceptor macos` only when the target is outside the page (native app, OS dialog, browser chrome).
- **Background first.** When the user names a specific app ("screenshot of Brave", "scroll Signal", "open a tab in Brave"), do the work without bringing that app to the foreground unless the task strictly requires focus. Never call `mac_app activate`, `osascript "tell application X to activate"`, or `mac_intent` payloads with `activate`/`reopen` verbs as a reflex. The bridge captures occluded windows via `CGSHWCaptureWindowList`; sets the AX tree via `AXManualAccessibility` wake-up; routes scroll wheels via `CGEvent.postToPid`; and drives Apple Events to apps without raising them. Respect the user's current focused window. Only escalate to a brief raise — or honor an explicit "bring it to front" — when the user asks, or when the operation provably cannot complete in the background (e.g. Chromium-occluded input event delivery).

## Background First

When the target is a specific app, prefer staying invisible to the user. The user's focused window must not change unless they ask for it.

| Operation | Background path (preferred) | When you must escalate |
|---|---|---|
| Screenshot of an app's window | `mac_screenshot --app "X"` (CGS path captures occluded / minimized / cross-Space) | `--mode display` only when the user wants the whole screen |
| List / read a Chrome / Brave tab | Apple Events: `mac_intent dispatch --bundle <id> --script 'tell ... get URL of active tab'` | Only if AppleScript is disabled in the target app |
| Open a URL in a specific browser | Apple Events: `mac_intent dispatch --bundle com.brave.Browser --script 'open location "https://…"'` (no `activate`) | Only if the user explicitly asks for the browser to come forward |
| Read a backgrounded Electron app's UI | `mac_tree --app "X"` (auto-fires `AXManualAccessibility` wake-up) | App that gates AX on visibility (Signal): brief-raise + restore focus |
| Scroll a backgrounded app | `mac_scroll <dir> <amount> --app "X"` (routes via `postToPid`) | Chromium-occluded apps that pause their event loop: brief-raise |
| Drive a native Cocoa app | AX `mac_act/click/type` against the target's PID without `activate` | OS-level `--os` modifier only if synthetic input fails |
| Read text / selection from another app | `mac_text` against the target — no focus change | (no escalation needed) |

**Reflexes to drop:**
- Do NOT call `mac_app activate` before screenshotting or reading. SCK + CGS work on offscreen windows.
- Do NOT add `activate` to AppleScript blocks unless the user asked the app to come forward.
- Do NOT bring a window forward "to be safe" — the bridge's CGS / AX paths are designed to work without it.
- Do NOT use `--mode display` for app-specific captures — it captures the visible composite (which has the wrong app on top).

**When the user explicitly says "bring it forward" / "show me X" / "switch to X":** respect that. Use `mac_app activate "X"` once, do the operation, and unless the user asked you to leave it there, restore the previous frontmost via `_SLPSSetFrontProcessWithOptions` (TODO: surface as `mac_app activate-and-restore`).

## Browser Extension vs macOS Bridge

Both surfaces overlap on some tasks. Pick by the strength matrix below; lean into whatever the user asked for specifically.

| Task | Browser extension | macOS bridge | Why |
|---|---|---|---|
| Click a link / fill a form on a page | ✅ default | ❌ | The extension is *inside* the page — cheap synthetic events, semantic selectors, no focus change |
| Read DOM / SPA network traffic | ✅ default | ❌ | `interceptor inspect`, `net log`, `scene` — built for this |
| Tab management visible to the page (cookies, storage, history) | ✅ default | ❌ | `chrome.tabs.*` extension surface |
| Open a URL in a *specific* browser the user named | ⚠️ only if that browser already has the extension | ✅ Apple Events | Extension can't switch browsers; bridge can address Brave/Chrome by bundle id without focus change |
| Screenshot a *specific* app window (browser or other) | ⚠️ if browser tab | ✅ `mac_screenshot --app` | Bridge captures any window via CGS even when minimized, cross-Space, or occluded |
| Native dialogs (Save / Open / file picker / system sheets) | ❌ extension cannot see | ✅ AX tree | These live outside the page DOM |
| Browser chrome (URL bar, bookmark menu, profile picker) | ❌ | ✅ AX tree | Outside DOM |
| Cross-app routing (copy from PDF in Preview → Slack) | ❌ | ✅ | Bridge addresses each app individually |
| Drive a non-browser app (Notes, Mail, Music, Cursor) | ❌ | ✅ default | Native AX + Apple Events |
| Drive an *occluded* Electron app (Signal, Slack while hidden) | ❌ | ✅ for capture, ⚠️ for input (Chromium event-loop pause) | CGS captures invisibly; Chromium-paused input requires brief-raise |
| Visual overlays / HUDs over content | ⚠️ DOM-only, in-page | ✅ `mac_overlay` (transparent NSPanel above compositor) | Only the bridge can render above all apps |
| OS-level keyboard / mouse delivery to specific PID | ❌ | ✅ `--os` / `postToPid` | OS-level CGEvent |

**Defaults when in doubt:**
- Page content → extension (`open`, `read`, `act`, `inspect`, `scene`, `net`, `eval --main`)
- Anything outside the page → bridge (`interceptor macos *`)
- App-level operation on a backgrounded app → bridge in background (do not activate)
- The user's words always win — if they say "open this in Brave" they mean *that* browser; if they say "leave my window alone" they mean don't activate

## Input Layer Priority

| Layer | Use For | Avoid For |
|---|---|---|
| **Synthetic** (`act`, `click`, `type`, `keys`, dispatched events via `eval --main` with `event.__interceptor_trust = true`) | DEFAULT for all browser content. Rich-editor typing, canvas pan/zoom/click, design-tool layer-row select + bulk export trigger, form fills, button clicks, keyboard shortcuts to focused inputs. | Native macOS apps; OS-mediated dialogs that escape the page. |
| **`--os`** (CGEvent on macOS) | ESCALATION ONLY when synthetic is proven not enough — sites with anti-automation that checks beyond `event.isTrusted` (some banking/payment gateways), IME composition input, sites that ignore prototype `isTrusted` overrides because they cache the per-instance own property at boot. | Default browser interaction — the pre-load `userActivation` override (`extension/src/inject-net.ts`) already satisfies the activation gate that historically forced `--os`. |
| **`interceptor macos`** | Native macOS apps (Finder, Mail, terminal). Browser chrome (URL bar, app menu, system Save/Open dialogs). System notifications. Cross-app workflows. | Content inside a browser page — go through the synthetic layer instead. |
| **`eval --main`** (with the `__interceptor_trust` marker on dispatched events) | Canvas-rendered surfaces (Docs/Slides/Sheets cell-precise input, WebGL viewer pan/zoom, design-tool layer click + button trigger), client-side blob export capture, monkey-patching for protocol sniffing (WebSocket, sendBeacon, BroadcastChannel). | Tasks that a built-in compound command already covers — prefer named commands first. |

The historical reflex of "site checks `isTrusted` → use `--os`" is no longer correct on most sites. `userActivation.isActive` reads `true` because the pre-load override forces it; dispatched events tagged with `__interceptor_trust` satisfy the per-event check on sites that read `isTrusted` via the prototype. Try synthetic first.

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

---

# Surface 1: Interceptor Browser

The sections below cover the Browser surface (`interceptor` with no prefix). For native macOS, jump to [Surface 2: Interceptor macOS](#surface-2-interceptor-macos). The skill package for this surface lives at `.agents/skills/interceptor-browser/`.

## Browser Workflow

Use `open` instead of manually combining tab creation, sleeps, tree reads, and text reads.

```bash
interceptor open https://example.com
interceptor open https://example.com --full
interceptor open https://example.com --tree-only
interceptor open https://example.com --text-only
interceptor open https://example.com --timeout 15000
interceptor open https://example.com --reuse        # Long automation: navigate the most recent Interceptor-group tab instead of opening a new one
```

For long-running automation that calls `open` many times in a single session — verification loops, batch inspections, repeated probes against the same surface — pass `--reuse` so each call navigates the same managed tab instead of leaving a dead tab behind. Without `--reuse`, every `open` creates a new tab and the browser fills with stale tabs over the course of a session. `--reuse` is opt-in to preserve existing scripts that depend on a fresh tab per call; it falls back to creating a new tab when the Interceptor group is empty or the candidate tab vanishes between query and navigation.

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
interceptor act e15 --os                 # FALLBACK ONLY — try without --os first; the pre-load userActivation override usually makes it unnecessary
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

### Canvas-Rendered Editor Input (Google Docs / Slides / Sheets)

When `scene insert` is not enough — e.g. cell-precise writes into a Docs table, paragraph style changes, keyboard shortcuts to surfaces with no scene equivalent — use the pre-load trust override path. Inject script `inject-net.js` (loaded at `document_start` in MAIN world) installs a `navigator.userActivation.{isActive,hasBeenActive}` override that always reports `true`, satisfying transient-activation gates so dispatched `MouseEvent` and `KeyboardEvent` propagate as if from real user input.

Pattern (run via `interceptor eval --main`):

1. **Caret positioning:** dispatch `mousedown`/`mouseup`/`click` on `.kix-canvas-tile-content` with `event.__interceptor_trust = true` and target pixel — this moves the canvas-side caret. Verify by reading `iwin.getSelection().anchorNode` parent chain for the `<TD>`.
2. **Text entry:** construct `KeyboardEvent` from the iframe's OWN window (`new iwin.KeyboardEvent(...)`), dispatch on the iframe document (`idoc.dispatchEvent(ev)`).
3. **Printable keys** (letters, digits, symbols, Space, Enter): full `keydown` → `keypress` → `keyup`.
4. **Navigation/control keys** (Tab, Arrow*, Home, End, Escape, Backspace, Delete, modifiers): `keydown` → `keyup` ONLY — never `keypress`. Dispatching `keypress` on a navigation key inserts its ASCII character (Tab=`\t`, ArrowUp=`&`, ArrowLeft=`%`, ArrowRight=`'`).

Trap: in Docs tables, **Tab past the last cell of the last row creates a new row.** Fill row N with N writes and N-1 Tabs; exit the table with `ArrowDown`.

For full reference + companion patterns (paragraph style change via `Cmd+Option+1`, recovery from stray character inserts), see [`use-cases/interaction-skills/canvas-rendered-editor-input.md`](use-cases/interaction-skills/canvas-rendered-editor-input.md) and [`use-cases/domain-skills/google-docs/fill-empty-table-cells.md`](use-cases/domain-skills/google-docs/fill-empty-table-cells.md).

### Canvas Camera Apps (WebGL viewers)

The same `userActivation` override + `__interceptor_trust` pattern drives WebGL camera apps. Pan via dispatched `MouseEvent` (mousedown → mousemove sweep → mouseup) on the canvas; zoom via `WheelEvent { deltaY: ±120 }` or `Minus`/`Equal` keystrokes. Anchor DOM overlays to lat/lng with a Web Mercator projection helper (`pixels per deg lng = 256 * 2^zoom / 360`) and refresh them on every URL change. Restyle the rendered viewport via CSS `filter` on the canvas element.

For the full mechanic (projection helper, URL-watcher, disposable handler pattern, antimeridian wrap), see [`use-cases/interaction-skills/canvas-camera-overlays.md`](use-cases/interaction-skills/canvas-camera-overlays.md) and [`use-cases/interaction-skills/webgl-camera-control.md`](use-cases/interaction-skills/webgl-camera-control.md).

### Native Export Capture (any client-side-rendering app)

Modern editor webapps render exports client-side (WebGL/Canvas2D → `Blob` → `URL.createObjectURL` → `<a download>.click()`). To capture the resulting bytes without ever showing the user a Save dialog or hitting the OS clipboard:

1. **Patch `URL.createObjectURL`** in MAIN world to record every blob the app stages — gives you the URL the moment it's created.
2. **Patch `HTMLAnchorElement.prototype.click`** to swallow programmatic auto-downloads (only suppresses anchors with a `download` attribute or `blob:` href; real user clicks elsewhere still work).
3. **`fetch(blobUrl).then(r => r.arrayBuffer())`** to read the bytes before the app revokes the URL.

This works on any app whose export pipeline goes through a blob. For a worked end-to-end recipe (frame enumeration, per-frame export trigger, blob extraction loop), see [`use-cases/interaction-skills/blob-export-capture.md`](use-cases/interaction-skills/blob-export-capture.md).

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

---

# Surface 2: Interceptor macOS

The sections below cover the macOS surface (`interceptor macos *`). For Browser, see [Surface 1: Interceptor Browser](#surface-1-interceptor-browser) above. The skill package for this surface lives at `.agents/skills/interceptor-macos/`.

`.agents/skills/interceptor-windows/` is reserved for a future Windows surface (UIA, Win32 input, ETW). Do not stub it; do not add `interceptor windows` commands to the CLI. The reservation is documentation-only until Windows actually ships.

## Native macOS Workflow

Use macOS commands when the target is a native macOS application (Finder, Mail, terminal), an OS-level dialog (Save/Open file picker, system sheet), browser chrome (URL bar, app menu, system notifications), or a cross-app workflow. **Do not default to `interceptor macos` for content inside a regular browser page** — go through the synthetic-event layer (`act`, `click`, `type`, or `eval --main` with the `__interceptor_trust` marker) first; see Input Layer Priority above.

**Stay in the background unless the user asks otherwise.** The bridge's capture / AX / Apple-Events / scroll paths all work without bringing the target app forward. See [Background First](#background-first) above for the full table.

```bash
# Background-friendly compound commands (no `activate`, no focus change)
interceptor macos read --app "Mail"                  # AX tree of Mail while another app stays focused
interceptor macos screenshot --app "Brave Browser"   # CGS captures Brave's window even if occluded
interceptor macos act <ref>                          # AX action against a backgrounded app via its ref

# Focus-changing — only when the user asks for it
interceptor macos open "Safari"                      # NOTE: `open` activates the app; use sparingly
interceptor macos app activate "Brave Browser"       # Foreground change — only when the user asks
```

Use lower-level commands only when compound native commands are not enough.

```bash
interceptor macos apps                          # List running apps + bundle ids (no focus change)
interceptor macos windows --app "Brave Browser" # SCShareableContent + AX windows for Brave
interceptor macos tree --app "X"                # AX tree (auto-wakes Electron AX) — no focus change
interceptor macos find "Save" --app "X"         # Search Brave's AX tree without raising it
interceptor macos click <ref>                   # AX press — does not require app to be frontmost
interceptor macos type "text"                   # Goes to currently focused field (in any app)
interceptor macos keys "Meta+S"                 # Goes to focused window — be careful which window has focus
interceptor macos scroll up 400 --app "Brave Browser" --times 5    # postToPid scroll, no focus change
interceptor macos intent dispatch --bundle com.brave.Browser \
  --script 'tell application id "com.brave.Browser" to make new tab at end of tabs of front window'
                                                # Apple Events — opens a tab in Brave WITHOUT activating it
interceptor macos app move "Brave Browser" 0 0  # Move/resize via AX — does not need to be frontmost
interceptor macos app resize "Brave Browser" 1440 900
```

**Background examples (do these, not the activate-then-act pattern):**

```bash
# "Take a screenshot of Brave"
interceptor macos screenshot --app "Brave Browser" --save --target-max-long-edge 1568

# "What URL is open in Brave?"
interceptor macos intent dispatch --bundle com.brave.Browser \
  --script 'tell application "Brave Browser" to URL of active tab of front window'

# "Open a new tab in Brave to https://example.com"
interceptor macos intent dispatch --bundle com.brave.Browser \
  --script 'tell application "Brave Browser" to tell front window to make new tab with properties {URL:"https://example.com"}'

# "Scroll Mail down 5 times"
interceptor macos scroll down 400 --app "Mail" --times 5 --interval-ms 80

# "Read the AX tree of Cursor"  (Electron — wake-up handled automatically)
interceptor macos tree --app "Cursor" --filter interactive --depth 6
```

None of those touch the user's focused window.

For installation validation, check both:

```bash
interceptor status
interceptor macos trust
```

`macos trust` reports permission state. `status` confirms daemon, bridge, helper, and native-host health.

---

# Shared Across Surfaces

The sections below apply to both surfaces (or contain commands available on both). The macOS monitor commands mirror the browser monitor commands with the `macos` prefix; eval/screenshots/data/storage commands without a `macos` prefix operate on the Browser surface; `batch` / `raw` accept either surface's actions; recovery rules cover both.

## Monitor Workflow

Use monitor commands when learning or replaying a human workflow matters more than immediate one-off interaction. The Browser surface uses `interceptor monitor *`; the macOS surface uses `interceptor macos monitor *`. Same sparse-JSON shape and same `--plan` export, different event source (DOM events vs AX events).

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

## Evaluation And Escape Hatches

Use built-in command surfaces first. Use `eval --main` only when there is no appropriate Interceptor command.

```bash
interceptor eval --main "document.title"
```

On strict-CSP sites, page-world evaluation may require Interceptor's automatic reload/retry fallback before code succeeds. Prefer purpose-built commands over page-world evaluation to reduce this risk.

Screenshots are a **last-resort** read surface. Use `read`, `text`, `inspect`, `scene text`, `canvas log`, or `macos tree` first — they cost ~10× fewer tokens per turn and survive DOM churn better than pixels. Only reach for a screenshot when pixels are the answer: explicit visual evidence is requested, a layout / color / chart issue cannot be confirmed structurally, or a specific render artifact must be captured. In editors, prefer `scene render` or `canvas read` before a page screenshot.

When you must take a screenshot, use the **agent-default recipe** unless the task specifically needs higher fidelity:

```bash
interceptor screenshot --save --format webp --target-max-long-edge 1568 --quality 85
```

This produces a small WebP on disk (~50–100 KB for a typical full page) and a path-only response in your tool output. The recipe respects every major vendor's auto-resize ceiling (Sonnet 1568 px, Opus 2576 px, OpenAI normalize-to-2048-then-768) so you pay zero tokens for pixels the model would discard anyway.

Flag reference:

- `--target-max-long-edge <px>` — clamp the rasterized canvas long edge to N pixels. Defaults to no clamp (legacy DPR behavior). Use `1568` for a safe Sonnet-aligned default; raise to `2576` only when the consumer is Opus or higher-fidelity is required. Applies to both DOM-render and `--pixel` paths.
- `--format webp` — re-encode at the SW boundary via OffscreenCanvas. ~5–8× smaller than PNG at q=85 with no measurable VLM accuracy loss. Falls back to PNG for archive use cases. Default quality for WebP is 85; PNG/JPEG default to 92.
- `--save` — write the bytes to disk in the CLI's CWD and **strip `dataUrl` from the result**. The structured stdout returns `{ filePath, format, size, width, height, mode }` instead of an inline base64 payload. Use this whenever you don't need to re-attach the image immediately — the path can be read back when needed and never bloats your context window.
- `--selector <css>` — capture a single matching element. Off-screen elements supported.
- `--element <ref>` — capture a refRegistry-tracked element (`e5`, `e2_7`).
- `--region X,Y,W,H` — capture an arbitrary page rectangle.
- `--scale <n>` — override pixel ratio. `--target-max-long-edge` wins when both set.
- `--pixel` — pixel-true compositor capture via `chrome.tabs.captureVisibleTab`. Requires the browser window visible and focused. Use only when DOM-render fidelity is insufficient (compositor effects, hardware video frames, chrome itself).
- `--pixel --full` — scroll-and-stitch full page. Throttled to clear Chrome's 2/sec `captureVisibleTab` quota; expect ~1.1s per viewport strip.

Default DOM-render works from a backgrounded Chrome on a different macOS Space — no focus required.

## Data, Storage, History, Bookmarks

Use these for task-relevant state that lives outside the DOM. They are cheap reads — prefer them over inspecting the page when the answer lives in cookies, localStorage, or browsing history.

```bash
interceptor cookies example.com                         # List cookies for a domain
interceptor cookies set '{"url":"https://example.com","name":"sid","value":"..."}'
interceptor cookies delete https://example.com sid

interceptor storage <key>                               # Read a localStorage key
interceptor storage set <key> <value>                   # Write a localStorage entry
interceptor storage delete <key>                        # Remove a localStorage entry
interceptor storage <key> --session                     # Operate on sessionStorage instead

interceptor history "search term"                       # Search browser history
interceptor bookmarks "query"                           # Search bookmarks
interceptor bookmarks tree                              # Full bookmark tree
```

Use the headers surface for tab-scoped request-header rewrites:

```bash
interceptor headers add x-debug 1                       # Append a request header rule
interceptor headers remove x-debug                      # Remove a previously-added rule
interceptor headers clear                               # Clear all header rules
```

## Batch, Raw, And Capabilities

Use `batch` when several actions must run in a single round-trip without intermediate reads.

```bash
interceptor batch '[{"type":"click","ref":"e5"},{"type":"wait","ms":500},{"type":"extract_text"}]'
interceptor batch '<json>' --stop-on-error
interceptor batch '<json>' --timeout 30000
```

Use `raw` to send any action verbatim when no compound or low-level command exposes the shape you need. Prefer named commands first.

```bash
interceptor raw '{"type":"any_action","key":"value"}'
```

Use `capabilities` to discover which input layers are available (synthetic, OS, native bridge). For browser tasks the default is the synthetic layer (`act` and friends), backed by the pre-load `userActivation` override and the `__interceptor_trust` event marker — see Input Layer Priority. `--os` is a fallback for the rare site that defeats synthetic input; `macos` is for non-browser targets. Use `reload` after extension changes during local development.

```bash
interceptor capabilities
interceptor reload
```

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
