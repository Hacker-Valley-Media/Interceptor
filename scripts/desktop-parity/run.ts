#!/usr/bin/env bun
// Desktop parity runner. Runs every case of the selected families against
// the installed CLI on this host, guards focus and cursor, and writes results.jsonl,
// summary.json and summary.md. Usage:
//   bun scripts/desktop-parity/run.ts [--families a,b] [--cli <path>] [--out <dir>] [--no-fixture] [--list]
import { mkdirSync, appendFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { families } from "./cases/index"
import { type Ctx, type Family, type Host, type Res, expectationFor, judge } from "./types"

const argv = process.argv.slice(2)
const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const host = (opt("--host") ?? process.platform) as Host
const cli = opt("--cli") ?? defaultCli()
const only = opt("--families")?.split(",").filter(Boolean)
const caseFilter = opt("--cases") ? new RegExp(opt("--cases")!) : undefined
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const out = opt("--out") ?? join(process.cwd(), "parity-results", `${host}-${stamp}`)
const here = import.meta.dir
const fixturesDir = opt("--fixtures") ?? join(here, "fixtures")

function defaultCli(): string {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? "", "Programs", "Interceptor", "interceptor.exe")
  if (process.platform === "linux") return join(homedir(), ".local", "bin", "interceptor")
  return "/usr/local/bin/interceptor"
}

const selected: Family[] = families.filter(f => !only || only.includes(f.family))
if (argv.includes("--list")) {
  for (const f of selected) for (const c of f.cases) console.log(`${c.id}\t${JSON.stringify(expectationFor(c, host))}`)
  process.exit(0)
}

async function run(args: string[], timeoutMs = 45_000): Promise<Res> {
  const started = performance.now()
  const proc = Bun.spawn([cli, "--json", "desktop", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; proc.kill() }, timeoutMs)
  // A killed process can stay alive with its pipes open (seen on Windows: exited, handles held);
  // the case then fails after a grace period instead of freezing the whole batch.
  let stuck: ReturnType<typeof setTimeout> | undefined
  const hung = new Promise<null>(resolve => { stuck = setTimeout(() => resolve(null), timeoutMs + 15_000) })
  const done = await Promise.race([Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]), hung])
  clearTimeout(timer); clearTimeout(stuck)
  if (!done) return { exit: -1, json: undefined, stdout: "", stderr: `process ${proc.pid} did not exit ${timeoutMs + 15_000}ms after start, even after kill`, ms: Math.round(performance.now() - started), timedOut: true }
  const [stdout, stderr, exit] = done
  let json: any
  try { json = JSON.parse(stdout) } catch { const i = stdout.indexOf("{"); try { json = i >= 0 ? JSON.parse(stdout.slice(i)) : undefined } catch { json = undefined } }
  return { exit, json, stdout, stderr, ms: Math.round(performance.now() - started), timedOut }
}

/** Depth-first search for an object carrying a ref whose name matches; exact names win over substrings. */
function findRef(value: any, name: string, exact = true): string | undefined {
  if (!value || typeof value !== "object") return exact ? findRef(value, name, false) : undefined
  const walk = (v: any): string | undefined => {
    if (!v || typeof v !== "object") return undefined
    if (Array.isArray(v)) { for (const x of v) { const r = walk(x); if (r) return r } return undefined }
    const label = v.name ?? v.title ?? v.label ?? v.description
    if (typeof v.ref === "string" && typeof label === "string" && (exact ? label === name : label.includes(name))) return v.ref
    for (const x of Object.values(v)) { const r = walk(x); if (r) return r }
    return undefined
  }
  return walk(value) ?? (exact ? findRef(value, name, false) : undefined)
}

