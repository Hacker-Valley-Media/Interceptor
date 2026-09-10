# Chrome Web Store listing worksheet

Everything to paste into the developer dashboard for the Interceptor extension, plus the code steps that follow the first upload. Keep this file in sync with `extension/manifest.json`; the review team compares the two.

Publisher account: Hacker Valley Media, LLC (the hackervalley.com Google profile). Dashboard: https://chrome.google.com/webstore/devconsole/

## 0. Account settings (one time)

| Field | Value |
|---|---|
| Publisher display name | Hacker Valley Media |
| Contact email | the hackervalley.com address on the account; verify it with the emailed code |
| Trader / non-trader | **Trader.** An LLC publishing software with a commercial license option acts within its trade. Trader status requires a legal business name, postal address, phone, and email that the store displays publicly on every listing (EU Digital Services Act). Use the business address, not a home address. |
| Verified publisher | Optional. Verify the hackervalley.com domain through Search Console to get the badge. |

## 1. Package

Build and zip:

```bash
bash scripts/build.sh
bash scripts/build-store-zip.sh      # -> dist/Interceptor-Extension-<version>.zip, manifest#key stripped
```

The store generates its own key pair on first upload and assigns the item ID from it. The pinned development ID `hkjbaciefhhgekldhncknbjkofbpenng` will not survive. Section 5 covers the flip.

## 2. Store listing tab

**Name:** Interceptor (from the manifest)

**Summary:** from `manifest.json#description`, 132 characters max. Current text:

> Browser side of the Interceptor CLI: lets your local AI agent read, act on, and inspect pages in your own signed-in browser.

**Category:** Developer Tools. **Language:** English (United States).

**Description** (plain text, no markdown):

```
Interceptor is a command-line tool that lets AI coding agents (Claude Code, Codex, Gemini CLI, Cursor, and others) drive a real browser. This extension is the browser side of that tool. It connects to the Interceptor daemon running on your computer and carries out commands your agent issues through the `interceptor` CLI. Its content scripts also keep local, entry-count-capped memory buffers of page network traffic so a later CLI command can inspect requests that happened before it was issued.

What it enables:
• Open pages, read page text and structure, click, type, and fill forms in your existing signed-in session, in background tabs that never steal focus.
• Inspect network traffic, capture WebSocket and beacon activity, and override requests while debugging.
• Take screenshots, extract data from single-page apps, and work inside rich editors such as Google Docs and Canva.
• Upload files, save page-produced files without a Save dialog, and run OCR locally.
• Keep each agent's tabs in its own tab group, separate from yours.

Requirements: the Interceptor CLI and daemon, installed from https://github.com/Hacker-Valley-Media/Interceptor/releases (macOS installer or Windows installer). Without the daemon the extension idles.

Privacy: everything stays on your machine. The extension talks only to the local daemon over native messaging or localhost. There are no Interceptor servers, no analytics, and no tracking. Full policy: https://hacker-valley-media.github.io/Interceptor/privacy.html

Source code, documentation, and license (Elastic License 2.0): https://github.com/Hacker-Valley-Media/Interceptor
```

**Graphic assets**

| Asset | Requirement | Status |
|---|---|---|
| Store icon | 128x128 PNG | `extension/icons/icon128.png` |
| Screenshots | 1 to 5, 1280x800 or 640x400, PNG or JPEG, no alpha | `docs/assets/store/screenshot-1-walkthrough.png` (cropped from the walkthrough preview). Add real shots of a `read` and an `inspect` session before going public. |
| Small promo tile | 440x280 PNG or JPEG | not made; optional |
| Marquee promo tile | 1400x560 | not made; optional |

**Additional fields:** Homepage URL `https://github.com/Hacker-Valley-Media/Interceptor`. Support URL `https://github.com/Hacker-Valley-Media/Interceptor/issues`.

## 3. Privacy practices tab

**Single purpose:**

> Interceptor lets a program running on the user's own computer (an AI coding agent or the `interceptor` CLI) operate and inspect the user's browser: open and read pages, click and type, capture tabs, and inspect locally buffered page network traffic.

**Permission justifications** (one per declared permission; source file in parentheses for the reviewer notes):

