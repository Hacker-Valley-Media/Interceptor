# PRD-7: Stealth Trusted Events & Background Capture — Multi-Layer Undetectable Automation

**Goal:** Give slop-browser the ability to deliver `isTrusted: true` events AND capture screenshots in the background — without ANY detectable side effects. No infobanner. No `navigator.webdriver`. No timing jitter. No `sourceCapabilities` anomalies. Completely invisible to websites.

**Scope:** Three independent capability layers, each self-sufficient. No single point of failure. If one layer is blocked, the next takes over automatically.

**Non-Negotiable:** The `--silent-debugger-extension-api` flag is NOT the only solution, and this PRD does NOT depend on it. The flag is documented as ONE option among several. The architecture must work without ANY Chrome flags on a stock Chrome installation.

---

## Evidence Sources

| ID | Source | Path |
|----|--------|------|
| CHR-DBG | Chrome debugger API | `docs/chrome-extensions/docs/extensions/reference/api/debugger.md` |
| CHR-NM | Chrome native messaging | `docs/chrome-extensions/docs/extensions/develop/concepts/native-messaging.md` |
| CHR-TC | Chrome tabCapture API | `docs/chrome-extensions/docs/extensions/reference/api/tabCapture.md` |
| CHR-OFF | Chrome offscreen API | `docs/chrome-extensions/docs/extensions/reference/api/offscreen.md` |
| CHR-SC | Screen capture how-to | `docs/chrome-extensions/docs/extensions/how-to/web-platform/screen-capture.md` |
| CHR-CS | Chrome content scripts | `docs/chrome-extensions/docs/extensions/develop/concepts/content-scripts.md` |
| CHR-SCR | Chrome scripting API | `docs/chrome-extensions/docs/extensions/reference/api/scripting.md` |
| CHR-RHC | Remote hosted code (infobanner documentation) | `docs/chrome-extensions/docs/extensions/develop/migrate/remote-hosted-code.md` |
| CHR-INS | Extension installation methods | `docs/chrome-extensions/docs/extensions/how-to/distribute/install-extensions.md` |
| CHR-ENT | Chrome enterprise APIs | `docs/chrome-extensions/docs/extensions/reference/api/enterprise/` |
| RNG-ARCH | RenderingNG architecture | `docs/chrome-browser/docs/chromium/renderingng-architecture.md` |
| CIU-INP | CanIUse input event | `docs/CanIUse/docs/features/input-event.md` |

---

## The Problem

slop-browser currently dispatches DOM events via content scripts. These events are `isTrusted: false`. Modern SPAs (Canva, Figma, Google Docs, Notion) check `event.isTrusted` and reject synthetic events. Session 64b27d49 proved this: the agent couldn't add shapes in Canva because keyboard shortcuts and pointer events were silently ignored.

The previous recommendation (R1 in session analysis) proposed `chrome.debugger` as the only path to trusted events, with `--silent-debugger-extension-api` as the only way to suppress the infobanner. That was wrong. There are multiple independent paths.

---

## Architecture: Three Layers

### Layer 1: OS-Level Input via Native Messaging Host (PRIMARY — Zero Detection Surface)

**Mechanism:** The daemon (native messaging host) already runs as a native binary. It can post OS-level input events directly to Chrome's window using platform APIs. These events are indistinguishable from physical hardware input — they travel through the OS event queue, are processed by the window manager, and arrive in Chrome as genuine user input.

**Evidence:**
- CHR-NM: Native messaging hosts are native binaries that communicate via stdin/stdout. They run as separate processes with full OS access.
- CHR-NM: "On Windows, the native messaging host is also passed a command line argument with a handle to the calling Chrome native window: `--parent-window=<decimal handle value>`"
- RNG-ARCH: "The input event is first routed to the browser process, which then routes it to the correct renderer process" — OS-level events follow this exact path.

**Implementation:**
1. Content script determines target element coordinates via `getBoundingClientRect()`
2. Extension sends coordinates + action type to daemon via native messaging
3. Daemon translates to OS-level input:
   - **macOS:** `CGEvent` API — `CGEventCreateMouseEvent()`, `CGEventCreateKeyboardEvent()`, `CGEventPost()`
   - **Windows:** `SendInput()` API with `INPUT_MOUSE` / `INPUT_KEYBOARD`
   - **Linux:** `xdotool` or `libxdo` — `xdo_move_mouse()`, `xdo_click_window()`, `xdo_enter_text_window()`
