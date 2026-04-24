import { describe, expect, test } from "bun:test"
import { recoverPendingRequestsAfterNativeDisconnect } from "../extension/src/background/pending-request-recovery"

describe("pending request recovery", () => {
  test("queues native disconnect errors with original request ids", () => {
    const clearedTimers: number[] = []
    const delivered: unknown[] = []
    const logs: unknown[][] = []
    const pending = new Map([
      ["relay-request-1", { action: "extract_text", timer: 101 as unknown as ReturnType<typeof setTimeout> }],
      ["relay-request-2", { action: "tab_switch", timer: 202 as unknown as ReturnType<typeof setTimeout> }]
    ])

    const summary = recoverPendingRequestsAfterNativeDisconnect(
      pending,
      (msg) => {
        delivered.push(msg)
        return "queued"
      },
      (timer) => { clearedTimers.push(timer as unknown as number) },
      (...args) => { logs.push(args) }
    )

    expect(summary).toEqual({ recovered: 2, failed: 0 })
    expect(clearedTimers).toEqual([101, 202])
    expect(delivered).toEqual([
      { id: "relay-request-1", result: { success: false, error: "native port disconnected" } },
      { id: "relay-request-2", result: { success: false, error: "native port disconnected" } }
    ])
    expect(logs.map((entry) => String(entry[0]))).toEqual([
      "orphaned request relay-request-1 (extract_text) — native port disconnected",
      "orphaned request relay-request-2 (tab_switch) — native port disconnected"
    ])
  })

  test("logs final delivery failures for unrecoverable requests", () => {
    const logs: unknown[][] = []
    const pending = new Map([
      ["relay-request-3", { action: "tab_list", timer: 303 as unknown as ReturnType<typeof setTimeout> }]
    ])

    const summary = recoverPendingRequestsAfterNativeDisconnect(
      pending,
      () => "failed",
      () => {},
      (...args) => { logs.push(args) }
    )

    expect(summary).toEqual({ recovered: 0, failed: 1 })
    expect(logs.map((entry) => String(entry[0]))).toEqual([
      "orphaned request relay-request-3 (tab_list) — native port disconnected",
      "final delivery failure for orphaned request relay-request-3 (tab_list)"
    ])
  })
})
