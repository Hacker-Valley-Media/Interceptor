/**
 * cli/lib/extension-welcome.ts — the first-install window on macOS
 * (`interceptor diagnose extension --welcome`, run by the pkg postinstall when no
 * earlier Interceptor package was installed).
 *
 * It looks for a copy already in a browser first: connected (done), in a profile
 * but not connected yet (wait, or say how to switch it on), or broken (the repair
 * dialog). With none, it offers three ways to add the extension:
 *   - Chrome Web Store: the listing opens in the chosen browser;
 *   - Load unpacked: the folder path goes on the clipboard, a branded step-by-step
 *     guide opens in the chosen browser, then its extensions page (Chromium
 *     ignores chrome://extensions on its command line; AppleScript's `open
 *     location` reaches it, proven in Brave on macOS 27.0.1);
 *   - Safari: the release page with the separate Safari package.
 * Then it waits and turns green when a new browser context reaches the daemon.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { STORE_LISTING_URL } from "../../shared/extension-identity"
import { probeContexts } from "../transport"
import { brandHeader, brandPage, esc, logoUri, openWindow } from "./hvm-window"
import { copyToClipboard, currentExtensionDir, dialog, findCopies, promptAndFix, findProblems, REPAIR_BROWSERS, userDataDir, type Copy, type Finding, type RepairBrowser } from "./extension-repair"

const RELEASES_URL = "https://github.com/Hacker-Valley-Media/Interceptor/releases/latest"
const stamp = () => `[${new Date().toISOString()}]`
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

type Method = "store" | "unpacked" | "safari"
type View = "checking" | "choose" | "waiting" | "found" | "connected"

/** Chromium browsers on this Mac (Chrome for Testing left out) and the default browser. */
export function detectBrowsers(): { installed: RepairBrowser[]; defaultId: string } {
  const candidates = REPAIR_BROWSERS.filter(b => b.bundleId && b.key !== "cft")
  const script = `function run(argv) {
    ObjC.import('AppKit'); const ws = $.NSWorkspace.sharedWorkspace
    const installed = JSON.parse(argv[0]).filter(id => { const u = ws.URLForApplicationWithBundleIdentifier(id); return u && !u.isNil() })
    let def = ''; const d = ws.URLForApplicationToOpenURL($.NSURL.URLWithString('https://example.com'))
    if (d && !d.isNil()) { const b = $.NSBundle.bundleWithURL(d); if (b && !b.isNil()) def = ObjC.unwrap(b.bundleIdentifier) || '' }
    return JSON.stringify({ installed, def })
  }`
  try {
    const r = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, JSON.stringify(candidates.map(b => b.bundleId))], { encoding: "utf8" })
    const { installed, def } = JSON.parse(r.stdout.trim())
    return { installed: candidates.filter(b => installed.includes(b.bundleId)), defaultId: def ?? "" }
  } catch {
    return { installed: [], defaultId: "" }
  }
}

/** The step-by-step page for Load unpacked, opened in the browser itself. */
export function guidePage(b: RepairBrowser, folder: string): string {
  const step = (s: string) => `<li>${s}</li>`
  return brandPage({
    title: `Load Interceptor in ${b.label}`, bridge: false, className: "guide",
    css: `.guide main{max-width:760px;margin:0 auto;padding:48px 32px}.guide .steps li{margin:12px 0}.guide kbd{font:600 12px "Montserrat",sans-serif;background:#ffffff14;border:1px solid #ffffff2e;border-radius:6px;padding:1px 6px;color:var(--light)}.guide a{color:#8fb3ff}`,
    body: `${brandHeader("Interceptor setup", `Load Interceptor in ${b.label}`)}
<p>Interceptor reaches your browser through its extension. These steps load the copy the installer put on your Mac. It takes about a minute.</p>
<div class="card"><div class="eyebrow">The folder (already on your clipboard)</div><p style="margin:8px 0 10px"><code id="folder">${esc(folder)}</code></p>
<button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('folder').textContent).then(()=>{this.textContent='Copied'})">Copy</button></div>
<div class="card"><ol class="steps">
${step(`Go to the <b>Extensions</b> tab Interceptor opened, or type <code>${esc(b.extensionsUrl)}</code> in the address bar.`)}
${step(`Turn on <b>Developer mode</b> (top right).`)}
${step(`Click <b>Load unpacked</b>.`)}
${step(`In the folder picker press <kbd>⌘</kbd> <kbd>Shift</kbd> <kbd>G</kbd>, paste the folder path, press <kbd>Return</kbd>, then click <b>Select</b>.`)}
${step(`The <b>Interceptor</b> card appears. Leave it switched on.`)}
${step(`Go back to the Interceptor window: it says <b>Connected</b> within a few seconds.`)}
</ol></div>
<div class="card"><p>Prefer one click? <a href="${esc(STORE_LISTING_URL)}">Add Interceptor from the Chrome Web Store</a> instead; it updates itself.</p>
<p class="muted" style="margin:0">If Interceptor disappears after you restart ${esc(b.label)}, run <code>interceptor diagnose extension</code> in Terminal.</p></div>`,
  })
}

