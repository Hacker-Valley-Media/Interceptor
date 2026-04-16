import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { existsSync, unlinkSync, writeFileSync, readFileSync, appendFileSync, rmSync } from "node:fs"
import { EVENTS_PATH } from "../shared/platform"
import {
  renderEvent,
  renderSession,
  escapeArg,
  buildPlan,
  readMonEvents,
  listSessions,
} from "../cli/commands/monitor"
import {
  appendSessionEvent,
  appendSessionNetArtifact,
  getSessionDir,
  writeSessionMeta,
} from "../shared/monitor-artifacts"

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
    try { rmSync(getSessionDir("artifact-alpha"), { recursive: true, force: true }) } catch {}
    try { rmSync(getSessionDir("artifact-bodies"), { recursive: true, force: true }) } catch {}
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
    const alpha = sessions.find((session) => session.sid === "alpha")
    expect(alpha).toBeTruthy()
    expect(alpha?.url).toBe("https://a/")
    expect(alpha?.ins).toBe("test")
    expect(alpha?.evt).toBeGreaterThan(0)
    expect(alpha?.mut).toBe(1)
    expect(alpha?.net).toBe(1)
    expect(alpha?.status).toBe("stopped")
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

  test("buildPlan emits valid interceptor replay script", () => {
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
    expect(plan).toContain('interceptor tab new "https://example.com/"')
    expect(plan).toContain("interceptor wait-stable")
    expect(plan).toContain('interceptor click "button:Search"')
    expect(plan).toContain('interceptor type "textbox:Query" "bun docs"')
    expect(plan).toContain('interceptor keys "Enter"')
    expect(plan).toContain("interceptor net log")
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
    // history nav must NOT emit interceptor navigate (already implicit in click)
    expect(plan).not.toContain('interceptor navigate "https://example.com/next"')
    // hard nav SHOULD emit interceptor navigate
    expect(plan).toContain('interceptor navigate "https://other.example.com/"')
  })

  test("readMonEvents prefers session-local artifacts when present", () => {
    writeFixture([
      { event: "mon_start", sid: "artifact-alpha", s: 0, t: 1000, tid: 1, url: "https://legacy/" },
      { event: "click", sid: "artifact-alpha", s: 1, t: 1100, ref: "e1", r: "button", n: "Legacy", tr: true },
    ])
    appendSessionEvent("artifact-alpha", {
      timestamp: new Date().toISOString(),
      event: "mon_start",
      sid: "artifact-alpha",
      s: 0,
      t: 2000,
      tid: 9,
      url: "https://artifact/"
    })
    appendSessionEvent("artifact-alpha", {
      timestamp: new Date().toISOString(),
      event: "click",
      sid: "artifact-alpha",
      s: 1,
      t: 2100,
      ref: "e9",
      r: "button",
      n: "Artifact",
      tr: true
    })
    const events = readMonEvents("artifact-alpha")
    expect(events.length).toBe(2)
    expect(events[0].tid).toBe(9)
    expect(events[1].n).toBe("Artifact")
  })

  test("listSessions includes persisted session metadata", () => {
    writeSessionMeta({
      artifactVersion: 2,
      sessionId: "artifact-alpha",
      startedAt: 3000,
      status: "stopped",
      paused: false,
      rootTabId: 77,
      instruction: "artifact run",
      url: "https://artifact.example/",
      counts: { evt: 12, mut: 2, net: 3, nav: 1 },
      stopReason: "user",
      attachments: []
    })
    appendSessionEvent("artifact-alpha", {
      timestamp: new Date().toISOString(),
      event: "mon_start",
      sid: "artifact-alpha",
      s: 0,
      t: 3000,
      tid: 77,
      url: "https://artifact.example/"
    })
    const sessions = listSessions()
    const persisted = sessions.find((session) => session.sid === "artifact-alpha")
    expect(persisted).toBeTruthy()
    expect(persisted?.url).toBe("https://artifact.example/")
    expect(persisted?.evt).toBe(12)
    expect(persisted?.status).toBe("stopped")
  })

  test("buildPlan with bodies uses persisted net artifacts", () => {
    appendSessionEvent("artifact-bodies", {
      timestamp: new Date().toISOString(),
      event: "mon_start",
      sid: "artifact-bodies",
      s: 0,
      t: 1000,
      tid: 1,
      url: "https://example.com/"
    })
    appendSessionEvent("artifact-bodies", {
      timestamp: new Date().toISOString(),
      event: "fetch",
      sid: "artifact-bodies",
      s: 1,
      t: 1200,
      cause: 7,
      u: "https://example.com/api/search",
      m: "POST",
      st: 200
    })
    appendSessionNetArtifact("artifact-bodies", {
      sid: "artifact-bodies",
      seq: 1,
      tid: 1,
      doc: "doc-1",
      cause: 7,
      kind: "fetch",
      url: "https://example.com/api/search",
      method: "POST",
      status: 200,
      contentType: "application/json",
      truncated: false,
      bodyBytes: 18,
      bodyPreview: "{\"ok\":true}"
    })
    const plan = buildPlan("artifact-bodies", false, true)
    expect(plan).toContain("persisted body FETCH POST https://example.com/api/search")
    expect(plan).toContain("{\"ok\":true}")
    expect(plan).not.toContain("interceptor net log")
  })

  test("renderSession with bodies includes persisted previews", () => {
    appendSessionEvent("artifact-bodies", {
      timestamp: new Date().toISOString(),
      event: "mon_start",
      sid: "artifact-bodies",
      s: 0,
      t: 1000,
      tid: 1,
      url: "https://example.com/"
    })
    appendSessionEvent("artifact-bodies", {
      timestamp: new Date().toISOString(),
      event: "fetch",
      sid: "artifact-bodies",
      s: 1,
      t: 1200,
      cause: 7,
      u: "https://example.com/api/search",
      m: "GET",
      st: 200
    })
    appendSessionNetArtifact("artifact-bodies", {
      sid: "artifact-bodies",
      seq: 1,
      tid: 1,
      doc: "doc-1",
      cause: 7,
      kind: "fetch",
      url: "https://example.com/api/search",
      method: "GET",
      status: 200,
      contentType: "application/json",
      truncated: false,
      bodyBytes: 18,
      bodyPreview: "{\"ok\":true}"
    })
    const out = renderSession("artifact-bodies", true)
    expect(out).toContain("persisted body: FETCH GET https://example.com/api/search")
    expect(out).toContain("{\"ok\":true}")
  })

  test("buildPlan emits tab switch for focus_switch attachments (PRD-34)", () => {
    writeFixture([
      { event: "mon_start",  sid: "focus-alpha", s: 0, t: 1000, tid: 1, url: "http://localhost:21113/" },
      { event: "mon_attach", sid: "focus-alpha", s: 1, t: 1001, tid: 1, doc: "docA", reason: "start", u: "http://localhost:21113/" },
      { event: "click",      sid: "focus-alpha", s: 2, t: 1100, ref: "e1", r: "button", n: "Open", tr: true },
      { event: "mon_detach", sid: "focus-alpha", s: 3, t: 2000, tid: 1, doc: "docA", reason: "focus_switch_handoff" },
      { event: "mon_attach", sid: "focus-alpha", s: 4, t: 2001, tid: 9, doc: "docB", reason: "focus_switch", u: "https://www.youtube.com/" },
      { event: "click",      sid: "focus-alpha", s: 5, t: 2100, ref: "e2", r: "button", n: "Play", tr: true },
      { event: "mon_stop",   sid: "focus-alpha", s: 6, t: 3000, evt: 7, mut: 0, net: 0, dur: 2000 },
    ])
    const plan = buildPlan("focus-alpha")
    expect(plan).toContain("# focus-switch to tab 9")
    expect(plan).toContain("interceptor tab switch 9")
    // The focus_switch_handoff detach has no replay step (it's a transition marker, not an action)
    // The new tab's clicks must still appear in the plan
    expect(plan).toContain('"button:Play"')
  })

  test("buildPlan does not emit tab switch for focus_switch without tid (defensive)", () => {
    writeFixture([
      { event: "mon_start",  sid: "focus-beta", s: 0, t: 1000, tid: 1, url: "https://example.com/" },
      { event: "mon_attach", sid: "focus-beta", s: 1, t: 2001, doc: "docX", reason: "focus_switch" },
      { event: "mon_stop",   sid: "focus-beta", s: 2, t: 3000, evt: 2, mut: 0, net: 0, dur: 2000 },
    ])
    const plan = buildPlan("focus-beta")
    expect(plan).not.toContain("interceptor tab switch")
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
