import { describe, expect, test } from "bun:test"
import { chooseOutboundTransport, isControlMessage, validateContextRouting } from "../daemon/outbound-routing"

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

  test("allows no-context routing through native relay when websocket context is absent", () => {
    expect(validateContextRouting({
      connectedContexts: [],
      nativeRelayAvailable: true,
    })).toEqual({ ok: true })
  })

  test("still fails no-context routing when no extension transport is attached", () => {
    expect(validateContextRouting({
      connectedContexts: [],
      nativeRelayAvailable: false,
    })).toEqual({ ok: false, code: "target_gone", error: "no extensions connected" })
  })

  test("requires explicit context when multiple websocket contexts are connected", () => {
    expect(validateContextRouting({
      connectedContexts: ["chrome-main", "brave-work"],
      nativeRelayAvailable: true,
    })).toEqual({
      ok: false,
      code: "target_ambiguous",
      error: "multiple extensions connected, use --context <id> (connected: chrome-main, brave-work); set a default once: interceptor contexts default <name>",
    })
  })

  test("rejects unknown explicit context even when native relay exists", () => {
    expect(validateContextRouting({
      contextId: "missing",
      connectedContexts: ["chrome-main"],
      nativeRelayAvailable: true,
    })).toEqual({
      ok: false,
      code: "target_gone",
      error: "context 'missing' not found (connected: chrome-main)",
    })
  })
})

describe("--json failure line", () => {
  test("always carries success:false and a code; a known code and data fields survive", async () => {
    const { jsonFailure } = await import("../cli/transport")
    expect(jsonFailure({ success: false, error: "cdp context 'x' not found" })).toEqual({ success: false, code: "provider_failed", error: "cdp context 'x' not found" })
    expect(jsonFailure({ success: false, code: "target_gone", error: "gone", data: { hint: "h" } })).toEqual({ success: false, code: "target_gone", error: "gone", hint: "h" })
    expect(jsonFailure({ success: false, error: "e", data: { code: "not_installed" } }).code).toBe("not_installed")
  })
})
