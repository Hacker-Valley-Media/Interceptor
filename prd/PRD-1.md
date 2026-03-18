# PRD-1: slop-browser — Agent-Driven Chrome Extension via CLI Bridge

**Goal:** Build a Chrome extension + Bun CLI bridge that gives AI agents (Claude Code) full, undetectable browser control without CDP, MCP, or API keys.

**Scope:** New project. Three components: Chrome extension (content script + background service worker), Bun daemon (native messaging bridge + Unix domain socket), and `slop` CLI tool (the agent-facing interface). No changes to any existing projects.

**Core Principle:** The AI agent IS the LLM. slop-browser is a transparent tool layer — it exposes raw browser capabilities as CLI subcommands that the agent selectively invokes. No internal agent loop, no prompt engineering, no API keys. The agent decides what to do; slop-browser does it.

**Problem Statement:**

1. **CDP is detectable and fragile.** Chrome DevTools Protocol requires the `debugger` permission, which triggers a visible warning banner in Chrome. Websites can detect CDP via `navigator.webdriver`, `Runtime.evaluate` artifacts, and CDP-specific DOM properties. CDP also breaks on extension updates and adds significant connection management overhead.
2. **MCP chokes on large payloads.** DOM trees, page content, and network intercepts produce large responses. MCP serializes everything as JSON, and large JSON blobs degrade MCP transport performance, eat context windows, and can cause tool call failures. A CLI tool returns text to stdout — the agent reads exactly what it needs.
3. **Standalone browser agents duplicate the agent loop.** Existing tools (Puppeteer-based agents, browser automation frameworks) embed their own LLM provider, prompt templates, and agent loops. When instantiated from Claude Code, this creates a redundant layer — Claude Code already has an agent loop, context management, and tool orchestration. The extension should be a dumb actuator, not a second brain.
4. **HTTP is the wrong transport for local IPC.** An extension talking to a process on the same machine doesn't need TCP, CORS, or a port. Chrome Native Messaging provides stdin/stdout pipes. The daemon bridges this to a Unix domain socket for the CLI.

---

## Research Evidence

### Non-CDP Browser Automation (Proven Techniques)

| Technique | Chrome Extension API | CDP Required? |
|-----------|---------------------|---------------|
| XHR/Fetch interception | `window.fetch` prototype override via MAIN world | No |
| DOM element interaction | `document.querySelector()` + `.click()` | No |
| Text input | `element.value = text` + dispatch events | No |
| Page mutation tracking | `MutationObserver` | No |
| Network observation | `CustomEvent` dispatch from injected script | No |
| Cross-context messaging | `document.dispatchEvent(new CustomEvent())` | No |
| Script injection | Content script + `world: 'MAIN'` in MV3 | No |
| Header modification | `chrome.declarativeNetRequest` | No |
| Cookie access | `chrome.cookies` | No |
| Screenshot capture | `chrome.tabs.captureVisibleTab()` | No |
| Tab management | `chrome.tabs.*` | No |
| Storage access | `chrome.storage.local` / `chrome.storage.session` | No |
| Download management | `chrome.downloads` | No |
| History access | `chrome.history` | No |
| Bookmark access | `chrome.bookmarks` | No |

**Finding:** Every browser automation action that CDP-based tools perform can be done through standard Chrome extension APIs and content script DOM manipulation — without any detectable fingerprint.

### Bun Native Messaging Host + CLI Capabilities

| Capability | Bun API | Role |
|------------|---------|------|
| Read stdin (JSON messages from Chrome) | `Bun.stdin.stream()` | Daemon: native messaging transport |
| Write stdout (JSON messages to Chrome) | `Bun.write(Bun.stdout, data)` | Daemon: native messaging transport |
| Unix domain socket server | `Bun.listen({ unix: path })` | Daemon: CLI bridge |
| Unix domain socket client | `Bun.connect({ unix: path })` | CLI: connect to daemon |
| File I/O | `Bun.file()` / `Bun.write()` | PID file, config |
| TypeScript native | Zero-config, no transpile step | DX |
| Single binary build | `bun build --compile` | CLI distribution |

### Chrome Native Messaging Protocol

**How it works:**
1. Extension calls `chrome.runtime.connectNative('com.slopbrowser.host')`
2. Chrome reads the native messaging host manifest (registered JSON file)
3. Chrome spawns the specified executable (Bun process — the daemon)
4. Chrome pipes extension messages to the daemon's stdin as length-prefixed JSON
5. Daemon writes length-prefixed JSON to stdout — Chrome delivers to extension
6. Port-based API: `.postMessage()`, `.onMessage`, `.onDisconnect`

**Message format:** 4-byte native-endian length prefix + UTF-8 JSON payload

**Constraints:**
- Max message size: 1 MB per message
- One native messaging host connection per extension instance
- Host process lifetime tied to port connection (disconnect = process exit)
- Host manifest must be registered in OS-specific location

