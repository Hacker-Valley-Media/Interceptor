// End-to-end check of `interceptor diagnose extension` against a real browser:
// headless Chrome for Testing in scratch profiles, the real old (hkjb…) and
// store (gomcp…) keys, and the product's own findProblems/fixBrowser. Each case
// builds the broken state the way a user's profile got there, repairs it the
// way the product says to, then starts the browser plainly and checks the
// current copy loads. Never reads or touches a real browser profile.
//
//   bun scripts/extension-repair-e2e.ts "<path to Chrome for Testing binary>"
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import identities from "../extension/store-identities.json"
import { LEGACY_DEVELOPMENT_EXTENSION_ID as OLD, LEGACY_DEVELOPMENT_PUBLIC_KEY, STORE_EXTENSION_ID as NEW } from "../shared/extension-identity"
import { findProblems, fixBrowser, instancePid, REPAIR_BROWSERS, type BrowserControl } from "../cli/lib/extension-repair"

const CFT = process.argv[2]
if (!CFT) throw new Error("usage: bun scripts/extension-repair-e2e.ts <Chrome for Testing binary>")
const ROOT = "/tmp/interceptor-repair-e2e"
const cft = REPAIR_BROWSERS.find(b => b.key === "cft")!
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const COMMON = ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-component-update"]
let failures = 0
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failures++ }

function ext(dir: string, key: string, code: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: code === "LEGACY" ? "Interceptor (old ID)" : "Interceptor", version: "2.1.4", key, background: { service_worker: "bg.js" } }))
  writeFileSync(join(dir, "bg.js"), `self.CODE = ${JSON.stringify(code)}; chrome.runtime.onStartup.addListener(() => {});`)
  writeFileSync(join(dir, "page.html"), `<title>${code}</title>`)
}

