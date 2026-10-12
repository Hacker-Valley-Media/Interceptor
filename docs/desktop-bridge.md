---
author: agent
generated_by: "claude-opus-5-5 (Maestro)"
created: 2026-10-02
updated: 2026-10-12
status: active
reviewed: false
source: "capabilities.json and the signed-install parity batches; shared/desktop-contract.ts; cli/commands/desktop.ts; interceptor-desktop/src"
---

# Desktop bridge on Windows and Linux

`interceptor desktop <family> ...` drives native apps on the host it runs on. On macOS it uses the Swift bridge, the same one behind `interceptor macos ...`. On Windows and Linux it uses the Rust provider `interceptor-desktop`. All three take the same verbs, the same flags and return the same JSON, because they share one contract (`shared/desktop-contract.ts`, generated into Rust and Swift).

Not every verb can work everywhere. When the host cannot do something, the command refuses and the error says why. Check before you start:

```bash
interceptor status                 # mode: full means the native provider is installed
interceptor desktop capabilities   # one row per operation; effective:false rows carry a reason
```

## Install

**Windows** (tested on Windows 11 ARM64; the x64 provider builds but has not been batch-tested):
- Run the signed `Interceptor-Full-<version>-windows-<arch>.exe`. It installs per user under `%LOCALAPPDATA%\Programs\Interceptor`. Every executable and the notification identity package are Authenticode-signed by Hacker Valley Media LLC.
- The provider has to run in the signed-in desktop session. A command started from an ssh session (session 0) is refused; run it from the desktop session, or through an interactive scheduled task.

**Linux** (tested on Arch ARM64 / Omarchy with Hyprland 0.56.1 on Wayland):
- Download `Interceptor-Full-<version>-linux-<arch>.tar.gz` with `SHA256SUMS` and `SHA256SUMS.cms`. Verify them with `bash scripts/verify-release-manifest.sh <folder>`. The script needs `linux-release-apple-root.pem` next to it and every archive the manifest lists.
- From the graphical session, run `bash scripts/install.sh --full`. It installs into `~/.local/share/interceptor`, links `~/.local/bin/interceptor`, and adds a login autostart entry.
- The provider must run in your own graphical login session. From a plain ssh shell it refuses ("compositor peer requires the same user and login session").
- These distribution packages are optional and light up one capability each. Without one, its capability row is `present:false` and names the package.

| Package | Enables |
|---|---|
| `tesseract`, `tesseract-data-eng` | `vision text`, `monitor --vision-text` |
| `gst-plugin-opencv` | `vision faces`, `overlay` face tracking |
| `libexttextcat` | `nlp language` |
| evolution-data-server | `contacts`, `calendar`, `reminders` |
| a Freedesktop notification server | `notifications` |

**Agent skills.** Both installs carry the agent skills, including `interceptor-desktop` for native apps: in `skills` under the Windows install folder, and in `~/.local/share/interceptor/skills` on Linux. Each OS gets its own copy, built by `scripts/gen-skills.ts`: the Windows copy names no Linux or Mac commands, and the Linux copy no Windows or Mac ones. The commands an OS lacks come from `shared/desktop-support.json`, which also trims `interceptor desktop --help` and the MCP desktop menu there. The skills are not linked automatically. `interceptor skills adopt` links them into Claude Code, Codex and other detected agents, and uninstall removes those links.

## What works on all three

These families pass the parity batches on macOS, Windows and Linux:
- Accessibility reads: `tree`, `find`, `inspect`, `value`, `text`, `focused`, `read`, `act`.
- Input to a background window: `click`, `type`, `keys`, `scroll`, `drag`, `menu`, `action`.
- Apps and windows: `apps`, `windows`, `frontmost`, `app`, `open`, `resize`, `move`.
- Pixels: `screenshot`, `capture`, `stream` (including `stream record --media`), `display list/info`.
- Files: `fs`, `files`, `thumbnail`, `clipboard`, `url`, `pdf`, `log`.
- Automation: `script run --jsc`, `intent dispatch --jsc`, `monitor`, `overlay`.
- Personal data: `contacts`, `calendar`, `reminders`, `notifications`, `share`.
- Security and status: `secret`, `auth`, `authdialog`, `trust`, `health`, `update`, `status`.
- Audio: `audio`, `vad`.

A capability row covers a whole operation. A single subcommand inside it can still refuse when the host has no equivalent, for example `location geocode` or `music library`.

Input is background-first on every host. Windows and Linux deliver input to the target window without activating it, and the parity runner fails any case that moves the foreground window or the cursor, except the verbs that exist to move focus (`app activate`, `open --activate`).

On Windows, keys sent to a window that is not in front go as window messages. A single key or a Shift chord types its character, but a chord that holds Ctrl, Alt or Windows (for example `Control+A`) refuses with `background_unavailable`: Windows apps read the physical modifier state, so the chord would arrive as a plain key. Such a chord reaches only the window already in front; for a background window use `type`, `value`, `action` or `menu`.

