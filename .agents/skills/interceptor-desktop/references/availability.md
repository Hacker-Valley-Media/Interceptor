---
author: agent
generated_by: claude-opus-5-5 (Maestro)
created: 2026-10-11
updated: 2026-10-12
status: draft
reviewed: false
source: docs/desktop-bridge.md; live `interceptor desktop capabilities` on the Windows 11 ARM64 and Linux ARM64 Full installs on 2026-10-11; the 2026-10-11 parity results (Windows 909 pass of 910, Linux 910 of 910)
---

# What works on this Windows computer <!-- os:win32 -->
# What works on this Linux computer <!-- os:linux -->

What `interceptor desktop` does on this OS with the Full install, and how its results differ from the Mac's. The machine in front of you can differ, so `interceptor desktop capabilities` decides. What does not work, or works only in part, is in the tables in [`../SKILL.md`](../SKILL.md).

Tested on Windows 11 ARM64. The x64 provider builds but has not been batch-tested. <!-- os:win32 -->
Tested on Arch Linux ARM64 with Hyprland 0.56.1 on Wayland. The x64 provider builds but has not been batch-tested. <!-- os:linux -->

## Works

| Area | Families |
|---|---|
| Reading elements | `tree`, `find`, `inspect`, `value`, `text`, `focused`, `read`, `act` |
| Input to a background window | `click`, `type`, `keys`, `scroll`, `drag`, `menu`, `action` |
| Apps and windows | `apps`, `windows`, `frontmost`, `app`, `open`, `resize`, `move` |
| Pixels | `screenshot`, `capture`, `stream` (with `stream record --media`), `display list`, `display info` |
| Files and data | `fs`, `files`, `thumbnail`, `clipboard`, `url`, `pdf`, `log` |
| Automation | `script run --jsc`, `intent dispatch --jsc`, `monitor`, `overlay`, `cdp` |
| Personal data | `contacts`, `calendar`, `reminders`, `notifications`, `share` |
| Security and status | `secret`, `auth`, `authdialog`, `trust`, `health`, `update`, `status`, `sudo` | <!-- os:linux -->
| Security and status | `secret`, `auth`, `authdialog`, `trust`, `health`, `update`, `status` | <!-- os:win32 -->
| Audio | `audio`, `vad`, `listen`, `sounds` |
| Vision and language | `vision`, `nlp`, `ai`, `translate`, `detect` |

A row in `capabilities` covers a whole operation. One subcommand or flag inside it can still refuse when this OS has no equivalent; the tables in `SKILL.md` list those.

## Filled by the operating system

| Command | Done by |
|---|---|
| `vision text` | Windows OCR | <!-- os:win32 -->
| `vision text` | system Tesseract 5 | <!-- os:linux -->
| `vision faces` | Windows face detector | <!-- os:win32 -->
| `vision faces` | GStreamer `facedetect` (OpenCV). `overlay ctl face-track-start` refuses, because each frame takes longer than the tracking deadline. | <!-- os:linux -->
| `nlp language` | Windows language detection | <!-- os:win32 -->
| `nlp language` | libexttextcat | <!-- os:linux -->
| `app launch <id>` | Start-menu app id (`Get-StartApps` in PowerShell lists them) | <!-- os:win32 -->
| `app launch <id>` | desktop-file id, started in the background launch scope | <!-- os:linux -->
| `thumbnail --types icon` | shell icon | <!-- os:win32 -->
| `thumbnail --types icon` | icon theme | <!-- os:linux -->
| `calendar tail`, `contacts changes`, `contacts current-token` | change tracker or a snapshot of the store | <!-- os:win32 -->
| `calendar tail`, `contacts changes`, `contacts current-token` | snapshot of the Evolution store | <!-- os:linux -->
| `calendar create-calendar --source` | only Interceptor's own account `windows-account:interceptor`; Windows grants writes only to an app's own accounts | <!-- os:win32 -->
| `calendar create-calendar --source` | only the built-in local source | <!-- os:linux -->
| `notifications request` | the real toast setting, with no prompt | <!-- os:win32 -->
| `notifications request` | whether a notification server runs, with no prompt | <!-- os:linux -->
| `monitor --video`, `monitor --vision-text` | MJPEG in Matroska, with OCR on each saved frame |

