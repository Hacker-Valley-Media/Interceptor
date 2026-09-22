# Interceptor iOS — command catalog

Every command is `interceptor ios <sub> [args] [--on <name>] [--json]`. A phone is
addressed by alias (`--on phone`), by udid (`ios:<udid>`), or omitted when only one
phone is set up. Phones auto-connect on the first drive verb.

## Setup (one-time)

| Command | What it does |
|---|---|
| `interceptor ios setup [<device>] [--team <id>]` | Xcode self-service: build + sign + install + launch the runner using the Apple ID signed into Xcode. |
| `interceptor ios login` | Unsupported compatibility command. Fails before password input and points to `ios setup`. |
| `interceptor ios logout` | Remove legacy stored Apple-ID data. |
| `interceptor ios refresh [<device>]` | Re-sign the installed runner now (also automatic before certificate expiry). |
| `interceptor ios install [<device>]` | Reinstall a runner already signed by `ios setup`. Refuses the unsigned release input. |
| `interceptor ios devices` | Phones with the agent installed, plus aliases, transport (USB/network), and iOS version. |
| `interceptor ios discover` | Full device discovery with toolchain + readiness notes. |
| `interceptor ios status` | Per-phone connection state: `connected` while the resident runner is dialed in, with its registration time; `disconnected` when it is not (the next drive verb auto-connects). |
| `interceptor ios name <device> <alias>` | Alias a phone so you can use `--on <alias>` (e.g. `--on phone`). |

## Drive verbs

| Command | What it does |
|---|---|
| `interceptor ios tree [--filter interactive\|all\|full]` | Ref-tagged element tree of the foreground app. Re-read before acting. |
| `interceptor ios find --label "Send" [--role button]` | Find elements by label and/or role; returns refs + frames. |
| `interceptor ios inspect <ref>` | Element details (type, label, enabled, frame). |
| `interceptor ios click <ref> \| --x N --y N` | Deterministic coordinate tap at the ref's frame center (or raw coordinates). |
| `interceptor ios type <ref> "text"` | Focus the field at `<ref>`, then type. Most reliable text entry — focus is atomic. |
| `interceptor ios keys "text"` / `ios keys Enter\|Return\|Tab` | Type into whatever is already focused (append); `Enter`, `Return`, or `Tab` as the whole argument presses that key (a real newline character does the same; the two characters `\n` are typed literally). |
| `interceptor ios type <ref> --secret <name>` / `ios keys --secret <name>` | Type a vault secret (passcode) by name; the daemon resolves it and the runner falls back to SpringBoard when a system passcode sheet owns the keyboard. Register once: `interceptor macos secret register ios-passcode --target ios`. |
| `interceptor ios unlock --secret <name>` / `ios unlock --probe` | Lock screen: wake, swipe up, type the passcode into SpringBoard's passcode field, wait for unlock. Needs the runner resident (it cannot start on a locked phone). `--probe` reports lock state + whether the passcode field appeared, without typing. |
| `interceptor ios scroll [<ref> \| --x N --y N] [--dir up\|down\|left\|right]` | Swipe 250 points from the ref's center, from a screen point, or (bare) from the screen center. `--dir` defaults to `down`. A ref that no longer resolves, or `--x` without `--y`, is an error: no gesture is sent. |
| `interceptor ios drag <from> <to> [--duration s]` | Drag between two ends; each is a ref (frame center) or a screen point written `x,y` (`120,330`), and the two kinds can be mixed. `--duration` is the press time in seconds before the move (default 0.6, fractions allowed, at most 55: the gesture deadline is 60 s). |
| `interceptor ios drag 200,400 200,400 --duration 2` | Long press: the same point twice. Use it for context menus and press-and-hold controls. It returns once the press has played, whether or not the surface settles (the Home Screen's icon menu, a browser's animating new-tab page). A runner built before 1.0.14 still waits up to 60 s for such a surface to idle and times out: run `interceptor ios refresh` once; `ios fgdebug` lists the patched `idleWait` selectors on the current runner. |
| `interceptor ios press home\|lock\|volume-up\|volume-down` | Hardware button. `lock` locks the phone (avoid mid-flow — it blocks launches). |
| `interceptor ios screenshot` | Capture the screen; saved as a VLM-budget-resized JPG. |
| `interceptor ios stream start\|stop\|status [--fps N] [--scale S] [--quality Q] [--out <path>]` | Continuous frames without a cable: the runner captures, downscales (default half size), JPEG-encodes (default quality 0.3), and pushes each frame over its own Wi-Fi socket at up to `--fps` (default 10, max 30). The daemon keeps the newest frame and, with `--out`, rewrites that file atomically for every frame, so a perception loop reads one path whenever it wants a look. `status` reports frames received, `ageMs` of the newest, `receivedFps`, frame `width`/`height` in pixels, and the runner's `lastCaptureMs`/`lastEncodeMs`. Runs alongside `click`, `gesture`, and `tree`. Not the Instruments `ios screen` poll. |
| `interceptor ios frame [--out <path>]` | Save the newest streamed frame (default `interceptor-ios-frame-<seq>.jpg` in the working directory) and print its seq, age, and size. No device round trip; an error when no stream has delivered a frame. |
| `interceptor ios gesture <finger> [<finger>...] [--hold ms]` | Multi-touch in one record, up to 10 fingers. Each positional is one finger written `x,y[@ms][>x,y@ms...]`: the first sample presses, later samples move, the last lifts. A lone `x,y` presses at 0 and lifts at `--hold` (default 100 ms). Points are in the app's own coordinate space, the same as `click`, `drag`, and the frames in `tree`; for a landscape app (a wider-than-tall app frame) the runner maps them to the screen and reports `orientation` (1 portrait; 3 the landscape with the camera cutout on the left, 4 on the right) and `orientationSource` (`app` when the app named the landscape side, `frame` otherwise). A phone lying on its side turns rotating apps such as Safari landscape too, so read `tree` or `find` frames for the current layout before choosing points. Returns when the record has played (`elapsedMs`, about 250 ms over the record length). The runner plays the timeline as written and applies no tap or long-press threshold; the app decides what a hold means (UIKit long-press recognizers want about 500 ms, so a short `--hold` reads as a tap). The last offset is at most 55,000 ms. Uses XCTest's private event record; on an SDK without it the error names the missing symbol. |
| `interceptor ios apps` | Installed apps on the phone (bundle id, name, version). |
| `interceptor ios app launch\|activate\|terminate <bundleId>` | App lifecycle by bundle id (e.g. `com.apple.Preferences`). |

