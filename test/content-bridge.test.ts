import { describe, expect, test } from "bun:test"
import { shouldRetryContentScript, INPUT_ACTIONS, isResponseLoss } from "../shared/content-script-retry"

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

describe("response-loss vs delivery-failure classification", () => {
  test("response loss: the message reached the page but the reply died", () => {
    expect(isResponseLoss("The page keeping the extension port is moved into back/forward cache, so the message channel is closed.")).toBe(true)
    expect(isResponseLoss("Attempting to use a disconnected port object")).toBe(true)
    expect(isResponseLoss("no response from content script")).toBe(true)
  })

  test("delivery failure is NOT response loss — re-sending is safe", () => {
    expect(isResponseLoss("Could not establish connection. Receiving end does not exist.")).toBe(false)
    expect(isResponseLoss(undefined)).toBe(false)
  })

  test("input actions are classified; reads are not", () => {
    for (const t of ["click", "click_selector", "input_text", "send_keys", "check", "file_upload"]) {
      expect(INPUT_ACTIONS.has(t)).toBe(true)
    }
    for (const t of ["query", "extract_text", "get_state", "rect", "exists"]) {
      expect(INPUT_ACTIONS.has(t)).toBe(false)
    }
  })
})