### Claude Code Integration Model

Claude Code interacts with external tools via the **Bash tool**. The `slop` CLI is invoked as Bash commands, returning results to stdout. Claude Code:

- Has its own agent loop, context window, and decision-making
- Calls tools selectively based on function descriptions
- Manages its own history and retry logic
- Can be configured with `--allowedTools "Bash(slop *)"` for auto-approval
- Subagent definitions can scope `slop` access to specific agent types

**Why not MCP:** MCP returns JSON that gets injected into context. DOM trees and page content can be 50-500KB of JSON — this bloats context and degrades tool call reliability. CLI output via Bash is plain text, can be truncated, and the agent naturally manages what it reads.

**Why not a direct subagent with extension MCP:** The extension MCP server approach (like Claude in Chrome) tightly couples the extension to one AI provider. The CLI bridge is transport-agnostic — any agent that can run shell commands can control the browser.

---

## Chrome Extension Docs Grounding

**Native Messaging:**
- Permission: `"nativeMessaging"` in manifest
- `chrome.runtime.connectNative(hostName)` returns a `Port` object
- Host manifest specifies: `name`, `description`, `path` (to executable), `type: "stdio"`, `allowed_origins` (extension IDs)

**Content Scripts:**
- `chrome.scripting.executeScript({ target: { tabId }, func })` — inject functions into page context
- Content scripts share DOM but run in isolated world (no access to page JS variables)
- To access page JS context: use `world: 'MAIN'` in MV3 `chrome.scripting.registerContentScripts()`

**Tabs API:**
- `chrome.tabs.query({ active: true, currentWindow: true })` — get active tab
- `chrome.tabs.create({ url })` — open new tab
- `chrome.tabs.update(tabId, { url })` — navigate existing tab
- `chrome.tabs.remove(tabId)` — close tab
- `chrome.tabs.onUpdated` — detect navigation completion

**Scripting API:**
- `chrome.scripting.executeScript()` — inject code into any tab
- `world: 'MAIN'` — execute in page's JS context (access page variables, prototype overrides)
- `world: 'ISOLATED'` — execute in content script's isolated world (default)

**Cookies API:**
- `chrome.cookies.getAll({ domain })` — read cookies
- `chrome.cookies.set()` — write cookies
- `chrome.cookies.remove()` — delete cookies

**Web Request / Declarative Net Request:**
- `chrome.declarativeNetRequest` — modify headers, block/redirect requests
- Rules-based, no persistent background page needed

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Claude Code (Agent)                 │
│                                                     │
│  The LLM. Decides what browser actions to take.     │
│  Calls `slop` CLI via Bash tool.                    │
│  Manages its own agent loop, history, and context.  │
└────────────────────────┬────────────────────────────┘
                         │ Bash tool calls
                         │ (e.g., `slop state`, `slop click 5`)
                         │
┌────────────────────────┴────────────────────────────┐
│                   slop CLI                           │
│                                                      │
│  Thin client. Connects to daemon via Unix socket.    │
│  Sends command, waits for response, prints to stdout.│
│  Each invocation is stateless — connect, send, recv. │
└────────────────────────┬─────────────────────────────┘
                         │ Unix Domain Socket
                         │ /tmp/slop-browser.sock
                         │
┌────────────────────────┴─────────────────────────────┐
│              Bun Daemon (Bridge Process)              │
│                                                       │
│  Spawned by Chrome via Native Messaging.              │
│  Bridges two transports:                              │
│    • Native Messaging (stdin/stdout) ↔ Extension      │
│    • Unix Domain Socket ↔ CLI                         │
│                                                       │
│  No agent logic. No LLM calls. Pure message routing.  │
│  Writes PID + socket path to /tmp/slop-browser.pid    │
└────────────────────────┬─────────────────────────────┘
                         │ stdin/stdout
                         │ (Native Messaging, 4-byte length prefix + JSON)
                         │
┌────────────────────────┴─────────────────────────────┐
│                 Chrome Extension                      │
│                                                       │
│  ┌──────────────────┐   ┌─────────────────────────┐  │
│  │ Content Script    │   │ Background Service       │  │
│  │ (per tab)         │   │ Worker                   │  │
│  │                   │   │                          │  │
│  │ • DOM extraction  │◄─►│ • Native messaging port  │  │
│  │ • Action execution│   │ • Tab management         │  │
│  │ • Event dispatch  │   │ • Route messages         │  │
│  │ • Network hooks   │   │ • Screenshot capture     │  │
│  │ • Stealth layer   │   │ • Cookie/storage access  │  │
│  └──────────────────┘   └─────────────────────────┘  │
│                                                       │
│  ┌──────────────────┐                                │
│  │ MAIN World Script │                               │
│  │ (injected)        │                               │
│  │                   │                               │
│  │ • Fetch intercept │                               │
│  │ • XHR intercept   │                               │
│  │ • JS context read │                               │
│  │ • Prototype hooks │                               │
│  └──────────────────┘                                │
└───────────────────────────────────────────────────────┘
                         │
                    DOM / Web APIs
                         │
                   ┌─────┴─────┐
                   │  Web Page  │
                   └───────────┘
