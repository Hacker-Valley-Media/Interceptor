<p align="center">
  <img src="docs/assets/interceptor-logo-square.png" alt="Interceptor logo" width="140">
</p>

<h1 align="center">Interceptor</h1>

<p align="center">
  <strong>Give your agent your browser, Mac, and iPhone.</strong>
</p>

<p align="center">
  Browser automation, computer use, and iPhone automation for AI agents.
</p>

<p align="center">
  <a href="#get-started"><strong>Get started</strong></a> ·
  <a href="#browser-automation">Browser</a> ·
  <a href="#macos-automation">macOS</a> ·
  <a href="#iphone-and-ios-automation">iPhone</a> ·
  <a href="#record-and-reuse-workflows">Record &amp; replay</a> ·
  <a href="#documentation">Docs</a>
</p>

<p align="center">
  <a href="https://github.com/Hacker-Valley-Media/Interceptor/releases/latest"><img src="https://img.shields.io/github/v/release/Hacker-Valley-Media/Interceptor?label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Elastic%202.0-blue" alt="Elastic License 2.0"></a>
</p>

Interceptor connects an AI agent or script to your signed-in browser, native apps on macOS, Windows, and Linux, and a physical iPhone. It combines structured UI reads and actions with access to page traffic, rich editors, app internals, and device state. The agent can inspect what happened after an action and use that evidence for its next step.

| Work you can build with Interceptor | Tools available |
|---|---|
| Research in your existing browser session | Page text, tables, links, browser search, multiple contexts, and a source-ledger research workflow. |
| Edit a document, slide, or design and save the result | Rich-editor scenes, canvas input, file uploads, and direct capture of page-produced export bytes. |
| Complete a native desktop task while you keep working | Accessibility controls, background input, and capture of covered windows on macOS, Windows, and Linux; Apple Events on the Mac. |
| Operate an app on a real iPhone and inspect its state | Element trees, taps, text entry, screenshots, process telemetry, and WebKit inspection. |
| Turn a demonstrated workflow into reusable commands | Browser and Mac recording, event timelines, and replay-plan export. |

Use it from any agent that can run shell commands, or through its built-in [Model Context Protocol (MCP) server](docs/mcp.md). Interceptor does not require a model API key; your chosen agent or model may have its own subscription or API costs.

## Why Interceptor

- **Your existing browser session.** Work with the profiles, cookies, and logins you already use. The default browser path uses an extension rather than launching a separate automated browser.
- **Look beyond pixels.** Read DOM and accessibility structure, inspect network activity, and use specialized interfaces for rich editors, Electron apps, native runtimes, and iPhone services.
- **Background automation.** Browser and native Mac operations default to background execution so you can keep working. Explicit activation brings a target forward when needed. [Behavior and exceptions](.agents/skills/interceptor-macos/references/background-first.md).
- **Keep the evidence.** Return text or JSON, save artifacts, record workflows, and verify task state before marking a browser task complete.
- **Use one command vocabulary.** `open`, `read`, `act`, and `inspect` combine common steps; detailed verbs and agent skills cover deeper work.

## Get started

