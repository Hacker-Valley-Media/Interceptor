---
name: interceptor
description: "Choose the right Interceptor surface. Use interceptor-browser for page DOM, network, browser tabs, rich editors, screenshots, and browser automation. Use interceptor-macos for native apps, browser chrome, URL bars, OS dialogs, cross-app routing, AX trees, native screenshots, Apple Events, trusted OS input, macOS Electron CDP/app web-content control, and in-process app runtime control. Use interceptor-ios for apps on an owned, unlocked, Developer-Mode iPhone. Use interceptor-research for deep multi-source web research. Background-first by default; focus changes require explicit opt-in."
#os:win32,linux description: "Choose the right Interceptor surface. Use interceptor-browser for page DOM, network, browser tabs, rich editors, screenshots, and browser automation. Use interceptor-desktop for native apps on this computer: element trees, windows, dialogs, background input, native screenshots, system services, and Electron or Chromium app web contents. Use interceptor-research for deep multi-source web research. Background-first by default; focus changes require explicit opt-in."
metadata:
  short-description: Choose the right Interceptor surface
---

# Interceptor

Use this as the routing skill before loading a surface-specific skill.

## Surface Decision

| Task | Skill |
|---|---|
| Page DOM, text, network, SPA state, browser monitor, screenshots of browser content | `interceptor-browser` |
| Rich browser editors (Docs/Slides/Canva), canvas/WebGL camera viewers, scene-graph reads, page-world request overrides, blob/export capture, or "cooking" a live page with overlays/HUDs | `interceptor-browser` |
| Native macOS apps, OS dialogs, browser chrome, URL bars, app windows, menu bars | `interceptor-macos` | <!-- os:darwin -->
| Native apps on this computer: element trees, windows, dialogs, menus, background input, native screenshots, system services | `interceptor-desktop` | <!-- os:win32,linux -->
| Electron / Chromium desktop app web contents, such as Slack, VS Code, Notion, or Descript DOM/network/JS | `interceptor macos cdp` / `interceptor macos cdp app` via `interceptor-macos/references/cdp-app.md` | <!-- os:darwin -->
| Electron / Chromium desktop app web contents, such as Slack, VS Code, Notion, or Descript DOM/network/JS | `interceptor desktop cdp` via `interceptor-desktop` | <!-- os:win32,linux -->
| Native app runtime internals: live view/object graph, selector calls, rendered text mutation, hooks, MapKit/AppKit/SwiftUI runtime work | `interceptor macos runtime` via `interceptor-macos/references/native-agent.md` | <!-- os:darwin -->
| Open or control a named app such as Brave, Mail, Finder, Signal, or Cursor | `interceptor-macos` | <!-- os:darwin -->
| Open or control a named app | `interceptor-desktop` | <!-- os:win32,linux -->
| Backgrounded, occluded, minimized, or cross-Space app capture | `interceptor-macos` | <!-- os:darwin -->
| Deep web research: investigate a topic across many sources with breadth + verification | `interceptor-research` |
| Owned physical iPhone, app automation, runner state and device services | `interceptor-ios` | <!-- os:darwin -->
| Capabilities added by an installed extension (operator-supplied) | run `interceptor extensions list`, then load the extension's own skill (`interceptor-ext-<name>`) |

## The User Is On This Mac Too <!-- os:darwin -->
## The User Is On This Computer Too <!-- os:win32,linux -->

Assume the person is working on this Mac while you work. Stay in the background at all costs. Take focus (the frontmost app, the focused window, or the tab showing in a window the user is using) only when the action truly cannot be done any other way. Never take it to make your own work easier, and never to test something. <!-- os:darwin -->
Assume the person is working on this computer while you work. Stay in the background at all costs. Take focus (the app in front, the focused window, or the tab showing in a window the user is using) only when the action truly cannot be done any other way. Never take it to make your own work easier, and never to test something. <!-- os:win32,linux -->

Before any focus-moving verb, go down this list and stop at the first rung that works:

1. **A background verb.** Synthetic browser input, AX refs, `--app` / `--pid` / `--window` on `interceptor macos` input, and `--trusted` browser input (a full install delivers it to an unfocused window). <!-- os:darwin -->
1. **A background verb.** Synthetic browser input, element refs, and `--app` / `--pid` / `--window` on `interceptor desktop` input. <!-- os:win32,linux -->
2. **`interceptor tab keepalive <id>`** for a page that will not render while hidden.
3. **Your own window.** `interceptor window new [url]` moves your tab group into its own background window, and `interceptor window new --tab <id>` builds one around a tab you already have. The tab showing there paints and plays media. `interceptor tab switch <id>` there changes only that window, but a tab switched in while the window is covered stays hidden, so use `--tab` for it. Never switch tabs in a window the user is working in. <!-- os:darwin -->
3. **Your own window.** `interceptor window new [url]` moves your tab group into its own background window, and `interceptor tab switch <id>` there changes only that window. Never switch tabs in a window the user is working in. <!-- os:win32,linux -->
4. **Only then a focus move.** Say so first, keep it to one fast batch, and put back the frontmost app, the active tab, and the cursor.