/** The window's page; the CLI drives it with ix.update(state). */
function welcomePage(): string {
  const script = String.raw`
const LOGO = ${JSON.stringify(logoUri())}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const head = (title, eyebrow = 'Setup') => '<div class="brand"><img src="' + LOGO + '" alt=""><div><div class="eyebrow">' + esc(eyebrow) + '</div><h1>' + esc(title) + '</h1></div></div>'
const spin = text => '<div class="status"><span class="spin"></span>' + esc(text) + '</div>'
const btn = (label, attrs, primary) => '<button class="btn' + (primary ? ' primary' : '') + '" ' + attrs + '>' + esc(label) + '</button>'
let S = {}, picked = ''
function label() { const b = (S.browsers || []).find(b => b.key === picked); return b ? b.label : 'your browser' }
function render() {
  const m = document.querySelector('main')
  document.body.className = S.view === 'connected' ? 'tone-ok' : 'tone-info'
  let h = ''
  if (S.view === 'checking') {
    h = head('Welcome to Interceptor') + '<p>Interceptor is installed. Checking your browsers for the Interceptor extension.</p>' + spin('Checking…')
      + '<div class="actions">' + btn('Later', 'data-choose="later" data-cancel autofocus') + '</div>'
  } else if (S.view === 'choose') {
    const browsers = S.browsers || []
    if (!picked || !browsers.some(b => b.key === picked)) picked = S.selected || (browsers[0] || {}).key || ''
    const pills = browsers.map(b => '<button class="pill' + (b.key === picked ? ' on' : '') + '" data-browser="' + esc(b.key) + '">' + esc(b.label) + '</button>').join('')
    const none = !browsers.length
    h = head('Add Interceptor to your browser')
      + '<p>Interceptor works through a browser extension. Pick your browser, then how to add it.</p>'
      + (none ? '<p class="muted">No Chrome, Brave, Edge or Vivaldi found on this Mac. Install one of them, or use Safari.</p>' : '<div class="pills">' + pills + '</div>')
      + '<div class="methods">'
      + '<div class="card method"><h2>Chrome Web Store</h2><p>Recommended. One click, and it updates itself.</p>' + btn('Open the store', 'data-pick="store"' + (none ? ' disabled' : ''), true) + '</div>'
      + '<div class="card method"><h2>Load unpacked</h2><p>Developer mode, using the copy the installer put on this Mac. A step-by-step guide opens with it.</p>' + btn('Show me how', 'data-pick="unpacked"' + (none ? ' disabled' : '')) + '</div>'
      + '<div class="card method"><h2>Safari</h2><p>Needs the separate Interceptor Safari package from the release page.</p>' + btn('Get the Safari package', 'data-pick="safari"') + '</div>'
      + '</div><div class="actions">' + btn('Later', 'data-choose="later" data-cancel autofocus') + '</div>'
  } else if (S.view === 'waiting') {
    const b = S.browserLabel || label()
    const steps = S.method === 'store'
      ? ['In the Chrome Web Store tab that opened in ' + b + ', click <b>Add to ' + esc(b.replace(/^Google /, '')) + '</b>.', 'Click <b>Add extension</b>.']
      : S.method === 'unpacked'
      ? ['The <b>Extensions</b> page and a step-by-step guide opened in ' + esc(b) + '.', 'Turn on <b>Developer mode</b>, then click <b>Load unpacked</b>.', 'In the folder picker press <b>⌘ Shift G</b>, paste the folder path (it is on your clipboard), press <b>Return</b>, then click <b>Select</b>.']
      : ['Get <b>Interceptor-Safari</b> from the release page that opened, then install it.', 'Open <b>InterceptorSafari</b> from Applications once.', 'In Safari, open <b>Settings › Extensions</b>, turn on Interceptor and allow it on all websites.']
    h = head(S.method === 'safari' ? 'Finish in Safari' : 'Finish in ' + b)
      + '<div class="card"><ol class="steps">' + steps.map(s => '<li>' + s + '</li>').join('') + '</ol>'
      + (S.method === 'unpacked' ? '<p class="muted" style="margin:10px 0 0">Folder: <code>' + esc(S.folder || '') + '</code> ' + btn('Copy again', 'data-copy') + '</p>' : '') + '</div>'
      + spin('Waiting for Interceptor to connect…')
      + '<div class="actions">' + btn('Later', 'data-choose="later" data-cancel autofocus') + btn('Back', 'data-back') + '</div>'
  } else if (S.view === 'found') {
    const off = (S.copies || []).filter(c => !c.on)
    h = head('Interceptor is already here')
      + '<div class="card"><ul class="items">' + (S.copies || []).map(c => '<li><span><b>' + esc(c.browser) + '</b><br><span class="muted">"' + esc(c.profile) + '"</span></span><span class="chip ' + (c.on ? 'ok' : '') + '">' + (c.on ? 'added' : 'switched off') + '</span></li>').join('') + '</ul></div>'
      + (off.length ? '<p>A copy is switched off. In ' + esc(off[0].browser) + ', open <code>' + esc(off[0].extUrl) + '</code>, turn on <b>Developer mode</b> if the card asks for it, and switch the Interceptor card on.</p>'
        : '<p>It connects within a minute. If nothing happens, quit and reopen the browser.</p>')
      + spin('Waiting for Interceptor to connect…')
      + '<div class="actions">' + btn('Later', 'data-choose="later" data-cancel autofocus') + btn('Add another way', 'data-back') + '</div>'
  } else if (S.view === 'connected') {
    h = head("You're all set")
      + '<p>Interceptor is connected' + (S.where ? ' in ' + esc(S.where) : '') + '.</p>'
      + '<div class="card"><p>Try it in Terminal: <code>interceptor open https://example.com</code>, or ask your AI agent to use Interceptor.</p><p class="muted" style="margin:0"><code>interceptor status</code> shows what is connected.</p></div>'
      + '<div class="actions">' + btn('Add to another browser', 'data-back') + btn('Done', 'data-choose="done" data-cancel autofocus', true) + '</div>'
  }
  m.innerHTML = h
  for (const e of m.querySelectorAll('[data-browser]')) e.onclick = () => { picked = e.dataset.browser; render() }
  for (const e of m.querySelectorAll('[data-pick]')) e.onclick = () => ix.post({ type: 'pick', method: e.dataset.pick, browser: picked })
  for (const e of m.querySelectorAll('[data-choose]')) e.onclick = () => ix.choose(e.dataset.choose)
  for (const e of m.querySelectorAll('[data-back]')) e.onclick = () => ix.post({ type: 'back' })
  for (const e of m.querySelectorAll('[data-copy]')) e.onclick = () => { ix.post({ type: 'copy' }); e.textContent = 'Copied' }
  const f = m.querySelector('[autofocus]'); if (f) f.focus()
  ix.fit()
}
window.onState = s => { S = s; render() }`
  return brandPage({
    title: "Interceptor",
    body: "",
    css: `
.status{display:flex;align-items:center;gap:10px;font:600 12px "Montserrat",sans-serif;color:var(--muted);margin:6px 0 0}
.spin{width:14px;height:14px;border-radius:50%;border:2px solid #ffffff26;border-top-color:#8fb3ff;animation:sp 0.9s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}
.pills{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
.pill{font:600 12px "Montserrat",sans-serif;color:var(--copy);background:#ffffff0a;border:1px solid #ffffff1f;border-radius:999px;padding:7px 14px;cursor:pointer}
.pill.on{background:#0050e826;border-color:var(--blue);color:var(--light)}
.methods{display:grid;gap:10px}
.method{display:grid;grid-template-columns:1fr auto;align-items:center;column-gap:16px;margin:0}
.method h2{grid-column:1;margin:0 0 2px;font-size:20px}.method p{grid-column:1;margin:0;color:var(--muted);font-size:13px}
.method .btn{grid-column:2;grid-row:1 / span 2;white-space:nowrap}
.btn[disabled]{opacity:.4;cursor:default}
.tone-ok .eyebrow{color:var(--green)}
`,
    script: script + `\nwindow.onState({view:'checking'})`,
  })
}