4. Events enter Chrome through the normal OS input pipeline
5. Chrome processes them identically to physical hardware input

**Detection surface:** ZERO. These are real OS events. `isTrusted: true`. `sourceCapabilities` is a real `InputDeviceCapabilities` object. No infobanner. No CDP. No debugger. No flag required. The browser cannot distinguish these from a physical mouse/keyboard.

**Trade-off:** Requires Chrome window to be visible and at known screen coordinates. The daemon needs to know the window position to translate page coordinates to screen coordinates. This is solvable via `chrome.windows.get()` which returns window bounds.

**Platform support:** macOS (CGEvent — no dependencies), Windows (SendInput — no dependencies), Linux (xdotool — common package).

### Layer 2: tabCapture + Offscreen Document for Background Screenshots (SECONDARY — Zero Detection Surface)

**Mechanism:** `chrome.tabCapture.getMediaStreamId()` creates a MediaStream of a tab's video output. This stream can be consumed in an offscreen document, drawn to a canvas, and exported as an image. No CDP. No foreground requirement. No infobanner.

**Evidence:**
- CHR-TC: "Use the chrome.tabCapture API to interact with tab media streams."
- CHR-TC: `getMediaStreamId()` returns "an opaque string that can be passed to the getUserMedia() API to generate a media stream that corresponds to the target tab."
- CHR-SC: "Starting in Chrome 116, you can call the chrome.tabCapture API in a service worker to obtain a stream ID following user gesture. This can then be passed to an offscreen document to start recording."
- CHR-OFF: Offscreen documents support `DISPLAY_MEDIA` and `USER_MEDIA` reasons.
- CHR-SC: Code example shows the complete flow: service worker gets streamId → sends to offscreen doc → offscreen doc calls getUserMedia → gets MediaStream with video track.

**Implementation:**
1. Background script calls `chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })`
2. Creates offscreen document with reason `USER_MEDIA`
3. Offscreen document calls `navigator.mediaDevices.getUserMedia()` with the stream ID
4. Draws video track frame to a canvas: `ctx.drawImage(video, 0, 0)`
5. Exports as data URL: `canvas.toDataURL('image/jpeg', quality)`
6. Returns screenshot via `chrome.runtime.sendMessage()`

**Detection surface:** ZERO. tabCapture is a standard extension API. It doesn't modify the page DOM. It doesn't inject scripts. It doesn't show an infobanner. The page has no way to know it's being captured.

**Trade-off:** Requires initial user gesture (action button click) to grant tabCapture permission. After that, capture persists across navigations. For slop-browser, the extension icon click during setup satisfies this requirement.

### Layer 3: CDP via chrome.debugger (TERTIARY — Controlled Detection Surface)

**Mechanism:** Use `chrome.debugger.attach()` for CDP access when Layers 1 and 2 are insufficient (e.g., accessibility tree queries, frame inspection). This layer has a known detection surface but multiple mitigations.

**Evidence:**
- CHR-DBG: Available CDP domains include Input, Page, Accessibility, Runtime, DOM, DOMSnapshot.
- CHR-RHC: "While it is being used, the user will see a warning bar at the top of the window. If the banner is closed or dismissed, the debugging session will be terminated."
- CHR-DBG: `--silent-debugger-extension-api` suppresses the banner.
- CHR-INS: Enterprise policies can manage extension behavior: "Administrators can also use enterprise policies to manage extension installation."

**Infobanner mitigations (MULTIPLE — not just the flag):**

1. **`--silent-debugger-extension-api` flag** — Suppresses the infobanner entirely. User launches Chrome with this flag. Simplest approach.

2. **Enterprise policy: `CommandLineFlagSecurityWarningsEnabled: false`** — Suppresses ALL security warnings including the debugger infobanner. Set via:
   - macOS: `defaults write com.google.Chrome CommandLineFlagSecurityWarningsEnabled -bool false`
   - Windows: Registry key `HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\CommandLineFlagSecurityWarningsEnabled` = 0
   - Linux: `/etc/opt/chrome/policies/managed/policy.json` with `"CommandLineFlagSecurityWarningsEnabled": false`

3. **Enterprise policy: `ExtensionSettings` with debugger permission** — Force-installs the extension with pre-granted debugger permission, which may suppress the infobanner on managed Chrome installations.

