import { describe, expect, test } from "bun:test"

// Half-open ws detection: after MV3 service-worker hibernation the OS socket can
// wedge OPEN-but-dead — the extension's outbound keepalives keep flowing while
// ws.onmessage is silently severed, so ws-forwarded actions never get a reply
// and the CLI times out. The outbound keepalive timer is the one callback still
// firing, so it watches "keepalives sent since the last inbound frame" and, once
// it has ever seen a daemon ack, force-reconnects after WS_KEEPALIVE_MISS_LIMIT
// unacked keepalives. The gate on "ack ever seen" is what stops a daemon that
// never acks from tripping a permanent false-positive reconnect loop — that gate
// is the correctness-critical decision, exercised here as a pure function.
//
// The counter reset itself is robust by construction: onmessage clears
// wsKeepalivesSentSinceAck on EVERY inbound frame before parsing, so any daemon
// traffic (ack or otherwise) proves the read side is alive and resets staleness.

describe("shouldForceWsReconnect — half-open gate", () => {
  test("never fires until a daemon ack has ever been seen (false-positive guard)", async () => {
    const { shouldForceWsReconnect, WS_KEEPALIVE_MISS_LIMIT } =
      await import("../extension/src/background/transport")
    // A daemon that never acks: even far past the limit, ackSupported=false → no reconnect.
    expect(shouldForceWsReconnect(false, WS_KEEPALIVE_MISS_LIMIT + 5, WS_KEEPALIVE_MISS_LIMIT)).toBe(false)
    expect(shouldForceWsReconnect(false, 100, WS_KEEPALIVE_MISS_LIMIT)).toBe(false)
  })

  test("fires only once ack-supported AND the unacked count reaches the limit", async () => {
    const { shouldForceWsReconnect } = await import("../extension/src/background/transport")
    expect(shouldForceWsReconnect(true, 0, 2)).toBe(false)
    expect(shouldForceWsReconnect(true, 1, 2)).toBe(false) // below limit
    expect(shouldForceWsReconnect(true, 2, 2)).toBe(true)  // at limit
    expect(shouldForceWsReconnect(true, 3, 2)).toBe(true)  // past limit
  })

  test("miss limit is a small positive window (~40s at the 20s interval)", async () => {
    const { WS_KEEPALIVE_MISS_LIMIT } = await import("../extension/src/background/transport")
    expect(WS_KEEPALIVE_MISS_LIMIT).toBeGreaterThanOrEqual(1)
    expect(WS_KEEPALIVE_MISS_LIMIT).toBeLessThanOrEqual(5)
  })
})

// The stateful transitions are pure reducers, so the actual runtime behavior —
// not just the gate — is exercised here: send increments, any inbound frame
// resets, an ack arms detection, and a fresh socket re-learns ack support
// instead of inheriting it. These lock in the review's #4 (per-connection
// reset) and #6 (stateful coverage) folds.
describe("ws keepalive state reducers", () => {
  test("a fresh socket starts clean and UN-armed (per-connection ack support)", async () => {
    const { wsStateOnOpen } = await import("../extension/src/background/transport")
    expect(wsStateOnOpen()).toEqual({ keepalivesSinceAck: 0, ackSupported: false })
  })

  test("each keepalive sent increments the unacked count", async () => {
    const { wsStateOnOpen, wsStateOnKeepaliveSent } =
      await import("../extension/src/background/transport")
    let s = wsStateOnOpen()
    s = wsStateOnKeepaliveSent(s)
    s = wsStateOnKeepaliveSent(s)
    expect(s.keepalivesSinceAck).toBe(2)
  })

  test("any inbound frame resets the unacked count but leaves ack support intact", async () => {
    const { wsStateOnKeepaliveSent, wsStateOnAck, wsStateOnInboundFrame } =
      await import("../extension/src/background/transport")
    let s = { keepalivesSinceAck: 0, ackSupported: false }
    s = wsStateOnAck(s)
    s = wsStateOnKeepaliveSent(s)
    s = wsStateOnKeepaliveSent(s)
    expect(s).toEqual({ keepalivesSinceAck: 2, ackSupported: true })
    s = wsStateOnInboundFrame(s)
    expect(s).toEqual({ keepalivesSinceAck: 0, ackSupported: true })
  })

  test("an ack arms detection; the gate only fires once armed AND stale", async () => {
    const { wsStateOnOpen, wsStateOnKeepaliveSent, wsStateOnAck, shouldForceWsReconnect } =
      await import("../extension/src/background/transport")
    // Un-armed: stack up misses past the limit — the gate stays shut.
    let s = wsStateOnOpen()
    s = wsStateOnKeepaliveSent(s)
    s = wsStateOnKeepaliveSent(s)
    expect(shouldForceWsReconnect(s.ackSupported, s.keepalivesSinceAck, 2)).toBe(false)
    // Arm via ack, then stack misses again — now the gate fires at the limit.
    s = wsStateOnAck(s)
    s = wsStateOnKeepaliveSent(s)
    s = wsStateOnKeepaliveSent(s)
    expect(shouldForceWsReconnect(s.ackSupported, s.keepalivesSinceAck, 2)).toBe(true)
  })

  test("#4: reopening drops a prior connection's ack support (no latched flag)", async () => {
    const { wsStateOnAck, wsStateOnOpen } = await import("../extension/src/background/transport")
    // Prior connection saw an ack.
    const armed = wsStateOnAck({ keepalivesSinceAck: 3, ackSupported: false })
    expect(armed.ackSupported).toBe(true)
    // New socket: ack support is re-learned, not inherited — so a downgraded
    // daemon can't false-positive-reconnect a healthy-but-unacked connection.
    expect(wsStateOnOpen().ackSupported).toBe(false)
  })
})