/** Opens the chosen way to add the extension. */
function act(method: Method, b: RepairBrowser | undefined, log: (l: string) => void): void {
  if (method === "safari") {
    spawnSync("/usr/bin/open", ["-b", "com.apple.Safari", RELEASES_URL])
    return log(`${stamp()} welcome: opened the Safari package release page`)
  }
  if (!b?.bundleId) return
  if (method === "store") {
    spawnSync("/usr/bin/open", ["-b", b.bundleId, STORE_LISTING_URL])
    return log(`${stamp()} welcome: opened the Chrome Web Store in ${b.label}`)
  }
  const folder = currentExtensionDir()
  copyToClipboard(folder)
  const dir = join(process.env.HOME ?? "", ".interceptor", "guide")
  const file = join(dir, `load-unpacked-${b.key}.html`)
  try { mkdirSync(dir, { recursive: true }); writeFileSync(file, guidePage(b, folder)) } catch {}
  spawnSync("/usr/bin/open", ["-b", b.bundleId, file])
  // After the guide, so the extensions page is the tab in front.
  spawnSync("/bin/sleep", ["1"])
  spawnSync("/usr/bin/osascript", ["-e", `tell application id "${b.bundleId}" to open location "${b.extensionsUrl}"`])
  log(`${stamp()} welcome: opened the load-unpacked guide and ${b.extensionsUrl} in ${b.label}`)
}

