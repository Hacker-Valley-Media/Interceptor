import { describe, expect, test } from "bun:test"
import { pickTimeoutForAction, INTERCEPTOR_TIMEOUT_MS } from "../cli/transport"

// pickTimeoutForAction chooses the CLI-side transport timeout per action.
// EVERY screenshot gets a long ceiling aligned with the daemon's request
// timeout: the --pixel path has no single SW cap, and the default DOM-render
// path can auto-fall-back to the pixel path (DOM ≤30s THEN a full pixel
// capture), so a 35s ceiling would race the combined fallback path. The SW
// bounds its own stages; the CLI only needs to out-wait the worst case.

describe("pickTimeoutForAction", () => {
  const isLongCeiling = (t: number) => t > 35_000 && t < 180_000

  test("default screenshot gets the long ceiling (can auto-fall-back to pixel)", () => {
    expect(isLongCeiling(pickTimeoutForAction({ type: "screenshot" }))).toBe(true)
    expect(isLongCeiling(pickTimeoutForAction({ type: "screenshot", pixel: false }))).toBe(true)
  })

  test("--pixel and --pixel --full get the long ceiling", () => {
    expect(isLongCeiling(pickTimeoutForAction({ type: "screenshot", pixel: true }))).toBe(true)
    expect(isLongCeiling(pickTimeoutForAction({ type: "screenshot", pixel: true, full: true }))).toBe(true)
  })

  test("the screenshot ceiling stays under the daemon's 180s request timeout", () => {
    // Otherwise the CLI would outlive the daemon's own response and mask it.
    expect(pickTimeoutForAction({ type: "screenshot" })).toBeLessThan(180_000)
  })

  test("macos overrides unchanged", () => {
    expect(pickTimeoutForAction({ type: "macos_listen" })).toBe(60_000)
    expect(pickTimeoutForAction({ type: "macos_vad" })).toBe(60_000)
  })

  test("unlisted actions fall back to the default timeout", () => {
    expect(pickTimeoutForAction({ type: "tab_list" })).toBe(INTERCEPTOR_TIMEOUT_MS)
  })
})
