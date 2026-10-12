// Screen families: screenshot, capture, display, stream. Every subcommand and flag from
// the CLI inventory appears below. Captures target the owned fixture window, the main
// display, or --mode display; whatever is started is stopped in later cases and teardown.
import { existsSync, statSync, renameSync, copyFileSync, rmSync } from "node:fs"
import { basename, dirname, extname, join } from "node:path"
import { type Ctx, type Exclusion, type Family, type Res, macOnly, refuse } from "../types"
import { list, pid, state, waitState, windowId } from "./helpers"

const slow = 70_000 // a Wayland portal monitor selection may take up to 50 s

/** Native id of the main display (first one when none is marked main). */
async function displayId(ctx: Ctx): Promise<string> {
  if (ctx.vars.displayId) return ctx.vars.displayId
  const r = await ctx.run(["display", "list"])
  const d = list(r).find(x => x.isMain) ?? list(r)[0]
  if (d?.id === undefined) throw new Error(`no display listed: ${r.stdout.slice(0, 200)}`)
  return (ctx.vars.displayId = String(d.id))
}

/** Screen center of a fixture element, for coordinate input. */
async function center(ctx: Ctx, name: string): Promise<[string, string]> {
  const r = await ctx.run(["find", name, "--pid", pid(ctx)])
  const f = list(r).find(x => x.name === name)?.frame
  if (!f) throw new Error(`no frame for ${name}: ${r.stdout.slice(0, 200)}`)
  return [String(Math.round(f.x + f.width / 2)), String(Math.round(f.y + f.height / 2))]
}

const brief = (r: Res) => JSON.stringify(r.json ?? r.stdout).slice(0, 200)
const image = (format: string, maxEdge?: number) => (r: Res) => {
  const d = r.json ?? {}
  if (d.format !== format) return `format ${d.format}, expected ${format}`
  if (!(d.width > 0 && d.height > 0 && d.bytes > 0)) return `no image dimensions: ${brief(r)}`
  if (!d.filePath && !String(d.dataUrl).startsWith(`data:image/${format};base64,`)) return `no ${format} data URL: ${brief(r)}`
  if (maxEdge && Math.max(d.width, d.height) > maxEdge) return `long edge ${Math.max(d.width, d.height)} exceeds ${maxEdge}`
}
const is = (value: unknown) => (r: Res) => r.json === value ? undefined : `expected ${JSON.stringify(value)}, got ${brief(r)}`

// Stream helpers: ids from start cases, a placeholder keeps later args valid when a start failed.
const sid = (ctx: Ctx) => ctx.vars.sid ?? "parity-missing"
const dsid = (ctx: Ctx) => ctx.vars.dsid ?? "parity-missing"
const afterFrames = async (ctx: Ctx, args: string[]) => { await ctx.sleep(1500); return args }
const streamFrame = (r: Res) => String(r.json?.dataUrl).startsWith("data:image/jpeg;base64,") && r.json.frameCount >= 1 ? undefined : `no stream frame: ${brief(r)}`
const listsSid = (key: "sid" | "dsid") => (r: Res, ctx: Ctx) => list(r).some(x => x.sid === ctx.vars[key]) ? undefined : `stream ${ctx.vars[key]} not listed: ${brief(r)}`

/** Media artifacts live in the provider's temp dir; remove the owned interceptor-stream-* directory. */
function dropArtifact(path?: unknown) {
  if (typeof path === "string" && basename(dirname(path)).startsWith("interceptor-stream-")) rmSync(dirname(path), { recursive: true, force: true })
}
const finalized = (audio: string) => (r: Res) => {
  const a = r.json?.artifact
  const failure = !a?.finalized || typeof a.filePath !== "string" || !existsSync(a.filePath) || !a.bytes || statSync(a.filePath).size !== a.bytes
    ? `media artifact not finalized on disk: ${brief(r)}` : a.audio !== audio ? `artifact audio ${a.audio}, expected ${audio}` : undefined
  dropArtifact(a?.filePath)
  return failure
}

