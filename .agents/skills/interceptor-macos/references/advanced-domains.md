# Advanced Domains

The macOS bridge supports more than the daily-driver set. These domains are fully supported but used less frequently — pull from this reference when the task specifically benefits from one of them. Tiering is presentation, not deprecation.

## Apps & Windows

```bash
interceptor macos apps                           # All running apps with name, pid, bundle ID
interceptor macos app activate "Finder"          # FOCUS CHANGE: only when the user asks for the app to come forward
interceptor macos app hide "Finder"              # Hide
interceptor macos app quit "Finder"              # Quit
interceptor macos app launch "com.apple.finder"  # Launch by bundle ID
interceptor macos frontmost                      # Current frontmost app
```

`apps` returns enough metadata to drive the cross-app routing recipes below without a separate AX read.

## Menu Traversal

```bash
interceptor macos menu                           # Frontmost app's full menu tree
interceptor macos menu --app "Finder"            # Specific app
interceptor macos menu "File" "New Folder"       # Invoke a menu item by path
```

Menu invocation goes through AX `AXPress` — does not need the app to be activated for many apps. Use it for deterministic menu paths instead of replicating keyboard shortcuts.

## Apple Events (`intent`)

```bash
interceptor macos intent dispatch --bundle com.brave.Browser --script 'open location "https://example.com"'
interceptor macos intent dispatch --bundle com.brave.Browser --script 'tell application "Brave Browser" to URL of active tab of front window'
interceptor macos intent warmup --bundle com.brave.Browser
```

- Apple Events deliver to a target bundle id without raising it. The most ergonomic path for cross-app routing (Notes → Slack, Mail → Brave) and for reading state from a backgrounded app (active tab URL, current selection).
- TCC consent is per (bridge, target_app) pair. First call to a new target app prompts. `intent warmup` pre-prompts so the first useful call doesn't stall.
- The script string is full AppleScript. Quoting matters — use single-quoted shell strings around AppleScript double quotes.
- See [`docs/native/app-intent.md`](../../../../docs/native/app-intent.md) for the full guide.

## Container Runtime (macOS 26+)

```bash
interceptor macos container run <image>
```

Run an OCI image in Apple's `container` runtime. Useful when an agent task needs an isolated build/test environment without Docker. See [`docs/native/container-run.md`](../../../../docs/native/container-run.md).

## Log Query

```bash
interceptor macos log query --subsystem com.apple.network --level error --last 30s
interceptor macos log query --predicate 'subsystem == "com.example.foo" && level == "fault"' --last 5m
```

Wraps `OSLogStore`. Use it for kernel-level diagnostics, framework error trails, and any signal that lives in unified logs rather than app stdout. See [`docs/native/log-query.md`](../../../../docs/native/log-query.md).

## Filesystem (`fs`)

```bash
interceptor macos fs read /path/to/file
interceptor macos fs write /path/to/file "contents"
interceptor macos fs search "query string"          # Spotlight via NSMetadataQuery
```

Native FileManager + UTType + Spotlight. Different surface than Bun / shell `cat` / `find` — this is the macOS-native path with proper UTType recognition and Spotlight metadata. See [`docs/native/fs.md`](../../../../docs/native/fs.md).

`fs write` honors a denylist for sensitive paths; review [`docs/native/safety.md`](../../../../docs/native/safety.md) before relying on it for arbitrary writes.

## URL Fetch (`url`)

```bash
interceptor macos url get "https://api.example.com/data"
interceptor macos url post "https://api.example.com/x" --body '{"k":"v"}'
```

URLSession + cookies + ETag handling + bodyRef sidecar pattern for responses >64 KB. The bodyRef sidecar avoids blowing up the agent context with multi-MB JSON; the response header carries a ref the agent can dereference on demand. See [`docs/native/url-fetch.md`](../../../../docs/native/url-fetch.md).

## Files Watch

```bash
interceptor macos files watch ~/Desktop          # Stream events as files in the directory change
```

Backed by `FSEvents`. Use when an agent needs to react to file system changes (downloads finishing, exports landing, log rotation). For direct file reads, prefer `fs read`.

## Notifications

```bash
interceptor macos notifications tail             # Live notification stream from Notification Center
```

Reads delivered notifications with title, body, app, and timestamp. Use it to react to alerts, calendar reminders, and long-running task completions.

## Clipboard (extended)

```bash
interceptor macos clipboard read                 # Read current pasteboard
interceptor macos clipboard write "text"         # Replace clipboard
interceptor macos clipboard tail                 # Stream every clipboard change
```

`clipboard tail` is one of the easiest ways to bridge data between an agent loop and a human ("copy this and I'll process it").

## Sensitive Content

```bash
interceptor macos sensitive ...
```

Sensitive content analysis (NSFW detection, etc.) for vetting captured frames before passing them to a model. Configure per environment.