```

---

## Phase 1: Native Messaging Transport + IPC Bridge

**Goal:** Extension ↔ Bun daemon ↔ CLI can exchange messages end-to-end.

### 1.1 Bun Daemon — Native Messaging + Unix Socket Bridge

**File:** `daemon/index.ts`

The daemon is spawned by Chrome's native messaging system. On startup, it:
1. Sets up native messaging transport (stdin/stdout with 4-byte length prefix)
2. Opens a Unix domain socket server at `/tmp/slop-browser.sock`
3. Writes PID and socket path to `/tmp/slop-browser.pid`
4. Bridges messages between the two transports

```typescript
import { unlinkSync } from "node:fs"

const SOCKET_PATH = "/tmp/slop-browser.sock"
const PID_PATH = "/tmp/slop-browser.pid"

try { unlinkSync(SOCKET_PATH) } catch {}

const pendingRequests = new Map<string, { resolve: (v: unknown) => void }>()

async function readNativeMessage(): Promise<unknown> {
  const reader = Bun.stdin.stream().getReader()
  const lengthBuf = await readExact(reader, 4)
  const length = new DataView(lengthBuf.buffer).getUint32(0, true)
  const messageBuf = await readExact(reader, length)
  return JSON.parse(new TextDecoder().decode(messageBuf))
}

function sendNativeMessage(msg: unknown): void {
  const json = JSON.stringify(msg)
  const encoded = new TextEncoder().encode(json)
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, encoded.byteLength, true)
  Bun.write(Bun.stdout, Buffer.concat([length, encoded]))
}

Bun.listen({
  unix: SOCKET_PATH,
  socket: {
    data(socket, data) {
      const request = JSON.parse(data.toString())
      const id = request.id ?? crypto.randomUUID()
      pendingRequests.set(id, {
        resolve: (result) => socket.write(JSON.stringify(result) + "\n")
      })
      sendNativeMessage({ ...request, id })
    },
    close() {},
    error(socket, err) { console.error(err) }
  }
})

Bun.write(PID_PATH, `${process.pid}\n${SOCKET_PATH}\n`)

async function listenNative() {
  while (true) {
    const msg = await readNativeMessage() as { id?: string }
    const pending = msg.id ? pendingRequests.get(msg.id) : null
    if (pending) {
      pending.resolve(msg)
      pendingRequests.delete(msg.id!)
    }
  }
}

listenNative()
```

### 1.2 Native Messaging Host Manifest

**File:** `daemon/com.slopbrowser.host.json`

```json
{
  "name": "com.slopbrowser.host",
  "description": "slop-browser daemon bridge",
  "path": "/Volumes/VRAM/00-09_System/01_Tools/slop-browser/daemon/run.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<EXTENSION_ID>/"]
}
```

### 1.3 Daemon Runner Script

**File:** `daemon/run.sh`

```bash
#!/bin/bash
exec bun run /Volumes/VRAM/00-09_System/01_Tools/slop-browser/daemon/index.ts
```

### 1.4 Manifest Registration

**macOS path:** `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.slopbrowser.host.json`

Symlink or copy the host manifest to this location.

### 1.5 Background Service Worker — Native Port

**File:** `extension/src/background.ts`

```typescript
let nativePort: chrome.runtime.Port | null = null

function connectToHost() {
  nativePort = chrome.runtime.connectNative("com.slopbrowser.host")
  nativePort.onMessage.addListener(handleHostMessage)
  nativePort.onDisconnect.addListener(() => {
    nativePort = null
  })
}

chrome.runtime.onInstalled.addListener(connectToHost)
chrome.runtime.onStartup.addListener(connectToHost)
```

### 1.6 Extension Manifest

**File:** `extension/manifest.json`

```json
{
  "manifest_version": 3,
  "name": "slop-browser",
  "version": "0.1.0",
  "permissions": [
    "activeTab",
    "scripting",
    "tabs",
    "storage",
    "nativeMessaging",
    "cookies",
    "webNavigation",
    "declarativeNetRequest"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }]
}
```

### 1.7 CLI Client — Socket Connection

**File:** `cli/index.ts`

The CLI is what Claude Code calls via Bash. Stateless — each invocation connects to the daemon's Unix socket, sends a command, receives a response, prints to stdout, and exits.

```typescript
import { parseArgs } from "node:util"

const SOCKET_PATH = "/tmp/slop-browser.sock"

