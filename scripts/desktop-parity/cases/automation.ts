// Automation families: script run, intent dispatch/warmup, appintent, monitor, overlay.
// Every subcommand and flag from the CLI inventory appears below.
import { join } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import { type Case, type Ctx, type Exclusion, type Family, type Res, errorText, macOnly, refuse } from "../types"
import { contains, list, pid, text } from "./helpers"

type Check = NonNullable<Case["check"]>
/** Checks also run after a matched refusal; these only judge a success. */
const whenOk = (f: Check): Check => (r, ctx) => r.exit === 0 && r.json?.success !== false ? f(r, ctx) : undefined
const onMac = (f: Check): Check => (r, ctx) => ctx.host === "darwin" ? f(r, ctx) : undefined
const result = (want: unknown): Check => r =>
  JSON.stringify(r.json?.result) === JSON.stringify(want) ? undefined : `script result ${JSON.stringify(r.json?.result)} != ${JSON.stringify(want)}`
const need = (ctx: Ctx, key: string) => { if (!ctx.vars[key]) throw new Error(`no ${key} from an earlier case`); return String(ctx.vars[key]) }

// AppleScript, JXA and Apple Events are macOS-only. Windows/Linux refuse
// in the capability gate (unsupported_operation) or the desktop parser (invalid_request).
// The portable surface refuses AppleScript, JXA and Apple Events on every host; Macs use `interceptor macos script`.
const osa = { all: refuse(["unsupported_operation", "invalid_request"], /macOS-only/) }

// --- monitor -------------------------------------------------------------------------
async function activeSids(ctx: Ctx): Promise<string[]> {
  const r = await ctx.run(["monitor", "status"])
  return (r.json?.sessions ?? (r.json?.sid ? [r.json] : [])).map((s: any) => s.sid).filter(Boolean)
}
/** Stops the recording a variant start created, after a short capture window. */
async function stopStarted(r: Res, ctx: Ctx): Promise<string | void> {
  const sid = r.json?.sid
  if (!sid) return `start returned no sid: ${text(r).slice(0, 200)}`
  await ctx.sleep(1200)
  const s = await ctx.run(["monitor", "stop", "--sid", sid])
  if (s.exit !== 0) return `stop ${sid} failed: ${errorText(s)}`
}
/** Fixture activity through the CLI while the main recording runs: a value write, a press, a file in the watched folder. */
async function fixtureActivity(ctx: Ctx) {
  await ctx.run(["value", await ctx.ref("Fixture input"), "Interceptor Parity monitor", "--pid", pid(ctx)])
  await ctx.run(["action", await ctx.ref("Submit fixture"), "press", "--pid", pid(ctx)])
  writeFileSync(join(need(ctx, "watch"), "Interceptor Parity monitor.txt"), "Interceptor Parity monitor\n")
  await ctx.sleep(1000)
}
const watchDir = (ctx: Ctx, name: string) => { const d = join(ctx.dir, `Interceptor Parity ${name}`); mkdirSync(d, { recursive: true }); return d }
const sid = (ctx: Ctx) => need(ctx, "sid")
const task = (ctx: Ctx) => need(ctx, "task")

// --- overlay -------------------------------------------------------------------------
const OUT_ENGINE = ["unsupported_operation", "not_installed", "background_unavailable"]
const OV = (name: string) => `interceptor-parity-${name}`
const OVERLAYS = ["particles", "scene", "script", "script-file", "html", "html-b64", "url", "bad"].map(OV)
const SCENE = JSON.stringify({ background: "transparent", banner: { text: "Interceptor Parity", y: 0.1, fontSize: 24, color: "white" },
  entities: [{ id: "parity-bot", emoji: "🤖", x: 0.5, y: 0.5, size: 64, facing: "left" }], timeline: [{ at: 0, op: "say", text: "Interceptor Parity" }] })
