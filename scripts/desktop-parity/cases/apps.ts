// App and window lifecycle plus compound verbs: apps, frontmost, read, act, resize, move,
// open, app. Every subcommand and flag from the CLI inventory appears below. `inspect`
// (with and without a ref) lives in accessibility.ts.
//
// Focus: hide and quit of the fixture would move focus off its observer window (Windows
// minimizes it, Linux refuses on the active app), and quit would end every later family.
// So on Windows and Linux the lifecycle cases target an owned helper app launched in the
// background with `open <absolute path>`; on the Mac they target the accessory fixture
// (never active there). Launching, quitting and activating never run on a Mac someone is using
// (disruptive). Keep `open` and `app` last in index.ts: activation moves focus.
import { chmodSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Ctx, type Exclusion, type Family, type Res, errorText, macOnly, ok, refuse, skip } from "../types"
import { closeLeftovers, contains, list, pid, state, waitState } from "./helpers"

const NO_APP = "Interceptor Parity No Such App"
const HELPER_TITLE = "Interceptor Parity Helper"

// ShowWithoutActivation keeps the first show in the background (Form.ShowParams -> SW_SHOWNOACTIVATE).
const WIN_HELPER = `using System; using System.Windows.Forms;
public class InterceptorParityHelper : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  [STAThread] public static void Main() {
    InterceptorParityHelper f = new InterceptorParityHelper();
    f.Text = "${HELPER_TITLE}"; f.StartPosition = FormStartPosition.Manual; f.SetBounds(120, 120, 360, 160);
    Application.Run(f);
  }
}`
const LINUX_HELPER = `#!/usr/bin/env gjs
imports.gi.versions.Gtk = '3.0';
const { Gtk, GLib } = imports.gi;
GLib.set_prgname('interceptor-parity-helper');
Gtk.init(null);
const w = new Gtk.Window({ title: '${HELPER_TITLE}', default_width: 360, default_height: 160 });
w.add(new Gtk.Label({ label: '${HELPER_TITLE}' }));
w.connect('destroy', () => Gtk.main_quit());
w.show_all();
Gtk.main();
`

/** Absolute path of the owned helper executable (Windows .exe built once with Add-Type, Linux gjs script). */
function helperPath(ctx: Ctx): string {
  const exe = join(ctx.dir, ctx.host === "win32" ? "InterceptorParityHelper.exe" : "interceptor-parity-helper")
  if (existsSync(exe)) return exe
  if (ctx.host === "win32") {
    const cs = join(ctx.dir, "InterceptorParityHelper.cs"), q = (p: string) => `'${p.replaceAll("'", "''")}'`
    writeFileSync(cs, WIN_HELPER)
    const r = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      `Add-Type -Path ${q(cs)} -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly ${q(exe)} -OutputType WindowsApplication`], { windowsHide: true, stderr: "pipe" })
    if (!existsSync(exe)) throw new Error(`helper build failed: ${r.stderr.toString().slice(0, 300)}`)
  } else if (ctx.host === "linux") { writeFileSync(exe, LINUX_HELPER); chmodSync(exe, 0o755) }
  else throw new Error("no owned launchable helper on the shared Mac")
  return exe
}

/** Background launch through the CLI; records the helper's pid and provider app name. */
async function launchHelper(ctx: Ctx): Promise<string> {
  const r = await ctx.run(["open", helperPath(ctx)])
  if (!(r.json?.pid > 0)) throw new Error(`helper launch failed: ${errorText(r)}`)
  ctx.vars.helperName = r.json.app
  return (ctx.vars.helperPid = String(r.json.pid))
}

async function stopHelper(ctx: Ctx) {
  try { if (ctx.vars.helperPid) process.kill(Number(ctx.vars.helperPid)) } catch {}
  // ponytail: Linux only; on Windows closing the active helper returns focus by z-order.
  if (ctx.host === "linux") Bun.spawnSync(["hyprctl", "dispatch", "focuswindow", "title:^Interceptor Parity Observer$"])
}