async function sendCommand(command: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = Bun.connect({
      unix: SOCKET_PATH,
      socket: {
        data(socket, data) {
          resolve(JSON.parse(data.toString()))
          socket.end()
        },
        error(socket, err) { reject(err) },
        connectError(socket, err) {
          reject(new Error("slop daemon not running. Open Chrome with the extension loaded."))
        }
      }
    })
  })
}
```

- [x] Daemon reads/writes length-prefixed JSON on stdin/stdout (native messaging)
- [x] Daemon opens Unix domain socket at `/tmp/slop-browser.sock`
- [x] Daemon writes PID file to `/tmp/slop-browser.pid`
- [x] Background service worker connects via `connectNative()`
- [x] CLI connects to socket, sends command, receives response
- [x] Round-trip verified: CLI → socket → daemon → native messaging → extension → back

---

## Phase 2: DOM Extraction (Content Script)

**Goal:** Content script builds an indexed, text-based DOM representation for agent consumption.

### 2.1 Interactive Element Detection

**File:** `extension/src/content.ts`

Walk the DOM tree, identify interactive/visible elements, assign indices.

Detection criteria:
- **Interactive elements:** `a`, `button`, `input`, `select`, `textarea`, `[role="button"]`, `[role="link"]`, `[role="tab"]`, `[role="menuitem"]`, `[onclick]`, `[contenteditable="true"]`, `details`, `summary`
- **Visible check:** `element.offsetParent !== null` and `getComputedStyle(element).visibility !== 'hidden'` and `getComputedStyle(element).display !== 'none'`
- **Viewport check:** `element.getBoundingClientRect()` intersects viewport (with configurable expansion for near-viewport elements)
- **Deduplication:** Skip nested interactive elements that are children of already-indexed parents (e.g., `<span>` inside `<button>`)

### 2.2 DOM Tree to Indexed Text

**File:** `extension/src/content.ts`

Compact text format optimized for LLM consumption:
```
url: https://example.com/dashboard
title: Dashboard - Example App
scroll: 0/2400 (vh:800)

[0]<a href="/dashboard">Dashboard</a>
[1]<button>Submit Form</button>
[2]<input type="text" placeholder="Search..." value=""/>
[3]<select>
  [4]<option>Option A</option>
  [5]<option selected>Option B</option>
</select>
[6]<a href="/settings">Settings</a>
---
Static text: Welcome back, Ron. You have 3 unread notifications.
```

The `selectorMap` maps index to a stable CSS selector chain for action execution.

### 2.3 Page State Object

**File:** `extension/src/content.ts`

```typescript
interface PageState {
  url: string
  title: string
  elementTree: string
  staticText: string
  scrollPosition: { y: number; height: number; viewportHeight: number }
  tabId: number
  timestamp: number
}
```

### 2.4 Screenshot Capability

**File:** `extension/src/background.ts`

Uses `chrome.tabs.captureVisibleTab()` — no CDP needed.

```typescript
async function captureScreenshot(tabId: number): Promise<string> {
  const dataUrl = await chrome.tabs.captureVisibleTab(
    undefined,
    { format: "jpeg", quality: 80 }
  )
  return dataUrl
}
```

Screenshots are saved to a temp file path and the path is returned to the CLI, avoiding large base64 blobs in stdout.

- [ ] Content script identifies interactive elements with index mapping
- [ ] DOM tree renders as indexed text format with metadata header
- [ ] Static text content extracted separately for reading tasks
- [ ] PageState includes URL, title, element tree, scroll info, timestamp
- [ ] Screenshot captures to temp file, returns path
- [ ] selectorMap maintained for index to element resolution

---

## Phase 3: Action Execution (Content Script + Background)

**Goal:** Extension executes browser actions commanded by the CLI, covering the full browser capability surface.

### 3.1 Core Action Types

**File:** `extension/src/types.ts`

```typescript
type Action =
  | { type: "click"; index: number }
  | { type: "input_text"; index: number; text: string; clear?: boolean }
  | { type: "navigate"; url: string }
  | { type: "scroll"; direction: "up" | "down" | "top" | "bottom"; amount?: number }
  | { type: "select_option"; index: number; value: string }
  | { type: "send_keys"; keys: string }
  | { type: "wait"; ms: number }
  | { type: "go_back" }
  | { type: "go_forward" }
  | { type: "extract_text"; index?: number }
  | { type: "extract_html"; index?: number }
  | { type: "evaluate"; code: string; world?: "MAIN" | "ISOLATED" }
  | { type: "screenshot" }
  | { type: "tab_create"; url?: string }
  | { type: "tab_close"; tabId?: number }
  | { type: "tab_switch"; tabId: number }
  | { type: "tab_list" }
  | { type: "cookies_get"; domain: string }
  | { type: "cookies_set"; cookie: chrome.cookies.SetDetails }
  | { type: "cookies_delete"; url: string; name: string }
  | { type: "network_intercept"; patterns: string[]; enabled: boolean }
  | { type: "network_log"; since?: number }
  | { type: "storage_get"; keys?: string[] }
  | { type: "storage_set"; data: Record<string, unknown> }
  | { type: "headers_modify"; rules: HeaderRule[] }
  | { type: "focus"; index: number }
  | { type: "hover"; index: number }
  | { type: "drag"; fromIndex: number; toIndex: number }
  | { type: "file_upload"; index: number; filePath: string }

