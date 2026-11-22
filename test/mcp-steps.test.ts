// MCP steps run in order, each gated like a single call.
import { expect, test } from "bun:test"
import { runSteps } from "../cli/mcp/server"
import { classify } from "../cli/mcp/tiers"

const session = { group: "mcp-test", allowEnv: undefined, fence: true }

test("steps run in order and the first error stops the list", async () => {
  const ran: string[] = []
  const fake = async (_s: string, verb: string) => {
    ran.push(verb)
    return verb === "click" ? { content: [{ type: "text" as const, text: "error: stale element" }], isError: true } : { content: [{ type: "text" as const, text: `${verb} ok` }] }
  }
  const r = await runSteps([{ verb: "open", args: ["https://example.com"] }, { verb: "click", args: ["e5"] }, { verb: "read" }], session, {}, fake as never)
  expect(ran).toEqual(["open", "click"])
  expect(r.isError).toBe(true)
  const text = r.content.map(c => (c as { text?: string }).text).join("\n")
  expect(text).toContain("[1/3] open https://example.com")
  expect(text).toContain("[2/3] click e5  (failed)")
  expect(text).toContain("stopped at step 2 of 3")
})

test("an exec-tier step is refused by the real gate and nothing after it runs", async () => {
  const r = await runSteps([{ verb: "eval", args: ["1+1"] }, { verb: "tabs" }], session, {})
  expect(r.isError).toBe(true)
  const text = r.content.map(c => (c as { text?: string }).text).join("\n")
  expect(text).toContain("[1/2] eval 1+1  (failed)")
  expect(text).not.toContain("[2/2]")
})

test("verify is read tier; run is exec tier so it cannot bypass step gating", () => {
  expect(classify("browser", "verify", ["--text", "x"]).tier).toBe("read")
  expect(classify("local", "run", ["-"]).tier).toBe("exec")
  expect(classify("browser", "run", ["-"]).tier).toBe("exec")
})
