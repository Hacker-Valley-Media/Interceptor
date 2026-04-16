import { describe, expect, test } from "bun:test"
import { shouldRetryContentScript } from "../shared/content-script-retry"

describe("content bridge retry classification", () => {
  test("retries on missing or disconnected content-script errors", () => {
    expect(shouldRetryContentScript("Could not establish connection. Receiving end does not exist.")).toBe(true)
    expect(shouldRetryContentScript("Attempting to use a disconnected port object")).toBe(true)
    expect(shouldRetryContentScript("message channel is closed")).toBe(true)
    expect(shouldRetryContentScript("no response from content script")).toBe(true)
  })

  test("does not retry unrelated action errors", () => {
    expect(shouldRetryContentScript("stale element [3]")).toBe(false)
    expect(shouldRetryContentScript("tab is not in the interceptor group")).toBe(false)
  })
})
