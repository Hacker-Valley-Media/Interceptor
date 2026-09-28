import { describe, expect, test } from "bun:test"
import { iosKeysText } from "../cli/commands/ios"
import { timeoutMsFlag } from "../cli/commands/ios-web"
import { pickTimeoutForAction } from "../cli/transport"

describe("ios keys named keys", () => {
  test("Enter/Return/Tab (any case) map to the control character XCUITest typeText presses", () => {
    expect(iosKeysText("Enter")).toBe("\n")
    expect(iosKeysText("return")).toBe("\n")
    expect(iosKeysText("TAB")).toBe("\t")
  })
  test("everything else is typed literally, including the two characters backslash-n", () => {
    expect(iosKeysText("hello")).toBe("hello")
    expect(iosKeysText("\\n")).toBe("\\n")
    expect(iosKeysText("Enter the code")).toBe("Enter the code")
  })
})

describe("ios web eval/call --timeout", () => {
  test("is seconds on the command line and milliseconds on the wire", () => {
    expect(timeoutMsFlag(["ios", "web", "eval", "1+1", "--timeout", "5"])).toBe(5000)
    expect(timeoutMsFlag(["ios", "web", "eval", "1+1", "--timeout", "0.5"])).toBe(500)
    expect(timeoutMsFlag(["ios", "web", "eval", "1+1"])).toBeUndefined()
    expect(timeoutMsFlag(["ios", "web", "eval", "1+1", "--timeout", "0"])).toBeUndefined()
    expect(timeoutMsFlag(["ios", "web", "eval", "1+1", "--timeout", "abc"])).toBeUndefined()
  })
  test("the CLI deadline outlives a --timeout longer than the 30 s default", () => {
    expect(pickTimeoutForAction({ type: "ios_web_eval", expression: "1", timeout: 60_000 } as any)).toBe(65_000)
    expect(pickTimeoutForAction({ type: "ios_web_call", method: "DOM.getDocument", timeout: 2_000 } as any)).toBe(30_000)
    expect(pickTimeoutForAction({ type: "ios_web_eval", expression: "1" } as any)).toBe(30_000)
  })
})
