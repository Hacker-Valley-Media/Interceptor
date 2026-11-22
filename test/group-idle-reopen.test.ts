// A group closed by the idle sweep reopens its last page; one closed by the agent does not.
import { expect, test } from "bun:test"
import { pickReopen, REOPEN_WINDOW_MS } from "../extension/src/background/tab-lifecycle"

const now = Date.parse("2026-11-21T20:00:00Z")
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString()
const log = [
  { at: at(90), group: "game", urls: ["https://a.example/old"] },
  { at: at(30), group: "other", urls: ["https://b.example/"] },
  { at: at(12), group: "game", urls: ["chrome://newtab/", "https://a.example/play?level=3"] },
]

test("the newest sweep closure of that group, last real URL", () => {
  expect(pickReopen(log, "game", now)).toEqual({ url: "https://a.example/play?level=3", closedAt: now - 12 * 60_000, minutesAgo: 12 })
})

test("a floor set by group close (or an earlier reopen) blocks older closures", () => {
  expect(pickReopen(log, "game", now, now - 5 * 60_000)).toBeNull()
})

test("unknown group, stale entry, or no usable URL", () => {
  expect(pickReopen(log, "nope", now)).toBeNull()
  expect(pickReopen([{ at: new Date(now - REOPEN_WINDOW_MS - 1).toISOString(), group: "g", urls: ["https://x/"] }], "g", now)).toBeNull()
  expect(pickReopen([{ at: at(1), group: "g", urls: ["chrome://newtab/", "about:blank"] }], "g", now)).toBeNull()
})

import { compoundNotice } from "../cli/commands/compound"
test("compound verbs surface the reopen note and the active-tab fallback note", () => {
  const note = "group 'g' was closed by the idle timer 3 min ago and was reopened at https://x/ in background tab 9 (page state from before is gone)"
  expect(compoundNotice(`${note}; no DOM change`)).toBe(note)
  expect(compoundNotice("reading the active tab 5 (x.com), which is not one of this session's tabs; run 'interceptor open <url>'")).toBe("reading the active tab 5 (x.com), which is not one of this session's tabs")
  expect(compoundNotice("DOM has changed since last state read")).toBeUndefined()
})
