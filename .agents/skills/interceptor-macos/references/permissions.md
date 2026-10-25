# macOS Permissions

TCC permission model, response shape, microphone re-poll pattern, Dock-icon notes, and feature-to-permission mapping. Reference doc — load when a native call returns "permission denied" or you need to surface a TCC prompt to the user.

## The trust command

```bash
interceptor macos trust                              # Current snapshot
interceptor macos trust --no-prompt                  # Read-only — forces every prompt flag false
interceptor macos trust --prompt                     # Fire all three TCC prompts
interceptor macos trust --walkthrough                # Prompt + open Settings pane
interceptor macos trust --accessibility-prompt
interceptor macos trust --screen-prompt
interceptor macos trust --microphone-prompt
```

Treat `interceptor macos trust` as a **permission snapshot**, not a runtime-health check. Use `interceptor status` to confirm the bridge socket is live before debugging native runtime failures.

For packaged installs, `/Applications/Interceptor.app` owns helper registration and privacy onboarding. `trust` reports app-owned trust state, not proof that a shell-launched probe will succeed. For microphone-sensitive workflows, verify the live path with `interceptor macos audio input start/stop` after trust looks good.

## Response shape

Every permission carries a `status` string drawn from Apple's `AVAuthorizationStatus` vocabulary:

| Status | Meaning | Where it can appear |
|---|---|---|
| `granted` | User authorized | All three permissions |
| `denied` | User declined (or never asked, on AX/Screen — Apple does not distinguish) | All three permissions |
| `not_determined` | User has not yet been prompted | **Microphone only** (Apple's `AXIsProcessTrusted` / `CGPreflightScreenCaptureAccess` return `Bool` only) |
| `restricted` | System policy blocks user from changing it | **Microphone only** |

AX and Screen Recording entries carry a `limitation` field documenting that 2-state asymmetry. Microphone entries do not — its status is fully expressive.

The legacy `granted: bool` field is still emitted for one release (computed from `status == "granted"`) for backward compatibility. Migrate to `status`.

## Worked example: re-poll the microphone after a prompt

The microphone prompt is non-blocking. The call returns immediately while the user is still deciding — you re-poll later.

```bash
interceptor macos trust --microphone-prompt --json
# returns immediately:
# { "microphone": "not_determined", "pending_user_action": ["Microphone"], ... }

# user clicks Allow on the system prompt at their leisure...

interceptor macos trust --json
# response after the user answered:
# { "microphone": "granted", ... }
```

This contract matches Apple's documented `requestAccess(for:completionHandler:)` semantics: *"Calling this method doesn't block the thread while the system is prompting the user for access."*

## Why the mic prompt briefly shows a Dock icon

When `--microphone-prompt` (or `--prompt` / `--walkthrough` / `--prompt-with-microphone-permission`) fires for the first time, you'll see `interceptor-bridge` flash into the Dock for a few seconds. **That is intentional and expected.**

The bridge ships as `LSUIElement = true` (background-only). Without temporarily upgrading `NSApp.setActivationPolicy(.regular)`, macOS surfaces the Microphone permission alert as a *transient banner* that auto-dismisses to "denied" before most users see it. The bridge upgrades to `.regular` immediately before `AVCaptureDevice.requestAccess`, then reverts to `.accessory` in the completion handler — same canonical pattern Hammerspoon, Bartender, and Karabiner-Elements use.

`camera start --prompt` uses the same upgrade for the camera prompt, and after the answer it gives focus back to the app that was frontmost when the call arrived. A plain `camera start` never prompts.

Accessibility and Screen Recording prompts do NOT need this treatment because their alert / Settings flows are window-server-level and don't depend on the calling app's activation policy.

## Microphone capture writes a real file

`interceptor macos audio input start --save` writes a CoreAudio Format file to `/tmp/interceptor-audio-input-<unix-ts>.caf` using `AVAudioEngine.inputNode` + `AVAudioFile`. The response payload's `filePath` field returns the same path on both `start` and `stop` — callers don't need to grep `/tmp`.

Format is whatever the default input device negotiates (typically `2 ch, 48000 Hz, Float32, interleaved`). Same API path Parrot uses; same TCC anchor (`com.apple.security.device.audio-input` entitlement, `NSMicrophoneUsageDescription` in Info.plist).

This matters for verification: if you expect a 5-second recording to exist on disk, it actually does. Read it back with `interceptor macos fs read` or any other file consumer.

## Feature-to-permission mapping

| Permission | Required for | Optional for |
|---|---|---|
| Accessibility | AX tree, AX input verbs, window management, `monitor`, refs that route to AX, the entire macOS surface really | — |
| Screen Recording | `screenshot`, `capture *`, `stream *`, `vision *`, `--frames` on `monitor` | reads that don't capture pixels |
| Microphone | `listen`, `vad`, `sounds`, `audio input`, `--include speech` on `monitor` | text-only paths |
| Camera | `camera start` (`camera start --prompt` shows the prompt the first time; `camera status` reports `authorization`). `trust` does not list it yet | `camera list`, `camera status` |
| Input Monitoring | Global key / click capture in `monitor` | one-shot synthesized input via `click` / `type` / `keys` |
| Apple Events | `intent dispatch` against a specific bundle id | granted per-app on first dispatch |

If `interceptor macos *` reports `Interceptor bridge not running` or `connection closed before response`, the helper lifecycle is unhealthy even if `trust` says permissions are granted. Surface that to the user; do not retry blindly.

## Per-permission flags

Narrow flows when you only need one prompt:

- `--accessibility-prompt` — Accessibility alone.
- `--screen-prompt` — Screen Recording alone.
- `--microphone-prompt` — Microphone alone (this is the one that flashes the Dock).

## Pitfalls

- **Assuming `granted` means runtime works.** It means TCC says yes. Helper / launchctl issues can still break the live path. Verify with the actual operation (`audio input start --save` for mic; `screenshot --app ...` for screen).
- **Looping on a "denied" status.** If the user explicitly denied, no amount of re-polling fixes it. Surface the deep link from `trust --walkthrough` and ask.
- **Restricted-by-policy.** `restricted` means the user *cannot* change it (parental controls, MDM). Don't tell the user to "click Allow" — there is no Allow option for them.