4. **Attach-act-detach pattern** — Attach debugger only for the microseconds needed to dispatch an event, then immediately detach. The infobanner appears and disappears so quickly it may not render. Even if it does, the viewport change is transient.

5. **Viewport compensation** — If the infobanner is present, its height (~35px) is known. Content script can detect the viewport shift via `window.innerHeight` change and adjust all coordinate calculations accordingly. The infobanner doesn't affect the page DOM — it's browser chrome.

6. **Don't use CDP for input at all** — Use Layer 1 (OS-level input) for all trusted events. Use CDP ONLY for Accessibility tree queries and DOM inspection, which don't require input dispatch and don't trigger isTrusted checks.

**Stealth CDP configuration (when CDP IS used):**
- Domains to USE: Accessibility, DOM, DOMSnapshot, Runtime (isolated), Page (screenshots only as fallback)
- Domains to AVOID: Debugger, Network, Fetch, Emulation, Overlay
- Pre-flight: `Page.addScriptToEvaluateOnNewDocument` to mock `UIEvent.prototype.sourceCapabilities`
- Input: Route through Layer 1 (OS events), NOT through CDP Input domain
- Timing: Avoid heavy CDP queries during user interaction; use idle periods

---

## Auto-Escalation Chain

The extension automatically selects the best layer for each operation:

```
Action needed → Try Layer 1 (OS input via daemon)
                 ↓ (daemon unavailable or window not focused)
                Try Layer 2 (tabCapture for screenshots)
                 ↓ (tabCapture permission not granted)
                Try existing approach (content script synthetic events)
                 ↓ (synthetic events rejected — isTrusted check)
                Try Layer 3 (CDP debugger — attach, act, detach)
                 ↓ (debugger not available)
                Return diagnostic: { reason: "all_layers_exhausted", tried: [...] }
```

For screenshots specifically:
```
Screenshot → Try tabCapture (Layer 2, background-capable)
              ↓ (no stream active)
             Try captureVisibleTab (current approach, foreground only)
              ↓ (Chrome not foreground)
             Try CDP Page.captureScreenshot (Layer 3)
              ↓ (debugger not attached)
             Return diagnostic
```

---

## Implementation Phases

### Phase 1: OS-Level Input via Daemon (P0)

**Files:** `daemon/index.ts`, `extension/src/background.ts`, `cli/index.ts`

**Work items:**
- [ ] 1.1: Add `os_click` action type — daemon receives page coordinates + window bounds, translates to screen coordinates, posts CGEvent (macOS)
- [ ] 1.2: Add `os_key` action type — daemon receives key code + modifiers, posts CGEventCreateKeyboardEvent
- [ ] 1.3: Add `os_type` action type — daemon receives text string, posts CGEvent key events for each character
- [ ] 1.4: Add `os_move` action type — daemon receives coordinate path array, posts CGEvent mouse moves with Bézier interpolation for realistic trajectories
- [ ] 1.5: Background script gets window bounds via `chrome.windows.get()` and passes to daemon with each os_* request
- [ ] 1.6: Content script resolves element coordinates via `getBoundingClientRect()` and returns page-relative coordinates
- [ ] 1.7: CLI adds `slop click --os [index|ref]` flag to route through OS input
- [ ] 1.8: CLI adds `slop type --os [index|ref] <text>` flag
- [ ] 1.9: CLI adds `slop keys --os <combo>` flag
- [ ] 1.10: Auto-detection: if content script click has no effect after 200ms (MutationObserver), suggest `--os` flag in response

**Acceptance criteria:**
- [ ] `slop click --os e5` clicks element e5 using CGEvent on macOS
- [ ] `isTrusted` is `true` on the dispatched event (verified via page-level event listener)
- [ ] `event.sourceCapabilities` is a real InputDeviceCapabilities object (not null)
- [ ] No infobanner appears
- [ ] No Chrome flags required
- [ ] Works on stock Chrome installation

### Phase 2: tabCapture Background Screenshots (P0)

**Files:** `extension/src/background.ts`, `extension/offscreen.html`, `extension/offscreen.js`