interface ActionResult {
  success: boolean
  error?: string
  data?: unknown
}
```

### 3.2 Click Action

**File:** `extension/src/content.ts`

Resolve index from selectorMap, scroll into view, dispatch full event sequence (mouseover → mousedown → mouseup → click) to match real user behavior. Fallback: dispatch `MouseEvent` with coordinates if `.click()` doesn't trigger the expected handler.

### 3.3 Text Input Action

**File:** `extension/src/content.ts`

If `clear: true`, select all + delete first. Set `element.value`, dispatch `input`, `change`, and `compositionend` events. For contentEditable elements, set `innerText` and dispatch `input` on the element. Trigger any framework-specific update handlers (React synthetic events via `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`).

### 3.4 Navigation Actions

**File:** `extension/src/background.ts`

- `navigate`: `chrome.tabs.update(tabId, { url })` — wait for `chrome.webNavigation.onCompleted`
- `go_back`: `chrome.tabs.goBack(tabId)`
- `go_forward`: `chrome.tabs.goForward(tabId)`
- All navigation actions wait for `status: 'complete'` before returning

### 3.5 Scroll Actions

**File:** `extension/src/content.ts`

- `up`/`down`: `window.scrollBy(0, ±viewportHeight * 0.8)`
- `top`/`bottom`: `window.scrollTo(0, 0 | document.body.scrollHeight)`
- Custom `amount`: `window.scrollBy(0, amount)`

### 3.6 Keyboard Actions

**File:** `extension/src/content.ts`

Parse `keys` string (e.g., `"Control+A"`, `"Enter"`, `"Tab"`, `"Shift+Tab"`). Dispatch `keydown`, `keypress`, `keyup` sequence on the focused element with correct `key`, `code`, `keyCode`, `which`, and modifier properties.

### 3.7 JavaScript Evaluation

**File:** `extension/src/content.ts` + `extension/src/background.ts`

Execute arbitrary JavaScript in either ISOLATED or MAIN world:
- `ISOLATED` (default): runs in content script's isolated world
- `MAIN`: runs in the page's JavaScript context (can access page variables, framework state, etc.)

Uses `chrome.scripting.executeScript({ world, func: new Function(code) })`.

### 3.8 Tab Management

**File:** `extension/src/background.ts`

- `tab_create`: `chrome.tabs.create({ url })`
- `tab_close`: `chrome.tabs.remove(tabId)`
- `tab_switch`: `chrome.tabs.update(tabId, { active: true })`
- `tab_list`: `chrome.tabs.query({})` — returns all tabs with id, url, title, active status

### 3.9 Cookie Operations

**File:** `extension/src/background.ts`

- `cookies_get`: `chrome.cookies.getAll({ domain })`
- `cookies_set`: `chrome.cookies.set(details)`
- `cookies_delete`: `chrome.cookies.remove({ url, name })`

### 3.10 Network Interception

**File:** `extension/src/content.ts` (MAIN world injection)

Intercept Fetch and XHR by overriding prototypes in the page's MAIN world. Log request/response pairs to a buffer, retrievable via `network_log`.

```typescript
const originalFetch = window.fetch
window.fetch = async function(...args) {
  const response = await originalFetch.apply(this, args)
  const clone = response.clone()
  logNetworkEvent({
    type: "fetch",
    url: args[0] instanceof Request ? args[0].url : String(args[0]),
    method: args[1]?.method ?? "GET",
    status: clone.status,
    timestamp: Date.now()
  })
  return response
}
```

### 3.11 Header Modification

**File:** `extension/src/background.ts`

Uses `chrome.declarativeNetRequest.updateDynamicRules()` to modify request/response headers without CDP.

### 3.12 Action Router

**File:** `extension/src/background.ts`

The background service worker routes all actions from the daemon to the appropriate handler (content script for DOM actions, background for tab/cookie/network actions).

```typescript
async function handleAction(action: Action, tabId: number): Promise<ActionResult> {
  switch (action.type) {
    case "click":
    case "input_text":
    case "scroll":
    case "send_keys":
    case "extract_text":
    case "extract_html":
    case "hover":
    case "focus":
    case "drag":
      return sendToContentScript(tabId, action)

    case "navigate":
    case "go_back":
    case "go_forward":
    case "tab_create":
    case "tab_close":
    case "tab_switch":
    case "tab_list":
    case "screenshot":
    case "cookies_get":
    case "cookies_set":
    case "cookies_delete":
    case "headers_modify":
      return handleInBackground(action, tabId)

    case "evaluate":
      return executeScript(tabId, action.code, action.world)

    case "network_intercept":
    case "network_log":
      return handleNetworkAction(tabId, action)
  }
}
```

- [ ] All core action types implemented (click, input, navigate, scroll, keys, wait)
- [ ] Extended actions implemented (evaluate, tabs, cookies, network, headers)
- [ ] selectorMap index resolution works for all element-targeting actions
- [ ] Navigation waits for page load completion
- [ ] Click dispatches full event sequence (mouseover → mousedown → mouseup → click)
- [ ] Input handles React/Vue/Angular framework-specific value setters
- [ ] Keyboard events include correct modifier properties
- [ ] Evaluate runs in both ISOLATED and MAIN worlds
- [ ] Network interception captures Fetch and XHR in MAIN world
- [ ] Action results returned with success/error/data

---

## Phase 4: CLI Interface

**Goal:** `slop` CLI exposes all browser capabilities as subcommands that Claude Code invokes via Bash.

### 4.1 CLI Design Principles

1. **One command = one action.** Each invocation does exactly one thing and returns.
2. **Text output, not JSON.** Responses are formatted as human/LLM-readable text. JSON is available via `--json` flag when needed.
3. **Stateless client.** The CLI connects to the daemon, sends a command, receives a response, and exits. No persistent state in the CLI.
4. **Self-documenting.** `slop help` prints all commands with descriptions — this serves as the function catalog the LLM uses to decide which commands to invoke.

### 4.2 Command Reference

**File:** `cli/index.ts`

```
slop state                          Get current page state (DOM tree, URL, title, scroll)
slop state --full                   Include static text content and full element attributes
slop state --tab <id>               Get state of a specific tab

