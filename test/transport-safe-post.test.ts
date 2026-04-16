import { describe, expect, test } from "bun:test"
import { safePortPost } from "../extension/src/background/safe-port-post"

describe("safePortPost", () => {
  test("returns posted:true when port.postMessage succeeds", () => {
    const received: unknown[] = []
    const port = {
      postMessage(msg: unknown) { received.push(msg) },
      disconnect() {}
    }
    const res = safePortPost(port, { type: "event", event: "mon_stop" })
    expect(res.posted).toBe(true)
    expect(res.error).toBeUndefined()
    expect(received).toEqual([{ type: "event", event: "mon_stop" }])
  })

  test("returns posted:false and traps synchronous throw from disconnected port", () => {
    let disconnectCalled = false
    const port = {
      postMessage(_msg: unknown) {
        throw new Error("Attempting to use a disconnected port object")
      },
      disconnect() { disconnectCalled = true }
    }
    const res = safePortPost(port, { type: "event", event: "mon_stop" })
    expect(res.posted).toBe(false)
    expect(res.error).toContain("disconnected port")
    expect(disconnectCalled).toBe(true)
  })

  test("tolerates missing disconnect method", () => {
    const port = {
      postMessage(_msg: unknown) { throw new Error("boom") }
    }
    const res = safePortPost(port, { hello: "world" })
    expect(res.posted).toBe(false)
    expect(res.error).toBe("boom")
  })

  test("tolerates disconnect itself throwing", () => {
    const port = {
      postMessage(_msg: unknown) { throw new Error("boom") },
      disconnect() { throw new Error("disconnect failed") }
    }
    const res = safePortPost(port, { hello: "world" })
    expect(res.posted).toBe(false)
    expect(res.error).toBe("boom")
  })

  test("returns posted:false for null port", () => {
    const res = safePortPost(null, { hello: "world" })
    expect(res.posted).toBe(false)
    expect(res.error).toBe("no port")
  })

  test("returns posted:false for undefined port", () => {
    const res = safePortPost(undefined, { hello: "world" })
    expect(res.posted).toBe(false)
    expect(res.error).toBe("no port")
  })
})