export const screen: Family[] = [
  {
    family: "screenshot",
    cases: [
      { id: "screenshot.app", sub: "-", args: ctx => ["screenshot", "--app", ctx.fixture.app], flags: ["--app"], check: image("jpeg") },
      { id: "screenshot.window-png", sub: "-", args: async ctx => ["screenshot", "--window", await windowId(ctx), "--format", "png"], flags: ["--window", "--format"], check: image("png") },
      { id: "screenshot.display-webp-edge", sub: "-", args: async ctx => ["screenshot", "--display", await displayId(ctx), "--format", "webp", "--target-max-long-edge", "640"], flags: ["--display", "--format", "--target-max-long-edge"], check: image("webp", 640),
        expect: { darwin: refuse("unsupported_operation", /no WebP encoder/) } },
      { id: "screenshot.mode-display-quality", sub: "-", args: ["screenshot", "--mode", "display", "--quality", "40"], check: image("jpeg"), timeoutMs: slow },
      { id: "screenshot.full-screen-full-res", sub: "-", args: ["screenshot", "--full-screen", "--target-max-long-edge", "0", "--quality", "50"], timeoutMs: slow,
        check: r => image("jpeg")(r) ?? (r.json.width === r.json.originalWidth ? undefined : `resized to ${r.json.width} from ${r.json.originalWidth}`) },
      { id: "screenshot.display-mode-display", sub: "-", args: async ctx => ["screenshot", "--display-mode", "--display", await displayId(ctx)], flags: ["--display-mode", "--display"], check: image("jpeg"), timeoutMs: slow },
      // No output-path flag: --save writes into the CLI's working directory, so the file is moved under ctx.dir after the check.
      { id: "screenshot.save", sub: "-", args: async ctx => ["screenshot", "--window", await windowId(ctx), "--save"], flags: ["--save", "--window"],
        check: (r, ctx) => {
          const p = r.json?.filePath
          if (typeof p !== "string" || !existsSync(p)) return `saved file missing: ${brief(r)}`
          const size = statSync(p).size, dest = join(ctx.dir, `Interceptor Parity screenshot${extname(p)}`)
          try { renameSync(p, dest) } catch { copyFileSync(p, dest); rmSync(p, { force: true }) }
          if (size < 100 || size !== r.json.bytes) return `saved file has ${size} bytes, result says ${r.json.bytes}`
        } },
      { id: "screenshot.element", sub: "-", args: ctx => ["screenshot", "--element", "e1", "--app", ctx.fixture.app], flags: ["--element"], expect: { all: refuse("unsupported_operation") } },
      { id: "screenshot.bad-quality", sub: "-", args: ["screenshot", "--mode", "display", "--quality", "101"], expect: { all: refuse("invalid_request") } },
      { id: "screenshot.bad-format", sub: "-", args: ["screenshot", "--mode", "display", "--format", "gif"], expect: { all: refuse("invalid_request") } },
    ],
  },
  {
    family: "capture",
    cases: [
      { id: "capture.status-idle", sub: "status", args: ["capture", "status"], check: r => typeof r.json?.active === "boolean" ? undefined : `no active flag: ${brief(r)}` },
      { id: "capture.frame-not-started", sub: "frame", args: ["capture", "frame", "--timeout-ms", "500"], expect: { all: refuse("invalid_request") } },
      { id: "capture.start-app", sub: "start", args: ctx => ["capture", "start", "--app", ctx.fixture.app, "--timeout-ms", "5000"], flags: ["--app", "--timeout-ms"], check: is("continuous capture started") },
      { id: "capture.start-again", sub: "start", args: ctx => ["capture", "start", "--app", ctx.fixture.app], expect: { all: refuse() } },
      { id: "capture.frame", sub: "frame", args: ctx => afterFrames(ctx, ["capture", "frame", "--timeout-ms", "5000"]), flags: ["--timeout-ms"], check: image("jpeg") },
      { id: "capture.frame-app", sub: "frame", args: ctx => ["capture", "frame", "--app", ctx.fixture.app], flags: ["--app"], check: image("jpeg") },
      { id: "capture.status-active", sub: "status", args: ctx => ["capture", "status", "--app", ctx.fixture.app, "--timeout-ms", "1000"], flags: ["--app", "--timeout-ms"],
        check: r => r.json?.active === true && r.json?.hasFrame === true ? undefined : `expected an active capture with a frame: ${brief(r)}` },
      { id: "capture.bad-timeout", sub: "frame", args: ["capture", "frame", "--timeout-ms", "10001"], expect: { all: refuse("invalid_request") } },
      { id: "capture.stop", sub: "stop", args: ctx => ["capture", "stop", "--app", ctx.fixture.app, "--timeout-ms", "1000"], flags: ["--app", "--timeout-ms"], check: is("capture stopped") },
      { id: "capture.status-stopped", sub: "status", args: ["capture", "status"], check: r => r.json?.active === false ? undefined : `capture still active: ${brief(r)}` },
    ],
    async teardown(ctx) { await ctx.run(["capture", "stop"]).catch(() => {}) },
  },
  {
    family: "display",
    cases: [
      { id: "display.list", sub: "list", args: ["display", "list"],
        check: r => list(r).length && list(r).every(d => d.id > 0 && d.width > 0 && d.height > 0) ? undefined : `bad display list: ${brief(r)}` },
      { id: "display.default-list", sub: "list", args: ["display"], check: r => list(r).length ? undefined : "no displays listed" },
      { id: "display.list-extra", sub: "list", args: ["display", "list", "--hidpi"], expect: { all: refuse() } },
      { id: "display.info", sub: "info", args: async ctx => ["display", "info", await displayId(ctx)],
        check: (r, ctx) => String(r.json?.id) === ctx.vars.displayId && r.json.pixelWidth > 0 ? undefined : `bad display info: ${brief(r)}` },
      { id: "display.info-flag", sub: "info", args: async ctx => ["display", "info", "--id", await displayId(ctx)], flags: ["--id"],
        check: (r, ctx) => String(r.json?.id) === ctx.vars.displayId ? undefined : `bad display info: ${brief(r)}` },
      { id: "display.info-missing", sub: "info", args: ["display", "info", "987654321"], expect: { all: refuse() } },
      // Virtual displays are out of scope on Windows/Linux. On the Mac they change the person's display topology.
      { id: "display.create", sub: "create", args: ["display", "create", "1280x720", "--hidpi", "--hz", "30"], expect: macOnly(), disruptive: true,
        check: (r, ctx) => { if (ctx.host !== "darwin") return; ctx.vars.virtualId = r.json?.id; return r.json?.width === 1280 && r.json?.hiDPI === true ? undefined : `bad virtual display: ${brief(r)}` } },
      { id: "display.remove", sub: "remove", args: ctx => ["display", "remove", ctx.vars.virtualId ?? "parityvd1"], expect: macOnly(), disruptive: true },
      { id: "display.remove-unknown", sub: "remove", args: ["display", "remove", "--id", "parityvd0"], expect: { all: refuse("unsupported_operation"), darwin: refuse("target_gone", /no virtual display with id/) } },
      // The parser never sets windowId/displayId, which DisplayDomain.moveWindow requires, so the Mac refuses too (CLI defect).
      { id: "display.move-window", sub: "move-window", args: async ctx => ["display", "move-window", "--id", await displayId(ctx)], flags: ["--id"],
        expect: { all: refuse("unsupported_operation"), darwin: refuse(undefined, /window ?id and (a )?display ?id/i) } },
    ],
    async teardown(ctx) { if (ctx.vars.virtualId) await ctx.run(["display", "remove", ctx.vars.virtualId]).catch(() => {}) },
  },
  {
    family: "stream",
    cases: [
      { id: "stream.status-idle", sub: "status", args: ["stream", "status"], check: r => Array.isArray(r.json) ? undefined : `not a session list: ${brief(r)}` },
      { id: "stream.list-idle", sub: "list", args: ["stream", "list"], check: r => Array.isArray(r.json) ? undefined : `not a session list: ${brief(r)}` },
      // The fixture owns two windows, so an app selector is ambiguous on every host.
      { id: "stream.start-app-ambiguous", sub: "start", args: ctx => ["stream", "start", "--app", ctx.fixture.app], flags: ["--app"], expect: { all: refuse() } },
      { id: "stream.start-virtual", sub: "start", args: ["stream", "start", "--virtual", "parity-virtual"], expect: { all: refuse("unsupported_operation"), darwin: refuse() } },
      { id: "stream.start-window", sub: "start", args: async ctx => ["stream", "start", "--window", await windowId(ctx), "--format", "jpeg"], flags: ["--window", "--format"],
        check: (r, ctx) => { ctx.vars.sid = r.json?.sid; return r.json?.status === "streaming" && r.json.sid ? undefined : `no stream admission: ${brief(r)}` } },
      { id: "stream.start-display", sub: "start", args: async ctx => ["stream", "start", "--display", await displayId(ctx), "--format", "jpg"], flags: ["--display", "--format"], timeoutMs: slow,
        check: (r, ctx) => { ctx.vars.dsid = r.json?.sid; return r.json?.status === "streaming" && r.json.sid ? undefined : `no stream admission: ${brief(r)}` } },
      { id: "stream.frame-window", sub: "frame", args: ctx => afterFrames(ctx, ["stream", "frame", sid(ctx)]), check: streamFrame },
      { id: "stream.frame-display", sub: "frame", args: ctx => ["stream", "frame", "--sid", dsid(ctx)], flags: ["--sid"], check: streamFrame },
      { id: "stream.fps", sub: "fps", args: ctx => ["stream", "fps", sid(ctx)], check: r => r.json?.fps >= 0 ? undefined : `no fps: ${brief(r)}` },
      { id: "stream.fps-sid", sub: "fps", args: ctx => ["stream", "fps", "--sid", dsid(ctx)], flags: ["--sid"], check: r => r.json?.fps >= 0 ? undefined : `no fps: ${brief(r)}` },
      { id: "stream.resolution", sub: "resolution", args: ctx => ["stream", "resolution", sid(ctx)], check: r => r.json?.width > 0 && r.json?.height > 0 ? undefined : `no resolution: ${brief(r)}` },
      { id: "stream.resolution-sid", sub: "resolution", args: ctx => ["stream", "resolution", "--sid", dsid(ctx)], flags: ["--sid"], check: r => r.json?.width > 0 && r.json?.height > 0 ? undefined : `no resolution: ${brief(r)}` },
      { id: "stream.status-active", sub: "status", args: ["stream", "status"], check: listsSid("sid") },
      { id: "stream.list-active", sub: "list", args: ["stream", "list"], check: listsSid("dsid") },
      { id: "stream.record-status", sub: "record", args: ctx => ["stream", "record", "status", sid(ctx)], check: r => r.json?.recording === false ? undefined : `unexpected recording state: ${brief(r)}` },
      { id: "stream.record-start", sub: "record", args: ctx => ["stream", "record", "start", sid(ctx)], check: r => r.json?.recording === true ? undefined : `recording not started: ${brief(r)}` },
      { id: "stream.record-stop", sub: "record", args: ctx => ["stream", "record", "stop", "--sid", sid(ctx)], flags: ["--sid"], check: r => r.json?.recording === false ? undefined : `recording not stopped: ${brief(r)}` },
      { id: "stream.record-media-start", sub: "record", args: ctx => ["stream", "record", "start", "--sid", sid(ctx), "--media", "--record-audio", "none"], flags: ["--sid", "--media", "--record-audio"],
        check: (r, ctx) => { ctx.vars.media = r.json?.artifact?.filePath; return r.json?.recording === true && r.json.artifact ? undefined : `media recording not admitted: ${brief(r)}` } },
      // Input to the window stream also gives the media recording changing frames.
      { id: "stream.inject-click", sub: "inject", args: async ctx => { ctx.vars.clicks = state(ctx).clicks ?? 0; const [x, y] = await center(ctx, "Submit fixture"); return ["stream", "inject", "click", sid(ctx), "--x", x, "--y", y] }, flags: ["--x", "--y"],
        check: (_r, ctx) => waitState(ctx, s => s.clicks > ctx.vars.clicks, "a submit click") },
      { id: "stream.inject-type", sub: "inject", args: async ctx => ["stream", "inject", "--sid", sid(ctx), "--input-type", "type", "--text", "parity stream", "--ref", await ctx.ref("Fixture input")], flags: ["--sid", "--input-type", "--text", "--ref"],
        check: (_r, ctx) => waitState(ctx, s => String(s.input).includes("parity stream"), "input typed through the stream") },
      { id: "stream.inject-keys", sub: "inject", args: ctx => { ctx.vars.keys = (state(ctx).keys ?? []).length; return ["stream", "inject", "keys", sid(ctx), "--combo", ctx.host === "win32" ? "x" : "ctrl+a"] }, flags: ["--combo"],
        check: (_r, ctx) => waitState(ctx, s => (s.keys ?? []).length > ctx.vars.keys, "a key through the stream") },
      { id: "stream.inject-scroll", sub: "inject", args: ctx => ["stream", "inject", "scroll", sid(ctx), "--direction", "down", "--amount", "3"], flags: ["--direction", "--amount"] },
      { id: "stream.inject-bad-amount", sub: "inject", args: ctx => ["stream", "inject", "scroll", sid(ctx), "--direction", "down", "--amount", "0"], expect: { all: refuse() } },
      { id: "stream.inject-display-refused", sub: "inject", args: ctx => ["stream", "inject", "click", dsid(ctx), "--x", "5", "--y", "5"], expect: { all: refuse() } },
      { id: "stream.record-media-stop", sub: "record", args: ctx => afterFrames(ctx, ["stream", "record", "stop", sid(ctx)]), check: finalized("none") },
      // System audio recording is out of scope on Windows/Linux. The Mac needs an explicit display stream.
      { id: "stream.record-system-audio", sub: "record", args: ctx => ["stream", "record", "start", dsid(ctx), "--media", "--record-audio", "system"], flags: ["--media", "--record-audio"], expect: macOnly(),
        check: (r, ctx) => { if (ctx.host !== "darwin") return; ctx.vars.audioMedia = r.json?.artifact?.filePath; return r.json?.artifact?.audio === "system" ? undefined : `system audio not admitted: ${brief(r)}` } },
      { id: "stream.record-system-audio-stop", sub: "record", args: ctx => afterFrames(ctx, ["stream", "record", "stop", "--sid", dsid(ctx)]), flags: ["--sid"],
        check: (r, ctx) => ctx.host === "darwin" ? finalized("system")(r) : r.json?.recording === false ? undefined : `recording state: ${brief(r)}` },
      { id: "stream.stop", sub: "stop", args: ctx => ["stream", "stop", sid(ctx)], check: is("ok") },
      { id: "stream.stop-sid", sub: "stop", args: ctx => ["stream", "stop", "--sid", dsid(ctx)], flags: ["--sid"], check: is("ok") },
    ],
    // Stop only this run's sessions: a bare `stream stop` would also end other agents' streams on the Mac.
    async teardown(ctx) {
      for (const s of [ctx.vars.sid, ctx.vars.dsid]) if (s) await ctx.run(["stream", "stop", s]).catch(() => {})
      dropArtifact(ctx.vars.media); dropArtifact(ctx.vars.audioMedia)
    },
  },
]

// Every inventory row of these families is exercised (Out rows as refusals), so nothing is excluded.
export const screenExclusions: Exclusion[] = []