Known foreground-only cases: launching an app that is not running (it can come forward even from a background launch, and an app updater can raise a password prompt), and a click or drag on a minimized window or hidden app. <!-- os:darwin -->
Known foreground case: `app launch` of a Store app starts it through the activation manager, which can bring it forward. <!-- os:win32 -->

## Core Rules

- Browser commands operate inside the cyan `interceptor` tab group. Do not use `--any-tab` unless the user explicitly authorizes acting outside that group.
- Solo browser work in a supported agent shell gets a soft per-session group automatically. For concurrent lanes, set a unique `INTERCEPTOR_SESSION_ID` or pass a unique `--group <label>` to each lane. Explicit groups are hard-scoped by default unless `--any-tab` is authorized. Close named groups with `interceptor group close <label>` when done; the idle timer is based on tab activity, so metadata polls do not keep a group alive.
- `interceptor open <url>`, `interceptor tab new <url>`, and `interceptor window new [url]` create background tabs and windows by default. Only `open --activate`, `tab new --activate`, `window new --activate`, `tab switch <id>`, and `window focus <id>` intentionally move browser focus.
- A page that will not render while hidden is not a reason to switch tabs in the user's window. `interceptor tab keepalive <id>` makes it read as visible and run its animation frames in place. A page that needs a real paint (video playback, a virtualized grid that measures itself) goes in your own window: `interceptor window new <url>`.
- A trusted click does not need a tab switch or a focused window: `interceptor click <ref> --trusted` reaches any tab on a full install. A tab that is not showing gets a background window of its own and goes back. The result ends `the page received it`, or fails with `the page reported none of it`: read the page before sending anything again. <!-- os:darwin -->
- The macOS surface is background-first by default. Only `interceptor macos app activate <app>` and `interceptor macos open <app> --activate` intentionally move focus. <!-- os:darwin -->
- `interceptor desktop <verb>` is the same command as `interceptor macos <verb>` on this Mac; use `macos`. <!-- os:darwin -->
- The native surface is background-first by default. Only `interceptor desktop app activate <name>` and `interceptor desktop open <name> --activate` intentionally move focus. <!-- os:win32,linux -->
- If multiple browser profiles are connected, run `interceptor contexts` and pass `--context <id>`.
- Safari registers as `safari`; use `interceptor --context safari <verb>` for page content and `interceptor macos` for Safari chrome or native fallbacks. <!-- os:darwin -->
- Prefer compound commands (`open`, `read`, `act`, `inspect`) and structured reads before screenshots.
- The zero-CDP browser rule governs the user's real Chrome/Brave/Safari web session. For owned Electron apps, `interceptor macos cdp` and `interceptor macos cdp app` are intentional app-control surfaces. <!-- os:darwin -->
- The zero-CDP browser rule governs the user's real browser session. For owned Electron apps, `interceptor desktop cdp` is an intentional app-control surface. <!-- os:win32,linux -->
- For native app runtime internals, use `interceptor macos runtime` after checking `interceptor status`; public Full installs may require operator-supplied runtime agent dylibs/signing identity before `macos runtime enable`. <!-- os:darwin -->
- If the extension behaves stale after a package update, run `interceptor reload --context <id>`: an unpacked copy picks up the installed files; a Chrome Web Store copy only asks the store for an update and keeps its version until the store publishes the new one. `interceptor contexts --verbose` shows which copy (store or unpacked) and version each context runs.
- `interceptor daemon stop` and `interceptor skills unadopt` are install/maintenance verbs. The daemon is shared by every agent on the machine — never stop it during normal automation; the next browser command respawns it, but every connected agent's in-flight work is dropped.

## Load A Surface Skill

- Load `interceptor-browser` for browser page content, network, tabs, scene graphs, and browser screenshots.
- Load `interceptor-macos` for native apps, browser chrome, OS dialogs, window capture, AX trees, Apple Events, Electron app CDP/app attach, and in-process native agent control. <!-- os:darwin -->
- Load `interceptor-ios` for an owned, unlocked, Developer-Mode iPhone. Disconnected unlock cannot bootstrap its runner. <!-- os:darwin -->
- Load `interceptor-desktop` for native apps, windows, dialogs, element trees, background input, system services, and Electron app CDP. It lists what this computer cannot do. <!-- os:win32,linux -->
- Load `interceptor-research` for deep web research — investigating a topic across many sources with a planner loop, an on-disk source ledger, and adversarial verification (methodology layered on the browser surface). Pull the playbook any time with `interceptor research`.