slop click <index>                  Click element at index
slop type <index> <text>            Type text into element (clears first)
slop type <index> <text> --append   Append text without clearing
slop select <index> <value>         Select dropdown option by value
slop focus <index>                  Focus element at index
slop hover <index>                  Hover over element at index

slop navigate <url>                 Navigate active tab to URL
slop back                           Go back in history
slop forward                        Go forward in history
slop scroll <direction>             Scroll: up, down, top, bottom
slop scroll down --amount 500       Scroll by pixel amount
slop wait <ms>                      Wait for specified milliseconds
slop keys <combo>                   Send keyboard shortcut (e.g., "Control+A", "Enter")

slop screenshot                     Capture visible tab, save to temp file, print path
slop screenshot --tab <id>          Capture specific tab

slop text                           Extract all visible text from page
slop text <index>                   Extract text from specific element
slop html <index>                   Extract HTML of specific element
slop eval <code>                    Evaluate JS in ISOLATED world, print result
slop eval <code> --main             Evaluate JS in MAIN world (page context)

slop tabs                           List all open tabs (id, url, title, active)
slop tab new [url]                  Open new tab, optionally navigate
slop tab close [id]                 Close tab (default: active)
slop tab switch <id>                Switch to tab by ID

slop cookies <domain>               List cookies for domain
slop cookies set <json>             Set a cookie
slop cookies delete <url> <name>    Delete a cookie

slop network on [patterns...]       Start intercepting network requests (optional URL patterns)
slop network off                    Stop intercepting
slop network log                    Print captured network requests since last call
slop network log --since <ms>       Print requests since timestamp

slop headers add <name> <value>     Add request header to all requests
slop headers remove <name>          Remove a header rule
slop headers clear                  Clear all header rules

slop upload <index> <filepath>      Upload file to file input element

slop status                         Daemon connection status + extension info
slop help                           Print all commands with descriptions
```

### 4.3 Output Formatting

Responses are formatted for LLM consumption — compact but structured:

**`slop state` output:**
```
url: https://example.com/dashboard
title: Dashboard - App
scroll: 0/2400 (vh:800)
tab: 123456

[0]<a href="/">Home</a>
[1]<button class="primary">Submit</button>
[2]<input type="email" placeholder="Email" value=""/>
[3]<a href="/settings">Settings</a>
```

**`slop click 1` output:**
```
ok: clicked [1]<button class="primary">Submit</button>
```

**`slop tabs` output:**
```
* 123456  https://example.com/dashboard    Dashboard - App
  789012  https://google.com               Google
  345678  about:blank                      New Tab