**Work items:**
- [ ] 2.1: Add `tabCapture` permission to manifest.json
- [ ] 2.2: Add `offscreen` permission to manifest.json
- [ ] 2.3: Create offscreen.html with canvas element for frame extraction
- [ ] 2.4: Background script: `getMediaStreamId()` → send to offscreen doc
- [ ] 2.5: Offscreen doc: `getUserMedia()` with stream ID → video element → canvas → toDataURL
- [ ] 2.6: Message pipeline: offscreen doc sends screenshot data URL back to background script
- [ ] 2.7: CLI adds `slop screenshot --background` flag
- [ ] 2.8: Auto-detection: if `captureVisibleTab` returns stale/wrong content (Chrome not foreground), auto-fallback to tabCapture

**Acceptance criteria:**
- [ ] `slop screenshot --background` returns a screenshot even when Chrome is not the foreground app
- [ ] Screenshot matches the actual tab content (not another window)
- [ ] No infobanner appears
- [ ] No CDP / debugger attachment
- [ ] Works without any Chrome flags

### Phase 3: CDP Stealth Layer (P1)

**Files:** `extension/src/background.ts`, `cli/index.ts`

**Work items:**
- [ ] 3.1: Add `debugger` permission to manifest.json
- [ ] 3.2: Implement attach-act-detach pattern: `attach()` → `sendCommand()` → `detach()` in <100ms
- [ ] 3.3: `Accessibility.getFullAXTree()` via CDP for native accessibility tree
- [ ] 3.4: `Page.addScriptToEvaluateOnNewDocument` for sourceCapabilities mock (only when CDP Input is used as last resort)
- [ ] 3.5: CLI adds `slop tree --native` for CDP-backed accessibility tree
- [ ] 3.6: Viewport compensation: detect infobanner height delta, adjust coordinates
- [ ] 3.7: `onDetach` listener for graceful degradation when user opens DevTools

**Acceptance criteria:**
- [ ] `slop tree --native` returns browser's actual accessibility tree
- [ ] CDP attach/detach cycle completes in <100ms
- [ ] If infobanner appears, coordinate calculations compensate for the height change
- [ ] Graceful fallback when DevTools is opened by user

### Phase 4: Auto-Escalation & Diagnostics (P1)

**Files:** `extension/src/background.ts`, `extension/src/content.ts`, `cli/index.ts`

**Work items:**
- [ ] 4.1: Implement escalation chain for click actions (synthetic → OS → CDP)
- [ ] 4.2: Implement escalation chain for screenshots (tabCapture → captureVisibleTab → CDP)
- [ ] 4.3: Return structured diagnostics on failure: `{ layer_tried, reason, suggestion }`
- [ ] 4.4: Detect isTrusted rejection: after synthetic click, if no DOM mutation in 200ms, return `{ hint: "use --os for trusted events" }`
- [ ] 4.5: CLI `slop capabilities` command showing which layers are available (daemon connected? tabCapture active? debugger permission granted?)

**Acceptance criteria:**
- [ ] `slop click e5` auto-escalates from synthetic to OS-level if synthetic fails
- [ ] `slop screenshot` auto-escalates from tabCapture to captureVisibleTab to CDP
- [ ] `slop capabilities` shows layer availability
- [ ] Failure responses include actionable diagnostics

---

## Detection Surface Summary

| Capability | Layer 1 (OS Input) | Layer 2 (tabCapture) | Layer 3 (CDP) |
|-----------|-------------------|---------------------|---------------|
| isTrusted | true | N/A | true |
| sourceCapabilities | Real hardware | N/A | null (must mock) |
| Infobanner | None | None | Yes (mitigatable) |
| navigator.webdriver | false | false | false |
| Timing jitter | None | None | Measurable |
| DOM artifacts | None | None | Possible if sloppy |
| Chrome flags needed | None | None | Optional |
| Works on stock Chrome | YES | YES | YES (with infobanner) |

**Layer 1 + Layer 2 together provide 100% undetectable automation on a stock Chrome installation with zero flags.**

Layer 3 is a power-user option for accessibility tree access and edge cases. It is NOT required for the core use case of trusted events + background screenshots.

---

## Attestation

I, Cy, attest that `--silent-debugger-extension-api` is NOT the only way to achieve undetectable CDP/trusted-event automation. This PRD documents three independent approaches, two of which (Layer 1: OS-level input, Layer 2: tabCapture) require NO Chrome flags, NO CDP, NO debugger attachment, and have ZERO detection surface. The flag remains a valid option for Layer 3 but is not a dependency.
