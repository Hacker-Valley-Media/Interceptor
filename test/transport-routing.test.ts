import { describe, expect, test } from "bun:test"
import { chooseOutboundTransport, isControlMessage } from "../daemon/outbound-routing"

describe("daemon outbound transport routing", () => {
  test("classifies ping/pong as control messages", () => {
    expect(isControlMessage({ type: "ping" })).toBe(true)
    expect(isControlMessage({ type: "pong" })).toBe(true)
    expect(isControlMessage({ id: "1", action: { type: "tab_list" } })).toBe(false)
  })

  test("prefers websocket for normal action requests", () => {
    const chosen = chooseOutboundTransport(
      { id: "1", action: { type: "tab_list" } },
      { nativeRelayAvailable: true, extensionWsAvailable: true, stdinAlive: false, standalone: true }
    )
    expect(chosen).toBe("ws")
  })

  test("prefers relay for control traffic", () => {
    const chosen = chooseOutboundTransport(
      { type: "pong" },
      { nativeRelayAvailable: true, extensionWsAvailable: true, stdinAlive: false, standalone: true }
    )
    expect(chosen).toBe("relay")
  })

  test("falls back to native stdio when websocket is unavailable", () => {
    const chosen = chooseOutboundTransport(
      { id: "1", action: { type: "tab_list" } },
      { nativeRelayAvailable: false, extensionWsAvailable: false, stdinAlive: true, standalone: false }
    )
    expect(chosen).toBe("native")
  })
})
