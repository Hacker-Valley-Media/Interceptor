// Input delivery: click, type, keys, scroll, drag. Every case names its target (ref, pid, app,
// window, or exact title + frame), so nothing can fall through to the frontmost app. Background
// cases run first in each family; coordinates are screen points from `find` / `windows` frames.
import { type Case, type Ctx, type Exclusion, type Family, type Res, refuse } from "../types"
import { list, pid, state, waitState, windowId } from "./helpers"

type Frame = { x: number; y: number; width: number; height: number }
const bad: Case["expect"] = { all: refuse("invalid_request"), darwin: refuse() }

/** Snapshot the fixture state as the case starts (dynamic args run right before it). */
const mark = (ctx: Ctx) => { ctx.vars.before = state(ctx) }
const was = (ctx: Ctx, key: string) => ctx.vars.before?.[key]
const clicked = (n = 1) => (_r: Res, ctx: Ctx) =>
  waitState(ctx, s => Number(s.clicks) >= Number(was(ctx, "clicks") ?? 0) + n, `${n} more submit click(s)`)
const unclicked = async (_r: Res, ctx: Ctx) => {
  await ctx.sleep(500)
  return Number(state(ctx).clicks) === Number(was(ctx, "clicks") ?? 0) ? undefined : "a right click pressed the button"
}
const typed = (text: string) => (_r: Res, ctx: Ctx) => waitState(ctx, s => String(s.input ?? "").includes(text), `input containing ${JSON.stringify(text)}`)
const changed = (key: string) => (_r: Res, ctx: Ctx) => waitState(ctx, s => JSON.stringify(s[key]) !== JSON.stringify(was(ctx, key)), `a ${key} change`)
/** A new state.keys entry matching re. The Mac fixture's field editor swallows keyDown, so on darwin only
 *  typed text is visible: `mac` accepts an input change there, otherwise darwin is not checked. */
const keyed = (re: RegExp, mac = false) => (_r: Res, ctx: Ctx) => ctx.host === "darwin"
  ? (mac ? waitState(ctx, s => s.input !== was(ctx, "input"), "typed input") : undefined)
  : waitState(ctx, s => (s.keys ?? []).slice((was(ctx, "keys") ?? []).length).some((k: unknown) => re.test(String(k))), `a new key matching ${re}`)

const box = (f: any): Frame => ({ x: Number(f?.x ?? f?.left), y: Number(f?.y ?? f?.top), width: Number(f?.width), height: Number(f?.height) })
const at = (f: Frame, fx = 0.5, fy = 0.5) => `${Math.round(f.x + f.width * fx)},${Math.round(f.y + f.height * fy)}`
const bounds = (f: Frame) => [f.x, f.y, f.width, f.height].join(",")

/** Fixture elements from one `find` (Windows find resets refs, so a case's refs and frames come from one read). */
async function els(ctx: Ctx, ...names: string[]): Promise<{ ref: string; frame: Frame }[]> {
  const read = () => ctx.run(["find", names.length === 1 ? names[0] : "fixture", "--pid", pid(ctx)])
  let r = await read()
  // A fixture rebuilding its tree right after the previous case's click can briefly expose no match.
  for (let tries = 0; tries < 3 && names.some(name => !list(r).some(x => x.name === name && x.ref && x.frame)); tries++) { await ctx.sleep(300); r = await read() }
  return names.map(name => {
    const e = list(r).find(x => x.name === name)
    if (!e?.ref || !e.frame) throw new Error(`fixture element ${JSON.stringify(name)} not found: ${r.stdout.slice(0, 200)}`)
    return { ref: String(e.ref), frame: box(e.frame) }
  })
}
const spot = async (ctx: Ctx, name: string, fx = 0.5, fy = 0.5) => at((await els(ctx, name))[0].frame, fx, fy)

async function windowFrame(ctx: Ctx): Promise<Frame> {
  const r = await ctx.run(["windows", "--pid", pid(ctx)])
  const w = list(r).find(x => String(x.title ?? "").includes(ctx.fixture.title) && !String(x.title).includes("Observer"))
  if (!w?.frame) throw new Error(`fixture window frame not found: ${r.stdout.slice(0, 200)}`)
  return box(w.frame)
}