const browserContexts = async () => ((await probeContexts()) ?? []).filter(id => !id.includes(":"))

const copyRows = (copies: Copy[]) => copies.map(c => ({ browser: c.browser.label, profile: c.profileName, on: c.on, extUrl: c.browser.extensionsUrl }))

export async function runWelcome(only: string | undefined, findings: Finding[], blocked: RepairBrowser[], quiet = false, log: (l: string) => void = console.log): Promise<void> {
  if (findings.length) {
    log(`${stamp()} welcome: found ${findings.length} problem(s); showing the repair dialog`)
    return promptAndFix(findings, () => findProblems(only))
  }
  const { installed, defaultId } = detectBrowsers()
  const browsers = installed.map(b => ({ key: b.key, label: b.label }))
  const selected = (installed.find(b => b.bundleId === defaultId) ?? installed[0])?.key
  let state: Record<string, unknown> = { view: "checking" as View, browsers, selected, folder: currentExtensionDir() }
  // Connections already there when the user goes on to add another browser;
  // only a new one counts after that. Until then any connection means done
  // (a copy added before the install connects within about 30 s).
  let known = new Set<string>()
  const snapshot = () => void browserContexts().then(ids => { known = new Set(ids) })
  const win = openWindow(welcomePage(), 640, 420, e => {
    if (e.type === "pick") {
      const method = e.method as Method
      const b = installed.find(x => x.key === e.browser)
      act(method, b, log)
      show({ view: "waiting", method, browserLabel: b?.label ?? "Safari" })
    } else if (e.type === "back") {
      if (state.view === "connected") snapshot()
      show({ view: "choose" })
    } else if (e.type === "copy") {
      copyToClipboard(currentExtensionDir())
    }
  })
  const show = (s: Record<string, unknown>) => { state = { ...state, ...s }; win.update(state) }
  show({})
  log(`${stamp()} welcome: window open; browsers ${browsers.map(b => b.label).join(", ") || "none"}${blocked.length ? `; cannot read ${blocked.map(b => b.label).join(", ")}` : ""}`)

  let open = true
  const result = win.done.then(r => { open = false; return r })
  const started = Date.now()
  let connectedAt = 0
  while (open) {
    const ids = await browserContexts()
    const fresh = ids.filter(id => !known.has(id))
    const view = state.view as View
    if (view !== "connected" && fresh.length) {
      const copies = findCopies(only, [], quiet)
      log(`${stamp()} welcome: connected (${ids.join(", ")})`)
      connectedAt = Date.now()
      // Brave writes a copy switched on to disk seconds later, so name every browser holding one.
      show({ view: "connected", where: [...new Set(copies.map(c => c.browser.label))].join(" and ") })
    } else if (view === "connected" && !state.where && Date.now() - connectedAt < 120_000) {
      // A copy just added reaches the profile files seconds after it connects. After
      // two minutes it is not coming (Safari, or a browser macOS keeps us out of).
      const where = [...new Set(findCopies(only, [], quiet).map(c => c.browser.label))].join(" and ")
      if (where) show({ where })
    } else if (view === "checking" && Date.now() - started > 6000) {
      const copies = findCopies(only, [], quiet)
      log(`${stamp()} welcome: ${copies.length ? `found ${copies.length} copy(ies), waiting for a connection` : "no copy found; showing the choices"}`)
      show(copies.length ? { view: "found", copies: copyRows(copies) } : { view: "choose" })
    }
    await Promise.race([sleep(1500), result])
  }
  const r = await result
  if (r !== undefined) return log(`${stamp()} welcome: closed (${r || "window closed"})`)
  // A window that ran and was then killed is not a reason to show another one.
  if (Date.now() - started > 5000) return log(`${stamp()} welcome: the window ended without an answer`)

  // No window (osascript could not show one): the plain dialog, same choices.
  log(`${stamp()} welcome: the branded window did not open; using the system dialog`)
  const b = installed.find(x => x.key === selected)
  const choice = dialog(`Interceptor is installed. Add its browser extension${b ? ` to ${b.label}` : ""}: the Chrome Web Store is one click and updates itself; Load unpacked uses developer mode.`, ["Later", "Load unpacked", "Chrome Web Store"])
  if (choice === "Chrome Web Store") act("store", b, log)
  else if (choice === "Load unpacked") act("unpacked", b, log)
}

