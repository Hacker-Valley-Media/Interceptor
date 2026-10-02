# TrustedInputGate

You are completing a flow that requires OS-level trusted input — a native app or web page that filters synthesized `CGEvents` and only accepts events from real hardware (real HID source state). This is the bench S8 workflow and the rare case where the synthetic-first default fails by design.

**Stay in the background.** The person is usually working on this Mac. Nothing in this workflow needs an app brought forward: a browser page takes `--trusted` input in an unfocused window, and a native app takes input addressed with `--app` / `--window`. Do not run `app activate`, `window focus`, or `tab switch` in the user's window to set up a trusted click.

**Try the default path first.** Synthetic events (the bridge's standard `click`/`type`/`keys`) work on almost everything. The browser-side equivalent — dispatched DOM events with `event.__interceptor_trust = true` — handles most `isTrusted`-checking webapps. Only escalate to `--os` after you've observed synthetic input failing.

## When `--os` is the answer

Look for these symptoms:
- The synthetic call returns successfully but the target acts as if nothing happened.
- The target is a native gate that checks `CGEventSourceGetSourceStateID` against `kCGEventSourceStateHIDSystemState`.
- The target is a webapp that reads `isTrusted` via a cached per-instance own property captured at boot (bypassing the prototype override).
- A banking, payment, or anti-automation page rejects standard input.

In those cases, `--os` flips the bridge to post events through `CGEvent.post(.cghidEventTap)` with `kCGEventSourceStateHIDSystemState`. The OS treats it as real hardware input.

## A browser page in a window that is not in front

A page that needs a trusted click does not need its window brought forward. On a full install:

```bash
interceptor click <ref> --trusted --tab <id>     # result: "delivered in the background, focus unchanged: …"
interceptor type <ref> "text" --trusted --tab <id>
interceptor keys Enter --trusted --tab <id>
```

The tab must be the active tab of its window and the window must not be minimized. The frontmost app and the cursor stay where they are. If the result carries `warning: the page reports hidden`, the browser has paused a fully covered window (Chrome does this, Brave does not): uncover part of it and retry. Read the page afterwards to confirm the effect.

## Verify permissions first

```bash
interceptor macos trust
```

The response shape:
- `accessibility` — must be `granted`. Without it, `CGEvent` posting fails silently.
- `screen_recording` — granted enables capture; not strictly needed for input gates.
- `microphone` / `input_monitoring` — separate consents, not required here.

If accessibility is `denied`, surface the deep link from `trust --walkthrough` so the user can grant it.

## The recipe

```bash
# A web page: trusted input to the tab, delivered in the background
interceptor click <ref> --trusted --tab <id>
interceptor type <ref> "..." --trusted --tab <id>
interceptor keys "Enter" --trusted --tab <id>

# A native app: address the app (and the window when it has several)
interceptor macos type "..." --app "<App>" [--window <id>]
interceptor macos keys "Meta+S" --app "<App>" [--window <id>]
```

A bare `interceptor macos type "..." --os` or `keys "..." --os` (no ref, no `--app`) goes to whatever app is frontmost, the way a real keyboard does. Use it only when the target is already frontmost by the user's own choice. Never activate an app to make it the target. If addressed delivery is rejected by a gate, stop and tell the user instead of taking focus.

## Worked example: the bench fixture

```bash
# 1. Navigate to the trusted-input page (browser surface)
interceptor open <trusted-input-fixture-url>

# 2. Identify the gate (read the page)
interceptor read --tree-only

# 3. If standard `type` doesn't satisfy the gate, escalate on the same ref.
#    The tab stays where it is; the result says "delivered in the background".
interceptor click <ref> --trusted                  # focus the input
interceptor type <ref> "expected text" --trusted   # OS-level keystrokes to that window

# 4. Verify the page accepted the input
interceptor read --text-only
```

The success criterion is whatever the gate reveals after acceptance — a "success" banner, a new DOM element, a network call. Read for it explicitly.

## Browser-side equivalent (when `--os` is wrong)

For webapps, the synthetic-events-with-trust-marker path is usually the right escalation, not `--os`. Dispatch via `eval --main`:

```javascript
const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
evt.__interceptor_trust = true;
element.dispatchEvent(evt);
```

Combined with the pre-load `userActivation` override (already installed via `inject-net.ts` at `document_start`), this handles transient-activation gates and per-event `isTrusted` checks without going to OS-level CGEvents. Only fall back to `--os` for native HID-source-state checks.

## Pitfalls

- **A bare `--os` call follows the frontmost app.** Your keys go to whatever the user is working in. Address the input instead (`--trusted` on a browser ref, `--app` / `--window` on a native app). Bare `--os` is only for a target the user already has in front.
- **Bringing the target forward to make `--os` work.** That takes the user's focus for something the addressed forms do in the background.
- **Reaching for `--os` reflexively.** The historical reflex "site checks `isTrusted` → use `--os`" is no longer correct on most sites. The pre-load `userActivation` override + `__interceptor_trust` marker handles the vast majority of webapps. Measure first.
- **Forgetting Accessibility consent.** `CGEvent.post` silently no-ops without it. If a `--os` call returns success but nothing happens, check `trust` first.
- **Sensitive frontmost-app gate.** The bridge rejects `type` / `keys` / `click x,y` / `drag` when frontmost is a denylisted bundle (Keychain, 1Password, Dashlane, LastPass, Bitwarden, System Settings, Chase, Bank of America, Wells Fargo). Surface the rejection to the user — do not try to bypass.

## Output format

Report:
- Why `--os` was needed (the observed symptom of synthetic failing)
- The exact call (`--trusted`, `--app` / `--window`, or bare `--os`)
- `frontmost` before and after (it must not change)
- The success indicator from the gate (banner text, new element, response status)
- Whether Accessibility TCC was granted before the call