/** Windows foreground cases leave the fixture active with focus on what they touched. Put the fixture's
 *  keyboard focus back in "Fixture input" and window focus back on the observer (setup, not a case). */
async function resetFocus(ctx: Ctx) {
  if (ctx.host !== "win32") return
  for (const name of ["Fixture input", "Observer focus"]) {
    try { await ctx.run(["click", await ctx.ref(name), "--pid", pid(ctx)]) } catch {}
  }
}

export const input: Family[] = [
  {
    family: "click", setup: resetFocus,
    cases: [
      // A point outside the addressed window is a definite refusal on every host.
      { id: "click.outside-window", sub: "-", args: async ctx => ["click", "99999,99999", "--pid", pid(ctx), "--window", await windowId(ctx), "--background-only"], expect: { all: refuse("unsupported_target") } },
      { id: "click.disabled", sub: "-", args: async ctx => ["click", await ctx.ref("Disabled fixture button"), "--pid", pid(ctx)], expect: { all: refuse() } },
      { id: "click.ref-background", sub: "-", args: async ctx => { mark(ctx); return ["click", await ctx.ref("Submit fixture"), "--pid", pid(ctx), "--background-only"] },
        flags: ["--pid", "--background-only"], check: clicked() },
      { id: "click.ref-app-window", sub: "-", args: async ctx => { mark(ctx); const w = await windowId(ctx); return ["click", await ctx.ref("Submit fixture"), "--app", ctx.fixture.app, "--window", w] },
        flags: ["--app", "--window"], check: clicked() },
      { id: "click.coords-window-background", sub: "-", args: async ctx => { mark(ctx); return ["click", await spot(ctx, "Submit fixture"), "--pid", pid(ctx), "--window", await windowId(ctx), "--background-only"] },
        flags: ["--pid", "--window", "--background-only"], check: clicked() },
      { id: "click.coords-title-bounds", sub: "-", args: async ctx => { mark(ctx); return ["click", await spot(ctx, "Submit fixture"), "--window-title", ctx.fixture.title, "--window-bounds", bounds(await windowFrame(ctx)), "--background-only"] },
        flags: ["--window-title", "--window-bounds", "--background-only"], check: clicked() },
      { id: "click.right-background", sub: "-", args: async ctx => { mark(ctx); return ["click", await spot(ctx, "Submit fixture"), "--right", "--pid", pid(ctx), "--window", await windowId(ctx), "--background-only"] },
        flags: ["--right", "--pid", "--window", "--background-only"], check: unclicked },
      // Default delivery with only --pid: the point picks the window (the fixture process has two).
      { id: "click.coords-pid", sub: "-", args: async ctx => { mark(ctx); return ["click", await spot(ctx, "Submit fixture"), "--pid", pid(ctx)] }, flags: ["--pid"], check: clicked() },
      { id: "click.double", sub: "-", args: async ctx => { mark(ctx); return ["click", await spot(ctx, "Submit fixture"), "--double", "--pid", pid(ctx), "--window", await windowId(ctx)] },
        flags: ["--double", "--pid", "--window"], check: clicked(2) },
      { id: "click.bad-coords", sub: "-", args: ctx => ["click", "10,abc", "--pid", pid(ctx)], expect: bad },
      { id: "click.background-untargeted", sub: "-", args: async ctx => ["click", await spot(ctx, "Submit fixture"), "--background-only"],
        expect: { all: refuse("invalid_request", /explicit native target/) } },
    ],
  },
  {
    family: "type", setup: resetFocus,
    cases: [
      { id: "type.ref-app-window-background", sub: "-", args: async ctx => { const w = await windowId(ctx); return ["type", await ctx.ref("Fixture input"), "parity background", "--app", ctx.fixture.app, "--window", w, "--background-only"] },
        flags: ["--app", "--window", "--background-only"], check: typed("parity background") },
      { id: "type.ref-title-bounds", sub: "-", args: async ctx => { const f = await windowFrame(ctx); return ["type", await ctx.ref("Fixture input"), "parity framed", "--window-title", ctx.fixture.title, "--window-bounds", bounds(f), "--background-only"] },
        flags: ["--window-title", "--window-bounds", "--background-only"], check: typed("parity framed") },
      { id: "type.focused-window-background", sub: "-", args: async ctx => ["type", "parity quiet", "--pid", pid(ctx), "--window", await windowId(ctx), "--background-only"],
        flags: ["--pid", "--window", "--background-only"], check: typed("parity quiet") },
      { id: "type.ref-pid", sub: "-", args: async ctx => ["type", await ctx.ref("Fixture input"), "parity typed", "--pid", pid(ctx)], flags: ["--pid"], check: typed("parity typed") },
      { id: "type.focused-window", sub: "-", args: async ctx => ["type", "parity focused", "--pid", pid(ctx), "--window", await windowId(ctx)], flags: ["--pid", "--window"], check: typed("parity focused") },
      { id: "type.read-only", sub: "-", args: async ctx => ["type", await ctx.ref("Read-only fixture input"), "parity readonly", "--pid", pid(ctx)], expect: { all: refuse() } },
      { id: "type.read-only-nothing-landed", sub: "-", args: async ctx => ["value", await ctx.ref("Read-only fixture input"), "--pid", pid(ctx)],
        check: (r, ctx) => String(state(ctx).input ?? "").includes("parity readonly") ? `the text went to the focused input: ${state(ctx).input}` : r.stdout.includes("parity readonly") ? "the read-only field changed" : undefined },
      // Real vault delivery is covered by the security group; a missing name must refuse before anything is typed.
      { id: "type.secret-missing", sub: "-", args: async ctx => ["type", await ctx.ref("Fixture input"), "--secret", "interceptor-parity-missing", "--pid", pid(ctx)],
        flags: ["--secret", "--pid"], expect: { all: refuse() } },
      { id: "type.keycodes-us", sub: "-", args: async ctx => ["type", await ctx.ref("Fixture input"), "abc", "--keycodes-us", "--pid", pid(ctx)],
        flags: ["--keycodes-us", "--pid"], expect: { all: refuse("invalid_request") } },
    ],
  },
  {
    // Keyboard cases pass --window: the fixture process has two windows, so --pid alone is ambiguous.
    family: "keys", setup: resetFocus,
    cases: [
      { id: "keys.letter-background", sub: "-", args: async ctx => { mark(ctx); return ["keys", "x", "--pid", pid(ctx), "--window", await windowId(ctx), "--background-only"] },
        flags: ["--pid", "--window", "--background-only"], check: keyed(/(^|\+)x$/i, true) },
      { id: "keys.ctrl-a-background", sub: "-", args: async ctx => { mark(ctx); return ["keys", "Control+A", "--pid", pid(ctx), "--window", await windowId(ctx), "--background-only"] },
        flags: ["--pid", "--window", "--background-only"], expect: { win32: refuse("background_unavailable") }, check: keyed(/(^|\+)a$/i) },
      { id: "keys.enter-app-window", sub: "-", args: async ctx => { mark(ctx); return ["keys", "Enter", "--app", ctx.fixture.app, "--window", await windowId(ctx)] },
        flags: ["--app", "--window"], check: keyed(/Return|Enter/i) },
      { id: "keys.letter-window", sub: "-", args: async ctx => { mark(ctx); return ["keys", "y", "--pid", pid(ctx), "--window", await windowId(ctx)] },
        flags: ["--pid", "--window"], check: keyed(/(^|\+)y$/i, true) },
      // Last positive case: Shift+Tab moves the fixture's focus out of the input.
      { id: "keys.shift-tab", sub: "-", args: async ctx => { mark(ctx); return ["keys", "Shift+Tab", "--pid", pid(ctx), "--window", await windowId(ctx)] },
        flags: ["--pid", "--window"], check: keyed(/Shift|Tab/i) },
      { id: "keys.unknown-key", sub: "-", args: async ctx => ["keys", "NoSuchKey", "--pid", pid(ctx), "--window", await windowId(ctx)], expect: bad },
      { id: "keys.unknown-modifier", sub: "-", args: async ctx => ["keys", "Hyper+q", "--pid", pid(ctx), "--window", await windowId(ctx)], expect: bad },
    ],
  },
  {
    family: "scroll", setup: resetFocus,
    cases: [
      { id: "scroll.ref-background", sub: "-", args: async ctx => { mark(ctx); return ["scroll", "down", "300", "--ref", await ctx.ref("Scroll fixture input"), "--pid", pid(ctx), "--background-only"] },
        flags: ["--ref", "--pid", "--background-only"], check: changed("scroll") },
      { id: "scroll.times-interval-background", sub: "-", args: async ctx => { mark(ctx); const w = await windowId(ctx); return ["scroll", "up", "120", "--ref", await ctx.ref("Scroll fixture input"), "--pid", pid(ctx), "--window", w, "--times", "3", "--interval-ms", "100", "--background-only"] },
        flags: ["--ref", "--pid", "--window", "--times", "--interval-ms", "--background-only"], check: changed("scroll") },
      { id: "scroll.ref-app-window", sub: "-", args: async ctx => { mark(ctx); const w = await windowId(ctx); return ["scroll", "down", "300", "--ref", await ctx.ref("Scroll fixture input"), "--app", ctx.fixture.app, "--window", w] },
        flags: ["--ref", "--app", "--window"], check: changed("scroll") },
      // Direction and amount are optional positionals (down, 300).
      { id: "scroll.default-direction", sub: "-", args: async ctx => { mark(ctx); return ["scroll", "--ref", await ctx.ref("Scroll fixture input"), "--pid", pid(ctx)] },
        flags: ["--ref", "--pid"], check: changed("scroll") },
      { id: "scroll.bad-direction", sub: "-", args: async ctx => ["scroll", "sideways", "300", "--ref", await ctx.ref("Scroll fixture input"), "--pid", pid(ctx)], expect: bad },
      { id: "scroll.over-budget", sub: "-", args: async ctx => ["scroll", "down", "120", "--ref", await ctx.ref("Scroll fixture input"), "--pid", pid(ctx), "--times", "10", "--interval-ms", "500"], expect: bad },
    ],
  },
  {
    family: "drag", setup: resetFocus,
    cases: [
      { id: "drag.coords-window-background", sub: "-", args: async ctx => { mark(ctx); const [pad] = await els(ctx, "Drag fixture"); return ["drag", at(pad.frame, 0.2), at(pad.frame, 0.8), "--pid", pid(ctx), "--window", await windowId(ctx), "--background-only"] },
        flags: ["--pid", "--window", "--background-only"], check: changed("drag") },
      { id: "drag.outside-window", sub: "-", args: async ctx => { const [pad] = await els(ctx, "Drag fixture"); return ["drag", at(pad.frame, 0.5), "99999,99999", "--pid", pid(ctx), "--window", await windowId(ctx), "--background-only"] }, expect: { all: refuse("unsupported_target") } },
      { id: "drag.coords-app-window", sub: "-", args: async ctx => { mark(ctx); const [pad] = await els(ctx, "Drag fixture"); return ["drag", at(pad.frame, 0.3), at(pad.frame, 0.7), "--app", ctx.fixture.app, "--window", await windowId(ctx)] },
        flags: ["--app", "--window"], check: changed("drag") },
      { id: "drag.refs-pid", sub: "-", args: async ctx => { mark(ctx); const [pad, label] = await els(ctx, "Drag fixture", "Menu fixture status"); return ["drag", pad.ref, label.ref, "--pid", pid(ctx)] },
        flags: ["--pid"], check: changed("drag") },
      // Only --pid: the start point picks the window (the fixture process has two).
      { id: "drag.coords-pid", sub: "-", args: async ctx => { mark(ctx); const [pad] = await els(ctx, "Drag fixture"); return ["drag", at(pad.frame, 0.25), at(pad.frame, 0.75), "--pid", pid(ctx)] },
        flags: ["--pid"], check: changed("drag") },
      { id: "drag.mixed-endpoints", sub: "-", args: ctx => ["drag", "e1", "10,10", "--pid", pid(ctx)], expect: bad },
      { id: "drag.missing-end", sub: "-", args: ["drag", "10,10"], expect: { all: refuse("invalid_request") } },
    ],
  },
]

export const inputExclusions: Exclusion[] = []
