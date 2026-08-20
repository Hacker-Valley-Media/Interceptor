/**
 * test/net-log-budget.test.ts
 *
 * Issue #161: an oversized net_log reply died silently in transit (64 MiB
 * caps at every hop) and surfaced as a generic timeout blaming the extension.
 * Two guards: the extension-side body budget keeps replies transportable, and
 * the CLI's timeout hint distinguishes "context connected" from "nothing
 * listening".
 */

import { describe, expect, test } from "bun:test"
import { budgetNetLogEntries } from "../extension/src/background/capabilities/passive-net"
import { timeoutMessageConnected, isGenericBrowserAction } from "../cli/transport"

function entry(url: string, bodyBytes: number): Record<string, unknown> {
  return {
    url,
    method: "GET",
    status: 200,
    body: "x".repeat(bodyBytes),
    type: "fetch",
    timestamp: 1,
    requestHeaders: {},
    responseHeaders: {},
  }
}

describe("budgetNetLogEntries (#161)", () => {
  test("under budget: entries pass through untouched", () => {
    const entries = [entry("a", 100), entry("b", 100)]
    const out = budgetNetLogEntries(entries, 10_000) as Array<Record<string, unknown>>
    expect(out[0].body).toHaveLength(100)
    expect(out[1].body).toHaveLength(100)
    expect(out[0].truncated).toBeUndefined()
  })

  test("over budget: OLDER bodies are blanked with truncated markers, newest kept", () => {
    const entries = [entry("oldest", 900), entry("middle", 900), entry("newest", 900)]
    const out = budgetNetLogEntries(entries, 1_500) as Array<Record<string, unknown>>
    expect(out[2].body).toHaveLength(900)          // newest survives
    expect(out[1].body).toBe("")                    // pushed over budget
    expect(out[1].truncated).toBe(true)
    expect(out[0].body).toBe("")
    expect(out[0].truncated).toBe(true)
  })

  test("shape and count are stable — meta fields survive the blanking", () => {
    const entries = [entry("a", 5_000), entry("b", 5_000)]
    const out = budgetNetLogEntries(entries, 1_000) as Array<Record<string, unknown>>
    expect(out).toHaveLength(2)
    expect(out[0].url).toBe("a")
    expect(out[0].status).toBe(200)
    expect(out[0].requestHeaders).toEqual({})
  })

  test("budget is measured in UTF-8 bytes, not UTF-16 code units", () => {
    // 600 CJK code units = 1,800 UTF-8 bytes; a code-unit measure would
    // wave this through a 1,000-byte budget.
    const cjk = { ...entry("cjk", 0), body: "漢".repeat(600) }
    const out = budgetNetLogEntries([cjk], 1_000) as Array<Record<string, unknown>>
    expect(out[0].body).toBe("")
    expect(out[0].truncated).toBe(true)
    const ascii = entry("ascii", 600)
    expect((budgetNetLogEntries([ascii], 1_000) as Array<Record<string, unknown>>)[0].body).toHaveLength(600)
  })

  test("bodyless entries never gain a truncated marker", () => {
    const bare = { url: "b", method: "GET", status: 204, body: "", type: "fetch", timestamp: 1 }
    const out = budgetNetLogEntries([entry("big", 5_000), bare], 1_000) as Array<Record<string, unknown>>
    expect(out[1].truncated).toBeUndefined()
  })
})

describe("timeout hint picks the honest branch (#161)", () => {
  test("net_log with a live context suggests --limit/--since/--filter, not a browser check", () => {
    const msg = timeoutMessageConnected("net_log", 15_000)
    expect(msg).toContain("A browser context is connected")
    expect(msg).toContain("--limit")
    expect(msg).toContain("--since")
    expect(msg).not.toContain("Ensure Chrome/Brave is open")
  })

  test("non-net actions get the generic connected wording", () => {
    const msg = timeoutMessageConnected("get_a11y_tree", 15_000)
    expect(msg).toContain("A browser context is connected")
    expect(msg).not.toContain("--limit")
  })

  test("only the browser lane probes — bridge/iOS/upload lanes keep their own hints", () => {
    expect(isGenericBrowserAction("net_log")).toBe(true)
    expect(isGenericBrowserAction("get_a11y_tree")).toBe(true)
    expect(isGenericBrowserAction("macos_tree")).toBe(false)
    expect(isGenericBrowserAction("ios_tree")).toBe(false)
    expect(isGenericBrowserAction("file_upload")).toBe(false)
    expect(isGenericBrowserAction("daemon_shutdown")).toBe(false)
  })
})