```

**`slop network log` output:**
```
GET 200 https://api.example.com/user  (45ms, 1.2KB)
POST 201 https://api.example.com/submit  (120ms, 0.3KB)
GET 404 https://api.example.com/missing  (12ms, 0.1KB)
```

**Error output:**
```
error: element [7] not found (stale selectorMap — run `slop state` to refresh)
```

### 4.4 Build as Standalone Binary

```bash
bun build cli/index.ts --compile --outfile=slop
```

Install to PATH (e.g., `~/.local/bin/slop` or `/usr/local/bin/slop`).

- [ ] All subcommands implemented and mapped to extension actions
- [ ] Text output format is compact and LLM-friendly
- [ ] `--json` flag available for all commands when structured output needed
- [ ] `slop help` serves as the function catalog
- [ ] Error messages are actionable (tell the agent what to do next)
- [ ] Built as standalone binary via `bun build --compile`
- [ ] `slop status` verifies daemon connectivity

---

## Phase 5: Stealth & Anti-Detection

**Goal:** Make the extension's automation undetectable to websites.

### 5.1 No CDP Fingerprints

By design, slop-browser never uses CDP. This eliminates:
- `navigator.webdriver` being set to `true`
- `Runtime.evaluate` artifacts in the DOM
- CDP-specific properties on `window` or `document`
- The Chrome DevTools debugger banner
- `debugger` permission in the manifest

### 5.2 Content Script Isolation

**File:** `extension/src/content.ts`

Content scripts run in Chrome's isolated world by default. Websites cannot detect their presence because:
- Isolated world has its own JS scope — no pollution of `window`
- DOM access is shared but script context is separate
- `MutationObserver` in isolated world is invisible to page scripts

### 5.3 Realistic Event Dispatch

**File:** `extension/src/content.ts`

All user interactions dispatch the full sequence of events that a real user would generate:

**Click sequence:**
1. `pointerover` → `pointerenter` → `mouseover` → `mouseenter`
2. `pointermove` → `mousemove` (with realistic coordinates)
3. `pointerdown` → `mousedown`
4. `focus` (if element is focusable)
5. `pointerup` → `mouseup`
6. `click`

**Type sequence:**
1. `focus` on input
2. For each character: `keydown` → `keypress` → `beforeinput` → `input` → `keyup`
3. `change` on blur

Events include realistic properties:
- `isTrusted: false` is unavoidable for dispatched events, but most sites don't check this
- Coordinates from `getBoundingClientRect()` + random offset within element
- Correct `button`, `buttons`, `which` properties
- Frame-rate-appropriate timing between events

### 5.4 MAIN World Injection Stealth

**File:** `extension/src/content.ts`

When injecting into MAIN world for network interception:
- Override prototypes before page scripts run (`run_at: "document_start"` for the network hook)
- Store original references in a closure, not on `window`
- Use `Object.defineProperty` to make overrides non-enumerable
- Clean up injection artifacts immediately

### 5.5 Extension Fingerprint Minimization

**File:** `extension/manifest.json`

- No `web_accessible_resources` (prevents probing for extension resources)
- No `externally_connectable` (prevents external messaging fingerprint)
- No side panel (removes UI that could be detected via DOM changes)
- Generic extension name in manifest (not "automation" or "bot")
- No `content_security_policy` overrides that could be detected

### 5.6 Timing Randomization

**File:** `extension/src/content.ts`

Add configurable random delays between actions to simulate human-like interaction patterns:
- Click-to-click: 200-800ms
- Keystroke-to-keystroke: 30-120ms
- Post-navigation wait: 500-2000ms

Timing is configurable per-command via `--delay` flag, defaulting to zero for speed when stealth isn't needed.

- [ ] No CDP usage anywhere in the codebase
- [ ] No `debugger` permission in manifest
- [ ] No `web_accessible_resources` in manifest
- [ ] Click/type/keyboard dispatch full realistic event sequences
- [ ] MAIN world injection uses closures and non-enumerable properties
- [ ] Network intercept hooks installed before page scripts run
- [ ] Timing randomization available via `--delay` flag

---

## Phase 6: Installation & Claude Code Integration

### 6.1 Install Script

**File:** `scripts/install.sh`

Automates:
1. Build extension: `bun build` for content script and background
2. Build CLI: `bun build --compile` for standalone binary
3. Symlink native messaging host manifest to `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
4. Make `daemon/run.sh` executable
5. Copy `slop` binary to `~/.local/bin/` (or user-specified PATH location)
6. Verify Bun is installed

### 6.2 Claude Code Bash Permission

Add to Claude Code settings to auto-approve all `slop` commands:

```json
{
  "permissions": {
    "allow": [
      "Bash(slop *)"
    ]
  }
}
```

### 6.3 Claude Code Subagent (Optional)

A `slop-browser` subagent definition for Claude Code that specializes in browser tasks:

**File:** `~/.claude/agents/slop-browser.md`