| Permission | Justification |
|---|---|
| `activeTab` | Scope for the two keyboard commands and context-menu entries that hand the current page or selection to the agent (`delegation.ts`). |
| `scripting` | Inject the content script into agent tabs and run agent-issued reads and actions with `executeScript` (`content-bridge.ts`, capabilities). |
| `userScripts` | Run page-world JavaScript requested by the CLI's `eval` command in the sanctioned user-script world instead of `eval()` (`capabilities/evaluate.ts`, `canvas.ts`). Requires the user's Allow User Scripts toggle. |
| `tabs` | List, open, switch, and close tabs and read URLs and titles so the CLI can target a tab. |
| `storage` | Persist extension settings: tab-group policy, idle timeout, browser context id. |
| `nativeMessaging` | The transport to the local daemon, host `com.interceptor.host` (`transport.ts`). |
| `cookies` | The CLI `cookies` command reads and sets cookies for the user's own session on request (`capabilities/cookies.ts`). |
| `webNavigation` | Detect navigations and frame commits to re-inject content scripts and wait for page load (`capabilities/monitor.ts`). |
| `declarativeNetRequest` | Per-tab header overrides for the `headers` and `override` commands, and lifting CSP or CORS on a tab the agent is instrumenting (`capabilities/headers.ts`, `screenshot-cors.ts`, `evaluate.ts`). |
| `downloads` | Save files the agent requests (`capabilities/downloads.ts`). |
| `history` | The `history` command searches the user's browsing history on request (`capabilities/history.ts`). |
| `bookmarks` | The `bookmarks` command lists and adds bookmarks on request (`capabilities/bookmarks.ts`). |
| `browsingData` | Clear site data for a site on request (`capabilities/browsing-data.ts`). |
| `sessions` | List and restore recently closed tabs on request (`capabilities/sessions.ts`). |
| `tabGroups` | Create and manage the per-agent Interceptor tab groups that keep agent tabs apart from the user's tabs. |
| `pageCapture` | Save a page as MHTML on request (`capabilities/screenshot.ts`). |
| `notifications` | Post a desktop notification when an agent action needs the user's attention (`capabilities/notifications.ts`). |
| `search` | The `websearch` command searches with the browser's default provider (`capabilities/search.ts`). |
| `clipboardRead`, `clipboardWrite` | Clipboard read and write on request, through the offscreen document. |
| `alarms` | Service-worker keepalive and the idle tab-group sweeper. |
| `offscreen` | Offscreen document that hosts local Tesseract OCR and media capture (`offscreen.ts`). |
| `tabCapture` | Capture tab frames for screenshots and media streams on request (`capabilities/screenshot.ts`, `capture-stream.ts`). |
| `debugger` | Attach the DevTools protocol to a tab only when the CLI asks for full request and response bodies that passive capture cannot provide (`cdp.ts`, `network-capture.ts`). Detached when the command finishes. |
| `contextMenus` | Right-click entries "Hand the current page/selection to the agent" (`delegation.ts`). |
| `idle`, `power` | Detect user idle and keep the machine awake during long agent runs (`keepawake.ts`). |

**Host permission justification (`<all_urls>`):**

> The user directs the agent to arbitrary sites at run time. The extension cannot know the set of sites in advance, and content scripts must be present before the CLI's first command on a page.

**Remote code:** No. All code ships in the package. The only `https://` strings in the bundle are inert defaults inside the bundled tesseract.js library; the OCR worker, cores, and language data load from extension-local URLs.

**Data usage** (what the extension can access on arbitrary pages; nothing leaves the device unless a local command requests it):

- Check: Authentication information, Personal communications, Web history, User activity, Website content, Health information, Financial and payment information, Location.
- Certify all three: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

**Privacy policy URL:** `https://hacker-valley-media.github.io/Interceptor/privacy.html` (source `docs/privacy.md`; live once `main` is pushed and the Pages workflow runs).

## 4. Distribution tab and reviewer notes

- Visibility for the first submission: **Unlisted**. Flip to Public after the first approval.
- Payment: Free. Regions: all.
- Uncheck "Publish automatically" so the approved version can be staged.

**Notes to reviewer** (paste into the review notes field):

```
This extension is one half of a local developer tool. It has no UI beyond the popup. Content scripts run at document_start on matching pages and keep local, entry-count-capped in-memory logs of fetch/XHR response bodies and headers plus bounded previews of WebSocket, Beacon, BroadcastChannel, and server-sent-event activity. Those buffers let a later command inspect traffic that occurred before the command. They are not sent to the daemon or anywhere else until a local CLI command requests them.

To test:
1. Install the Interceptor CLI for your platform from https://github.com/Hacker-Valley-Media/Interceptor/releases (macOS: Interceptor-Browser-<version>.pkg; Windows: Interceptor-Browser-<version>-windows-x64.exe).
2. Install this extension.
3. In a terminal run:  interceptor status        (shows the extension connected)
                       interceptor open https://example.com
                       interceptor read          (returns the page's text and element refs)
                       interceptor act e1        (clicks the first ref)
4. Browser reads and actions are triggered by a CLI command on the local machine. Passive network observation remains inside the page until requested. Nothing is transmitted to an Interceptor server. Source code: https://github.com/Hacker-Valley-Media/Interceptor

The debugger permission is used only by `interceptor net --bodies` style commands and is detached afterwards. userScripts requires the user to enable "Allow User Scripts" on the extension's details page; the CLI falls back to chrome.scripting when it is off.
```