// The Mac fixture is an accessory app (no Dock icon on the person's screen), and macOS declines to hide one.
const ACCESSORY = refuse(undefined, /declined app (hide|unhide)/)
/** Lifecycle target: the fixture on the Mac, the owned helper elsewhere. */
function target(ctx: Ctx): { pid: string; name: string } {
  if (ctx.host === "darwin") return { pid: pid(ctx), name: ctx.fixture.app }
  if (!ctx.vars.helperPid) throw new Error("owned helper is not running (setup failed)")
  return { pid: ctx.vars.helperPid, name: ctx.vars.helperName }
}

/** Fixture main window (not the observer) with its ref and frame. */
async function fixtureWindow(ctx: Ctx): Promise<{ ref: string; frame: Record<string, number> }> {
  const r = await ctx.run(["windows", "--pid", pid(ctx)])
  const w = list(r).find(x => String(x.title ?? "").includes(ctx.fixture.title) && !String(x.title).includes("Observer"))
  if (!w?.ref || !w.frame) throw new Error(`fixture window ref/frame not found: ${r.stdout.slice(0, 200)}`)
  return w
}

/** Polls `windows --pid` until the fixture frame matches (2 px tolerance). */
async function frameIs(ctx: Ctx, want: Record<string, number>): Promise<string | void> {
  let frame: Record<string, number> = {}
  for (let i = 0; i < 6; i++) {
    frame = (await fixtureWindow(ctx)).frame
    if (Object.entries(want).every(([k, v]) => Math.abs(frame[k] - v) <= 2)) return
    await ctx.sleep(250)
  }
  return `fixture frame ${JSON.stringify(frame)} is not ${JSON.stringify(want)}`
}

const frontIs = async (ctx: Ctx, want: string) => {
  let got = ""
  for (let i = 0; i < 12; i++) { const r = await ctx.run(["frontmost"]); got = String(r.json?.pid); if (got === want) return; await ctx.sleep(250) }
  return `frontmost is ${got}, expected ${want}`
}
const samePid = (r: Res, ctx: Ctx) => r.json?.pid === ctx.fixture.pid ? undefined : `result pid ${r.json?.pid} is not the fixture ${ctx.fixture.pid}`
const lifecycle = (word: string) => (r: Res, ctx: Ctx) =>
  ctx.host === "darwin" ? contains(word)(r) : String(r.json?.pid) === target(ctx).pid ? undefined : `lifecycle pid ${r.json?.pid} is not ${target(ctx).pid}`
const hasWindow = (title: string) => (r: Res) =>
  (r.json?.windows ?? []).some((w: any) => String(w.title).includes(title)) ? undefined : `open lists no ${JSON.stringify(title)} window: ${JSON.stringify(r.json?.windows).slice(0, 200)}`

