// A group closed by the idle sweep reopens its last page; one closed by the agent does not.
import { expect, test } from "bun:test"
import { pickReopen, REOPEN_WINDOW_MS, setReopenFloor, reopenFloor, lastReapedUrl } from "../extension/src/background/tab-lifecycle"

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
  const note = "group 'g' was closed by the idle timer 3 min ago and its last page was reopened in background tab 9 (page state from before is gone)"
  expect(compoundNotice(`${note}; no DOM change`)).toBe(note)
  expect(compoundNotice("reading the active tab 5 (x.com), which is not one of this session's tabs; run 'interceptor open <url>'")).toBe("reading the active tab 5 (x.com), which is not one of this session's tabs")
  expect(compoundNotice("DOM has changed since last state read")).toBeUndefined()
})

test("floors persist in storage.local, survive concurrent writes, and are pruned after the window", async () => {
  const store: Record<string, unknown> = {
    tabLifecycleSweepLog: [{ at: at(12), group: "game", urls: ["https://a.example/play"] }],
  }
  const saved = (globalThis as { chrome?: unknown }).chrome
  ;(globalThis as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: structuredClone(store[k]) }),
        set: async (o: Record<string, unknown>) => { Object.assign(store, structuredClone(o)) },
      },
      session: { get: async () => { throw new Error("floors must not use storage.session") }, set: async () => { throw new Error("floors must not use storage.session") } },
    },
  }
  try {
    await setReopenFloor("stale", now - REOPEN_WINDOW_MS - 1)
    await Promise.all([setReopenFloor("a", now), setReopenFloor("b", now)])
    expect(await reopenFloor("a")).toBe(now)
    expect(await reopenFloor("b")).toBe(now)
    expect(await reopenFloor("stale")).toBe(0)
    expect((await lastReapedUrl("game", now))?.url).toBe("https://a.example/play")
    await setReopenFloor("game", now)
    expect(await lastReapedUrl("game", now)).toBeNull()
    await setReopenFloor("__proto__", now)
    expect(await reopenFloor("__proto__")).toBe(now)
  } finally {
    ;(globalThis as { chrome?: unknown }).chrome = saved
  }
})
