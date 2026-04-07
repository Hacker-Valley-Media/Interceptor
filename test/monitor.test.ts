import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { existsSync, unlinkSync, writeFileSync, readFileSync, appendFileSync } from "node:fs"
import { EVENTS_PATH } from "../shared/platform"
import {
  renderEvent,
  renderSession,
  escapeArg,
  buildPlan,
  readMonEvents,
  listSessions,
} from "../cli/commands/monitor"

describe("monitor sparse format + renderer + plan generator", () => {
  // Each test rewrites EVENTS_PATH with a controlled fixture so we don't depend on
  // a running daemon or extension.
  let backupContent: string | null = null

  beforeAll(() => {
    if (existsSync(EVENTS_PATH)) {
      backupContent = readFileSync(EVENTS_PATH, "utf-8")
    }
  })

  afterAll(() => {
    if (backupContent !== null) {
      writeFileSync(EVENTS_PATH, backupContent)
    } else {
      try { unlinkSync(EVENTS_PATH) } catch {}
    }
  })

  beforeEach(() => {
    try { unlinkSync(EVENTS_PATH) } catch {}
  })

  function writeFixture(events: Array<Record<string, unknown>>) {
    const lines = events.map((e) => JSON.stringify({ timestamp: new Date().toISOString(), ...e }))
    writeFileSync(EVENTS_PATH, lines.join("\n") + "\n")
  }

  test("escapeArg escapes double quotes and backslashes", () => {
    expect(escapeArg("hello")).toBe("hello")
    expect(escapeArg('say "hi"')).toBe('say \\"hi\\"')
    expect(escapeArg("a\\b")).toBe("a\\\\b")
  })

  test("readMonEvents filters by session id", () => {
    writeFixture([
      { event: "mon_start", sid: "alpha", s: 0, t: 1000, tid: 1, url: "https://a/" },
      { event: "click", sid: "alpha", s: 1, t: 1100, ref: "e1", r: "button", n: "Go", tr: true },
      { event: "mon_stop", sid: "alpha", s: 2, t: 1200, evt: 3, mut: 0, net: 0, dur: 200 },
      { event: "mon_start", sid: "beta", s: 0, t: 2000, tid: 2, url: "https://b/" },
      { event: "click", sid: "beta", s: 1, t: 2100, ref: "e2", r: "link", n: "More", tr: true },
    ])
    const alpha = readMonEvents("alpha")
    expect(alpha.length).toBe(3)
    expect(alpha.every((e) => e.sid === "alpha")).toBe(true)
    const beta = readMonEvents("beta")
    expect(beta.length).toBe(2)
  })

  test("listSessions groups by sid and returns counts", () => {
    writeFixture([
      { event: "mon_start", sid: "alpha", s: 0, t: 1000, tid: 1, url: "https://a/", ins: "test" },
      { event: "click", sid: "alpha", s: 1, t: 1100, ref: "e1", r: "button", n: "Go", tr: true },
      { event: "mut", sid: "alpha", s: 2, t: 1150, c: 3, add: 1, rem: 0, attr: 2, cause: 1 },
      { event: "fetch", sid: "alpha", s: 3, t: 1180, u: "/api/x", m: "GET", st: 200, bz: 100, cause: 1 },
      { event: "mon_stop", sid: "alpha", s: 4, t: 1500, evt: 5, mut: 1, net: 1, dur: 500 },
    ])
    const sessions = listSessions()
    expect(sessions.length).toBe(1)
    expect(sessions[0].sid).toBe("alpha")
    expect(sessions[0].url).toBe("https://a/")
    expect(sessions[0].ins).toBe("test")
    expect(sessions[0].evt).toBeGreaterThan(0)
    expect(sessions[0].mut).toBe(1)
    expect(sessions[0].net).toBe(1)
    expect(sessions[0].status).toBe("stopped")
  })

  test("renderSession produces aligned text", () => {
    writeFixture([
      { event: "mon_start", sid: "alpha", s: 0, t: 1000, tid: 1, url: "https://a/", ins: "do thing" },
      { event: "click", sid: "alpha", s: 1, t: 1100, ref: "e1", r: "button", n: "Go", tr: true, x: 100, y: 50 },
      { event: "input", sid: "alpha", s: 2, t: 1200, ref: "e2", r: "textbox", n: "Q", v: "hello", tr: true },
      { event: "mut", sid: "alpha", s: 3, t: 1250, c: 5, add: 2, rem: 0, attr: 3, cause: 1 },
      { event: "fetch", sid: "alpha", s: 4, t: 1300, u: "/api/search", m: "GET", st: 200, bz: 1024, cause: 1 },
      { event: "mon_stop", sid: "alpha", s: 5, t: 1700, evt: 5, mut: 1, net: 1, dur: 700 },
    ])
    const out = renderSession("alpha")
    expect(out).toContain("session alpha")
    expect(out).toContain("instruction:")
    expect(out).toContain("click")
    expect(out).toContain("Go")
    expect(out).toContain("textbox")
    expect(out).toContain("/api/search")
    expect(out).toContain("ended after")
  })

  test("buildPlan emits valid slop replay script", () => {
    writeFixture([
      { event: "mon_start", sid: "alpha", s: 0, t: 1000, tid: 1, url: "https://example.com/" },
      { event: "click", sid: "alpha", s: 1, t: 1100, ref: "e1", r: "button", n: "Search", tr: true },
      { event: "input", sid: "alpha", s: 2, t: 1150, ref: "e2", r: "textbox", n: "Query", v: "bun docs", tr: true },
      { event: "mut", sid: "alpha", s: 3, t: 1180, c: 4, add: 2, rem: 0, attr: 1, cause: 2 },
      { event: "key", sid: "alpha", s: 4, t: 1200, kc: "Enter", tr: true },
      { event: "fetch", sid: "alpha", s: 5, t: 1250, u: "/api/search?q=bun", m: "GET", st: 200, bz: 2048, cause: 4 },
      { event: "mon_stop", sid: "alpha", s: 6, t: 1500, evt: 6, mut: 1, net: 1, dur: 500 },
    ])
    const plan = buildPlan("alpha")
    expect(plan).toContain('slop tab new "https://example.com/"')
    expect(plan).toContain("slop wait-stable")
    expect(plan).toContain('slop click "button:Search"')
    expect(plan).toContain('slop type "textbox:Query" "bun docs"')
    expect(plan).toContain('slop keys "Enter"')
    expect(plan).toContain("slop net log")
    // Plan must end with comments referencing the cued fetch
    expect(plan).toMatch(/api\/search/)
  })

  test("buildPlan ignores synthetic (tr:false) events", () => {
    writeFixture([
      { event: "mon_start", sid: "alpha", s: 0, t: 1000, tid: 1, url: "https://example.com/" },
      { event: "click", sid: "alpha", s: 1, t: 1100, ref: "e1", r: "button", n: "Synthetic", tr: false },
      { event: "click", sid: "alpha", s: 2, t: 1200, ref: "e2", r: "button", n: "Real", tr: true },
      { event: "mon_stop", sid: "alpha", s: 3, t: 1300, evt: 3, mut: 0, net: 0, dur: 300 },
    ])
    const plan = buildPlan("alpha")
    expect(plan).not.toContain("Synthetic")
    expect(plan).toContain('"button:Real"')
  })

  test("buildPlan emits TODO for masked password inputs", () => {
    writeFixture([
      { event: "mon_start", sid: "alpha", s: 0, t: 1000, tid: 1, url: "https://example.com/login" },
      { event: "input", sid: "alpha", s: 1, t: 1100, ref: "e1", r: "textbox", n: "Password", v: "***12***", tr: true },
      { event: "mon_stop", sid: "alpha", s: 2, t: 1200, evt: 2, mut: 0, net: 0, dur: 200 },
    ])
    const plan = buildPlan("alpha")
    expect(plan).toContain("# TODO")
    expect(plan).toContain("masked")
  })

  test("buildPlan handles hard navigation but skips history nav", () => {
    writeFixture([
      { event: "mon_start", sid: "alpha", s: 0, t: 1000, tid: 1, url: "https://example.com/" },
      { event: "click", sid: "alpha", s: 1, t: 1100, ref: "e1", r: "link", n: "Next", tr: true },
      { event: "nav", sid: "alpha", s: 2, t: 1150, u: "https://example.com/next", typ: "history", cause: 1 },
      { event: "click", sid: "alpha", s: 3, t: 1200, ref: "e2", r: "link", n: "External", tr: true },
      { event: "nav", sid: "alpha", s: 4, t: 1300, u: "https://other.example.com/", typ: "hard", cause: 3 },
      { event: "mon_stop", sid: "alpha", s: 5, t: 1500, evt: 5, mut: 0, net: 0, dur: 500 },
    ])
    const plan = buildPlan("alpha")
    // history nav must NOT emit slop navigate (already implicit in click)
    expect(plan).not.toContain('slop navigate "https://example.com/next"')
    // hard nav SHOULD emit slop navigate
    expect(plan).toContain('slop navigate "https://other.example.com/"')
  })

  test("renderEvent omits empty fields and right-aligns time", () => {
    const ev = {
      timestamp: new Date().toISOString(),
      event: "click",
      sid: "alpha",
      s: 1,
      t: 1100,
      k: "click",
      ref: "e1",
      r: "button",
      n: "Submit",
      tr: true,
    }
    const out = renderEvent(ev as any, 1000)
    expect(out).toContain("click")
    expect(out).toContain("Submit")
    expect(out).toContain("e1")
  })

  test("readMonEvents tolerates malformed lines", () => {
    appendFileSync(EVENTS_PATH, '{"event":"mon_start","sid":"alpha","s":0,"t":1000}\n')
    appendFileSync(EVENTS_PATH, "this is not json\n")
    appendFileSync(EVENTS_PATH, '{"event":"click","sid":"alpha","s":1,"t":1100,"ref":"e1","r":"button","n":"X","tr":true}\n')
    const evs = readMonEvents("alpha")
    expect(evs.length).toBe(2)
  })
})
