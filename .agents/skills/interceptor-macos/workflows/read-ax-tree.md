# ReadAxTree

You are reading the accessibility tree of a macOS app without bringing it to the foreground. Use this when you need to know what's in another app's UI — a button label, a window title, a text field's current value, the structure of a menu — and the app may be backgrounded, occluded, or just not focused.

**The bridge handles Electron's AX wake-up for you.** Electron apps (Slack, Discord, Cursor, Brave, Notion, VS Code) gate their AX tree on visibility for performance. Interceptor fires `AXManualAccessibility` to wake them up — no focus change.

## The recipe

```bash
interceptor macos tree --app "Cursor" --filter interactive --depth 6
```

That call:
1. Resolves "Cursor" to a running app and its main window.
2. Fires `AXManualAccessibility = true` on the app element (Chromium-specific signal — wakes the tree without activating).
3. Walks the AX tree to depth 6.
4. Filters to interactive elements only.
5. Returns refs (`e5`, `e7`, …) and labels.

## Important note about wake-up signals

The bridge uses `AXManualAccessibility` exclusively. **`AXEnhancedUserInterface` was removed** because it foregrounded AppKit apps (it's the "VoiceOver is active" flag, which AppKit interprets as "raise main window"). Don't expect or set it. If you see code anywhere telling you to set `AXEnhancedUserInterface` from a background-first reader, that's stale guidance.

**Read twice before you conclude the tree is empty.** An Electron app builds its tree after the wake-up signal, so the first read can return only the menu bar. Wait a second and read again. Signal 8.28 returned 215 nodes (all menu items) on the first read and its buttons, table, and text field on the second, in the background and again while hidden.

Do not raise an app to read it. If a second read still has no content, check that the app has a window at all (`interceptor macos windows --app "X"`); a menu-bar-only or never-shown app has nothing to read. Tell the user what you found instead of activating it.

## Filter options

- `--filter interactive` — clickable, editable, focusable elements only. The default for "find me something to act on".
- `--filter all` — every element in the tree, including decorative ones. Bigger output.
- `--filter labels` — text-bearing elements only. Good for "what does this window say".

## Depth tuning

Default 4–6 is enough for most apps. Increase when:
- The target is a deep menu (`--depth 10` or more for nested submenus).
- You need to descend into a sidebar's nested rows (`--depth 8`).

Decrease when you only need the window-level structure (`--depth 2`).

## Worked examples

```bash
# What's in the main Slack window?
interceptor macos tree --app "Slack" --filter interactive --depth 6

# Read just the menu bar of Brave
interceptor macos menu --app "Brave Browser"

# Find the AX ref of a specific button without scanning the whole tree
interceptor macos find "Send" --app "Slack" --role button

# Look at one ref in detail
interceptor macos inspect e7
```

## Pitfalls

- **Reading too deep on a chatty app.** A `--depth 20 --filter all` tree on VS Code returns thousands of nodes. Start narrow.
- **Refs from a stale tree.** AXObserver invalidates refs when the app rebuilds part of its tree. If `act <ref>` returns "stale ref", re-run `tree`.
- **Stopping after one thin read.** A first read that is all `menuitem` is the wake-up still in progress, not the app's real tree. Read again.
- **Launching the app to read it.** A launch can take the user's focus and raise an updater prompt. Read apps that are already running.
- **Assuming "no visible windows" means "not running".** A menu-bar-only app (tray app, Discord-in-tray) has no AX window but is still running. Use `interceptor macos apps` to confirm.

## Output format

Report:
- The app you read
- The number of nodes returned (sanity check)
- The refs and labels relevant to what the user asked
- Frontmost app before and after — proof that focus did not change
