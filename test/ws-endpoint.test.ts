// The extension learns its user's daemon port from the native host's pong
// (extension/src/background/ws-endpoint.ts). uid 501 keeps 19222, so the
// default is unchanged; a pong naming another port moves the WebSocket lane.
import { beforeEach, describe, expect, test } from "bun:test"

const stored: Record<string, unknown> = {}
;(globalThis as { chrome?: unknown }).chrome = {
  storage: {
    session: {
      set: async (v: Record<string, unknown>) => { Object.assign(stored, v) },
      get: async (k: string) => ({ [k]: stored[k] }),
    },
  },
}
const mod = await import("../extension/src/background/ws-endpoint")

describe("ws-endpoint", () => {
  beforeEach(() => { mod.adoptWsPort(mod.DEFAULT_WS_PORT) })

  test("dials the primary account's port on loopback by IP until told otherwise", () => {
    expect(mod.wsEndpoint()).toBe("ws://127.0.0.1:19222")
  })

  test("a pong with another user's port moves the lane and notifies listeners", () => {
    const seen: number[] = []
    mod.onWsPortChange((p) => seen.push(p))
    expect(mod.adoptWsPort(19228)).toBe(true)
    expect(mod.wsEndpoint()).toBe("ws://127.0.0.1:19228")
    expect(seen).toEqual([19228])
    expect(stored.wsPort).toBe(19228)
  })

  test("the same port, junk, or out-of-range values change nothing", () => {
    expect(mod.adoptWsPort(19222)).toBe(false)
    expect(mod.adoptWsPort("19228")).toBe(false)
    expect(mod.adoptWsPort(0)).toBe(false)
    expect(mod.adoptWsPort(70000)).toBe(false)
    expect(mod.adoptWsPort(undefined)).toBe(false)
    expect(mod.wsEndpoint()).toBe("ws://127.0.0.1:19222")
  })

  test("a service-worker restart restores the last reported port", async () => {
    stored.wsPort = 19230
    mod.restoreWsPort()
    await new Promise((r) => setTimeout(r, 0))
    expect(mod.currentWsPort()).toBe(19230)
  })
})
