---
name: interceptor-desktop
description: "Drive native apps on this computer via interceptor desktop *: element trees, background click/type/keys/drag/scroll, window screenshots and capture, clipboard, files, PDF, OCR and local vision, speech, local AI, monitor/replay, overlays, vault secrets, and Electron or Chromium app web contents via interceptor desktop cdp. Check interceptor desktop capabilities first: every operation reports whether it works on this computer and why not. Use for native apps, window control, and system UI. Not for content inside browser pages (use interceptor-browser)."
compatibility: "Windows or Linux host with the Interceptor Full install (interceptor status prints mode: full)."
#os:win32 compatibility: "Windows with the Interceptor Full install (interceptor status prints mode: full)."
#os:linux compatibility: "Linux with the Interceptor Full install (interceptor status prints mode: full)."
metadata:
  short-description: Drive native apps on this computer via the interceptor CLI; background-first
  author: agent
  generated_by: "claude-opus-5-5 (Maestro)"
  created: "2026-10-11"
  updated: "2026-10-12"
  status: draft
  reviewed: "false"
  source: "docs/desktop-bridge.md; shared/desktop-support.json; cli/commands/desktop.ts; live runs on the Windows 11 ARM64 and Linux ARM64 (Hyprland) Full installs"
---

<!-- One source for every OS that ships this skill. scripts/gen-skills.ts keeps each OS's tagged lines
     and fills the generated tables from shared/desktop-support.json; see .agents/rules/skill-os-variants.md. -->

# Interceptor Desktop

Agent-operator skill for the native surface of Interceptor on this Windows computer. `interceptor desktop <family> ...` drives native applications through the `interceptor-desktop` provider, which uses UI Automation and Win32. For content inside a browser tab load `interceptor-browser` instead. <!-- os:win32 -->
Agent-operator skill for the native surface of Interceptor on this Linux computer. `interceptor desktop <family> ...` drives native applications through the `interceptor-desktop` provider, which uses AT-SPI and the compositor. For content inside a browser tab load `interceptor-browser` instead. <!-- os:linux -->

**This computer is not a Mac.** Mac and iPhone commands refuse here with `macos/ios commands require macOS`, and their skills are not installed. Where other text mentions them, use this skill.

This installed skill is self-contained. Packaged users have only the skill directory beside the install.

## Fast Path

```bash
interceptor status                                  # 1. "mode: full" and "desktop provider: installed"
interceptor desktop capabilities                    # 2. One row per operation: effective, reason, provider, limits
interceptor desktop apps                            # 3. Running apps as "[pid] name"
interceptor desktop open "<name>"                   # 4. Tree + windows of a running app (does not raise it)
interceptor desktop find "Submit" --app "<name>"    # 5. Elements by name, each with a ref and a frame
interceptor desktop act <ref>                       # 6. Press the element, no focus change
interceptor desktop act <ref> "hello"               # 7. Set its text, no focus change
```

Four things to know before the first command:

- **`--app` takes the name exactly as `apps` prints it** (`powershell`, `explorer`). Another spelling fails with `no target app found` or `input requires exactly one matching top-level window`. `--pid <pid>` is exact. <!-- os:win32 -->
- **`--app` takes the name exactly as `apps` prints it** (`gjs`, `org.gnome.Nautilus`). Another spelling fails with `no target app found` or `input requires exactly one matching top-level window`. `--pid <pid>` is exact. <!-- os:linux -->
- **Refs are long strings** (`e0809...0257`). Copy them whole. Every read returns new ones, so use the latest and read again on `stale_reference`.
- **A reply with `effectRequiresObservation: true` means delivered, not confirmed.** Read the target again before the next step. `act` returns the fresh tree for you.
- **Password fields read as `•••`.** That is correct. Do not retry for the value.

## The One Rule

**Ask the computer before you claim or try anything.** `interceptor desktop capabilities` is the source of truth for what works on this machine. `interceptor desktop --help` lists only the commands this build has for this OS, and the tables below name what is missing; whether a listed command works here still depends on its capability row.

Read each row like this:

| Row says | Do this |
|---|---|
| `effective: true` | Use it. `provider` names what does the work and `limits` lists the conditions on the target. |
| `effective: false`, `reason` says the model downloads the first time | Run the command once to start the 2.8 GB download, then follow `interceptor desktop ai status` until it prints `available: true`. |
| `effective: false`, `reason` names an engine or service this build does not ship | Not available. Tell the user what is missing. Do not install or configure anything unless they ask. |
| `present: false` | The package or program it needs is not installed. `reason` names it. |
| No row, or `desktop <family> is not implemented by this host provider` | This computer has no such family. Stop. |

Never tell the user a command works because the help lists it. Say it works when its row is `effective: true`, or after you ran it.

## Background First

**The user is on this computer too.** Input goes to the target window without activating it, and the cursor stays where it is. Only `interceptor desktop app activate <name>` and `interceptor desktop open <name> --activate` exist to move focus. Use them when the user asks for the app to come forward, never to make your own work easier.

Go down this list and stop at the first route that works:

1. **Refs.** `act`, `click <ref>`, `type <ref> "text"`, `value`, `action`, `menu`. They work through the app's accessibility elements.
2. **A window.** `click X,Y --app <name>`, `type "text" --app <name>`, `keys "Control+L" --app <name>`, `scroll`, `drag`. `X,Y` use the same coordinates as the `frame` values from `find` and `windows`. The reply shows `background: true` with `cursorUnchanged` or `focusUnchanged`. Add `--window <id>` (from `windows --app <name>`) when the app has several windows.
3. **Pixels.** `screenshot --app <name>` and `vision text --app <name>` when the app exposes no elements.

Known limits:

- **An app can expose an empty tree.** `open` still lists its windows. Use routes 2 and 3.
- **A `keys` chord that holds Ctrl, Alt or the Windows key reaches only the window that is already in front.** For a background window it refuses with `background_unavailable`, because Windows apps read the physical modifier keys. Use `type`, `value`, `action` or `menu` instead. A single key or a Shift chord works in the background. <!-- os:win32 -->
- **`type "text" --app <name>` with no ref refuses when that window has not had a focused control yet.** Pass the control's ref. <!-- os:win32 -->
- **`app launch` on a Store app starts it through the activation manager** and replies `activated: true`, so it can come forward. <!-- os:win32 -->
- **Background pointer and key delivery is qualified on Hyprland 0.56.1 with native Wayland windows**, and `keys` takes one key plus modifiers. On another compositor read the `click` and `keys` rows first. <!-- os:linux -->
- **Run from the signed-in desktop session.** From an ssh shell or a service the provider is out of reach, and commands answer `requires the logged-in user's interactive session; Session 0 is not supported`. <!-- os:win32 -->
- **Run from the signed-in desktop session.** From an ssh shell or a service the provider is out of reach, and commands can fail with a bare `No such file or directory`. <!-- os:linux -->

Full procedure with the replies to expect: [`workflows/drive-app-in-background.md`](workflows/drive-app-in-background.md).

## What Does Not Exist Here

These commands do not work on this OS in this build. `interceptor desktop --help` leaves them out.

<!-- generated:unsupported -->
Filled at build time from shared/desktop-support.json with this OS's `no` rows.
<!-- /generated -->

## What Works In Part

<!-- generated:partial -->
Filled at build time from shared/desktop-support.json with this OS's `partial` rows.
<!-- /generated -->

What the operating system fills in, what ships with the install, and how results differ from the Mac's: [`references/availability.md`](references/availability.md).

## Electron And Chromium Apps

Web contents of an Electron or Chromium app go through `interceptor desktop cdp`, not the element tree:

```bash
interceptor desktop cdp discover                              # Running Electron/Chromium apps and their debug-port state
interceptor desktop cdp connect <port> --host 127.0.0.1       # Attach to an app started with --remote-debugging-port; returns a contextId
interceptor desktop cdp targets --context <contextId>
interceptor desktop cdp raw Runtime.evaluate '{"expression":"6*7","returnByValue":true}' --context <contextId>
interceptor desktop cdp detach --context <contextId>
```

`cdp launch <app> --port N` relaunches the app and refuses without `--confirm`. On this OS, `cdp launch` and `cdp app attach` have only been tested for their refusals, not against an installed Electron app.

## Settings

The `INTERCEPTOR_*` variables a `reason` names are read by the provider when the user signs in. Setting them in a terminal does not reach it. Set them as user environment variables (`setx NAME value`), then sign out and back in. <!-- os:win32 -->
The `INTERCEPTOR_*` variables a `reason` names are read by the provider when the user logs in. Setting them in a terminal does not reach it. Put them in `~/.config/environment.d/interceptor.conf`, one `NAME=value` per line, then log out and back in. <!-- os:linux -->

The Full install updates itself: the provider installs a newer release once Interceptor has gone 10 minutes without a request. `interceptor update status` shows the last check and install, and `interceptor update install` installs a newer release now (it returns at once; follow it with `update status`). `INTERCEPTOR_AUTO_UPDATE=off`, set the same way, turns the background updater off.

## Recovery Reflexes

| You see | Do this |
|---|---|
| `no target app found`, `input requires exactly one matching top-level window`, `capture requires one matching accessible application` | Use the name from `apps` exactly, or `--pid`. Several windows: add `--window <id>`. |
| `open` answers `new Linux application launch requires an absolute executable path` | The name matched no running app, so `open` tried to launch it. Use the name from `apps`, or `app launch <id>`. | <!-- os:linux -->
| `stale_reference` | Read again and use the new ref. |
| `unsupported_target` | The element or app does not expose what the verb needs. Use the window route or pixels. |
| `background_unavailable` | No background route for that request. Read the message; it names the alternative. |
| `timeout_unknown_outcome` | Do not replay. Read the target first, then decide. |
| `not_installed`, `present: false` | The row names the missing package. Report it. |
| An AI command refuses and reports download progress | `interceptor desktop ai status`. Retry when it prints `available: true`. |
| `no_interactive_session` | You are outside the desktop session. |
| A command fails with the provider unreachable, then works again a minute later | An automatic update may have just installed. Run the command again; `interceptor update status` shows `lastInstallVersion`. |

## When To Switch Surfaces

If the target is **inside a browser page** (DOM, network, tabs, forms), load `interceptor-browser`.

If the task is **research across many sources**, load `interceptor-research`.

## Do Not Default To Troubleshooting

- User wants a task done in an app on this computer: run Interceptor commands.
- User wants Interceptor fixed, installed, or explained: that is a separate task. Ask before diving into install state.