```markdown
---
name: slop-browser
description: Browser automation specialist. Use when the task requires interacting with web pages, filling forms, extracting data from websites, or any browser-based operation.
tools: Bash, Read
model: inherit
---

You control a Chrome browser via the `slop` CLI. The browser extension is already loaded and the daemon is running.

Available commands:
[output of `slop help` injected here at build time]

Workflow:
1. Run `slop state` to see the current page
2. Decide which element to interact with based on the indexed DOM tree
3. Execute actions via `slop click <index>`, `slop type <index> <text>`, etc.
4. Run `slop state` again to verify the result
5. Repeat until the task is complete

Tips:
- Always `slop state` after navigation to get the new DOM tree
- Element indices change after any DOM mutation — re-run `slop state` to refresh
- Use `slop eval` for complex operations that don't map to a single action
- Use `slop screenshot` when you need visual verification
- Use `slop network on` before actions to capture API responses
```

### 6.4 Build Scripts

**File:** `scripts/build.sh`

```bash
#!/bin/bash
set -euo pipefail

bun build extension/src/background.ts --outdir=extension/dist --target=browser
bun build extension/src/content.ts --outdir=extension/dist --target=browser
cp extension/manifest.json extension/dist/

bun build daemon/index.ts --outdir=daemon/dist --target=bun

bun build cli/index.ts --compile --outfile=dist/slop
```

### 6.5 Extension Loading

Load the extension in Chrome:
1. Navigate to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `extension/dist/`
5. Note the extension ID — update `daemon/com.slopbrowser.host.json` `allowed_origins`

- [ ] Install script builds all three components
- [ ] CLI binary installed to PATH
- [ ] Native messaging host manifest registered
- [ ] Claude Code `Bash(slop *)` permission documented
- [ ] Optional subagent definition provided
- [ ] Extension loads in Chrome via "Load unpacked"
- [ ] End-to-end test: Claude Code runs `slop state` and gets page DOM back

---

## Files Overview

| File | Purpose | Est. LOC |
|------|---------|----------|
| `daemon/index.ts` | Native messaging bridge + Unix socket server | 150 |
| `daemon/com.slopbrowser.host.json` | Native messaging host manifest | 8 |
| `daemon/run.sh` | Bun launcher script | 3 |
| `cli/index.ts` | CLI client — subcommand routing + socket client | 300 |
| `cli/format.ts` | Output formatting (text + JSON modes) | 100 |
| `extension/manifest.json` | Chrome extension manifest | 30 |
| `extension/src/background.ts` | Service worker: native port + tab/cookie/header routing | 300 |
| `extension/src/content.ts` | DOM extraction + action execution + stealth event dispatch | 500 |
| `extension/src/network.ts` | MAIN world script: Fetch/XHR interception | 100 |
| `extension/src/types.ts` | Shared type definitions | 80 |
| `scripts/install.sh` | Full installation automation | 40 |
| `scripts/build.sh` | Build all components | 20 |
| **Total** | | **~1,631** |

---

## What We're NOT Building

| Feature | Why We Skip It |
|---------|---------------|
| Internal agent loop | Claude Code is the agent. No duplicate decision-making. |
| LLM provider / API keys | The calling agent provides the intelligence. Zero LLM code. |
| MCP server | Large payloads degrade MCP. CLI + Bash tool is more reliable. |
| Side panel UI | No human-facing UI. This is an agent tool, not a user app. |
| Puppeteer / CDP | Content scripts + Chrome APIs. No detectable fingerprint. |
| React / framework UI | No UI at all. CLI output is the interface. |
| Token counting / budget | Agent manages its own context. |
| Message history | Agent maintains its own conversation history. |
| Prompt engineering | Agent brings its own prompts and reasoning. |
| LangChain / AI SDK | No AI dependencies whatsoever. |
| Multi-agent orchestration | Agent orchestration is the caller's responsibility. |
| Configuration UI | Env vars + CLI flags. No settings page. |

---

## Implementation Order

Phases are sequential — each depends on the prior:

1. **Phase 1** (Native Messaging + IPC Bridge) — foundation, daemon + CLI connectivity
2. **Phase 2** (DOM Extraction) — extension can observe pages, CLI can read state
3. **Phase 3** (Action Execution) — extension can interact with pages, CLI can send commands
4. **Phase 4** (CLI Interface) — full command set available to agents
5. **Phase 5** (Stealth) — anti-detection hardening
6. **Phase 6** (Installation + Integration) — packaging, Claude Code setup

---

## Future Considerations (Out of Scope for v1)

- **Multi-tab Orchestration:** Parallel tasks across multiple tabs with independent state tracking.
- **Shadow DOM Traversal:** Deep extraction into Shadow DOM trees (common in web components).
- **iframe Navigation:** Recursive content script injection into iframes.
- **WebSocket Interception:** Capture and replay WebSocket messages (useful for real-time apps).
- **Request Replay/Modification:** Not just intercept but modify in-flight requests and responses.
- **Session Recording:** Record all actions + page states for replay/debugging.
- **Proxy Integration:** Route browser traffic through custom proxies for IP rotation.
- **Mobile Viewport Emulation:** Resize and set device pixel ratio for responsive testing.