### Filled by the operating system

| Command | Windows | Linux |
|---|---|---|
| `vision text` (`--image`, `--app`, `--debug-dump`) | `Windows.Media.Ocr` | system Tesseract 5.x |
| `vision faces`, `overlay ctl face-track-start` | `Windows.Media.FaceAnalysis.FaceDetector` | GStreamer `facedetect` (OpenCV); face tracking refuses on Linux because each frame takes longer than the tracking deadline |
| `nlp language` | Windows language detection (ELS) | libexttextcat |
| `app launch <app id>` | Start-menu app id: desktop apps open without activation, packaged apps start through the activation manager | XDG desktop-file id, started in the background launch scope |
| `thumbnail --types icon` | shell icon (`IShellItemImageFactory`) | icon theme through GIO and gdk-pixbuf |
| `calendar tail` | `AppointmentStore.ChangeTracker` | snapshot of the Evolution store |
| `calendar create-calendar --source` | Interceptor's own account `windows-account:interceptor`; other accounts refuse (Windows grants writes only to the app's own accounts and calendars) | the built-in local source |
| `contacts current-token`, `changes` | snapshot of the contact store | snapshot of the Evolution store, including groups |
| `notifications request` | real `ToastNotifier.Setting` state, no prompt | whether a notification server is running, no prompt |
| `monitor --video`, `monitor --vision-text` | MJPEG in Matroska; OCR on each saved frame | same |

Things that differ from the Mac:
- Where the OS gives no score (Windows OCR and faces, OpenCV faces, both language detectors), `confidence` is `null`. Linux Tesseract does return a confidence.
- `calendar tail` and `contacts changes` compare snapshots of the real store. Several edits made between two reads arrive as one change, and the reply says `method: "snapshot"`.
- Vision regions and face boxes are normalized with a bottom-left origin, the same as on the Mac.
- `app launch` returns `launched:false` with the existing pid when the app is already running.

### Bundled with the Full install

These need nothing installed and nothing configured. The models ship in the `engines` folder beside the provider, each with its license, and run inside Interceptor's own process. No vendor library is loaded and nothing is sent anywhere.

| Command | What runs it |
|---|---|
| `vision hands`, `vision bodies` | Google's MediaPipe hand and pose models, as ONNX files from the OpenCV Zoo |
| `vision classify` | MobileNetV2 with ImageNet labels |
| `vision saliency` | U2-Net-p salient-object model |
| `sounds` | CED-tiny, 527 AudioSet sound classes, in two-second windows |
| `nlp embed`, `nlp similar` | all-MiniLM-L6-v2 sentence embeddings (384 numbers) |
| `listen` on Linux | whisper.cpp 1.9.5 with the multilingual tiny model, in five-second windows. Windows `listen` uses the recognizer Windows ships. |
| `detect` for links, email addresses and phone numbers | Exact pattern matching in the provider. No model is involved. |

Things that differ from the Mac:
- `vision hands` joints carry `confidence: null`: the model gives no score per joint.
- `vision bodies` returns MediaPipe's 33 joint names (`leftShoulder`, `rightFootIndex`, ...), and at most one body.
- `vision classify` returns ImageNet labels ("cheeseburger"); the Mac returns Apple's label set.
- `sounds` returns AudioSet labels ("Cat", "Speech"); the Mac returns Apple's.

### Downloads once, on first use

`ai`, `nlp entities`, `nlp sentiment`, `translate`, and `detect` for dates, addresses, money, flights, tracking numbers, measurements and payment ids use a local AI model: Gemma 4 E2B (Apache-2.0, 2.8 GB), run by a llama.cpp server that ships with the install.

- The first of these commands starts the download from Hugging Face and refuses, saying how far along it is. `interceptor desktop ai status` shows the progress and never starts anything. Run the command again when status says `available: true`.
- The file is checked against a pinned SHA256. A file that does not match is deleted. An interrupted download resumes where it stopped.
- The model lives in `%LOCALAPPDATA%\Interceptor\Models` (Windows) or `~/.local/share/interceptor-models` (Linux), outside the install folder, so an upgrade keeps it. Uninstall removes it.
- Interceptor starts the server itself on 127.0.0.1 with a random key and with the server's own downloads off. It uses at most four threads and unloads the model after ten idle minutes. Nothing you type leaves the machine.
- While the model is loaded the server holds about 4.5 GB of memory (measured on Linux ARM64).
- `INTERCEPTOR_AI_DOWNLOAD=off` turns the download off. The commands then refuse and say so.
- On Windows the llama.cpp server needs the Microsoft Visual C++ runtime. Most PCs have it. When it is missing, the command says so and names the fix: `winget install Microsoft.VCRedist.2015+.x64` (or `.arm64`).
- Your own server still wins. Set `INTERCEPTOR_LLAMA_CHAT_URL`, `_MODEL` and `_KEY` and Interceptor uses it for these commands; `INTERCEPTOR_LLAMA_EMBED_*` does the same for `nlp embed` and `similar`.
- `translate` accepts the languages Apple's Translation offers: ar, de, en, es, fr, hi, id, it, ja, ko, nl, pl, pt, ru, th, tr, uk, vi, zh.

