---
author: agent
generated_by: claude-opus-5-5 (Maestro)
created: 2026-10-11
updated: 2026-10-12
status: draft
reviewed: false
source: live runs against the installed Full build on Windows 11 ARM64 and Linux ARM64 (Hyprland 0.56.1), 2026-10-11; scripts/desktop-parity/cases/input.ts
---

# Drive an app in the background

You are reading or changing an app on this computer without bringing it forward. The person may be using the machine while you work.

## 1. Find the app

```bash
interceptor desktop apps
```

```
[7084] powershell <!-- os:win32 -->
[6612] explorer <!-- os:win32 -->
[18628] gjs <!-- os:linux -->
[10084] org.gnome.Nautilus <!-- os:linux -->
```

The text after `[pid]` is the app name. Pass it to `--app` exactly as printed, or pass the number to `--pid`. The name is the process name (`powershell`, `explorer`, and `ApplicationFrameHost` for a UWP app such as Settings). <!-- os:win32 -->
The text after `[pid]` is the app name. Pass it to `--app` exactly as printed, or pass the number to `--pid`. The name can be an app id (`org.gnome.Nautilus`) or the program that hosts the window (`gjs`). <!-- os:linux -->

App not running: `interceptor desktop app launch <id>`. The id is a Start-menu app id (`Get-StartApps` in PowerShell lists them). The reply carries `launched` and `pid`. `launched: false` with a pid means it was already running. A Store app replies `activated: true` and can come forward. <!-- os:win32 -->
App not running: `interceptor desktop app launch <id>`. The id is a desktop-file id (`org.gnome.Nautilus`). The reply carries `launched` and `pid`. `launched: false` with a pid means it was already running. <!-- os:linux -->

## 2. Read it

```bash
interceptor desktop open "<name>"                 # app, pid, tree, windows
interceptor desktop tree --app "<name>"           # tree only
interceptor desktop find "Fixture input" --app "<name>"
```

A tree line looks like this:

```
[e08094693014983422608927727399199729309600000000000000000149] textfield "Fixture input"
[e08094693014983422608927727399199729309600000000000000000150] button "Submit fixture"
[e08094693014983422608927727399199729309600000000000000000152] textfield "Fixture password" value="•••"
```

`find` returns each match with `ref`, `role`, `name`, `frame` and `secure`. Copy the whole ref.

If the tree comes back empty, the app exposes no elements. `open` still lists its windows with frames. Skip to step 4.

## 3. Act by ref

```bash
interceptor desktop act <ref> "hello"     # reply: "action": "typed"
interceptor desktop act <ref>             # reply: "action": "clicked"
interceptor desktop value <ref>           # prints the element's current value
```

`act` returns the tree again with new refs. Take the next ref from that reply, or run `find` again.

Then confirm. Read the element the action should have changed (`value <ref>` on a result label, or `find` for text that should now exist). A reply that says `typed` or `clicked` reports delivery. Only the read shows the app took it.

## 4. Act by window when there are no refs

```bash
interceptor desktop windows --app "<name>"                 # frame and windowId per window
interceptor desktop click 640,400 --app "<name>"           # X,Y in the same coordinates as the frames
interceptor desktop keys "Enter" --app "<name>" <!-- os:win32 -->
interceptor desktop keys "Control+L" --app "<name>" <!-- os:linux -->
interceptor desktop type "text" --app "<name>"
```

The reply shows what happened to the person's desktop:

```
"background": true,
"cursorUnchanged": true,
"focusUnchanged": true,
"effectRequiresObservation": true
```

`effectRequiresObservation: true` means look before you continue:

```bash
interceptor desktop screenshot --app "<name>" --save       # reply key is "filePath"
interceptor desktop vision text --app "<name>"             # text regions with normalized boxes
```

`screenshot --save` writes a file and returns its path in `filePath`. Delete the file when you are done with it.

## 5. Leave it as you found it

- Close what you opened: `interceptor desktop app quit "<name>"`. Some apps keep a windowless process after their window closes; `apps` still lists it.
- Do not run `app activate` to check your work. Read instead.

## When it does not work

| You see | Cause | Do this |
|---|---|---|
| `no target app found` | `--app` does not match a name from `apps` | Copy the name exactly, or use `--pid` |
| `input requires exactly one matching top-level window` | No window, or more than one, matches | `windows --app <name>`, then `--window <id>` |
| `capture requires one matching accessible application` | Same, for `screenshot` and `vision` | Same |
| `selected process has no mapped native Wayland windows` | The process has no window | Launch it again or pick another pid | <!-- os:linux -->
| `background_unavailable` on `keys` | A chord holding Ctrl, Alt or the Windows key, sent to a window that is not in front | Use `type`, `value`, `action` or `menu` | <!-- os:win32 -->
| `background_unavailable`: `has not focused a control` | `type` with no ref into a window that never had focus | `type <ref> "text"` | <!-- os:win32 -->
| `stale_reference` | The element is gone | Read again |