## Trust & Permissions

```bash
interceptor macos trust                          # Read-only snapshot — every field is a status string
interceptor macos trust --no-prompt              # Defense-in-depth read-only (overrides every other prompt flag)
interceptor macos trust --prompt                 # Fire all three TCC prompts (non-blocking)
interceptor macos trust --walkthrough            # Prompt + auto-open the next missing Privacy pane
interceptor macos trust --accessibility-prompt   # Single-permission prompt
interceptor macos trust --screen-prompt          # Single-permission prompt
interceptor macos trust --microphone-prompt      # Single-permission prompt
```

`trust` is the entry point for permission troubleshooting. Every field — top-level `accessibility` / `screenRecording` / `microphone` plus `permissions[].status` — is a string drawn from Apple's `AVAuthorizationStatus` vocabulary: `granted | denied | not_determined | restricted`. Apple's AX and Screen Recording APIs return `Bool` only, so those entries can only ever surface `granted` or `denied`; both carry a `limitation` field documenting the asymmetry. Microphone entries surface all four values and never carry `limitation`. The legacy `granted: bool` shim is still emitted for one release for backward compat — migrate to `status`.

The microphone prompt is non-blocking — it returns immediately with `microphone: "not_determined"` and `pending_user_action: ["Microphone"]` while the macOS dialog is awaiting the user's response. Re-poll `trust` to observe the resolved state. Per Apple's documented `AVCaptureDevice.requestAccess(for:completionHandler:)`: *"Calling this method doesn't block the thread while the system is prompting the user for access."*

When `--microphone-prompt` (or `--prompt` / `--walkthrough`) fires for the first time, `interceptor-bridge` flashes into the Dock for ~5 seconds. That is intentional. The bridge ships as `LSUIElement = true` — without temporarily upgrading `NSApp.setActivationPolicy(.regular)`, macOS surfaces the Microphone alert as a transient banner that auto-dismisses to "denied" before most users see it. The bridge upgrades to `.regular` immediately before `requestAccess` and reverts to `.accessory` in the completion handler — same pattern Hammerspoon, Bartender, and Karabiner-Elements use. Accessibility and Screen Recording prompts do not need this treatment.

Two requirements per Apple's [`requesting-authorization-for-media-capture-on-macos`](https://developer.apple.com/documentation/bundleresources/requesting-authorization-for-media-capture-on-macos): `NSMicrophoneUsageDescription` in Info.plist (we ship one), and `com.apple.security.device.audio-input` as an entitlement on the signed binary (we ship one). Without either, the system terminates the request silently rather than showing the dialog.

## Display & Stream

```bash
interceptor macos display list                   # Physical + virtual displays
interceptor macos display create 1920x1080       # Create a virtual display (CGVirtualDisplay)
interceptor macos display remove <id>
interceptor macos stream start --app "Finder"
interceptor macos stream frame
interceptor macos stream fps
interceptor macos stream stop
```

Virtual displays let an agent drive an offscreen workspace without taking over a real monitor. `stream` is the continuous version of `capture`.

## Text (selection / visible / full)

```bash
interceptor macos text                           # Read selection, then visible text, then full text
```

Reads whatever the frontmost app exposes via AX. Some apps expose only the selection; some expose the full document. Best-effort fallback chain.

## Apple Intelligence (`ai`, macOS 26+)

```bash
interceptor macos ai prompt "Summarize this paragraph"
```

On-device LLM through Apple Intelligence. Useful for cheap, private summarization / classification when the agent doesn't need a frontier model. macOS 26+ only.

## Overlays

Particles, SpriteKit titans scene, scene-script DSL, HTML HUD overlays. NSPanel-backed, composited above app content. Panic hotkey `Ctrl+Opt+Cmd+Escape` closes every active overlay regardless of session. See [`docs/native/overlays.md`](../../../../docs/native/overlays.md), [`docs/native/scene-script-cookbook.md`](../../../../docs/native/scene-script-cookbook.md), and [`docs/native/vision-anchored-huds.md`](../../../../docs/native/vision-anchored-huds.md) for the full overlay system.

## Compound

The bridge exposes a compound surface that bundles multiple primitives behind one wire call (`interceptor macos open`, `read`, `act`, `inspect` all bottom out in the compound domain). Most agent calls flow through compound; the individual primitive commands are still available for surgical control.

## Packaged-install notes

- The shipped `/Applications/Interceptor.app` owns helper registration and privacy onboarding.
- `interceptor macos trust` in a packaged install reports app-owned trust state, not proof that a shell-launched probe will succeed.
- If `interceptor macos *` reports `bridge not running` or `connection closed before response`, the helper lifecycle is unhealthy even if `trust` says permissions are granted. Run `interceptor status` before debugging deeper.