Download an installer from [Releases](https://github.com/Hacker-Valley-Media/Interceptor/releases/latest). Start with Browser for web tasks, or Full for native Mac and iPhone work. The macOS packages are built for Apple silicon. On an Intel Mac, build from source (see [Development and contributions](#development-and-contributions)).

| Host / package | What it enables |
|---|---|
| macOS: `Interceptor-Browser-<version>.pkg` | CLI, daemon, and browser extension files. |
| macOS: `Interceptor-Full-<version>.pkg` | Browser package plus the native Mac bridge and iPhone tooling. The bridge requires macOS 15+. |
| macOS: `Interceptor-Safari-<version>.pkg` | Safari extension add-on, installed after either core package. |
| Windows 11 24H2+: `Interceptor-Browser-<version>-windows-{x64,arm64}.exe` | Browser automation. [Windows installation guide](docs/windows-install.md). |
| Windows 11 24H2+: `Interceptor-Full-<version>-windows-{x64,arm64}.exe` | Browser automation plus native app control with `interceptor desktop`. [Desktop guide](docs/desktop-bridge.md). |
| Linux: `Interceptor-Browser-<version>-linux-{x64,arm64}.tar.gz` | Browser automation and install scripts. |
| Linux: `Interceptor-Full-<version>-linux-{x64,arm64}.tar.gz` | Browser automation plus native app control with `interceptor desktop`, with a signed release manifest. |

The macOS release binaries target Apple silicon. On Windows and Linux, the Full packages add native app control through `interceptor desktop`; run `interceptor desktop capabilities` to see what works on that computer. iPhone setup requires a Mac.

### macOS installation

1. Install the Browser or Full `.pkg` from Releases. On a first install, the Interceptor window opens: it checks whether the extension is already in your browser, and if not, walks you through adding it from the Chrome Web Store, as an unpacked extension (with a step-by-step guide in the browser), or for Safari. Open it again any time with `interceptor diagnose extension --welcome`.
2. In Chrome or Brave, install the [Interceptor extension](https://chromewebstore.google.com/detail/interceptor/gomcpnagjjlhehnkoobkjgnkbleiooed) if the window did not already do it. The local runtime and browser extension are both required.
3. For Safari, also install the Safari `.pkg`, open `/Applications/InterceptorSafari.app` once, then enable Interceptor and website access in **Safari → Settings → Extensions**. Safari requires your approval.
4. With Full, grant the permissions needed by your task to `interceptor-bridge`. Run `interceptor macos trust --walkthrough` for guidance. Accessibility enables native UI control; screen, microphone, and app-automation access are needed for their respective features.

For an unpacked Chrome/Brave extension, enable Developer Mode on the browser's extensions page and load `/Library/Application Support/Interceptor/extension/`. Keep one copy per profile. Store and unpacked installations share an extension ID; store updates arrive after store review.

### Windows and Linux

On **Windows**, run the architecture-matched installer, install the browser extension, then open a new terminal. Chrome, Brave, and Edge can use the Chrome Web Store listing; Edge requires allowing extensions from other stores. The [Windows guide](docs/windows-install.md) also covers unpacked extensions, silent installation, updates, and removal.

On **Linux**, extract the architecture-matched archive and run this from its directory:

```bash
bash scripts/install.sh --browser-only --brave
# For Chrome, use --chrome instead of --brave.
./dist/interceptor open "https://example.com"
```

Follow the installer's extension-loading instructions. The archive includes compiled binaries, so a separate Bun installation is not needed for this release path.

For native app control on Linux, download the Full archive with `SHA256SUMS` and `SHA256SUMS.cms`, verify them with `bash scripts/verify-release-manifest.sh <folder>`, then run `bash scripts/install.sh --full` from your graphical session. On Windows, run the Full installer instead of the Browser one. The [desktop guide](docs/desktop-bridge.md) lists what each OS supports and the optional Linux packages that light up OCR, face detection, and personal data.

### Your first browser task

With the extension enabled and browser open:

```bash
interceptor open "https://example.com" --group first-task
interceptor read --group first-task
interceptor group close first-task
```

`open` starts the daemon when needed, opens a managed tab in the background, and returns the page's tree and text. You should see **Example Domain**. `read` inspects it again; `group close` cleans up that task's tabs.

If several browser contexts are connected, run `interceptor contexts` and add `--context <id>` to your browser commands. Safari's ID is `safari`. `interceptor status` reports local health but does not start the daemon by itself.

### Connect your agent

For a shell-capable agent, adopt the bundled skills into detected agent runtimes. The Mac and Windows installers and the Linux archives each bundle the skills for their operating system:

```bash
interceptor skills adopt
```

For an MCP client, register Interceptor and restart the client. The installer detects Claude Code, Codex, Gemini CLI, Cursor, and Claude Desktop:

```bash
interceptor mcp install
interceptor mcp status
```

The MCP server exposes browser, macOS, iOS, read, local, and raw tools, plus discovery resources. Its permissions are configured by the operator. See the [MCP guide](docs/mcp.md).

<a id="browser"></a>

## Browser automation

**Read and operate the web apps you are already signed into.** Chrome, Brave, and Safari use Interceptor's extension. Browser-specific limits are described in the [browser guide](.agents/skills/interceptor-browser/SKILL.md).

- **Pages and forms:** read text, HTML, tables, links, frames, and accessibility-style element references. Click, type, select, drag, scroll, and navigate. Native dropdown selection validates exact values or unique labels and rejects invalid options.
- **Rich editors and canvases:** inspect supported scene graphs, select objects, navigate slides, and enter text in canvas-rendered editors. Workflows cover Google Docs, Slides, Sheets, Canva, and WebGL viewers; support depends on the app and operation.
- **Network and application state:** inspect fetch/XHR, SSE, WebSocket, Beacon, and BroadcastChannel traffic; examine headers, rewrite matching requests, and export captured traffic. Passive inspection uses standard page APIs without attaching a debugger.
- **Files and exports:** upload local files to inputs, drop zones, and supported file pickers. Save page-produced `Blob`, buffer, or `blob:` URL bytes directly to disk with `save`, including native exports from supported web apps.
- **Capture and browser data:** screenshots, OCR, canvas inspection, cookies, storage, history, bookmarks, downloads, and session management.
- **Multiple tasks:** select a browser profile with `--context`, a tab with `--tab`, and a task's managed tabs with `--group`. Use a distinct group for each concurrent worker.
- **Tab cleanup:** when no command has touched a managed tab group for 10 minutes, Interceptor closes its idle tabs. It keeps the tab you are looking at, audible tabs, tabs with unsaved form input, and a window's last tab, so the group itself can remain. The extension popup changes the idle time and can delete the whole idle group instead (off by default). Administrators can set both through managed browser policy. `interceptor sessions restore <id>` reopens a closed page in the background.

```bash
interceptor open "https://example.com" --group browser-task
interceptor find "Learn more" --group browser-task
interceptor inspect --group browser-task
interceptor group close browser-task
```

To interact, use the current reference returned by `read` or `find`: `interceptor act <ref>` clicks it; `interceptor act <ref> "text"` enters text. Re-read after navigation or a stale-reference error, and check the resulting state after an action.

[Browser command reference](.agents/skills/interceptor-browser/references/command-catalog.md) · [Rich-editor workflows](.agents/skills/interceptor-browser/workflows/rich-editor-workflows.md) · [Export capture](.agents/skills/interceptor-browser/references/blob-export-capture.md)

<a id="macos"></a>

## macOS automation

**Desktop automation for native Mac apps, windows, menus, and dialogs, including supported background workflows.** The Full package provides a Swift bridge with Accessibility, capture, input, and Apple framework integrations.

```bash
interceptor macos trust
interceptor macos tree --app "Finder"
interceptor macos windows --app "Finder"
```

These commands inspect Finder without activating it. Use returned element references with `macos act`, `click`, or `type`; use `macos open "Finder" --activate` when you want to bring it forward.

| Area | Capabilities |
|---|---|
| App control | Accessibility trees, text and values, clicks, typing, keyboard input, scrolling, dragging, menus, app lifecycle, and window placement. |
| Capture and perception | Covered/minimized-window screenshots, screen streaming, OCR and vision over a window or a saved image file (including an iPhone screenshot), system/microphone audio, speech recognition, sound classification, and language analysis. |
| Files and system work | Spotlight search, file reads/writes/watchers, clipboard, URL fetching, OS logs, AppleScript/JXA, JavaScriptCore scripts, and Apple Events. |
| Documents | PDF text, forms, annotations, merge/split operations, data detection, translation, and thumbnails. |
| Personal apps | Calendar, reminders, contacts, photos, location, music, maps, sharing, and notifications through the corresponding system frameworks and permissions. |
| Visual tools | HTML and SpriteKit overlays, window-anchored HUDs, capture streams, and virtual displays. |
| Local compute | Apple Intelligence on supported macOS 26+ systems, OCI containers, and Linux/macOS VM lifecycle and guest tools. See the guides for runtime, model, and guest prerequisites. |

[Mac command reference](.agents/skills/interceptor-macos/references/command-catalog.md) · [Background behavior](.agents/skills/interceptor-macos/references/background-first.md) · [System and media tools](.agents/skills/interceptor-macos/references/advanced-domains.md) · [Documents](docs/native/document.md) · [Personal data](docs/native/personal-data.md) · [Overlays](docs/native/overlays.md) · [VMs](.agents/skills/interceptor-macos/workflows/vm-lifecycle.md)

<a id="iphone"></a>

## iPhone and iOS automation

**Drive apps on a physical iPhone and inspect more than its screen.** Interceptor's own on-device XCUITest runner handles UI work; additional interfaces expose developer and device services.

Setup requires an owned, unlocked iPhone in Developer Mode, pairing with your Mac, a Full installation, and Xcode signed into an Apple ID (a free personal team works; its signing lasts 7 days and Interceptor renews it). Connect by USB for initial pairing. Wi-Fi operation is available once paired, with network reachability between the phone and Mac. Away from your Mac, including on cellular, open InterceptorRunner on the phone and it connects back over Tailscale.

```bash
interceptor ios discover
interceptor ios setup
interceptor ios tree
```

`setup` builds, signs, installs, and launches the runner. Complete any on-device XCTest authorization prompt yourself, grant Local Network access when needed, and keep the phone unlocked and awake during automation. This operates the phone's foreground UI. It does not provide the desktop's background-use guarantee.

| Area | Capabilities |
|---|---|
| App interaction | Ref-tagged element trees, find/inspect, taps, text, scrolling, dragging, long presses, multi-finger gestures, hardware buttons, screenshots, a continuous frame stream over Wi-Fi, and app launch/activate/terminate. Taps, drags, swipes, and gestures also take screen coordinates, for games and canvas apps with no element tree. |
| On-device scripts | `ios eval` runs JavaScript inside the runner, combining UI reads, decisions, and actions in one request. |
| Developer telemetry | Process lists, CPU/memory and GPU sampling, app launch with arguments, and location simulation through supported device services. |
| Web content | `ios web` inspects exposed Safari and WKWebView targets: page structure, JavaScript, console, and network activity. |
| Device inspection | Logs, diagnostics, crash reports, profiles, and supported media or app-container file access. Availability depends on iOS, pairing, and service permissions. |

Use `--on <alias>` to select a phone when several are configured. For setup, exact verbs, service limits, and connection recovery, see the [iPhone guide](.agents/skills/interceptor-ios/SKILL.md) and [command reference](.agents/skills/interceptor-ios/references/command-catalog.md).

## Record and reuse workflows

Teach a browser workflow by doing it once while Interceptor records clicks, inputs, navigation, DOM changes, and correlated traffic. Export the session as a timeline or a replay plan:

```bash
# Start with an open Interceptor-managed browser tab.
interceptor monitor start --instruction "Search the catalog and compare two items"
# Perform the workflow.
interceptor monitor stop
# Use the session ID returned above:
interceptor monitor export <session-id> --plan
```

Native Mac recording uses `interceptor macos monitor` and the same `export <session-id> --plan` pattern. Review a generated plan, supply any missing inputs, and check the result when replaying it.

For longer browser jobs, `monitor task` stores checkpoints, target context, lessons, and verification checks. Resume a task across agent sessions; `task complete` runs its checks and marks it complete only when they all return `true`.

[Browser recording](.agents/skills/interceptor-browser/workflows/record-and-replay.md) · [Mac recording](.agents/skills/interceptor-macos/workflows/record-and-replay-mac-flow.md) · [Durable task state](.agents/skills/interceptor-browser/workflows/task-state.md)

## Go deeper

These interfaces add access beyond ordinary UI controls. Each has its own setup and support boundaries.

| Interface | What it adds | Guide |
|---|---|---|
| Electron / Chromium apps | Read DOM, execute JavaScript, inspect traffic, and capture an app's web contents with `macos cdp` or `macos cdp app`. Some attachment paths require an app relaunch. | [App control](.agents/skills/interceptor-macos/references/cdp-app.md) |
| Native runtime | Inspect live objects and layers, call selectors, change rendered text, and observe calls with `macos runtime`. Requires a compatible target and an agent dylib; advanced extensions are separate from the core package. | [Runtime setup and commands](.agents/skills/interceptor-macos/references/native-agent.md) |
| Research | A browser-based investigation workflow with query planning, saved sources, corroboration, and an evidence ledger. Start with `interceptor research` or the research skill. | [Research skill](.agents/skills/interceptor-research/SKILL.md) |
| Extensions | Add operator-supplied bridge domains, commands, runtime agents, and skills. Inspect installed extensions with `interceptor extensions list`. | [Extension authoring](docs/extensions/authoring.md) |

The default browser path and passive capture do not require CDP. Electron control uses CDP where appropriate, and optional browser debugger commands are available separately.

## Permissions and data

Interceptor runs locally and hands results to the agent or script you choose. That agent may send content to its model provider. Interceptor's browser extension has no publisher analytics; see the [privacy policy](docs/privacy.md) for its access, passive page buffers, and storage behavior.

- **Real access:** commands act in your accounts and apps. Browser commands normally target managed tabs, but the extension's permissions and local capture hooks are broader than that task boundary.
- **Credentials by name:** the macOS keychain-backed vault can deliver a secret to an allowed target with `--secret`; supported Chromium saved logins can also be filled by host. Standard browser reads mask password and credential-marked fields. This is not blanket redaction of screenshots, scene reads, eval, or network data.
- **MCP permissions:** reads and UI mutations are enabled by default. Destructive and arbitrary-code execution tiers require operator opt-in and confirmation. These gates belong to MCP; the direct CLI follows its own command contracts.
- **Focus:** default browser and Mac actions preserve your working context. Browser `--os` input requires a focused target; browser pixel-screenshot fallback may briefly borrow focus. Use `--no-fallback` when that is unacceptable.

[Permission guide](.agents/skills/interceptor-macos/references/permissions.md) · [Credential delivery](.agents/skills/interceptor-macos/references/accessibility-and-input.md) · [MCP controls](docs/mcp.md)

## Documentation

Start with the [browser guide](.agents/skills/interceptor-browser/SKILL.md), [Mac guide](.agents/skills/interceptor-macos/SKILL.md), or [iPhone guide](.agents/skills/interceptor-ios/SKILL.md). For implementation details, read [Architecture](ARCHITECTURE.md); for agent operating rules, read [AGENTS.md](AGENTS.md).

```bash
interceptor help                  # Capability overview for your installation
interceptor help <command>        # One command's usage and options
interceptor help --all            # Full command reference
interceptor manifest              # Machine-readable command contracts
interceptor diagnose              # Runtime and extension diagnostics
```

### Updates and troubleshooting

On a Full Mac installation, `interceptor update` checks for an update and `interceptor update status` reports progress. Windows and Linux Full installs update the way Sparkle updates a Mac: once a day the native provider checks the signed feed on `updates.hackervalley.media`, and a newer release opens Interceptor's update window with its release notes and **Skip This Version**, **Remind Me Later**, and **Install Update**. Nothing downloads or installs until you click. The installer is checked against the signed feed (plus its Authenticode signature on Windows), then **Install and Relaunch** installs it. `interceptor update` checks now and opens the window when there is an update; `interceptor update status` shows what happened. Set `INTERCEPTOR_AUTO_UPDATE=off` in the provider's login environment to stop the daily checks. Browser-only users can run a newer installer; `interceptor upgrade --full` adds Mac native capabilities.

If no browser context connects, check that both the runtime and extension are installed and enabled. `interceptor diagnose` distinguishes store and unpacked versions. If Interceptor disappears every time the browser restarts, run `interceptor diagnose extension`. It finds a profile that loaded the unpacked copy before 1.0.1 (an entry for the old extension ID blocks the folder), a load from `scripts/install.sh` that lasts one session, and two copies running at once. `--fix` repairs the first by restarting Brave, Vivaldi or Chromium on macOS; everything else gets exact steps. Installs and updates run the same check and ask before touching a browser. On macOS 27, an app needs your permission to read Chrome, Brave and Edge settings, so the check runs inside the bridge: in System Settings > Privacy & Security > Files & Folders, turn on each browser under `interceptor-bridge`, or give `interceptor-bridge` Full Disk Access. On a Mac that had Interceptor before 1.0.1, the installer asks and checks as soon as access is on. `interceptor reload --context <id>` reloads an unpacked extension; a store copy remains subject to store publication. For missing native permissions, use `interceptor macos trust --walkthrough`.

macOS package removal: `sudo bash "/Library/Application Support/Interceptor/uninstall.sh"`. Add `--bridge-only` to remove native Mac support while retaining Browser.

## Development and contributions

The CLI, daemon, and browser extension use TypeScript and Bun. The native Mac bridge and iPhone runner use Swift. A local daemon routes commands to the selected browser, bridge, app runtime, or device.

For a source install, use Bun and an installed Chrome or Brave browser. The default build on macOS also builds the native bridge and requires macOS 15+ and a Swift 6.2 toolchain. Source builds work on Apple silicon and Intel Macs. The `interceptor macos vm` commands require Apple silicon.

```bash
git clone https://github.com/Hacker-Valley-Media/Interceptor.git
cd Interceptor
bun install
bun run build
bash scripts/install.sh --browser-only --brave
# On macOS, use --full instead of --browser-only for native capabilities.
./dist/interceptor open "https://example.com"
```

Enable Developer Mode in the selected browser profile before loading an unpacked extension. Branded Chrome requires manually loading `extension/dist/` from its extensions page. The installer can relaunch Brave and asks before closing a running instance. Windows source installs use `scripts/install.ps1`; see the [Windows guide](docs/windows-install.md).

For code changes, run the checks appropriate to the affected surface:

```bash
bun run typecheck
bun test
bun run build
```

[Report a bug](https://github.com/Hacker-Valley-Media/Interceptor/issues) with the version, OS/browser or device, command, expected result, and relevant redacted output. Contributions to code, reproducible workflows, and documentation are welcome.

## License and credits

Interceptor is licensed under [Elastic License 2.0](LICENSE). See [commercial terms](COMMERCIAL.md).

Created by [Ron Eddings](https://github.com/ronaldeddings/). Thanks to [Pedram Amini](https://github.com/pedramamini/) for early feedback and [Maestro](https://runmaestro.ai), [Daniel Miessler](https://github.com/danielmiessler/) for the name and [PAI](https://github.com/danielmiessler/PAI), [Klaus Agnoletti](https://github.com/klausagnoletti/) for Edge/Vivaldi installer support, and [Alex Tabisz](https://github.com/atabisz/) for Linux support.