export const apps: Family[] = [
  {
    family: "apps",
    cases: [
      { id: "apps.list", sub: "-", args: ["apps"],
        check: (r, ctx) => ctx.host === "darwin" ? contains("Finder")(r) : list(r).some(a => a.pid === ctx.fixture.pid) ? undefined : `fixture pid missing from apps: ${JSON.stringify(r.json).slice(0, 200)}` },
    ],
  },
  {
    family: "frontmost",
    cases: [
      { id: "frontmost.read", sub: "-", args: ["frontmost"], check: r => Number(r.json?.pid) > 0 ? undefined : `no frontmost pid: ${JSON.stringify(r.json).slice(0, 200)}` },
    ],
  },
  {
    family: "read",
    cases: [
      { id: "read.pid", sub: "-", args: ctx => ["read", "--pid", pid(ctx)], flags: ["--pid"], check: (r, ctx) => samePid(r, ctx) ?? contains("Submit fixture")(r) },
      { id: "read.app-filter-depth", sub: "-", args: ctx => ["read", "--app", ctx.fixture.app, "--filter", "all", "--depth", "8"], flags: ["--app", "--filter", "--depth"], check: contains("Fixture input") },
      { id: "read.bad-depth", sub: "-", args: ctx => ["read", "--pid", pid(ctx), "--depth", "-2"], expect: { all: refuse() } },
    ],
  },
  {
    family: "act",
    cases: [
      { id: "act.type-pid", sub: "-", args: async ctx => ["act", await ctx.ref("Fixture input"), "parity act text", "--pid", pid(ctx)], flags: ["--pid"],
        check: (r, ctx) => r.json?.action === "typed" ? waitState(ctx, s => s.input === "parity act text", "input = parity act text") : `action is ${r.json?.action}, expected typed` },
      { id: "act.click-app", sub: "-", flags: ["--app"],
        args: async ctx => { ctx.vars.clicks = state(ctx).clicks ?? 0; return ["act", await ctx.ref("Submit fixture"), "--app", ctx.fixture.app] },
        check: (r, ctx) => r.json?.action === "clicked" ? waitState(ctx, s => s.clicks > ctx.vars.clicks, "another submit click") : `action is ${r.json?.action}, expected clicked` },
      { id: "act.disabled", sub: "-", args: async ctx => ["act", await ctx.ref("Disabled fixture button"), "--pid", pid(ctx)], expect: { all: refuse() } },
      { id: "act.stale-ref", sub: "-", args: ctx => ["act", "e987654321", "parity", "--pid", pid(ctx)], expect: { all: refuse() } },
    ],
  },
  {
    family: "resize",
    async setup(ctx) { ctx.vars.frame = (await fixtureWindow(ctx)).frame },
    cases: [
      { id: "resize.flags-pid", sub: "-", flags: ["--width", "--height", "--pid"],
        args: async ctx => { const f = ctx.vars.frame; ctx.vars.want = { width: f.width + 40, height: ctx.host === "win32" ? f.height + 20 : Math.max(f.height, 780) }
          return ["resize", (await fixtureWindow(ctx)).ref, "--width", String(ctx.vars.want.width), "--height", String(ctx.vars.want.height), "--pid", pid(ctx)] },
        check: (_r, ctx) => frameIs(ctx, ctx.vars.want) },
      { id: "resize.positionals-app", sub: "-", flags: ["--app"],
        args: async ctx => ["resize", (await fixtureWindow(ctx)).ref, String(ctx.vars.frame.width + 20), String(Math.max(ctx.vars.frame.height, 780) + 20), "--app", ctx.fixture.app],
        // A resize past the screen's visible frame is clamped and says so; the frame must then fill it.
        check: (r, ctx) => { const want = { width: ctx.vars.frame.width + 20, height: Math.max(ctx.vars.frame.height, 780) + 20 }, c = r.json?.clampedTo
          if (r.json?.clamped && c) { want.width = Math.min(want.width, c.x + c.width - ctx.vars.frame.x); want.height = Math.min(want.height, c.y + c.height - ctx.vars.frame.y) }
          return frameIs(ctx, want) } },
      { id: "resize.zero-width", sub: "-", args: async ctx => ["resize", (await fixtureWindow(ctx)).ref, "--width", "0", "--height", "100", "--pid", pid(ctx)], expect: { all: refuse("invalid_request") } },
    ],
    async teardown(ctx) { const { ref } = await fixtureWindow(ctx); await ctx.run(["resize", ref, String(ctx.vars.frame.width), String(ctx.vars.frame.height), "--pid", pid(ctx)]) },
  },
  {
    family: "move",
    async setup(ctx) { ctx.vars.frame = (await fixtureWindow(ctx)).frame },
    cases: [
      { id: "move.flags-pid", sub: "-", flags: ["--x", "--y", "--pid"],
        args: async ctx => { const f = ctx.vars.frame; ctx.vars.want = { x: f.x + 30, y: f.y + 20 }
          return ["move", (await fixtureWindow(ctx)).ref, "--x", String(ctx.vars.want.x), "--y", String(ctx.vars.want.y), "--pid", pid(ctx)] },
        check: (_r, ctx) => frameIs(ctx, ctx.vars.want) },
      { id: "move.positionals-app", sub: "-", flags: ["--app"],
        args: async ctx => ["move", (await fixtureWindow(ctx)).ref, String(ctx.vars.frame.x), String(ctx.vars.frame.y), "--app", ctx.fixture.app],
        check: (_r, ctx) => frameIs(ctx, { x: ctx.vars.frame.x, y: ctx.vars.frame.y }) },
      { id: "move.x-out-of-range", sub: "-", args: async ctx => ["move", (await fixtureWindow(ctx)).ref, "--x", "4294967296", "--y", "0", "--pid", pid(ctx)], expect: { all: refuse("invalid_request") } },
    ],
    async teardown(ctx) { const { ref } = await fixtureWindow(ctx); await ctx.run(["move", ref, String(ctx.vars.frame.x), String(ctx.vars.frame.y), "--pid", pid(ctx)]) },
  },
  {
    family: "open",
    async setup(ctx) { if (ctx.host !== "darwin") helperPath(ctx); await closeLeftovers(ctx) },
    cases: [
      { id: "open.pid", sub: "-", args: ctx => ["open", "--pid", pid(ctx)], flags: ["--pid"], check: (r, ctx) => samePid(r, ctx) ?? hasWindow(ctx.fixture.title)(r) },
      { id: "open.app-filter-depth", sub: "-", args: ctx => ["open", "--app", ctx.fixture.app, "--filter", "all", "--depth", "6"], flags: ["--app", "--filter", "--depth"],
        check: (r, ctx) => samePid(r, ctx) ?? contains("Fixture input")(r) },
      { id: "open.positional", sub: "-", args: ctx => ["open", ctx.fixture.app], check: samePid },
      { id: "open.not-installed", sub: "-", args: ["open", NO_APP], expect: { all: refuse("unsupported_target"), darwin: refuse() } },
      { id: "open.bad-depth", sub: "-", args: ctx => ["open", "--pid", pid(ctx), "--depth", "0"], expect: { all: refuse("invalid_request"), darwin: refuse() } },
      // Cold launch by absolute path in the background: the runner fails it if focus moves.
      { id: "open.launch-path", sub: "-", disruptive: true, args: ctx => ["open", helperPath(ctx)],
        check: (r, ctx) => { ctx.vars.helperPid = r.json?.pid > 0 ? String(r.json.pid) : undefined
          return r.json?.pid > 0 && r.json.pid !== ctx.fixture.pid ? hasWindow(HELPER_TITLE)(r) : `launch returned pid ${r.json?.pid}` } },
      { id: "open.activate", sub: "-", disruptive: true, focus: "allowed", flags: ["--pid", "--activate"],
        args: ctx => ["open", "--pid", target(ctx).pid, "--activate"], check: (_r, ctx) => frontIs(ctx, target(ctx).pid) },
    ],
    teardown: stopHelper,
  },
  {
    family: "app",
    async setup(ctx) { await closeLeftovers(ctx); if (ctx.host !== "darwin") await launchHelper(ctx) },
    cases: [
      { id: "app.hide-pid", sub: "hide", args: ctx => ["app", "hide", "--pid", target(ctx).pid], flags: ["--pid"], check: lifecycle("hidden"), expect: { darwin: ACCESSORY } },
      { id: "app.unhide-pid", sub: "unhide", args: ctx => ["app", "unhide", "--pid", target(ctx).pid], flags: ["--pid"], check: lifecycle("unhidden"), expect: { darwin: ACCESSORY } },
      { id: "app.hide-app", sub: "hide", args: ctx => ["app", "hide", "--app", target(ctx).name], flags: ["--app"], check: lifecycle("hidden"), expect: { darwin: ACCESSORY } },
      { id: "app.unhide-app", sub: "unhide", args: ctx => ["app", "unhide", "--app", target(ctx).name], flags: ["--app"], check: lifecycle("unhidden"), expect: { darwin: ACCESSORY } },
      { id: "app.hide-positional", sub: "hide", args: ctx => ["app", "hide", target(ctx).name], check: lifecycle("hidden"), expect: { darwin: ACCESSORY } },
      { id: "app.unhide-positional", sub: "unhide", args: ctx => ["app", "unhide", target(ctx).name], check: lifecycle("unhidden"), expect: { darwin: ACCESSORY } },
      { id: "app.hide-two-targets", sub: "hide", args: ctx => ["app", "hide", "--app", target(ctx).name, "--pid", target(ctx).pid], flags: ["--app", "--pid"], expect: { all: refuse("invalid_request") } },
      // Bundle ids are Apple-only; Windows/Linux launch through `open <absolute path>`. Finder is
      // always running, so the Mac answers "already running" without launching anything.
      { id: "app.launch-positional", sub: "launch", args: ["app", "launch", "com.apple.finder"], expect: { darwin: ok, win32: refuse("target_gone"), linux: refuse("target_gone") } },
      { id: "app.launch-bundle", sub: "launch", args: ["app", "launch", "--bundle", "com.apple.finder"], expect: { darwin: ok, win32: refuse("target_gone"), linux: refuse("target_gone") } },
      // Launch a host-native app id for real. Windows Explorer is always running (launched:false, no window);
      // the Linux terminal launches in the background and is quit in teardown.
      { id: "app.launch-native", sub: "launch", flags: ["--app"], disruptive: true,
        expect: { darwin: skip("covered by the Finder case"), win32: ok, linux: ok },
        needs: ctx => ctx.host === "linux" && !["/usr/share/applications/foot.desktop", "/usr/local/share/applications/foot.desktop"].some(existsSync) ? "no foot.desktop on this host" : undefined,
        args: ctx => ctx.host === "win32" ? ["app", "launch", "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\charmap.exe"] : ["app", "launch", "foot"],
        check: async (r, ctx) => { const pid = r.json?.pid; if (!pid) return "launch returned no pid"; if (r.json?.launched === true) await ctx.run(["app", "quit", "--pid", String(pid)]); return undefined } },
      { id: "app.launch-with-pid", sub: "launch", args: ctx => ["app", "launch", "com.apple.finder", "--pid", pid(ctx)], flags: ["--pid"], expect: { all: refuse("invalid_request") } },
      { id: "app.quit-missing", sub: "quit", args: ["app", "quit", "--app", NO_APP], expect: { all: refuse("unsupported_target"), darwin: refuse() } },
      // Quit the background helper before any activation: Linux refuses quit on the active app.
      { id: "app.quit-helper", sub: "quit", disruptive: true, flags: ["--pid"],
        args: ctx => ["app", "quit", "--pid", (ctx.vars.quitPid = target(ctx).pid)],
        check: async (_r, ctx) => {
          for (let i = 0; i < 20; i++) { if (!list(await ctx.run(["apps"])).some(a => String(a.pid) === ctx.vars.quitPid)) return; await ctx.sleep(250) }
          return `helper ${ctx.vars.quitPid} is still listed after quit`
        } },
      // Activation targets a freshly launched helper, so the fixture observer is not the one losing focus.
      { id: "app.activate-pid", sub: "activate", disruptive: true, focus: "allowed", flags: ["--pid"],
        args: async ctx => ["app", "activate", "--pid", await launchHelper(ctx)], check: (_r, ctx) => frontIs(ctx, target(ctx).pid) },
      { id: "app.activate-app", sub: "activate", disruptive: true, focus: "allowed", args: ctx => ["app", "activate", "--app", target(ctx).name], flags: ["--app"],
        check: (_r, ctx) => frontIs(ctx, target(ctx).pid) },
      { id: "app.activate-positional", sub: "activate", disruptive: true, focus: "allowed", args: ctx => ["app", "activate", target(ctx).name],
        check: (_r, ctx) => frontIs(ctx, target(ctx).pid) },
    ],
    async teardown(ctx) {
      if (ctx.host === "darwin") await ctx.run(["app", "unhide", "--pid", pid(ctx)])
      else await stopHelper(ctx)
    },
  },
]

// Every inventory row of these families is exercised above.
export const appsExclusions: Exclusion[] = []
