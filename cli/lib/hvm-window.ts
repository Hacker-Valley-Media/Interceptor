/**
 * cli/lib/hvm-window.ts — Interceptor's own windows on macOS, in the Hacker
 * Valley look of the April 2026 installer app (commit 855a6fb): black canvas,
 * the logo, Balboa headings, Raleway text, Montserrat buttons, HVM blue.
 *
 * The window is an HTML/CSS page in a native WebKit view. The host is
 * an osascript (JXA) script, so Full and Browser installs need nothing compiled.
 * Checked on macOS 27.0.1:
 *   - JXA cannot adopt WKScriptMessageHandler (the protocol is not in the
 *     runtime), so the page talks through document.title: "ix:" + a JSON list
 *     of its last messages, each with a seq; a 0.1 s timer reads it.
 *   - a hand-rolled event loop never activates an osascript app (no events
 *     arrive), and a modal one floats above every app; app.run does neither.
 * Page messages: {type:"choose"} closes the window and is the result, {type:
 * "size"} fits the height, anything else reaches the caller as an event. The
 * caller updates the page through a state file the host passes to ix.update().
 */
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import balboa from "../../assets/brand/BalboaExtraCondensed.ttf" with { type: "file" }
import montserrat from "../../assets/brand/Montserrat-SemiBold.ttf" with { type: "file" }
import raleway from "../../assets/brand/RalewayRegular.ttf" with { type: "file" }
import logo from "../../assets/brand/interceptor-logo.png" with { type: "file" }

const HOST_JS = String.raw`
ObjC.import('Cocoa'); ObjC.import('WebKit')
function run(argv) {
  const htmlPath = argv[0], width = Number(argv[1]) || 560, height = Number(argv[2]) || 400, statePath = argv[3] || ''
  const app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
  const out = s => $.NSFileHandle.fileHandleWithStandardOutput.writeData($(s + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, width, height),
    $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable | $.NSWindowStyleMaskFullSizeContentView, $.NSBackingStoreBuffered, false)
  win.titlebarAppearsTransparent = true
  win.titleVisibility = $.NSWindowTitleHidden
  win.backgroundColor = $.NSColor.blackColor
  win.releasedWhenClosed = false
  const web = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, width, height), $.WKWebViewConfiguration.alloc.init)
  web.setValueForKey($.NSNumber.numberWithBool(false), 'drawsBackground')
  win.contentView = web
  const url = $.NSURL.fileURLWithPath(htmlPath)
  web.loadFileURLAllowingReadAccessToURL(url, url.URLByDeletingLastPathComponent)
  win.center
  let result = '', seq = 0, state = '', raised = 0
  // app.stop takes effect after the next event, so post one.
  const stop = () => { app.stop(null); app.postEventAtStart($.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2($.NSEventTypeApplicationDefined, $.NSMakePoint(0, 0), 0, 0, 0, null, 0, 0, 0), true) }
  const timer = $.NSTimer.timerWithTimeIntervalRepeatsBlock(0.1, true, function () {
    if (!win.isVisible) return stop()
    if (statePath && !web.isLoading) {
      const s = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(statePath, $.NSUTF8StringEncoding, null))
      if (s && s !== state) {
        state = s
        let st = {}
        try { st = JSON.parse(s) } catch (e) {}
        // The caller closes the window, or brings it back in front of System Settings.
        if (st.close) { win.orderOut(null); return stop() }
        if (st.raise && st.raise !== raised) { raised = st.raise; win.makeKeyAndOrderFront(null); app.activateIgnoringOtherApps(true) }
        web.evaluateJavaScriptCompletionHandler('window.ix && ix.update(' + s + ')', function () {})
      }
    }
    const t = ObjC.unwrap(web.title) || ''
    if (t.indexOf('ix:') !== 0) return
    let list = []
    try { list = JSON.parse(t.slice(3)) } catch (e) { return }
    for (const msg of list) {
      if (!(msg.seq > seq)) continue
      seq = msg.seq
      if (msg.type === 'choose') { result = String(msg.value); win.orderOut(null); return stop() }
      if (msg.type === 'size') { win.setContentSize($.NSMakeSize(width, Math.min(Math.max(Number(msg.height) || height, 160), 860))); win.center }
      else out('event ' + JSON.stringify(msg))
    }
  })
  $.NSRunLoop.currentRunLoop.addTimerForMode(timer, $.NSRunLoopCommonModes)
  win.makeKeyAndOrderFront(null)
  app.activateIgnoringOtherApps(true)
  app.run
  timer.invalidate
  win.orderOut(null)
  out('result ' + result)
  return ''
}`

// ── look ────────────────────────────────────────────────────────────────────

const dataUri = (path: string, type: string) => `data:${type};base64,${readFileSync(path).toString("base64")}`
let fontCss: string | undefined
export const logoUri = () => dataUri(logo, "image/png")

