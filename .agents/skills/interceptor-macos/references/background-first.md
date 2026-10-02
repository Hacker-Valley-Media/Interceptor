# Background-First Contract

Full contract, verb inventory, recipes, reflexes-to-drop, and pitfalls for the macOS surface's background-first default. Reference doc — load when you need to remember which verbs are background-safe, why `AXEnhancedUserInterface` was removed, or what the routing tags mean.

## The One Rule

**Only two commands are allowed to move focus:**

1. `interceptor macos app activate <app>`
2. `interceptor macos open <app> --activate`

Everything else is background-first by contract — including `open` without `--activate`, all input verbs, all reads, capture, AX, menu, intent dispatch, scroll, drag, vision, and overlays. If you call any other command and the user's frontmost app changes, that is a bug — file it.

## The user is on this Mac too

Assume the person is working on this Mac while you work. The two focus commands are for the user's request ("bring it forward", "show me"), not for your convenience. Never run one to make a step easier, to "be safe", or to test something.

Before a focus move, go down this list and stop at the first rung that works:

1. A ref (`act`, `click <ref>`, `type <ref>`): pure accessibility, no events.
2. Addressed input: `--app` / `--pid`, plus `--window <id>` when the app has several windows.
3. For a page in a browser: `interceptor click <ref> --trusted` (delivered to an unfocused window), and `interceptor window new` to give your tabs their own background window.
4. Only then a focus move. Say so first, keep it to one fast batch, and put back the frontmost app and the cursor.

What is truly foreground-only today:

- **Launching an app that is not running.** It can come forward even from `open` without `--activate`, and an app with a pending update can raise a password prompt. Never launch an app to test or to look around.
- **Click or drag on a minimized window or a hidden app.** There are no pixels to hit. The verb refuses with `(nothing was delivered)`.
- **Chrome with a fully covered window** can pause the page. Brave and Electron apps do not.

## When the user names a specific app

When the user says "screenshot of Brave", "scroll Signal", "open a tab in Brave" — do the work **without bringing it to the foreground unless the task strictly requires it.**

| Operation | Background path | When you must escalate |
|---|---|---|
| Screenshot of an app's window | `interceptor macos screenshot --app "X"` — `CGSHWCaptureWindowList` captures occluded / minimized / cross-Space | `--mode display` only when the user wants the whole screen |
| List / read a Chrome / Brave tab | Apple Events: `interceptor macos intent dispatch --bundle <id> --script 'tell ... get URL of active tab'` | Only if AppleScript is disabled in the target app |
| Open a URL in a specific browser | Apple Events: `interceptor macos intent dispatch --bundle com.brave.Browser --script 'open location "..."'` (no `activate`) | Only if the user explicitly asks for the browser to come forward |
| Read a backgrounded Electron app's UI | `interceptor macos tree --app "X"` (auto-fires `AXManualAccessibility` wake-up). Read twice: the first read can return only the menu bar while the app builds its tree | (no escalation needed; Signal reads in the background and while hidden) |
| Scroll a backgrounded app | `interceptor macos scroll <dir> <amount> --app "X" [--ref <ref>]` (stamped for the window, at the ref or the window center) | Chrome with the window fully covered: tell the user it needs to be partly uncovered; do not raise it |
| Click or drag in a backgrounded app | `interceptor macos click X,Y --app "X"` / `drag X1,Y1 X2,Y2 --app "X"`; add `--window <id>` when another window of that app covers the point | Minimized window or hidden app: the verb refuses. Unminimizing takes focus, so say so first |
| Drive a native Cocoa app | AX `interceptor macos act/click/type` against the target's PID without `activate` | (no escalation needed; a bare `--os` call goes to the frontmost app, so it is only for a target the user already has in front) |
| Trusted click or typing in a browser page | `interceptor click <ref> --trusted` / `type <ref> "..." --trusted` / `keys ... --trusted`: delivered to the tab's window while it is unfocused or covered | Tab is not the active tab of its window: `interceptor window new`, then `tab switch <id>` in that window |
| Read text / selection from another app | `interceptor macos text` against the target — no focus change | (no escalation needed) |
| Move / resize a window in the background | `interceptor macos move/resize <ref> --app "X"` returns `{frame, requested, clamped, clampedTo}` | (no escalation needed; refs churn after geometry — refresh from `windows`) |

## Reflexes to drop

- **Do NOT** call `interceptor macos app activate` before screenshotting or reading. SCK + CGS work on offscreen windows.
- **Do NOT** add `activate` to AppleScript blocks unless the user asked the app to come forward.
- **Do NOT** bring a window forward "to be safe" — the bridge's CGS / AX paths are designed to work without it.
- **Do NOT** activate an app, focus a window, or switch the user's tab to validate your own work. Find a background check, or say it was not checked.
- **Do NOT** launch an app that is not running just to test against it.
- **Do NOT** use `--mode display` for app-specific captures — it captures the visible composite (which has the wrong app on top).
- **Do NOT** set `AXEnhancedUserInterface = true` from a background-first reader. That's the "VoiceOver is active" flag and AppKit apps raise their main window in response.