// --- fixture -------------------------------------------------------------------------
const FIXTURE_TITLE = "Interceptor Parity Fixture"
let fixtureProc: ReturnType<typeof Bun.spawn> | undefined
const helpers: ReturnType<typeof Bun.spawn>[] = []
async function startFixture(ctx: Ctx) {
  if (argv.includes("--no-fixture")) return
  const fx = fixturesDir
  // A fixture left by an interrupted run keeps its windows and can hang UI Automation reads.
  if (host === "win32") Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'windows-fixture|windows-media-fixture|InterceptorParityHost' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"])
  // Run the Windows fixture under a uniquely-named copy of powershell so `--app` targets it
  // unambiguously even when the shared VM has other powershell processes running.
  let winHost = "powershell.exe"
  if (host === "win32") {
    winHost = join(ctx.dir, "InterceptorParityHost.exe")
    const base = (process.env.SystemRoot ?? "C:\\Windows") + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    try { if (!existsSync(winHost)) copyFileSync(base, winHost) } catch { winHost = "powershell.exe" }
  }
  let pid = 0
  if (host === "darwin") {
    // LaunchServices with -g starts the fixture without activating it; exec'd directly, the
    // AppKit fixture took the foreground from the person's app.
    const exe = join(macFixture(fx), "Contents", "MacOS", "InterceptorParityFixture")
    const opened = Bun.spawnSync(["open", "-g", "-n", "-a", macFixture.app, "--args", ctx.dir], { stderr: "pipe" })
    if (opened.exitCode !== 0) throw new Error(`fixture launch failed: ${opened.stderr.toString().slice(0, 300)}`)
    for (let i = 0; i < 100 && !pid; i++) { pid = Number(Bun.spawnSync(["pgrep", "-n", "-f", exe]).stdout.toString().trim()) || 0; if (!pid) await Bun.sleep(100) }
    if (!pid) throw new Error("fixture process did not start")
  } else {
    const cmd = host === "win32" ? [winHost, "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", join(fx, "windows-fixture.ps1"), "-StatusDir", ctx.dir]
      : ["gjs", join(fx, "linux-fixture.js"), ctx.dir]
    fixtureProc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    pid = fixtureProc.pid
  }
  ctx.fixture.pid = pid; fixturePid = pid
  for (let i = 0; i < 60; i++) {
    const r = await run(["windows", "--pid", String(pid)], 15_000)
    const w = (Array.isArray(r.json) ? r.json : r.json?.windows ?? []).find((x: any) => String(x.title ?? x.name ?? "").includes(FIXTURE_TITLE))
    if (w) {
      if (host === "linux") layoutLinuxFixture(pid)
      // The --app spelling the provider uses for this pid (process or AT-SPI application name).
      const apps = await run(["apps"], 15_000)
      const a = (Array.isArray(apps.json) ? apps.json : apps.json?.apps ?? []).find((x: any) => x.pid === pid)
      ctx.fixture.app = a?.name ?? a?.app ?? ctx.fixture.app
      return
    }
    await Bun.sleep(1000)
  }
  throw new Error("fixture window did not appear")
}
/** Hyprland tiles new windows, so where the fixture's controls land on screen changed run to run
 *  (a tiled 368 px fixture put its drag pad under the observer). Float both at the Windows
 *  fixture's positions; window moves change neither focus nor the cursor. */
function layoutLinuxFixture(pid: number) {
  const clients = JSON.parse(Bun.spawnSync(["hyprctl", "-j", "clients"]).stdout.toString() || "[]") as { address: string; pid: number; title: string }[]
  for (const c of clients.filter(c => c.pid === pid)) {
    const [x, y, w, h] = c.title.includes("Observer") ? [620, 200, 380, 180] : [12, 30, 560, 760]
    const win = `window="address:${c.address}"`
    for (const d of [`hl.dsp.window.float{${win},action="set"}`, `hl.dsp.window.resize{${win},x=${w},y=${h},relative=false}`, `hl.dsp.window.move{${win},x=${x},y=${y},relative=false}`])
      Bun.spawnSync(["hyprctl", "dispatch", d])
  }
}
/** Compiles the Mac fixture app on first use (accessory app: no Dock icon, windows ordered to the back).
 *  swiftc stamps the SDK's macOS version (newer than the running OS), which LaunchServices refuses
 *  with -10825, so build for macOS 14 and declare it. Returns the bundle path. */
