# DriveBackgroundedApp

You are clicking, typing, sending keys, scrolling, or dragging against a macOS app that is not frontmost, and you must not bring it to the foreground. The person is usually working on this Mac while you do. Use this when the user says "scroll Mail", "type into TextEdit without switching to it", "click that button in Signal while I keep working", or any task where the target app is occluded, hidden, or just not focused.

**Do not call `interceptor macos app activate` before the input.** That defeats the entire purpose. The bridge has dedicated background-routing paths (AX press, AX value-set, and events addressed to one window of one app) that deliver input without changing what the user is looking at. The frontmost app and the cursor stay where they are.

## The routing paths

| You provide | What the bridge does | Frontmost changes? |
|---|---|---|
| A ref (`e5`, `e2_7`) | `AXUIElementPerformAction(kAXPressAction)` or `AXUIElementSetAttributeValue(kAXValueAttribute, ...)` — pure AX, no event posting | No |
| `--app "X"` or `--pid <n>` (no ref) | Events addressed to one window of that app: the window under the point for click / drag / scroll, the app's focused window for type / keys | No |
| `--window <id>` added | The same, to exactly that window (ids come from `interceptor macos windows --app "X"`). Use it when the app has several windows | No |
| Neither | Falls back to `cghidEventTap` (legacy "drive whatever's frontmost") | Whatever's frontmost gets it |

**Always prefer refs.** They're the strongest signal of intent, they don't need focus, and they're the path that's been live-verified to leave frontmost untouched.

## AX value-set is gated to text-bearing roles

`AXTextField`, `AXTextArea`, `AXSearchField`, `AXComboBox`. Other roles fall back to synthesized key events posted via `postToPid` of the ref's owning PID. You usually don't need to think about this — the bridge routes for you — but it's why typing into a Cocoa text field "just works" and typing into a custom drawn control doesn't.

## Reading the routing tag

Every input verb returns a routing tag in its success message. **Always check it.**

- `"ax-pressed ref"` — pure AX press. No event posting. Fastest, most reliable.
- `"ax-set value (N chars)"` — AX value-set. The N matches the string length you asked for.
- `"clicked at (x, y) → pid=NNNN window=MMMM"` — events addressed to that window of that app. Good: no focus change. Check the window id is the one you meant.
- An error ending `(nothing was delivered)` — the window is minimized, the app is hidden, or the point is outside the app's windows. Nothing was clicked. `interceptor macos windows --app "X"` lists frames and ids.
- `"clicked at (x, y) → frontmost"` — synthesized CGEvent on the system HID tap. **This is the legacy fallback.** If you see this when you expected per-PID delivery, the target wasn't resolvable. Pass `--app` or `--pid` explicitly.

## Worked example: type into a backgrounded TextEdit while another app stays frontmost

```bash
# Whatever's frontmost stays frontmost. We populate TextEdit silently.
interceptor macos open "TextEdit"                          # no activation; reads AX state
interceptor macos focused --app "TextEdit"                 # → ref e1 = AXTextArea
interceptor macos type e1 "hello, background world"        # → "ax-set value (21 chars)"
interceptor macos value e1                                 # confirms text landed
interceptor macos frontmost                                # unchanged
```

The final `frontmost` call is the proof of correctness — same app before and after.

## Worked example: scroll Mail without touching it

```bash
interceptor macos scroll down 400 --app "Mail" --times 5 --interval-ms 80
interceptor macos frontmost                                # unchanged
```

The wheel events are addressed to Mail's window. Cocoa, Electron, and browser windows handle this in the background.

## Worked example: click into Signal (Electron, occluded)

```bash
interceptor macos tree --app "Signal" --filter interactive   # AX tree auto-wakes via AXManualAccessibility
interceptor macos act e7                                     # AX press on the ref — "ax-pressed ref"
```

## Pitfalls

- **A fully covered Chrome window.** Chrome can pause a window that is completely covered, so an input lands and nothing happens. Brave and Electron apps took clicks, keys, and scrolls while fully covered. Do not raise the app to fix it. Check you addressed the right window (`--window <id>`), then tell the user the window needs to be partly uncovered and let them decide.
- **Several windows of one app.** Without `--window`, a point click goes to the app's front window at that point and keys go to its focused window. For a browser that is usually the user's window. Pass `--window <id>`.
- **Minimized window or hidden app.** Click and drag refuse with `(nothing was delivered)`. Unminimizing takes focus, so say so before doing it.
- **An app that is not running.** Launching it can bring it forward even through `interceptor macos open` without `--activate`, and some apps raise an updater password prompt on launch. Do not launch an app just to test or look at something.
- **The legacy fallback.** A bare `interceptor macos click 100,200` with no ref / `--app` / `--pid` follows the user's current frontmost. That's documented behavior, but it's almost never what you want.
- **AX value-set blowing away existing text.** It replaces the field's value with what you pass. To append, read `value <ref>` first, concatenate, then `type <ref> "<combined>"`.
- **Stale refs after a redraw.** AXObserver invalidates refs when the app rebuilds part of its tree. If `act <ref>` returns "stale ref", re-run `tree --app "X"` or `focused --app "X"`.

## Output format

Report:
- The routing tag returned by each input verb (`ax-pressed ref`, `ax-set value (N chars)`, `→ pid=NNNN window=MMMM`)
- What you intended to do vs what landed (verify with `value <ref>` for text, `read` / `tree` for clicks)
- Frontmost app before and after — proof that focus did not change
- If `→ frontmost` appeared when you didn't want it: which call, and the corrected invocation with `--app` or `--pid`
