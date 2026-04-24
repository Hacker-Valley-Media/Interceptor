import { describe, expect, test } from "bun:test"
import { safeNativePortDisconnect, safeNativePortPing, shouldSkipNativeKeepalive } from "../extension/src/background/native-port-lifecycle"

describe("native port lifecycle helpers", () => {
  test("keepalive ping is posted through the safe port wrapper", () => {
    const received: unknown[] = []
    const res = safeNativePortPing({
      postMessage(msg: unknown) { received.push(msg) },
      disconnect() {}
    })

    expect(res.posted).toBe(true)
    expect(received).toEqual([{ type: "ping" }])
  })

  test("stale keepalive ping does not throw and disconnects the port", () => {
    let disconnectCalled = false
    const res = safeNativePortPing({
      postMessage() {
        throw new Error("Attempting to use a disconnected port object")
      },
      disconnect() { disconnectCalled = true }
    })

    expect(res.posted).toBe(false)
    expect(res.error).toContain("disconnected port")
    expect(disconnectCalled).toBe(true)
  })

  test("stale disconnect is trapped", () => {
    const res = safeNativePortDisconnect({
      disconnect() {
        throw new Error("Attempting to use a disconnected port object")
      }
    })

    expect(res.disconnected).toBe(false)
    expect(res.error).toContain("disconnected port")
  })

  test("recent native activity suppresses keepalive pings", () => {
    expect(shouldSkipNativeKeepalive(11_000, 2_000, 10_000)).toBe(true)
    expect(shouldSkipNativeKeepalive(12_001, 2_000, 10_000)).toBe(false)
  })
})