/** The brand stylesheet. Fonts are inlined: a file:// page in Chrome may not load local fonts. */
export function brandCss(): string {
  fontCss ??= [["Balboa", balboa], ["Montserrat", montserrat], ["Raleway", raleway]]
    .map(([name, path]) => `@font-face{font-family:"${name}";src:url(${dataUri(path, "font/ttf")}) format("truetype")}`).join("\n")
  return `${fontCss}
:root{--blue:#0050e8;--blue-hover:#0040c0;--red:#e30000;--gold:#f4ba42;--green:#3ceb8b;--light:#f8fafc;--copy:#dbe3f0;--muted:#a3b0c4;
--surface:#1a1f29;--raised:#2e3647;--edge:#ffffff14;--line:#004ad538}
*{box-sizing:border-box}
html,body{margin:0;background:#000;color:var(--copy);font:14px/1.55 "Raleway",-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
body{background:radial-gradient(120% 70% at 50% -10%,#0a1a3d 0%,#000 60%) #000;min-height:100vh}
main{padding:34px 32px 26px}
.brand{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.brand img{width:52px;height:52px;border-radius:12px;filter:drop-shadow(0 8px 14px #004ad559)}
.eyebrow{font:600 11px "Montserrat",sans-serif;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
h1{font:400 34px/1.05 "Balboa",Impact,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:var(--light);margin:2px 0 0}
h2{font:400 22px/1.1 "Balboa",Impact,sans-serif;letter-spacing:.05em;text-transform:uppercase;color:var(--light);margin:0 0 8px}
p{margin:0 0 12px}
.muted{color:var(--muted)}
code{font:12px ui-monospace,"SF Mono",Menlo,monospace;background:#ffffff12;border:1px solid var(--edge);padding:1px 6px;border-radius:6px;color:var(--light);overflow-wrap:anywhere}
.card{background:#1a1f29f5;border:1px solid var(--line);border-radius:20px;padding:16px 18px;margin:0 0 14px}
.items{list-style:none;margin:0;padding:0}
.items li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--edge)}
.items li:first-child{border-top:0;padding-top:0}
.items b{font:600 13px "Montserrat",sans-serif;color:var(--light)}
.chip{font:600 11px "Montserrat",sans-serif;padding:3px 9px;border-radius:999px;white-space:nowrap;background:#f4ba4224;color:var(--gold)}
.chip.ok{background:#3ceb8b24;color:var(--green)}.chip.info{background:#0050e833;color:#8fb3ff}
.steps{margin:0;padding-left:20px}.steps li{margin:6px 0}
.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.btn{font:600 13px "Montserrat",sans-serif;color:var(--light);background:transparent;border:1px solid #ffffff2e;border-radius:14px;padding:11px 18px;cursor:pointer}
.btn:hover{background:#ffffff0f}
.btn.primary{background:var(--blue);border-color:var(--blue)}.btn.primary:hover{background:var(--blue-hover)}
.btn:focus-visible{outline:2px solid #8fb3ff;outline-offset:2px}
.tone-warn h1{color:var(--light)}.tone-warn .eyebrow{color:var(--gold)}.tone-ok .eyebrow{color:var(--green)}
`
}

const BRIDGE_JS = `window.ix={q:[],seq:0,
post(m){this.q.push(Object.assign({},m,{seq:++this.seq}));this.q=this.q.slice(-12);document.title='ix:'+JSON.stringify(this.q)},
choose(v){this.post({type:'choose',value:v})},
update(s){if(window.onState)window.onState(s)},
fit(){const m=document.querySelector('main');if(m)this.post({type:'size',height:Math.ceil(m.getBoundingClientRect().height)})}};
addEventListener('load',()=>ix.fit());
addEventListener('keydown',e=>{if(e.key==='Escape'){const c=document.querySelector('[data-cancel]');if(c)c.click()}});`

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Escapes text, then marks commands in quotes and absolute paths as code. */
export function rich(text: string): string {
  return esc(text.replace(/Application Support/g, "ApplicationSupport"))
    .replace(/'(interceptor [^']+)'/g, "<code>$1</code>")
    .replace(/(^|[\s(])((?:\/(?:Library|Users|Applications|private|tmp)|[A-Z]:\\)[^\s,;)]*[^\s,;).])/g, (_m, pre, p) => `${pre}<code>${p.replace(/([\/\\])/g, "$1<wbr>")}</code>`)
    .replace(/\b((?:chrome|brave|edge|vivaldi):\/\/extensions)\b/g, "<code>$1</code>")
    .replace(//g, " ")
}