## What this build does not do on Windows and Linux

| Command | Why |
|---|---|
| `sensitive` | No image model for sensitive-content checks ships. The Mac refuses too unless its bridge carries Apple's entitlement. A multimodal llama.cpp server can be configured (`INTERCEPTOR_LLAMA_VISION_URL`, `_MODEL`, `_KEY`). |
| `photos` | Neither system has a photo library with albums. The provider's folder-based library needs ExifTool (`INTERCEPTOR_PHOTOS_EXIFTOOL`, `INTERCEPTOR_PHOTOS_LIBRARY`), which cannot ship in the bundle. |
| `maps`, `location geocode/reverse/postal-geocode` | Need map servers (`INTERCEPTOR_PHOTON_URL`, `INTERCEPTOR_VALHALLA_URL`, `INTERCEPTOR_GEOCODER_URL`). None ship. |
| `music library/library-search/play <query>/queue/subscription` | No system music library. Play, pause, next, previous, seek, repeat and shuffle work through the system player. |
| `vm` | Needs a QEMU engine (`INTERCEPTOR_QEMU_SYSTEM`) and a guest image. |
| `container run` (Windows only) | Needs Podman with a running machine. On Linux it works when Podman is installed. |
| `monitor --tap` | No global input source: Wayland has no protocol for it, and the Windows build ships no global input hook. Use the app's accessibility input events (`--include input`). |
| `sudo` (Windows only) | Elevation needs UAC consent on the secure desktop, which cannot be driven. |
| `runtime`, `tcc`, `appintent`, `display create/remove`, `share airdrop/reading-list` | Apple-only. |
| `stream record --record-audio system` | Synchronized system audio is not implemented off the Mac. |
| `intent warmup` | Only Apple Events targets need a warmup; Windows and Linux `intent dispatch` run `--jsc` only. |

The `INTERCEPTOR_*` settings named above are read by the Interceptor provider, which starts when you log in. Setting them in a terminal does not reach it. On Linux put them in `~/.config/environment.d/interceptor.conf` (`NAME=value`, one per line); on Windows set them as user environment variables (`setx NAME value`). Then log out and back in.

## How it is tested

`bun scripts/desktop-parity/launch.ts windows|linux|mac` runs the same 910-case catalog (every verb and flag in the inventory) against the installed CLI on each host. The Windows and Linux hosts come from `PARITY_*` environment variables (`PARITY_WINDOWS_HOST`, `PARITY_LINUX_HOST`, their keys, and `PARITY_WAYLAND_DISPLAY`), and evidence goes to `.interceptor/parity/`. On Windows the catalog runs in the signed-in session through an interactive scheduled task, and on Linux in the Hyprland session through `systemd-run --user`. Each case also checks that the foreground window and cursor did not move. The vision cases use three photos with known content, and the AI cases wait for the model download first.

On 2026-10-12, against the signed 2.0.0 builds installed the way a user installs them:
- Windows 11 ARM64: 909 pass, 0 fail, 1 skipped. The skip deletes a URL reminder, which Windows refuses to create: Windows tasks have no URL field. The catalog ran in family chunks. One case (`app.launch-with-pid`) failed once when Character Map took the foreground as it opened, and passed when its family was run again.
- Linux ARM64 (Arch Linux ARM, Hyprland 0.56.1 on Wayland): 910 pass, 0 fail, in one run.
- macOS: 613 pass, 0 fail, 297 skipped. The Mac runs the same catalog on the person's own desktop and skips cases that would take the screen, play sound, or change their real Photos, Calendar, Contacts or Reminders. Three `url` cases failed while httpbin.org answered 503 and `monitor.start.vision-text` failed once; all passed when their families were run again. `files.open.limit` found a reply check that capped the skipped-process count on a busy Mac, which 2.0.0 fixes.

The x64 Windows and Linux providers are built from the same source; the catalog was run on the ARM64 hosts.

Rust unit tests pass on each host with the 2.0.0 source: Windows ARM64 144, Linux ARM64 166, macOS 137. On Windows and Linux they include the hand, body, classify, saliency, sound and embedding models run against the installed engine bundle and checked against known photos and recordings.

What the local AI model does not do well: `detect` for dates, addresses, money, flights, tracking numbers and measurements is best effort. A match the provider cannot check against the text is dropped, so a result can be incomplete (an address without its city, a weight not reported), but it does not contain invented values.
