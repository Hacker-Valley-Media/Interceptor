// --context wins, then $INTERCEPTOR_CONTEXT, then nothing (daemon auto-route).
import { describe, expect, test } from "bun:test"
import { resolveContextId } from "../cli/parse"

describe("resolveContextId", () => {
  test("explicit flag beats the env", () => {
    expect(resolveContextId(["--context", "brave-work", "open", "x"], { INTERCEPTOR_CONTEXT: "main" })).toBe("brave-work")
  })
  test("env supplies the lane default", () => {
    expect(resolveContextId(["open", "x"], { INTERCEPTOR_CONTEXT: "main" })).toBe("main")
  })
  test("empty or whitespace env means unset", () => {
    expect(resolveContextId(["open", "x"], { INTERCEPTOR_CONTEXT: "  " })).toBeUndefined()
    expect(resolveContextId(["open", "x"], {})).toBeUndefined()
  })
})