/** A full branded page; `bridge` adds the window bridge (leave it out of pages opened in a browser). */
export function brandPage(o: { title: string; body: string; css?: string; script?: string; bridge?: boolean; className?: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(o.title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${brandCss()}${o.css ?? ""}</style></head>
<body class="${o.className ?? ""}"><main>${o.body}</main>
${o.bridge === false ? "" : `<script>${BRIDGE_JS}</script>`}${o.script ? `<script>${o.script}</script>` : ""}</body></html>`
}

export const brandHeader = (eyebrow: string, title: string) =>
  `<div class="brand"><img src="${logoUri()}" alt=""><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1></div></div>`

// ── showing it ──────────────────────────────────────────────────────────────

/** The window files (page + host); exported so a test can render them on another Mac. */
export const writePage = (html: string) => {
  const dir = mkdtempSync(join(tmpdir(), "interceptor-window-"))
  writeFileSync(join(dir, "index.html"), html)
  writeFileSync(join(dir, "host.js"), HOST_JS)
  return dir
}

/** Shows a page until it chooses; the result, "" when closed, or undefined when no window could open. */
export function showWindowSync(html: string, width: number, height = 360): string | undefined {
  const dir = writePage(html)
  try {
    const r = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", join(dir, "host.js"), join(dir, "index.html"), String(width), String(height)], { encoding: "utf8" })
    const line = (r.stdout ?? "").split("\n").find(l => l.startsWith("result "))
    return line === undefined ? undefined : line.slice(7)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export type LiveWindow = {
  /** Resolves with the choice, "" when closed, undefined when no window could open. */
  done: Promise<string | undefined>
  /** Hands a new state to the page's window.onState; `raise: n` (a new n) brings the window to the front. */
  update(state: object): void
  /** Closes the window; done then resolves with "". */
  close(): void
}

/** A window that stays up while the caller updates it and hears its events. */
export function openWindow(html: string, width: number, height: number, onEvent: (e: Record<string, unknown>) => void): LiveWindow {
  const dir = writePage(html)
  const statePath = join(dir, "state.json")
  writeFileSync(statePath, "")
  const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", join(dir, "host.js"), join(dir, "index.html"), String(width), String(height), statePath], { stdio: ["ignore", "pipe", "ignore"] })
  let buf = "", result: string | undefined
  child.stdout!.on("data", chunk => {
    buf += chunk.toString()
    let i: number
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.startsWith("result ")) result = line.slice(7)
      else if (line.startsWith("event ")) { try { onEvent(JSON.parse(line.slice(6))) } catch {} }
    }
  })
  const done = new Promise<string | undefined>(resolve => child.on("close", () => {
    rmSync(dir, { recursive: true, force: true })
    resolve(result)
  }))
  let version = 0
  const write = (state: object) => { try { writeFileSync(statePath, JSON.stringify({ ...state, version: ++version })) } catch {} }
  return { done, update: write, close: () => write({ close: true }) }
}

// ── the dialog ──────────────────────────────────────────────────────────────

export type DialogView = {
  title: string
  eyebrow?: string
  tone?: "warn" | "ok" | "info"
  /** Plain text paragraphs (commands in quotes and paths become code). */
  text?: string[]
  items?: { name: string; detail?: string; chip?: string; chipTone?: "warn" | "ok" | "info" }[]
  /** Text after the list. */
  after?: string[]
}

/** The page for a dialog: the first button is the default and the cancel (Return
 *  and Escape pick it), so a stray key never picks the action; the last is blue. */
export function dialogPage(view: DialogView, buttons: string[]): string {
  const para = (t: string) => `<p>${rich(t).replace(/\n/g, "<br>")}</p>`
  const items = view.items?.length
    ? `<div class="card"><ul class="items">${view.items.map(i => `<li><span><b>${esc(i.name)}</b>${i.detail ? `<br><span class="muted">${rich(i.detail)}</span>` : ""}</span>${i.chip ? `<span class="chip ${i.chipTone ?? ""}">${esc(i.chip)}</span>` : ""}</li>`).join("")}</ul></div>`
    : ""
  const btns = buttons.map((b, n) => `<button class="btn${n === buttons.length - 1 && buttons.length > 1 ? " primary" : ""}"${n === 0 ? " autofocus data-cancel" : ""} data-value="${esc(b)}">${esc(b)}</button>`).join("")
  return brandPage({
    title: view.title,
    className: `tone-${view.tone ?? "info"}`,
    body: `${brandHeader(view.eyebrow ?? "Interceptor", view.title)}${(view.text ?? []).map(para).join("")}${items}${(view.after ?? []).map(para).join("")}<div class="actions">${btns}</div>`,
    script: `for(const b of document.querySelectorAll('[data-value]'))b.onclick=()=>ix.choose(b.dataset.value)`,
  })
}

/** A branded dialog: the clicked button, null when closed, undefined when no window could open. */
export function brandDialog(view: DialogView, buttons: string[]): string | null | undefined {
  const r = showWindowSync(dialogPage(view, buttons), 540)
  return r === undefined ? undefined : r || null
}