// ── macOS 27: asking for the browsers' data, in a window that stays open ─────
// The check runs inside interceptor-bridge, so only a switch under that name in
// Files & Folders helps it. The window stays up while the user is in Settings,
// shows each switch as it turns on, comes back to the front and checks at once.

function accessPage(): string {
  const script = String.raw`
const LOGO = ${JSON.stringify(logoUri())}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const btn = (label, attrs, primary) => '<button class="btn' + (primary ? ' primary' : '') + '" ' + attrs + '>' + esc(label) + '</button>'
let S = {}
function render() {
  const m = document.querySelector('main')
  const names = (S.browsers || []).map(b => b.label)
  const list = names.join(' and ')
  const chips = '<div class="card"><ul class="items">' + (S.browsers || []).map(b =>
    '<li><span><b>' + esc(b.label) + '</b></span><span class="chip ' + (b.state === 'clean' ? 'ok' : b.state === 'on' ? 'info' : '') + '">' +
    (b.state === 'clean' ? 'checked, nothing to fix' : b.state === 'on' ? 'access on' : 'waiting for the switch') + '</span></li>').join('') + '</ul></div>'
  const head = (title, eyebrow) => '<div class="brand"><img src="' + LOGO + '" alt=""><div><div class="eyebrow">' + esc(eyebrow || 'Browser check') + '</div><h1>' + esc(title) + '</h1></div></div>'
  let h = ''
  if (S.view === 'ask') {
    h = head('Let Interceptor check your browsers')
      + '<p>Interceptor can\'t check ' + esc(list) + ' for a problem that makes Interceptor disappear when the browser restarts. On this version of macOS, an app needs your permission to read another app\'s data.</p>'
      + '<p>Open Settings shows where to allow it. This window stays open and checks the moment you do.</p>'
      + '<div class="actions">' + btn('Later', 'data-choose="later" data-cancel autofocus') + btn('Open Settings', 'data-settings', true) + '</div>'
  } else if (S.view === 'waiting' || S.view === 'checking' || S.view === 'clean') {
    const allDone = (S.browsers || []).every(b => b.state === 'clean')
    h = head(S.view === 'checking' ? 'Checking ' + (S.checking || list) : allDone ? 'All set' : 'Allow access in Settings')
      + (allDone ? '<p>Interceptor checked ' + esc(list) + ': nothing to fix.</p>' :
        '<div class="card"><ol class="steps">'
        + '<li>In <b>System Settings › Privacy &amp; Security › Files &amp; Folders</b>, find <b>interceptor-bridge</b>.</li>'
        + '<li>Click the arrow next to it.</li>'
        + '<li>Turn on the switch for ' + names.map(n => '<b>' + esc(n) + '</b>').join(' and ') + '.</li>'
        + '</ol><p class="muted" style="margin:10px 0 0">Use interceptor-bridge, not "interceptor" or "Installer": the check runs inside interceptor-bridge.</p></div>')
      + chips
      + (S.view === 'checking' ? '<div class="status"><span class="spin"></span>Checking…</div>'
        : allDone ? '' : '<div class="status"><span class="spin"></span>Waiting for you to turn it on…</div>')
      + '<div class="actions">' + (allDone ? btn('Done', 'data-choose="done" data-cancel autofocus', true)
        : btn('Later', 'data-choose="later" data-cancel autofocus') + btn('Open Settings again', 'data-settings')) + '</div>'
  }
  m.innerHTML = h
  for (const e of m.querySelectorAll('[data-choose]')) e.onclick = () => ix.choose(e.dataset.choose)
  for (const e of m.querySelectorAll('[data-settings]')) e.onclick = () => ix.post({ type: 'settings' })
  const f = m.querySelector('[autofocus]'); if (f) f.focus()
  ix.fit()
}
window.onState = s => { S = s; render() }`
  return brandPage({
    title: "Interceptor",
    body: "",
    css: `
.status{display:flex;align-items:center;gap:10px;font:600 12px "Montserrat",sans-serif;color:var(--muted);margin:6px 0 0}
.spin{width:14px;height:14px;border-radius:50%;border:2px solid #ffffff26;border-top-color:#8fb3ff;animation:sp 0.9s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}
`,
    script: script + `\nwindow.onState({view:'ask',browsers:[]})`,
  })
}