## Bundled with the install

These need nothing installed. The models sit in the `engines` folder beside the provider and run inside Interceptor's own process.

| Command | Model |
|---|---|
| `vision hands`, `vision bodies` | MediaPipe hand and pose models (ONNX) |
| `vision classify` | MobileNetV2, ImageNet labels |
| `vision saliency` | U2-Net-p |
| `sounds` | CED-tiny, 527 AudioSet classes, two-second windows |
| `nlp embed`, `nlp similar` | all-MiniLM-L6-v2 (384 numbers) |
| `listen` | the speech recognizer Windows ships | <!-- os:win32 -->
| `listen` | whisper.cpp with the multilingual tiny model, five-second windows | <!-- os:linux -->
| `detect` for links, email addresses and phone numbers | pattern matching, no model |

## Downloads once, on first use

`ai`, `nlp entities`, `nlp sentiment`, `translate`, and `detect` for dates, addresses, money, flights, tracking numbers, measurements and payment ids use a local model (Gemma 4 E2B, 2.8 GB) run by a bundled llama.cpp server on 127.0.0.1. Nothing typed leaves the machine.

1. Until the model is on disk, the `ai`, `translate` and `detect` rows say `effective: false` with a `reason` that the model downloads the first time.
2. The first of these commands starts the download and refuses, saying how far along it is.
3. `interceptor desktop ai status` shows progress and never starts anything. Run the command again when it prints `"available": true`.

- The download is 2.8 GB and the loaded model holds about 4.5 GB of memory. Tell the user before you start it on a small machine.
- The model lives in `%LOCALAPPDATA%\Interceptor\Models`, outside the install folder, so an upgrade keeps it. Uninstall removes it. <!-- os:win32 -->
- The model lives in `~/.local/share/interceptor-models`, outside the install folder, so an upgrade keeps it. Uninstall removes it. <!-- os:linux -->
- `INTERCEPTOR_AI_DOWNLOAD=off` turns the download off. The commands then refuse and say so.
- The server needs the Microsoft Visual C++ runtime. When it is missing, the command names the fix. <!-- os:win32 -->
- `translate` accepts: ar, de, en, es, fr, hi, id, it, ja, ko, nl, pl, pt, ru, th, tr, uk, vi, zh.
- `detect` for the model-backed types is best effort. It drops any match it cannot check against the text, so a result can be incomplete but does not contain invented values.

## Results that differ from the Mac's

- `confidence` is `null` where the OS gives no score: OCR, faces, language detection, and `vision hands` joints. <!-- os:win32 -->
- `confidence` is `null` where the OS gives no score: faces, language detection, and `vision hands` joints. Tesseract OCR does return one. <!-- os:linux -->
- `vision bodies` returns MediaPipe's 33 joint names (`leftShoulder`, `rightFootIndex`, ...) and at most one body.
- `vision classify` returns ImageNet labels ("cheeseburger"). `sounds` returns AudioSet labels ("Cat", "Speech").
- Vision regions and face boxes are normalized with a bottom-left origin.
- `calendar tail` and `contacts changes` compare snapshots. Several edits between two reads arrive as one change, and the reply says `method: "snapshot"`.
- `app launch` returns `launched: false` with the existing pid when the app is already running.
- `stream record --media` writes MJPEG frames in Matroska with measured arrival times, and has no synchronized audio.
- `contacts me` needs a "Me" card in the contact store.

<!-- os:linux -->
## Packages that switch a capability on

Without the package the capability row is `present: false` and names it.

| Package | Enables |
|---|---|
| `tesseract`, `tesseract-data-eng` | `vision text`, `monitor --vision-text` |
| `gst-plugin-opencv` | `vision faces` |
| `libexttextcat` | `nlp language` |
| evolution-data-server | `contacts`, `calendar`, `reminders` |
| a Freedesktop notification server | `notifications` |
| Podman | `container run` |
<!-- /os -->