## When the user explicitly says "bring it forward"

Respect that. This section is for the user's request only, never for your own convenience. Capture the current frontmost first, activate the target, do the operation, then — unless the user asked you to leave it there — restore the previous frontmost:

```bash
PREV=$(interceptor macos frontmost --json | jq -r '.bundleId')
interceptor macos app activate "Target"
# ...do the work that needed focus...
interceptor macos app activate "$PREV"
```

## `open` running-vs-not-running behavior

`interceptor macos open` and the synthesized-input verbs (`click`, `type`, `keys`, `drag`) are background-first by default. Foregrounding is opt-in via `--activate` on `open`, or via the explicit `app activate` command.

```bash
interceptor macos open "Finder"               # background — does NOT raise Finder
interceptor macos open "Finder" --activate    # explicit foregrounding
```

**When the target app is already running**, the bridge does literally nothing in the launch path and proceeds straight to AX reads. This is deliberate: per Apple docs, calling `NSWorkspace.openApplication(at:configuration:)` for an already-running app delivers a `kAEOpenApplication` Apple Event, and standard AppKit apps respond by self-activating. `OpenConfiguration.activates = false` only suppresses the *system's* activation pass — it does NOT stop the app's own self-activation reflex. The only truly background-safe behavior for a running target is to skip the launch call entirely.

**When the target app is not yet running**, the bridge resolves the app URL through a directed search of `/Applications`, `/System/Applications`, `/System/Applications/Utilities`, and `~/Applications`, then calls `NSWorkspace.openApplication(at:configuration:)` with `activates = false` and `addsToRecentItems = false`. Note: AppKit apps may still self-activate during a cold launch — this is platform behavior. For a guaranteed background launch, use `interceptor macos intent dispatch --bundle <id> --script 'launch'` and let the Apple Event open the app without the open-document reflex.

## Input verb routing