### Apps with no element tree (games, canvases)

Coordinates are screen points, the same space as the frames in `ios tree` (the root element's frame is the screen size). When the tree is empty or useless, read the screen with the Mac's Vision framework and act by coordinate:

```bash
interceptor ios screenshot --on phone                               # prints the saved path
interceptor macos vision text --image <that path>                   # regions: text plus a normalized box
interceptor ios click --x 196 --y 412 --on phone                    # tap
interceptor ios drag 196,412 196,412 --duration 2 --on phone        # long press
interceptor ios scroll --x 196 --y 600 --dir down --on phone        # swipe from a point
```

A driving game wants a pedal held while an arrow is tapped, and a fresh look every few hundred milliseconds. Stream frames to one file and read that file; hold and tap in one gesture:

```bash
interceptor ios stream start --fps 5 --out /tmp/phone.jpg --on phone    # best effort: the runner sends what it captures; the file is rewritten atomically
interceptor macos vision text --image /tmp/phone.jpg                      # read the HUD from the newest frame
interceptor ios gesture "380,700@0>380,700@600" "120,650@100>120,650@300" --on phone   # gas held 600 ms, steer tapped 100 to 300 ms
interceptor ios stream status --on phone                                  # frames, ageMs, receivedFps, capture and encode ms
interceptor ios stream stop --on phone
```

Frame pixels map to screen points by the frame size over the screen size (`ios inspect e1` gives the screen frame in points): `x_pt = x_px * W_pt / width`. Frames follow the app's orientation (a landscape game gives a 1434x660 frame for a 956x440 point space), and capture is slower while a game renders (about 500 ms per frame against 100 ms on a static app), so ask for 3 to 5 fps in a game and 10 on ordinary apps.

Vision boxes are normalized 0 to 1 with the origin at the bottom left, so for a screen `W` by `H` points the center of a region is `x = (box.x + box.width / 2) * W` and `y = (1 - box.y - box.height / 2) * H`.

## Runner-free lanes (Instruments / DTX / telemetry)

These reach the device over the RemoteXPC tunnel **without** the XCUITest runner, so
they work even when the runner is idle or asleep. Routed before the runner fallback.

| Command | What it does |
|---|---|
| `interceptor ios proc` | Live process list (Instruments deviceinfo). |
| `interceptor ios top [--follow]` | Per-process CPU/mem + per-core load (sysmontap). First real sample lands ~1.2 s in. |
| `interceptor ios gpu [--follow]` | FPS / GPU sampling (graphics.opengl). |
| `interceptor ios spawn <bundle> [--env K=V ...] [--arg X ...]` | Launch an app with env/args (processcontrol) → returns pid. |
| `interceptor ios kill <pid>` | Kill a process by pid. |
| `interceptor ios location set <lat> <lon>` / `location clear` | Simulate / clear the device GPS fix. |
| `interceptor ios shot [<out.png>]` | One-shot screenshot via Instruments (runner-free; falls back to the runner). |
| `interceptor ios backup` | mobilebackup2 handshake + protocol info. |
| `interceptor ios screen [--out <dir>] [--seconds N] [--fps F]` | Live screen frames (via the runner). |
| `interceptor ios axtree` | Runner-free accessibility probe (axAuditDaemon). |

## On-device JS brain

| Command | What it does |
|---|---|
| `interceptor ios eval "<js>" \| --file <f.js>` | Run a JS program inside the runner's JSContext. An `Interceptor` global bridges to the device: `tree()`, `tap(x,y)`, `type(text)`, `sleep(ms)`, `log(msg)`, `foreground()`. A whole observe→decide→act loop runs on the phone in **one round-trip**. `tree()` nodes carry `{label, type, rect:{x,y,width,height}, children[]}`; a `rect` center is directly tappable. |

## Other lanes

- `interceptor ios web <targets\|attach\|read\|text\|find\|eval\|call\|console\|network\|...>` — inspect/drive Safari & WKWebView content (WebInspector). `interceptor ios web --help`.
- `interceptor ios <logs\|diag\|fs\|crash\|profiles\|notify\|springboard>` — runner-free classic-Lockdown device services (diagnostics, syslog, AFC files, crash reports, profiles, Darwin notifications, SpringBoard). `interceptor ios <sub> --help`.

## Addressing

- `--on <alias>` — the friendly name set with `interceptor ios name`.
- `--context ios:<udid>` — explicit context id; also how `interceptor contexts` lists the phone.
- Omit both when exactly one phone is set up.

## Notes

- **Refs are coordinates, not handles.** They are re-minted on every `tree` read, so
  they never go stale the way server-side element ids do — but they only reflect the
  screen at read time. Re-read after any navigation.
- **Unlocked + foreground.** A locked phone refuses app launches. Keep Auto-Lock off so
  the runner stays resident; while connected, `ios unlock --secret <name>` attempts
  passcode entry and requires an observed unlocked state for success. Disconnected unlock
  and `--probe` fail immediately. Unlock once and run `ios tree` to connect first.
- **Passcodes come from the vault.** Nothing can fake Face ID or Apple Pay. A passcode sheet
  is typed with `ios type <ref> --secret <name>` / `ios keys --secret <name>`; never put a
  passcode in a literal `type` call. Register it once with
  `interceptor macos secret register <name> --target ios`.
- **After a device reboot.** The phone drops off usbmux (its Wi‑Fi route is cleared even though `xcrun devicectl list devices` still lists it) → a brief USB cable touch reseeds it. The first runner launch also pops an on-device *"Enter iPhone Passcode for XCTest — Enable UI Automation"* dialog. Runner-free lanes (`proc`/`shot`) keep working through all of this.
- **The XCTest authorization sheet cannot be entered from the Mac. Stop and ask.** It blocks the runner itself, so `ios unlock` / `keys --secret` cannot reach it; AccessibilityAudit and Accessibility Inspector read it but every action on it reports unsupported (field stays `0 of 6`); Switch Control cannot target a digit; iPhone Mirroring does not forward keystrokes to it; re-signed copies of Apple's tools lose the private entitlements. Report the sheet and ask for a tap on the phone (or a paired hardware keyboard), then restart the daemon (drops the stale testmanagerd session) and retry.
- **Unsigned or stale staged runner.** A drive verb now fails in under a second with the signing reason and `run: interceptor ios setup <udid>` instead of a two-minute "did not register" timeout; an early `xcodebuild` exit is reported with its exit code and stderr tail. Run `interceptor ios setup` when you see either. A runner that `ios setup` built is kept across package upgrades (the bundled unsigned build no longer replaces it); run `interceptor ios refresh` to rebuild on a newer bundled runner.
- **Runner socket dropped.** The daemon holds the session for 10 s (`ios status` shows `connecting`) while the runner re-dials; only a lapsed window or a dead launch process tears it down.
- **Runner never registers (`did not register within 120s`).** The error names the address the runner was handed and the rung that chose it (`ios status` → `dialBack` / `dialBackVia`). A local-network address (rungs `interface`, `subnet`, `default-route`, `first`) is silently denied while the runner's Local Network privilege is still undetermined: XCTest backgrounds the runner before it dials, and iOS denies a backgrounded app's local-network connection without showing the alert (TN3179). Once Settings › Privacy & Security › Local Network shows InterceptorRunner-Runner switched on, LAN dial-back registers in about 10 s. Fixes: grant that switch, or put the phone and Mac on the same VPN (Tailscale), which the daemon prefers automatically (`dialBackVia: vpn`). `INTERCEPTOR_WS_URL` overrides the ladder.
- **Away from home (phone on cellular + VPN only).** Not driveable: iOS does not expose lockdown (62078) or RemotePairing (49152) on the VPN interface (`Connection refused`), so usbmuxd cannot see the phone and no runner can be launched. A computer next to the phone (USB or its Wi-Fi) must run the daemon. Runner-free lanes are equally blocked.
- Add `--json` to any command for machine-readable output.