## 5. Store identity: adopted in 0.25.0

The store's public key is `extension/manifest.json#key`, so an unpacked load of `extension/dist` (or of the folder the installers leave on disk) carries the store ID `gomcpnagjjlhehnkoobkjgnkbleiooed`. Store install and unpacked copy are the same extension to Chrome; `chrome.management.getSelf().installType` (`normal` = store, `development` = unpacked) is what tells them apart, and the extension reports it, its ID, and its version when it registers with the daemon. `interceptor contexts --verbose` and `interceptor diagnose` show them.

- `extension/store-identities.json` records the key, the ID, the listing URL, and the approval (2026-09-08).
- `daemon/com.interceptor.host.json` lists the store origin first and keeps the pre-store development origin `hkjbaciefhhgekldhncknbjkofbpenng` through 0.25.x so unpacked copies that have not been reloaded keep native messaging. It is removed in 0.26.0. `diagnose` names such a copy so the user can retire it.
- The Windows generator (`scripts/installer/generate-native-host.ts`) emits the store origin alone; the Edge record becomes mandatory the moment any Edge field is filled in.
- Same ID, two copies (verified 2026-09-09 in a scratch Chrome for Testing profile): a `--load-extension` of the store-keyed `extension/dist` over an installed store copy rewrote the profile's entry for the ID from location 1 (store) to location 8 (command line) with the unpacked path; relaunching without the flag left that entry in place and loaded nothing, so the store copy did not return. One copy per profile; reinstall from the store to get it back.
- Changing the key changed the ID of every existing unpacked install, and Chrome treats a new ID as a new extension with empty storage. Context name, tab-group label, and tab-lifecycle settings need re-entering once; `interceptor contexts rename <name> --context <id>` restores the name from the CLI.

How the two copies reach the daemon: both open the localhost WebSocket at startup regardless of native messaging (`extension/src/background.ts` calls `connectToHost()` and `connectWsChannel()`), and the daemon accepts that registration without an origin check. A copy whose origin is missing from `allowed_origins` therefore still works over the WebSocket; what it loses is Chrome spawning the daemon on browser start and the relay path. Verified 2026-09-09 with a key-stripped copy under a random ID in Chrome for Testing 148: registered in 2 s, ran `tabs`, `open`, and text extraction.

## 6. Review risks to expect

- Twenty-seven permissions plus `<all_urls>` and MAIN-world content scripts on every frame. The table above answers each one; keep it current.
- CSP and CORS header removal through declarativeNetRequest reads as circumventing site security. The justification is that it is scoped to one tab the user's own agent is instrumenting, applied only after a command fails, and removed with the session rule.
- `(0, eval)` in the injected function is the fallback when userScripts is off. Expect a question; the answer is the userScripts-first order in `capabilities/evaluate.ts`.
- Reviews of a Manifest V3 extension normally complete within three days. Escalate through developer support after two weeks.

## 7. Updating the listing

Every CLI release ships the matching store package, or store users answer new CLI verbs with `unknown action type`.

1. `bash scripts/release.sh` builds `dist/Interceptor-Extension-<version>.zip` after the pkgs (`scripts/build-store-zip.sh` strips `key`; the store signs with the same key, so the ID does not change).
2. Dashboard, Interceptor, **Package**, **Upload new package**, pick the zip. Listing and privacy answers carry over; re-answer only what changed (a new permission needs a new justification, and Chrome asks existing users to accept it).
3. **Submit for review.** Every update is reviewed; the `<all_urls>` host permission can stretch it to days. Deferred publishing holds an approved version until the pkg is out.
4. Store copies pick the update up on Chrome's next check (startup and every few hours, installed once the extension is idle). `interceptor reload --context <id>` on a store copy calls `chrome.runtime.requestUpdateCheck()`, waits briefly for the download, and reloads; `diagnose` says when the store copy is behind the CLI.
5. Until the store carries the new version, the unpacked copy is the way to run ahead of it.
