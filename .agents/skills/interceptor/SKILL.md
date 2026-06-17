---
name: interceptor
description: "Choose the right Interceptor surface. Use interceptor-browser for page DOM, network, browser tabs, rich editors, screenshots, and browser automation. Use interceptor-macos for native apps, browser chrome, URL bars, OS dialogs, cross-app routing, AX trees, native screenshots, Apple Events, trusted OS input, macOS Electron CDP/app web-content control, and in-process app runtime control. Background-first by default; focus changes require explicit opt-in."
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
| Native macOS apps, OS dialogs, browser chrome, URL bars, app windows, menu bars | `interceptor-macos` |
| Electron / Chromium desktop app web contents, such as Slack, VS Code, Notion, or Descript DOM/network/JS | `interceptor macos cdp` / `interceptor macos cdp app` via `interceptor-macos/references/cdp-app.md` |
| Native app runtime internals: live view/object graph, selector calls, rendered text mutation, hooks, MapKit/AppKit/SwiftUI runtime work | `interceptor macos runtime` via `interceptor-macos/references/native-agent.md` |
| Open or control a named app such as Brave, Mail, Finder, Signal, or Cursor | `interceptor-macos` |
| Backgrounded, occluded, minimized, or cross-Space app capture | `interceptor-macos` |
| Deep web research: investigate a topic across many sources with breadth + verification | `interceptor-research` |
| Capabilities added by an installed extension (operator-supplied) | run `interceptor extensions list`, then load the extension's own skill (`interceptor-ext-<name>`) |

## Core Rules

- Browser commands operate inside the cyan `interceptor` tab group. Do not use `--any-tab` unless the user explicitly authorizes acting outside that group.
- `interceptor open <url>` and `interceptor tab new <url>` create background tabs by default. Only `open --activate`, `tab new --activate`, `tab switch <id>`, and `window focus <id>` intentionally move browser focus.
- The macOS surface is background-first by default. Only `interceptor macos app activate <app>` and `interceptor macos open <app> --activate` intentionally move focus.
- If multiple browser profiles are connected, run `interceptor contexts` and pass `--context <id>`.
- Prefer compound commands (`open`, `read`, `act`, `inspect`) and structured reads before screenshots.
- The zero-CDP browser rule governs the user's real Chrome/Brave web session. For owned Electron apps, `interceptor macos cdp` and `interceptor macos cdp app` are intentional app-control surfaces.
- For native app runtime internals, use `interceptor macos runtime` after checking `interceptor status`; public Full installs may require operator-supplied runtime agent dylibs/signing identity before `macos runtime enable`.
- If an already-loaded unpacked extension behaves stale after a package update, reload it from `chrome://extensions` or `brave://extensions`, or run `interceptor reload` once the extension is reachable.

## Load A Surface Skill

- Load `interceptor-browser` for browser page content, network, tabs, scene graphs, and browser screenshots.
- Load `interceptor-macos` for native apps, browser chrome, OS dialogs, window capture, AX trees, Apple Events, Electron app CDP/app attach, and in-process native agent control.
- Load `interceptor-research` for deep web research — investigating a topic across many sources with a planner loop, an on-disk source ledger, and adversarial verification (methodology layered on the browser surface). Pull the playbook any time with `interceptor research`.
