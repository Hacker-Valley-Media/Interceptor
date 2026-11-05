# CaptureBackgroundedApp

You are screenshotting a specific macOS app window without bringing it to the foreground. Use this when the user says "screenshot of Brave / Signal / Mail / X" and the app may be occluded, minimized, on another Space, or simply not frontmost. The user's focused window must not change.

**Do not call `interceptor macos app activate` first.** The whole point of this workflow is that you don't have to. The bridge uses `CGSHWCaptureWindowList` to pull the app's window directly from the compositor — it works on occluded, minimized, and cross-Space windows.

## The recipe

```bash
interceptor macos screenshot --app "Brave Browser" --save --target-max-long-edge 1568
```

That single call:
1. Resolves "Brave Browser" to a running app and its windows.
2. Captures the front window via `CGSHWCaptureWindowList` — no focus change.
3. Writes a WebP to disk and returns a path-only result (no inline base64).
4. Clamps the long edge to the VLM auto-resize ceiling (1568 for Sonnet; raise to 2576 for Opus).

Pair with the screenshot policy in `../../interceptor-browser/references/screenshot-policy.md` for budget rationale.

## Verify nothing moved

```bash
interceptor macos frontmost                            # before
interceptor macos screenshot --app "Brave Browser" ... # work
interceptor macos frontmost                            # after — should match
```

If the `before` and `after` frontmost differ, something foregrounded the target. Suspect:
- You called `app activate` somewhere in the chain.
- The AppleScript block you ran contained `activate` or `reopen`.
- The app cold-launched (`open` against a not-running target may self-activate via `kAEOpenApplication`).

## When to override the default

- `--window <windowId>` — the numeric `windowId` from `interceptor macos windows --app "X"`, not its ref (a ref fails). Use when an app has multiple windows: `--app` alone captures the largest one.
- `--format png` — archival fidelity; webp is the agent default.
- `--target-max-long-edge 2576` — Opus consumer.

## Pitfalls

- **`--mode display`.** Do NOT use it for app-specific captures. It captures the visible composite, which by definition has the wrong app on top — the whole point is the target *isn't* on top.
- **Activating "to be safe".** The bridge's CGS path was designed not to need it. Skip it.
- **Asking for a window that doesn't exist.** If the app has no visible windows (only a menu bar item, like a tray-only Electron app), the capture fails. Run `interceptor macos windows --app "X"` first to confirm at least one window exists.
- **Apps that disable window-server capture for security** (some payment / 1Password sheets). The capture returns empty or a black rectangle. There is no quiet escalation — surface the failure to the user.

## Output format

Report:
- File path written
- Dimensions and on-disk size
- Frontmost app before and after (proof of no focus change)
- What you saw in the image (the visual finding, not a description that "the screenshot worked")