/** Asks for access in a window that stays open until the check is done.
 *  "no-window" when no window could open (the caller falls back to dialogs). */
export async function runAccess(blocked: RepairBrowser[], only: string | undefined, log: (l: string) => void = console.log): Promise<"done" | "no-window"> {
  // A browser that is not installed has no switch to turn on.
  const installed = new Set(detectBrowsers().installed.map(b => b.key))
  const targets = blocked.filter(b => installed.has(b.key))
  if (!targets.length) { log(`${stamp()} access: ${blocked.map(b => b.label).join(", ")} not installed; nothing to ask`); return "done" }
  const canRead = (b: RepairBrowser) => { try { readdirSync(userDataDir(b)!); return true } catch { return false } }
  const status = new Map<string, "waiting" | "on" | "clean">(targets.map(b => [b.key, canRead(b) ? "on" : "waiting"]))
  let state: Record<string, unknown> = { view: "ask" }
  let raise = 0
  const settings = () => spawnSync("/usr/bin/open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"])
  const win = openWindow(accessPage(), 600, 360, e => {
    if (e.type !== "settings") return
    log(`${stamp()} access: opened Files & Folders`)
    settings()
    show({ view: state.view === "ask" ? "waiting" : state.view })
  })
  const show = (s: Record<string, unknown>) => {
    state = { ...state, ...s, browsers: targets.map(b => ({ label: b.label, state: status.get(b.key) })) }
    win.update(state)
  }
  show({})
  log(`${stamp()} access: window open for ${targets.map(b => b.label).join(", ")}`)
  let open = true, answered: string | undefined
  const result = win.done.then(r => { open = false; answered = r; return r })
  const started = Date.now()
  while (open) {
    await Promise.race([sleep(1000), result])
    if (!open) break
    const fresh = targets.filter(b => status.get(b.key) === "waiting" && canRead(b))
    if (!fresh.length) continue
    for (const b of fresh) status.set(b.key, "on")
    const names = fresh.map(b => b.label).join(" and ")
    log(`${stamp()} access is on for ${names}; checking`)
    show({ view: "checking", checking: names, raise: ++raise })
    const findings = findProblems(only).filter(f => fresh.some(b => b.key === f.browser.key))
    if (findings.length) {
      log(`${stamp()} access: found ${findings.length} problem(s); showing the repair window`)
      win.close()
      await result
      await promptAndFix(findings, () => findProblems(only))
      return "done"
    }
    for (const b of fresh) status.set(b.key, "clean")
    log(`${stamp()} access: ${names}: nothing to fix`)
    show({ view: "clean" })
  }
  if (answered === undefined && Date.now() - started < 5000) return "no-window"
  log(`${stamp()} access: closed (${answered || "window closed"})`)
  return "done"
}