const OPS = JSON.stringify([{ op: "move-to", target: "parity-bot", x: 0.25, y: 0.25, duration: 0.5, easing: "easeInOut" }, { op: "say", text: "Interceptor Parity ops" }])
const HTML64 = Buffer.from("<p>Interceptor Parity base64</p>").toString("base64")
const stopOverlay = (id: string): Check => async (_r, ctx) => {
  const s = await ctx.run(["overlay", "stop", id])
  if (s.exit !== 0) return `overlay stop ${id} failed: ${errorText(s)}`
}
async function displayId(ctx: Ctx): Promise<string> {
  const r = await ctx.run(["display", "list"])
  const d = list(r).find(x => x.isMain) ?? list(r)[0]
  if (d?.id === undefined) throw new Error(`no display id: ${r.stdout.slice(0, 200)}`)
  return String(d.id)
}
// Overlays draw a visible HUD: allowed on the VMs, skipped on the shared Mac.
const ctl = (mode: string, verb: string, ...flags: string[]): Case =>
  ({ id: `overlay.ctl.${mode}-${verb}${flags.includes("--args") ? "-args" : ""}`, sub: "ctl", args: ["overlay", "ctl", OV(mode), verb, ...flags], disruptive: true })

export const automation: Family[] = [
  {
    family: "script",
    cases: [
      { id: "script.run.expression", sub: "run", args: ["script", "run", "--jsc", "6*7"], check: result(42) },
      { id: "script.run.args", sub: "run", args: ["script", "run", "--jsc", 'run = argv => argv.join("|")', "--args", '["Interceptor","Parity"]'], check: result("Interceptor|Parity") },
      { id: "script.run.host-bare", sub: "run", args: ["script", "run", "--jsc", "[typeof host.home, typeof host.readText, typeof host.sh, typeof host.sqlite]", "--jsc-host"], check: result(["function", "function", "function", "function"]) },
      { id: "script.run.host-none", sub: "run", args: ["script", "run", "--jsc", "typeof host", "--jsc-host", "none"], check: result("undefined") },
      { id: "script.run.host-env", sub: "run", args: ["script", "run", "--jsc", "host.home().length > 0", "--jsc-host", "env"], check: result(true) },
      { id: "script.run.host-fs", sub: "run", flags: ["--jsc", "--jsc-host", "--args"],
        args: ctx => ["script", "run", "--jsc", 'host.writeText(argv[0], "Interceptor Parity fs"); host.readText(argv[0])', "--jsc-host", "env,fs", "--args", JSON.stringify([join(ctx.dir, "Interceptor Parity script.txt")])],
        check: result("Interceptor Parity fs") },
      { id: "script.run.host-shell", sub: "run", args: ["script", "run", "--jsc", 'host.sh("echo InterceptorParityShell").stdout.includes("InterceptorParityShell")', "--jsc-host", "shell"], check: result(true) },
      // An empty file is an empty SQLite database; the host opens it read-only.
      { id: "script.run.host-sqlite", sub: "run", flags: ["--jsc", "--jsc-host", "--args"],
        args: ctx => { const db = join(ctx.dir, "Interceptor Parity.sqlite"); writeFileSync(db, ""); return ["script", "run", "--jsc", 'host.sqlite(argv[0], "SELECT 41+1 AS answer")', "--jsc-host", "sqlite", "--args", JSON.stringify([db])] },
        check: result([{ answer: 42 }]) },
      { id: "script.run.unsafe-native", sub: "run", args: ["script", "run", "--jsc", "typeof host.sh", "--jsc-unsafe-native"], check: result("function") },
      { id: "script.run.host-not-enabled", sub: "run", args: ["script", "run", "--jsc", 'host.sh("echo x")', "--jsc-host", "env"], expect: { all: refuse() } },
      { id: "script.run.bad-host", sub: "run", args: ["script", "run", "--jsc", "1", "--jsc-host", "bogus"], expect: { all: refuse("invalid_request") } },
      { id: "script.run.applescript", sub: "run", args: ["script", "run", "--script", 'return "Interceptor Parity"'], expect: osa, check: onMac(contains("Interceptor Parity")) },
      { id: "script.run.jxa", sub: "run", args: ["script", "run", "--jxa", '"Interceptor Parity"'], expect: osa, check: onMac(contains("Interceptor Parity")) },
      { id: "script.run.javascript-alias", sub: "run", args: ["script", "run", "--javascript", '"Interceptor Parity"'], expect: osa, check: onMac(contains("Interceptor Parity")) },
      // Apple Events to another app can raise an Automation consent prompt on the Mac.
      { id: "script.run.bundle", sub: "run", disruptive: true, expect: osa,
        args: ["script", "run", "--jxa", "Application.currentApplication().name()", "--bundle", "com.apple.finder", "--intent", "activate", "--target", "window 1", "--params", "{}"] },
    ],
  },
  {
    family: "intent",
    cases: [
      { id: "intent.dispatch.jsc", sub: "dispatch", args: ["intent", "dispatch", "--jsc", '"Interceptor Parity"'], check: result("Interceptor Parity") },
      { id: "intent.dispatch.args", sub: "dispatch", args: ["intent", "dispatch", "--jsc", "function run(a){return a.length}", "--args", '["a","b","c"]'], check: result(3) },
      { id: "intent.dispatch.host", sub: "dispatch", args: ["intent", "dispatch", "--jsc", "typeof host.readText", "--jsc-host", "fs"], check: result("function") },
      { id: "intent.dispatch.unsafe-native", sub: "dispatch", args: ["intent", "dispatch", "--jsc", "typeof host.sqlite", "--jsc-unsafe-native"], check: result("function") },
      { id: "intent.dispatch.no-source", sub: "dispatch", args: ["intent", "dispatch"], expect: { all: refuse("invalid_request") } },
      { id: "intent.dispatch.applescript", sub: "dispatch", args: ["intent", "dispatch", "--script", 'return "Interceptor Parity"'], expect: osa, check: onMac(contains("Interceptor Parity")) },
      { id: "intent.dispatch.jxa", sub: "dispatch", args: ["intent", "dispatch", "--jxa", '"Interceptor Parity"'], expect: osa, check: onMac(contains("Interceptor Parity")) },
      { id: "intent.dispatch.javascript-alias", sub: "dispatch", args: ["intent", "dispatch", "--javascript", '"Interceptor Parity"'], expect: osa },
      { id: "intent.dispatch.apple-event", sub: "dispatch", disruptive: true, expect: osa,
        args: ["intent", "dispatch", "--bundle", "com.apple.finder", "--intent", "get name of", "--target", "startup disk", "--params", "{}"] },
      // A bundle id that is not running answers without a consent prompt.
      { id: "intent.warmup.absent-app", sub: "warmup", args: ["intent", "warmup", "com.interceptor.parity-absent"], expect: macOnly(), check: onMac(contains("com.interceptor.parity-absent")) },
    ],
  },
  {
    family: "appintent",
    cases: [
      { id: "appintent.list", sub: "list", args: ["appintent", "list"], expect: macOnly(), check: onMac(contains("shortcuts")) },
      { id: "appintent.registered", sub: "registered", args: ["appintent", "registered"], expect: macOnly(), check: onMac(contains("ActivateAppIntent")) },
      { id: "appintent.donate", sub: "donate", args: ["appintent", "donate", "ActivateAppIntent"], expect: macOnly(), check: onMac(contains("ActivateAppIntent")) },
      { id: "appintent.update-parameters", sub: "update-parameters", args: ["appintent", "update-parameters"], expect: macOnly() },
      { id: "appintent.supports", sub: "supports", args: ["appintent", "supports"], expect: macOnly(), check: onMac(contains("frameworkAvailable")) },
      { id: "appintent.donate-unknown", sub: "donate", args: ["appintent", "donate", "InterceptorParityNoSuchIntent"], expect: { all: refuse() } },
    ],
  },
  {
    family: "monitor",
    async setup(ctx) {
      // Task metadata stays in this run's scratch folder instead of the user's task store.
      ctx.vars.tasksEnv = process.env.INTERCEPTOR_TASKS_DIR
      process.env.INTERCEPTOR_TASKS_DIR = join(ctx.dir, "Interceptor Parity monitor tasks")
      ctx.vars.preexisting = await activeSids(ctx)
    },
    async teardown(ctx) {
      for (const s of await activeSids(ctx)) if (!ctx.vars.preexisting?.includes(s)) await ctx.run(["monitor", "stop", "--sid", s])
      if (ctx.vars.tasksEnv === undefined) delete process.env.INTERCEPTOR_TASKS_DIR
      else process.env.INTERCEPTOR_TASKS_DIR = ctx.vars.tasksEnv
    },
    cases: [
      { id: "monitor.status.all", sub: "status", args: ["monitor", "status"] },
      { id: "monitor.list.limit", sub: "list", args: ["monitor", "list", "--limit", "5"], check: r => list(r).length <= 5 ? undefined : "list exceeded --limit 5" },
      // Main recording: start, fixture activity, pause/resume, tail, stop, export, list.
      { id: "monitor.start.main", sub: "start", flags: ["--app", "--instruction", "--include", "--watch-path", "--exclude", "--ax-coalesce-ms", "--scroll-coalesce-ms", "--speech-mode"],
        args: ctx => ["monitor", "start", "--app", ctx.fixture.app, "--instruction", "Interceptor Parity monitor", "--include", "files", "--watch-path", (ctx.vars.watch = watchDir(ctx, "monitor watch")),
          "--exclude", "scroll", "--ax-coalesce-ms", "50", "--scroll-coalesce-ms", "50", "--speech-mode", "off"],
        check: (r, ctx) => (ctx.vars.sid = r.json?.sid) ? undefined : `start returned no sid: ${text(r).slice(0, 200)}` },
      { id: "monitor.status.sid", sub: "status", flags: ["--sid"], args: async ctx => { await fixtureActivity(ctx); return ["monitor", "status", "--sid", sid(ctx)] }, check: (r, ctx) => contains(sid(ctx))(r) },
      { id: "monitor.pause.sid", sub: "pause", flags: ["--sid"], args: ctx => ["monitor", "pause", "--sid", sid(ctx)], check: contains("paused") },
      { id: "monitor.resume.sid", sub: "resume", flags: ["--sid"], args: ctx => ["monitor", "resume", "--sid", sid(ctx)], check: contains("recording") },
      { id: "monitor.tail.sid-limit", sub: "tail", flags: ["--sid", "--limit"], args: ctx => ["monitor", "tail", "--sid", sid(ctx), "--limit", "20"],
        check: r => list(r).length >= 2 ? undefined : `recording holds nothing beyond its start: ${text(r).slice(0, 200)}` },
      { id: "monitor.tail.json", sub: "tail", flags: ["--sid", "--json"], args: ctx => ["monitor", "tail", "--sid", sid(ctx), "--json"] },
      { id: "monitor.tail.plan", sub: "tail", flags: ["--sid", "--plan"], args: ctx => ["monitor", "tail", "--sid", sid(ctx), "--plan"], expect: { all: refuse("invalid_request", /no --plan/) } },
      { id: "monitor.tail.raw", sub: "tail", flags: ["--sid", "--raw"], args: ctx => ["monitor", "tail", "--sid", sid(ctx), "--raw"] },
      { id: "monitor.stop.sid", sub: "stop", flags: ["--sid"], args: ctx => ["monitor", "stop", "--sid", sid(ctx)] },
      // An unknown session is a definite target_gone on every host.
      { id: "monitor.stop.unknown-sid", sub: "stop", args: ["monitor", "stop", "--sid", "interceptor_parity_no_such_sid"], expect: { all: refuse("target_gone") } },
      { id: "monitor.export.positional", sub: "export", args: ctx => ["monitor", "export", sid(ctx)],
        check: r => typeof r.json === "string" && r.json.length ? undefined : `timeline export is not text: ${text(r).slice(0, 200)}` },
      { id: "monitor.export.json", sub: "export", flags: ["--sid", "--json"], args: ctx => ["monitor", "export", "--sid", sid(ctx), "--json"],
        check: (r, ctx) => { writeFileSync(join(ctx.dir, "Interceptor Parity monitor export.json"), r.stdout); return list(r).length >= 2 ? undefined : "export holds nothing beyond its start" } },
      { id: "monitor.export.plan", sub: "export", flags: ["--sid", "--plan"], args: ctx => ["monitor", "export", "--sid", sid(ctx), "--plan"],
        check: r => typeof r.json === "string" && r.json.length ? undefined : "plan export is not text" },
      { id: "monitor.export.raw", sub: "export", flags: ["--sid", "--raw"], args: ctx => ["monitor", "export", "--sid", sid(ctx), "--raw"] },
      { id: "monitor.list.archive", sub: "list", flags: ["--limit"], args: ["monitor", "list", "--limit", "50"], check: (r, ctx) => contains(sid(ctx))(r) },
      // Task-owned recording addressed by --task.
      { id: "monitor.start.task", sub: "start", flags: ["--app", "--task", "--mode", "--retention-policy", "--guard-policy", "--verifier-policy"],
        args: ctx => ["monitor", "start", "--app", ctx.fixture.app, "--task", "Interceptor Parity Task", "--mode", "agent-record",
          "--retention-policy", "default-local-redacted-retention", "--guard-policy", "default-require-approval-guard", "--verifier-policy", "interceptor-parity-verifier"],
        check: (r, ctx) => (ctx.vars.task = r.json?.taskId) && r.json?.sid ? undefined : `start returned no taskId/sid: ${text(r).slice(0, 200)}` },
      { id: "monitor.status.task", sub: "status", flags: ["--task"], args: ctx => ["monitor", "status", "--task", task(ctx)] },
      { id: "monitor.pause.task", sub: "pause", flags: ["--task"], args: ctx => ["monitor", "pause", "--task", task(ctx)] },
      { id: "monitor.resume.task", sub: "resume", flags: ["--task"], args: ctx => ["monitor", "resume", "--task", task(ctx)] },
      { id: "monitor.tail.task", sub: "tail", flags: ["--task", "--limit"], args: ctx => ["monitor", "tail", "--task", task(ctx), "--limit", "10"] },
      { id: "monitor.stop.task", sub: "stop", flags: ["--task"], args: ctx => ["monitor", "stop", "--task", task(ctx)], timeoutMs: 90_000, check: (r, ctx) => contains(task(ctx))(r) },
      // Start variants; each stops its own recording.
      { id: "monitor.start.apps-watch-paths", sub: "start", flags: ["--apps", "--include", "--watch-paths", "--include-system-apps", "--exclude-app"],
        args: ctx => ["monitor", "start", "--apps", ctx.fixture.app, "--include", "files", "--watch-paths", `${watchDir(ctx, "watch A")},${watchDir(ctx, "watch B")}`,
          "--include-system-apps", "--exclude-app", "Interceptor Parity Excluded App"], check: whenOk(stopStarted) },
      { id: "monitor.start.log", sub: "start", flags: ["--app", "--include", "--log-predicate"],
        args: ctx => ["monitor", "start", "--app", ctx.fixture.app, "--include", "log", "--log-predicate", 'subsystem == "com.interceptor.parity-fixture"'], check: whenOk(stopStarted) },
      { id: "monitor.start.frames", sub: "start", flags: ["--app", "--frames", "--frame-format", "--frame-quality", "--frame-max-long-edge", "--frame-budget", "--frame-disk-cap", "--frame-pixel-scale"],
        args: ctx => ["monitor", "start", "--app", ctx.fixture.app, "--frames", "2", "--frame-format", "png", "--frame-quality", "80", "--frame-max-long-edge", "640",
          "--frame-budget", "10", "--frame-disk-cap", "50", "--frame-pixel-scale", "1"], check: whenOk(stopStarted) },
      { id: "monitor.start.video", sub: "start", flags: ["--app", "--video", "--video-max-mb"],
        args: ctx => ["monitor", "start", "--app", ctx.fixture.app, "--video", "2", "--video-max-mb", "20"], check: whenOk(stopStarted) },
      // OCR and speech need the vision/listen engines, which are out of scope on Windows and Linux.
      { id: "monitor.start.vision-text", sub: "start", flags: ["--app", "--frames", "--vision-text"],
        args: ctx => ["monitor", "start", "--app", ctx.fixture.app, "--frames", "1", "--vision-text"], check: whenOk(stopStarted) },
      { id: "monitor.start.speech-live", sub: "start", flags: ["--app", "--speech-mode"], expect: macOnly("unsupported_operation"), disruptive: true,
        args: ctx => ["monitor", "start", "--app", ctx.fixture.app, "--speech-mode", "live"], check: whenOk(stopStarted) },
      // --tap asks for raw global input: Windows records it, Wayland cannot by design. On the Mac it taps the person's keystrokes.
      { id: "monitor.start.tap", sub: "start", flags: ["--app", "--tap"], expect: { linux: refuse("unsupported_operation") }, disruptive: true,
        args: ctx => ["monitor", "start", "--app", ctx.fixture.app, "--tap"],
        check: whenOk(async (r, ctx) => {
          const stopped = await stopStarted(r, ctx)
          const input = (r.json?.coverage ?? []).find((c: any) => c.source === "input")
          return stopped
        }) },
      // Records every app the person uses: VMs only.
      { id: "monitor.start.all-apps", sub: "start", disruptive: true,
        args: ["monitor", "start", "--all-apps", "--include-system-apps", "--exclude-app", "Interceptor Parity Excluded App", "--instruction", "Interceptor Parity all apps"], check: whenOk(stopStarted) },
      { id: "monitor.start.mode-needs-task", sub: "start", args: ["monitor", "start", "--app", "Interceptor Parity", "--mode", "agent-record"], expect: { all: refuse("invalid_request") } },
      { id: "monitor.start.frames-bound", sub: "start", args: ["monitor", "start", "--app", "Interceptor Parity", "--frames", "61"], expect: { all: refuse("invalid_request") } },
    ],
  },
  {
    family: "overlay",
    async teardown(ctx) { for (const id of OVERLAYS) await ctx.run(["overlay", "stop", id]) },
    cases: [
      { id: "overlay.list.read", sub: "list", args: ["overlay", "list"] },
      { id: "overlay.ctl.unknown-verb", sub: "ctl", args: ["overlay", "ctl", OV("particles"), "no-such-verb"], expect: { all: refuse("invalid_request") } },
      // Particles: start, inventory, status/verbs (with and without an ID), every particle control, stop.
      { id: "overlay.start.particles", sub: "start", disruptive: true, check: contains(OV("particles")),
        args: ["overlay", "start", "--id", OV("particles"), "--particles", "roses", "--emojis", "🌹,🌸", "--direction", "up", "--density", "8", "--lifetime", "2",
          "--velocity", "120", "--size-scale", "1", "--anchor", "br", "--width", "320", "--height", "240", "--level", "floating", "--timeout-seconds", "90", "--no-interactive"] },
      { id: "overlay.list.owned", sub: "list", disruptive: true, args: ["overlay", "list"], check: contains(OV("particles")) },
      { id: "overlay.status.only", sub: "status", disruptive: true, args: ["overlay", "status"], check: contains(OV("particles")) },
      { id: "overlay.status.id", sub: "status", disruptive: true, args: ["overlay", "status", OV("particles")], check: contains(OV("particles")) },
      { id: "overlay.verbs.only", sub: "verbs", disruptive: true, args: ["overlay", "verbs"], check: contains("burst") },
      { id: "overlay.verbs.id", sub: "verbs", disruptive: true, args: ["overlay", "verbs", OV("particles")], check: contains("set-density") },
      ctl("particles", "set-density", "--value", "10"), ctl("particles", "set-direction", "--value", "down"), ctl("particles", "set-emojis", "--value", "⭐,❄️"),
      ctl("particles", "set-lifetime", "--value", "2"), ctl("particles", "set-velocity", "--value", "150"), ctl("particles", "set-scale", "--value", "1.2"),
      ctl("particles", "burst", "--count", "5"), ctl("particles", "burst", "--args", '{"count":3}'), ctl("particles", "pause"), ctl("particles", "resume"),
      { id: "overlay.stop.particles", sub: "stop", disruptive: true, args: ["overlay", "stop", OV("particles")], check: contains(OV("particles")) },
      // Titans scene and its fighter controls.
      { id: "overlay.start.scene", sub: "start", disruptive: true, check: contains(OV("scene")),
        args: ["overlay", "start", "--id", OV("scene"), "--scene", "titans", "--rect", "40,40,480,320", "--level", "statusBar", "--duration-ms", "90000"] },
      ctl("scene", "say", "--text", "Interceptor Parity"), ctl("scene", "round", "--n", "2", "--text", "Round two"), ctl("scene", "punch", "--who", "kong", "--emoji", "👊"),
      ctl("scene", "breathe-fire", "--who", "godzilla", "--emoji", "🔥"), ctl("scene", "throw", "--who", "kong", "--emoji", "🪨"), ctl("scene", "taunt", "--who", "g"),
      ctl("scene", "roar", "--who", "godzilla", "--text", "Roar"), ctl("scene", "bow", "--who", "kong"), ctl("scene", "jump", "--who", "k", "--height", "60"),
      ctl("scene", "tint", "--who", "kong", "--color", "red", "--amount", "0.5"), ctl("scene", "knockout", "--who", "gz"),
      ctl("scene", "pause"), ctl("scene", "resume"), ctl("scene", "reset"),
      { id: "overlay.stop.scene", sub: "stop", disruptive: true, args: ["overlay", "stop", OV("scene")], check: contains(OV("scene")) },
      // Scene script and its entity/timeline controls.
      { id: "overlay.start.script", sub: "start", disruptive: true, check: contains(OV("script")),
        args: ["overlay", "start", "--id", OV("script"), "--scene-script", SCENE, "--anchor", "center", "--width", "480", "--height", "320", "--duration", "90000"] },
      ctl("script", "append-ops", "--ops", OPS, "--relative", "true"), ctl("script", "append-script", "--json", JSON.stringify({ banner: { text: "Interceptor Parity appended" } })),
      ctl("script", "say", "--text", "Interceptor Parity"), ctl("script", "spawn", "--entity", JSON.stringify({ id: "parity-bot-2", emoji: "🦾", x: 0.3, y: 0.7 })),
      ctl("script", "despawn", "--id", "parity-bot-2"),
      // Face tracking drives the vision face detector per frame (Windows FaceDetector, Linux OpenCV through the provider).
      { ...ctl("script", "face-track-start", "--fps", "5"),
        check: (r) => r.json?.trackingObservation ? undefined : "face-track start returned no tracking observation" }, ctl("script", "face-track-stop"),
      ctl("script", "clear-entities"), ctl("script", "pause"), ctl("script", "resume"), ctl("script", "reset"),
      { id: "overlay.stop.script", sub: "stop", disruptive: true, args: ["overlay", "stop", OV("script")], check: contains(OV("script")) },
      // HTML overlay with evaluation.
      { id: "overlay.start.html", sub: "start", disruptive: true, check: contains(OV("html")),
        args: ["overlay", "start", "--id", OV("html"), "--html", "<p>Interceptor Parity</p>", "--anchor", "tr", "--width", "320", "--height", "120", "--interactive", "--visible", "--timeout-seconds", "60"] },
      { id: "overlay.eval.html", sub: "eval", disruptive: true, args: ["overlay", "eval", OV("html"), "document.body.innerText", "--timeout-seconds", "5"], check: contains("Interceptor Parity") },
      { id: "overlay.stop.html", sub: "stop", disruptive: true, args: ["overlay", "stop", OV("html")], check: contains(OV("html")) },
      // Remaining content sources and placement flags; each stops itself.
      { id: "overlay.start.script-file", sub: "start", disruptive: true, flags: ["--id", "--scene-script-file", "--anchor", "--width", "--height", "--display-id", "--single-space", "--no-fullscreen-aux", "--timeout-seconds"],
        args: async ctx => { const file = join(ctx.dir, "Interceptor Parity scene.json"); writeFileSync(file, SCENE)
          return ["overlay", "start", "--id", OV("script-file"), "--scene-script-file", file, "--anchor", "tl", "--width", "240", "--height", "160", "--display-id", await displayId(ctx), "--single-space", "--no-fullscreen-aux", "--timeout-seconds", "30"] },
        check: stopOverlay(OV("script-file")) },
      { id: "overlay.start.html-b64", sub: "start", disruptive: true, check: stopOverlay(OV("html-b64")),
        args: ["overlay", "start", "--id", OV("html-b64"), "--html-b64", HTML64, "--anchor", "bottom", "--width", "320", "--height", "100", "--level", "mainMenu", "--timeout-seconds", "30"] },
      { id: "overlay.start.url", sub: "start", disruptive: true, check: stopOverlay(OV("url")),
        args: ["overlay", "start", "--id", OV("url"), "--url", "https://example.com/", "--anchor", "left", "--width", "400", "--height", "300", "--level", "screenSaver", "--timeout-seconds", "30"] },
      { id: "overlay.start.bad-level", sub: "start", disruptive: true, args: ["overlay", "start", "--id", OV("bad"), "--particles", "roses", "--level", "bogus"], expect: { all: refuse("invalid_request") } },
      { id: "overlay.stop.all", sub: "stop", disruptive: true, args: ["overlay", "stop"] },
    ],
  },
]

/** Every inventory flag of these families is exercised above. */
export const automationExclusions: Exclusion[] = []