function macFixture(fx: string): string {
  const app = join(out, "InterceptorParityFixture.app"), exe = join(app, "Contents", "MacOS", "InterceptorParityFixture")
  macFixture.app = app
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true })
  const built = Bun.spawnSync(["swiftc", "-O", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`, "-o", exe, join(fx, "macos-fixture.swift")], { stderr: "pipe" })
  if (built.exitCode !== 0) throw new Error(`fixture build failed: ${built.stderr.toString().slice(0, 300)}`)
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.interceptor.parity-fixture</string><key>CFBundleName</key><string>InterceptorParityFixture</string><key>CFBundleExecutable</key><string>InterceptorParityFixture</string><key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>14.0</string></dict></plist>`)
  Bun.spawnSync(["codesign", "-s", "-", "--force", app])
  return app
}
macFixture.app = ""
function stopFixture() {
  try { fixtureProc?.kill() } catch {}
  for (const h of helpers) { try { h.kill() } catch {} }
  try { probe?.proc.kill() } catch {}
  if (host === "darwin") { Bun.spawnSync(["pkill", "-f", "InterceptorParityFixture.app/Contents/MacOS"]); if (macFixture.app) Bun.spawnSync(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-u", macFixture.app]) }
}

// --- focus and cursor guard ----------------------------------------------------------
type Focus = { front: string; cursor: [number, number] | null; pid?: number; name?: string }
const WIN_SHELL = /^(ShellExperienceHost|StartMenuExperienceHost|SearchHost|SearchApp|TextInputHost|LockApp|dwm|LogonUI|OpenWith)$/i
let fixturePid = 0
// Windows: bun:ffi is unavailable in Bun's Windows ARM64 build, so one long-lived PowerShell
// process compiles the two user32 calls once and answers a line per query.
let probe: { proc: ReturnType<typeof Bun.spawn>; reader: ReadableStreamDefaultReader<Uint8Array>; buffer: string } | undefined
const PROBE = `Add-Type 'using System;using System.Runtime.InteropServices;public static class P{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);[StructLayout(LayoutKind.Sequential)]public struct PT{public int X;public int Y;}[DllImport("user32.dll")]public static extern bool GetCursorPos(out PT p);}'
while($null -ne [Console]::In.ReadLine()){$p=New-Object P+PT;[void][P]::GetCursorPos([ref]$p);$h=[P]::GetForegroundWindow();$fpid=0;[void][P]::GetWindowThreadProcessId($h,[ref]$fpid);$nm=(Get-Process -Id $fpid -ErrorAction SilentlyContinue).ProcessName;[Console]::Out.WriteLine(([string]$h)+' '+$p.X+' '+$p.Y+' '+$fpid+' '+$nm);[Console]::Out.Flush()}`
async function windowsProbe(): Promise<string> {
  if (!probe) {
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", PROBE], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    probe = { proc, reader: (proc.stdout as ReadableStream<Uint8Array>).getReader(), buffer: "" }
  }
  const sink = probe.proc.stdin as unknown as { write(s: string): void; flush(): void }
  sink.write("q\n"); sink.flush()
  while (!probe.buffer.includes("\n")) {
    const { value, done } = await probe.reader.read()
    if (done) throw new Error("focus probe exited")
    probe.buffer += new TextDecoder().decode(value)
  }
  const i = probe.buffer.indexOf("\n"), line = probe.buffer.slice(0, i).trim()
  probe.buffer = probe.buffer.slice(i + 1)
  return line
}
async function focusNow(): Promise<Focus> {
  if (host === "win32") {
    const [front, x, y, fpid, name] = (await windowsProbe()).split(" ")
    return { front, cursor: [Number(x), Number(y)], pid: Number(fpid), name: name ?? "" }
  }
  if (host === "linux") {
    const a = Bun.spawnSync(["hyprctl", "-j", "activewindow"]).stdout.toString()
    const c = Bun.spawnSync(["hyprctl", "-j", "cursorpos"]).stdout.toString()
    let front = "", cursor: [number, number] | null = null
    // Address plus class and title, so a focus failure names the window that took focus.
    try { const w = JSON.parse(a); front = w.address ? `${w.address} ${w.class}:${String(w.title).slice(0, 40)}` : "" } catch {}
    try { const p = JSON.parse(c); cursor = [p.x, p.y] } catch {}
    return { front, cursor }
  }
  // The person is using this Mac: track the frontmost app only, never the cursor.
  const asn = Bun.spawnSync(["lsappinfo", "front"]).stdout.toString().trim()
  return { front: Bun.spawnSync(["lsappinfo", "info", "-only", "bundleid", asn]).stdout.toString().trim(), cursor: null }
}
function focusMoved(a: Focus, b: Focus): string | undefined {
  if (a.front !== b.front) {
    if (host === "darwin" && !/InterceptorParityFixture|interceptor/i.test(b.front)) return undefined // the person switched apps
    if (host === "win32" && fixturePid && b.pid === fixturePid) return undefined // the fixture's own windows
    if (host === "win32" && (WIN_SHELL.test(b.name ?? "") || WIN_SHELL.test(a.name ?? ""))) return undefined // idle shell overlay stole/released focus, not Interceptor
    return `frontmost changed ${a.front} -> ${b.front} (${a.name ?? "?"} -> ${b.name ?? "?"})`
  }
  if (a.cursor && b.cursor && (Math.abs(a.cursor[0] - b.cursor[0]) > 1 || Math.abs(a.cursor[1] - b.cursor[1]) > 1)) return `cursor moved ${a.cursor} -> ${b.cursor}`
  return undefined
}

// --- main ----------------------------------------------------------------------------
mkdirSync(out, { recursive: true })
const scratch = join(out, "scratch"); mkdirSync(scratch, { recursive: true })
const results = join(out, "results.jsonl")
const ctx: Ctx = {
  host, dir: scratch, vars: {},
  fixture: { app: host === "win32" ? "powershell" : host === "linux" ? "gjs" : "InterceptorParityFixture", title: FIXTURE_TITLE },
  run,
  fixtures: fixturesDir,
  spawn(cmd) { const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" }); helpers.push(p); return { pid: p.pid, kill: () => { try { p.kill() } catch {} } } },
  async ref(name, role) {
    const args = ["find", name, "--pid", String(ctx.fixture.pid)]
    if (role) args.push("--role", role)
    const r = await run(args)
    const ref = findRef(r.json, name)
    if (!ref) throw new Error(`no ref for ${JSON.stringify(name)}: ${r.stdout.slice(0, 200)}`)
    return ref
  },
  sleep: ms => Bun.sleep(ms),
}

const caps = await run(["capabilities"])
writeFileSync(join(out, "capabilities.json"), JSON.stringify(caps.json ?? caps.stdout, null, 2))
await startFixture(ctx)
const summary: Record<string, { pass: number; fail: number; skip: number; failures: string[] }> = {}
try {
  for (const fam of selected) {
    const s = summary[fam.family] = { pass: 0, fail: 0, skip: 0, failures: [] as string[] }
    ctx.vars = {}
    try { await fam.setup?.(ctx) } catch (e) { s.failures.push(`setup: ${(e as Error).message}`); s.fail++ }
    for (const c of fam.cases) {
      if (caseFilter && !caseFilter.test(c.id)) continue
      const e = expectationFor(c, host)
      const record: any = { family: fam.family, id: c.id, sub: c.sub, expect: e }
      const missing = "skip" in e ? undefined : c.needs?.(ctx)
      if ("skip" in e || missing || (host === "darwin" && c.disruptive)) {
        s.skip++; record.outcome = "skip"; record.reason = "skip" in e ? e.skip : missing ?? "disruptive on the shared Mac"
        appendFileSync(results, JSON.stringify(record) + "\n"); continue
      }
      let failure: string | undefined, r: Res | undefined
      const before = await focusNow()
      try {
        const args = typeof c.args === "function" ? await c.args(ctx) : c.args
        record.args = args
        r = await run(args, c.timeoutMs)
        failure = judge(e, r) ?? ("ok" in e && c.check ? (await c.check(r, ctx)) ?? undefined : undefined)
      } catch (err) { failure = `case error: ${(err as Error).message}` }
      const moved = c.focus === "allowed" ? undefined : focusMoved(before, await focusNow())
      if (moved) failure = failure ? `${failure}; ${moved}` : moved
      Object.assign(record, { outcome: failure ? "fail" : "pass", failure, exit: r?.exit, ms: r?.ms, code: r?.json?.code, error: r?.json?.error, data: excerpt(r?.json) })
      if (failure) { s.fail++; s.failures.push(`${c.id}: ${failure}`) } else s.pass++
      appendFileSync(results, JSON.stringify(record) + "\n")
      console.log(`${failure ? "FAIL" : "pass"} ${c.id}${failure ? `  -- ${failure}` : ""}`)
    }
    try { await fam.teardown?.(ctx) } catch (e) { s.failures.push(`teardown: ${(e as Error).message}`) }
  }
} finally { stopFixture() }

function excerpt(v: any): any { const t = JSON.stringify(v); return t && t.length > 600 ? t.slice(0, 600) + "…" : v }

const totals = Object.values(summary).reduce((a, s) => ({ pass: a.pass + s.pass, fail: a.fail + s.fail, skip: a.skip + s.skip }), { pass: 0, fail: 0, skip: 0 })
writeFileSync(join(out, "summary.json"), JSON.stringify({ host, cli, stamp, totals, families: summary }, null, 2))
const md = [`# Desktop parity: ${host} ${stamp}`, "", `CLI: \`${cli}\`. Pass ${totals.pass}, fail ${totals.fail}, skip ${totals.skip}.`, "", "| Family | Pass | Fail | Skip |", "|---|---|---|---|",
  ...Object.entries(summary).map(([f, s]) => `| ${f} | ${s.pass} | ${s.fail} | ${s.skip} |`), "", "## Delta", "",
  ...Object.values(summary).flatMap(s => s.failures.map(f => `- ${f}`))]
writeFileSync(join(out, "summary.md"), md.join("\n") + "\n")
console.log(`\n${host}: pass ${totals.pass} fail ${totals.fail} skip ${totals.skip} -> ${out}`)
process.exit(totals.fail ? 1 : 0)