When `--app`, `--pid`, or `--window` is provided, the bridge posts events to that PID via `CGEvent.postToPid(pid_t)`, stamped with the id of one window and the point relative to it. For a left click, a drag, typed text, and keys it first tells that window it has focus (the frontmost app does not change) and hands focus back afterwards; when the target is another window of the frontmost app, the window that was key is made key again. A right-click and a scroll need no focus step. The events do not need the target to be frontmost. A mouse verb that resolves no on-screen window refuses and delivers nothing. When neither is provided, the bridge falls back to `cghidEventTap` (system-wide HID, follows the user's frontmost app — legacy "drive whatever's visible" semantics).

**Refs always route to AX first.** `act <ref>`, `click <ref>`, `type <ref>` use `AXUIElementPerformAction(kAXPressAction)` and `AXUIElementSetAttributeValue(kAXValueAttribute, ...)` directly when possible, bypassing CGEvents and never moving focus. AX value-set is gated to text-bearing roles: `AXTextField`, `AXTextArea`, `AXSearchField`, `AXComboBox`. Other roles fall back to synthesized key events posted via `postToPid` of the ref's owning PID.

### Routing tags

Each input verb returns one of these in its success message:

- `"ax-pressed ref"` — pure AX press, no event posting.
- `"ax-set value (N chars)"` — AX value-set, no event posting.
- `"clicked at (x, y) → pid=NNNN"` — synthesized CGEvent posted to a specific PID.
- `"clicked at (x, y) → frontmost"` — synthesized CGEvent on the system HID tap (legacy fallback).

If you see `→ frontmost` when you expected per-PID delivery, the target wasn't resolvable and the call hit the legacy fallback — pass `--app` or `--pid`.

## Background-Safe Verb Inventory

Every verb in this table has been live-verified to leave frontmost untouched.

| Verb | Background-safe? | Notes |
|---|---|---|
| `open <app>` (no `--activate`) | yes | No-op if running; documented background-first launch otherwise |
| `read --app <app>` | yes | Pure AX read |
| `tree --app <app>` | yes | Sets `AXManualAccessibility` only (NOT `AXEnhancedUserInterface`) |
| `windows --app <app>` | yes | Pure AX read |
| `focused --app <app>` | yes | Pure AX read |
| `find --app <app>` | yes | Pure AX read |
| `inspect <ref>` / `inspect --app <app>` | yes | Pure AX read |
| `value <ref>` | yes | Pure AX read |
| `act <ref>` | yes | AX press; no CGEvent |
| `act <ref> "text"` | yes | AX value-set; no CGEvent |
| `click <ref>` | yes | AX press first; PID-routed CGEvent fallback |
| `click x,y --app <app> [--window <id>]` | yes | `CGEvent.postToPid`, stamped for one window |
| `type <ref> "..."` | yes | AX value-set first; PID-routed keys fallback |
| `type "..." --app <app>` | yes | AX value-set if focused on text role; else PID-routed keys |
| `keys "..." --app <app>` | yes | `CGEvent.postToPid`, after telling the target window it has focus |
| `keys "..." --pid <n>` | yes | `CGEvent.postToPid` |
| `drag --app <app>` | yes | `CGEvent.postToPid`, stamped for one window |
| `scroll <dir> <n> --app <app>` | yes | `CGEvent.postToPid`, stamped for one window |
| `screenshot --app <app>` | yes | `CGSHWCaptureWindowList` — occluded / minimized / cross-Space |
| `intent dispatch --bundle <id>` | yes | Apple Events deliver without raising |
| `menu --app <app>` (list / invoke) | yes | AX |
| `app hide / unhide / quit` | yes | Pure lifecycle operations |
| `pdf *`, `detect *`, `translate *`, `thumbnail *` | yes | Local file I/O / in-process frameworks |
| `calendar *`, `reminders *`, `contacts *`, `photos *` | yes | Framework reads/writes; first-run TCC dialog only |
| `location current/geocode/reverse/distance` | yes | CLGeocoder + one-shot CLLocationManager.requestLocation |
| `music search/library/play/pause/now-playing` | yes | ApplicationMusicPlayer plays in-process |
| `appintent *` | yes | Runtime introspection only |
| `maps search/complete/directions/eta/reverse` | yes | Network calls; no UI |
| `notifications post/schedule-*/...` | yes | UNUserNotificationCenter; banner appears OS-side |
| `app activate <app>` | **no by design** | This command's contract is to foreground |
| `open <app> --activate` | **no by design** | Explicit opt-in |
| `click x,y` (no `--app`/`--pid`) | **no by design** | Legacy "drive frontmost" mode |
| `type "..."` (no `--app`/`--pid`/ref) | **no by design** | Legacy "drive frontmost" mode |
| `keys "..."` (no `--app`/`--pid`) | **no by design** | Legacy "drive frontmost" mode |
| `auth confirm` | partial | Touch ID / Face ID prompt — modal but does not change frontmost |
| `maps mapitem-open` | partial | Opens Maps.app; activates Maps |
| `share airdrop/email/message/...` | partial | OS-rendered share sheet may surface above the bridge |

## Background recipes

```bash
# Screenshot of Brave's current window — Brave stays where it was
interceptor macos screenshot --app "Brave Browser" --save --target-max-long-edge 1568

# Open a tab in Brave without bringing Brave to front
interceptor macos intent dispatch --bundle com.brave.Browser \
  --script 'tell application "Brave Browser" to tell front window to make new tab with properties {URL:"https://example.com"}'

# Read the active tab URL/title from Brave (no focus change)
interceptor macos intent dispatch --bundle com.brave.Browser \
  --script 'tell application "Brave Browser" to URL of active tab of front window'

# Read AX tree of Cursor (Electron — wake-up automatic) without activating it
interceptor macos tree --app "Cursor" --filter interactive --depth 6

# Scroll Mail down 5 times while another app stays focused
interceptor macos scroll down 400 --app "Mail" --times 5 --interval-ms 80

# Type into a backgrounded TextEdit while another app stays frontmost
REF=$(interceptor macos focused --app "TextEdit" --json | jq -r '.ref')
interceptor macos type "$REF" "background-only edit"      # → "ax-set value (...)"
interceptor macos value "$REF"                             # confirm landed
```

## Pitfalls (historical foregrounding leaks)

Three documented foregrounding leaks shipped in earlier bridge versions. All fixed as of 0.11.0. If you see frontmost change unexpectedly in a future build, suspect one of these:

- **`AXEnhancedUserInterface = true` on the app element.** This is the AppKit "VoiceOver is active" flag, not just a Chromium tree-build signal. AppKit apps respond by raising their main window. The bridge now sets only `AXManualAccessibility` (the Chromium-specific signal) in `wakeAXTree`. Never set `AXEnhancedUserInterface` from a background-first reader.
- **`NSWorkspace.openApplication(at:configuration:)` with `activates = false` against an already-running app.** Per Apple docs the `activates` flag only suppresses the *system's* activation pass; the receiving app still self-activates in response to `kAEOpenApplication` / `kAEOpenDocuments`. The bridge therefore never calls `openApplication` for a running target — the running-app branch is a strict no-op.
- **Deprecated `NSWorkspace.fullPath(forApplication:)` falling through to deprecated `launchApplication(_:)`.** That fallback always foregrounds and has no configuration knob. The bridge now resolves URLs via `urlForApplication(withBundleIdentifier:)` plus a directed walk of `/Applications`, `/System/Applications`, `/System/Applications/Utilities`, `~/Applications`, and fails closed if nothing matches.

One platform constraint cannot be suppressed: launching a not-running AppKit app from cold via `openApplication` may still self-activate via the `kAEOpenApplication` reflex. If you need a guaranteed-background cold launch, skip `open` and use `intent dispatch --bundle <id>` to deliver a custom Apple Event, or accept that cold launches inherently raise.