type Cdp = { send: (m: string, p?: object, s?: string) => Promise<any> }
async function startCdp(udd: string, args: string[] = []): Promise<Cdp> {
  const child = spawn(CFT, [...COMMON, `--user-data-dir=${udd}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", ...args, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] })
  const w = child.stdio[3] as any, r = child.stdio[4] as any
  let buf = "", seq = 0
  const pend = new Map<number, (m: any) => void>()
  r.on("data", (c: any) => { buf += c.toString(); let i; while ((i = buf.indexOf("\0")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id) pend.get(m.id)?.(m) } })
  r.on("error", () => {}); w.on("error", () => {})
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((res) => {
    const id = ++seq; pend.set(id, res)
    setTimeout(() => { if (pend.delete(id)) res({ error: "timeout" }) }, 15_000)
    try { w.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0") } catch { res({ error: "closed" }) }
  })
  await sleep(2500)
  return { send }
}
async function evalIn(b: Cdp, targetId: string, expression: string) {
  const s = (await b.send("Target.attachToTarget", { targetId, flatten: true })).result?.sessionId
  return b.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, s)
}
async function devMode(b: Cdp) { const t = (await b.send("Target.createTarget", { url: "chrome://extensions" })).result.targetId; await sleep(800); await evalIn(b, t, "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})") }
async function worker(b: Cdp, id: string, tries = 10): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    const t = (await b.send("Target.getTargets")).result?.targetInfos?.find((x: any) => x.type === "service_worker" && x.url.includes(id))
    if (t) return (await evalIn(b, t.targetId, "self.CODE")).result?.result?.value ?? null
    await sleep(500)
  }
  return null
}
async function reload(b: Cdp, id: string) { const t = (await b.send("Target.getTargets")).result.targetInfos.find((x: any) => x.type === "service_worker" && x.url.includes(id)); if (t) await evalIn(b, t.targetId, "chrome.runtime.reload()"); await sleep(1500) }
async function quit(udd: string) { const pid = instancePid(udd, cft); if (pid) process.kill(pid, "SIGHUP"); for (let i = 0; i < 60 && instancePid(udd, cft); i++) await sleep(250) }
async function enabledIds(b: Cdp): Promise<string> {
  const t = (await b.send("Target.createTarget", { url: "chrome://extensions" })).result.targetId
  await sleep(800)
  return (await evalIn(b, t, "chrome.developerPrivate.getExtensionsInfo({includeDisabled:true}).then(a=>a.map(e=>e.id.slice(0,4)+\":\"+e.state).join(\" \"))")).result?.result?.value ?? "?"
}
async function pageLoads(udd: string, id: string, why?: (s: string) => void): Promise<string | null> {
  const b = await startCdp(udd)
  const code = await worker(b, id, 30)
  if (why) why(await enabledIds(b))
  await quit(udd)
  return code
}

const headless = (udd: string): BrowserControl => ({
  launch: (args) => { spawn(CFT, [...COMMON, `--user-data-dir=${udd}`, ...args], { detached: true, stdio: "ignore" }).unref() },
  openProfile: (dir) => { spawn(CFT, [...COMMON, `--user-data-dir=${udd}`, `--profile-directory=${dir}`], { detached: true, stdio: "ignore" }).unref() },
})

/** A scratch profile whose shared folder had the old key, then got the store key (the 1.0.1 upgrade). */
async function upgraded(name: string, reloadedAfterUpgrade: boolean) {
  const udd = join(ROOT, name), shared = join(ROOT, `${name}-extension`)
  ext(shared, LEGACY_DEVELOPMENT_PUBLIC_KEY, "OLD")
  const b = await startCdp(udd); await devMode(b)
  await b.send("Extensions.loadUnpacked", { path: shared }); await sleep(800)
  await reload(b, OLD) // a CDP load persists only after one reload
  ext(shared, identities.chrome.publicKey, "CURRENT")
  // Reloading the running old copy after the files changed re-keys it: the store ID
  // gets its own entry on the same folder and the old one stays behind (both-ids).
  if (reloadedAfterUpgrade) await reload(b, OLD)
  await quit(udd)
  return { udd, shared }
}

function point(udd: string) {
  for (const b of REPAIR_BROWSERS) process.env[b.overrideEnv] = join(ROOT, "none")
  process.env[cft.overrideEnv] = udd
}

rmSync(ROOT, { recursive: true, force: true }); mkdirSync(ROOT, { recursive: true })
const legacy = join(ROOT, "extension-legacy")
ext(legacy, LEGACY_DEVELOPMENT_PUBLIC_KEY, "LEGACY")
process.env.INTERCEPTOR_LEGACY_EXTENSION_DIR = legacy

try {
  // A. both IDs: the restart fix, with an unrelated instance of the same app running.
  {
    const { udd } = await upgraded("both", true)
    point(udd)
    const before = findProblems()
    check("A both-ids detected, restart can fix it", before.length === 1 && before[0].kind === "both-ids" && before[0].autoFix, JSON.stringify(before.map(f => `${f.kind}:${f.autoFix}`)))
    check("A both-ids: nothing loads after a plain restart", (await pageLoads(udd, NEW)) === null)
    const bystanderDir = join(ROOT, "bystander")
    spawn(CFT, [...COMMON, `--user-data-dir=${bystanderDir}`], { detached: true, stdio: "ignore" }).unref()
    await sleep(2500)
    const bystander = instancePid(bystanderDir, cft)
    headless(udd).launch([], { hidden: true }) // the user's browser is open when the dialog appears
    await sleep(2500)
    const r = await fixBrowser(cft, before, l => console.log(`      ${l}`), headless(udd))
    check("A fixBrowser reports the profile fixed", r.fixed.length === 1 && r.failed.length === 0, r.reason)
    let reopened = false
    for (let i = 0; i < 40 && !reopened; i++) { reopened = instancePid(udd, cft) !== null; if (!reopened) await sleep(250) }
    check("A fixBrowser reopened the browser it closed", reopened)
    check("A the other instance of the same app was not touched", bystander !== null && instancePid(bystanderDir, cft) === bystander)
    await quit(udd); await quit(bystanderDir)
    let live = ""
    check("A after a plain restart the current copy loads", (await pageLoads(udd, NEW, x => { live = x })) === "CURRENT", live)
    check("A and keeps loading after a second plain restart", (await pageLoads(udd, NEW)) === "CURRENT")
    check("A nothing left to report", findProblems().length === 0, JSON.stringify(findProblems().map(f => f.kind)))
  }

  // B. old ID only: the steps by hand, including the reload for the cached code.
  {
    const { udd } = await upgraded("oldonly", false)
    point(udd)
    const before = findProblems()
    check("B old-id-only detected, by hand", before.length === 1 && before[0].kind === "old-id-only" && !before[0].autoFix, JSON.stringify(before.map(f => f.kind)))
    const b = await startCdp(udd); await devMode(b)
    await b.send("Extensions.loadUnpacked", { path: legacy }); await sleep(2000)
    const cached = await worker(b, OLD)
    check("B after Load unpacked the browser still runs the cached old code", cached === "OLD", String(cached))
    await reload(b, OLD)
    check("B the reload arrow switches it to the shipped code", (await worker(b, OLD)) === "LEGACY")
    await quit(udd)
    check("B after a plain restart the old-ID copy loads", (await pageLoads(udd, OLD)) === "LEGACY")
    check("B nothing left to report", findProblems().length === 0, JSON.stringify(findProblems().map(f => f.kind)))
  }

  // C + D. both IDs where --load-extension cannot help (Google Chrome, Edge): the steps by hand.
  {
    const { udd } = await upgraded("byhand", true)
    point(udd)
    const b = await startCdp(udd); await devMode(b)
    await b.send("Extensions.loadUnpacked", { path: legacy }); await sleep(1500)
    await reload(b, OLD)
    await quit(udd)
    const mid = findProblems()
    check("C skipping the Remove step is caught: Interceptor running twice", mid.length === 1 && mid[0].kind === "two-copies", JSON.stringify(mid.map(f => f.kind)))
    // The old-ID card comes up switched off here ("for reload"); at the next start
    // the browser drops it, so quit and reopen is the whole fix.
    const b2 = await startCdp(udd)
    const live = { current: await worker(b2, NEW), old: await worker(b2, OLD) }
    await quit(udd)
    check("D after quit and reopen only the current copy runs", live.current === "CURRENT" && live.old === null, JSON.stringify(live))
    check("D nothing left to report", findProblems().length === 0, JSON.stringify(findProblems().map(f => f.kind)))
  }

  // E. a --load-extension start only (scripts/install.sh).
  {
    const udd = join(ROOT, "session"), dir = join(ROOT, "session-extension")
    ext(dir, identities.chrome.publicKey, "CURRENT")
    point(udd)
    await startCdp(udd, [`--load-extension=${dir}`]); await sleep(1500); await quit(udd)
    const found = findProblems()
    check("E a one-session load is reported", found.length === 1 && found[0].kind === "session", JSON.stringify(found.map(f => f.kind)))
    check("E and it really is gone after a plain restart", (await pageLoads(udd, NEW)) === null)
  }
} finally {
  spawnSync("/usr/bin/pkill", ["-f", ROOT])
  await sleep(1000)
  rmSync(ROOT, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed")
process.exit(failures ? 1 : 0)
