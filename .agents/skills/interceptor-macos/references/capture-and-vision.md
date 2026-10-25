# Capture And Vision

## Capture (ScreenCaptureKit + CGSHWCaptureWindowList)

```bash
interceptor macos screenshot                       # Frontmost window
interceptor macos screenshot --app "Brave Browser" # Specific app — works occluded / minimized / cross-Space
interceptor macos screenshot --save                # Save to disk; result has filePath, no inline data
interceptor macos screenshot --save --target-max-long-edge 1568   # Clamp long edge for upload-friendly size
interceptor macos capture start                    # Start continuous 30 fps capture
interceptor macos capture frame                    # Get latest frame
interceptor macos capture stop
```

Default capture is **background-friendly** — `CGSHWCaptureWindowList` reads compositor buffers without raising the target. Use `--app "X"` instead of activating the app.

## Camera (no window)

```bash
interceptor macos camera list                      # Cameras: built-in, Continuity (iPhone), Desk View, USB
interceptor macos camera start                     # Default camera; --device <id|name>, --fps 1-30 (default 10)
interceptor macos camera start --prompt            # First use only: show the macOS camera prompt, then return focus
interceptor macos camera frame --out frame.jpg     # Latest frame to a JPEG; without --out, an inline data URL
interceptor macos camera frame --out f.jpg --max-long-edge 640
interceptor macos camera status                    # active, device, frameAgeMs, frames, authorization, interruption
interceptor macos camera stop
interceptor macos vision faces --image frame.jpg   # Vision over a camera frame
```

The bridge holds the camera session, so nothing has to stay on screen and covering windows do not freeze the feed. Until the camera grant is decided, `camera start` refuses with `permission_required` and names `camera start --prompt`. That one call shows the macOS camera prompt for interceptor-bridge, then returns focus to the app that was in front (the result's `returnedTo`); a denied grant returns `permission_required`. `start` reports `deviceFps`, the rate the camera itself was set to. The camera light is on while the session runs; `camera stop` turns it off. A bare `ffmpeg -f avfoundation` from a terminal or agent shell has no bundle to grant and waits on a prompt that never appears; use this instead. `status` reports `interruption` when the camera is taken away mid-session (lid closed, a Continuity iPhone walked off) rather than serving an old frame as live: check `frameAgeMs`.

## Stream (continuous frames)

```bash
interceptor macos stream start --app "Finder"
interceptor macos stream frame                     # Latest JPEG data URL
interceptor macos stream fps                       # Current FPS
interceptor macos stream stop
```

## Vision (on-device, Apple's Vision framework)

```bash
interceptor macos vision text                      # OCR — read printed text in frontmost window
interceptor macos vision faces                     # Face detection (bounding boxes + landmarks)
interceptor macos vision hands                     # Hand pose (21-joint model)
interceptor macos vision bodies                    # Body pose
interceptor macos vision classify                  # Scene and object labels with confidence
interceptor macos vision saliency                  # Regions that draw attention
interceptor macos vision text --image shot.png     # Any verb over a saved image file instead of a window
```

`--app <name>` picks a window; without it the frontmost window is used. `--image <path>` replaces the window with a file: nothing is captured, no app has to be open, a relative path resolves from your working directory, and an EXIF rotation tag is applied first. It is how an iPhone screen is read from the Mac (`interceptor ios screenshot`, then `vision text --image <path>`). `--image` and `--app` cannot be combined.

Use vision when text or pixel-region content is needed and the AX tree is opaque (rendered HTML in a WKWebView, image-only documents, video frames).

## Audio Intelligence

```bash
interceptor macos listen start                     # Real-time speech recognition
interceptor macos listen transcript                # Snapshot current transcript
interceptor macos listen tail                      # Poll-friendly streaming transcript
interceptor macos listen stop                      # Stop + return transcript

interceptor macos vad start                        # Voice activity detection
interceptor macos vad status                       # RMS level + isSpeaking

interceptor macos sounds start                     # Sound classification (300+ types)
interceptor macos sounds status

interceptor macos audio output start               # Capture system audio
interceptor macos audio input start                # Capture microphone
```

Speech, VAD, and sound classification are independent runners — start any combination, query status, stop independently.

## Permissions

- **Screen Recording** is required for `screenshot`, `capture`, `stream`, and `vision` operations on most macOS versions. Run `interceptor macos trust` to confirm.
- **Microphone** is required for `listen`, `vad`, `sounds`, `audio input`. `audio output` (system audio) does not need the microphone permission but does need Screen Recording on recent macOS.
- After granting, verify the live path: `interceptor macos audio input start` then `interceptor macos audio input stop`. A green light from `trust` does not always mean the helper has live access yet.

## Common mistakes

- Trying to use `interceptor screenshot` (browser surface) for a native window. The browser surface only sees the active Chrome tab. Use `interceptor macos screenshot --app "X"` for any native window.
- Activating the target app to screenshot it. Not needed — `CGSHWCaptureWindowList` works on occluded and minimized windows.
- Saving large screenshots without `--target-max-long-edge`. Multi-MB PNGs blow up agent context windows; use `--save --target-max-long-edge 1568` for the upload-friendly default.
