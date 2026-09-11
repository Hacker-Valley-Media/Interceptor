// group list / group close across every connected extension context when no
// context is resolved (cli/commands/group.ts).
import { describe, expect, test } from "bun:test"
import { runGroupAcrossContexts } from "../cli/commands/group"
import type { DaemonResponse } from "../cli/transport"

type Reply = { success: boolean; data?: unknown; error?: string }
function fakeSend(byContext: Record<string, Reply>) {
  return async (_a: { type: string }, _t?: number, ctx?: string): Promise<DaemonResponse> =>
    ({ id: "x", result: byContext[ctx!] } as unknown as DaemonResponse)
}

describe("runGroupAcrossContexts", () => {
  test("group_list merges every context's groups tagged with the context", async () => {
    const r = await runGroupAcrossContexts({ type: "group_list" }, ["a", "b"], fakeSend({
      a: { success: true, data: [{ label: "x" }] },
      b: { success: true, data: [{ label: "y" }, { label: "z" }] },
    }))
    expect(r.success).toBe(true)
    expect(r.data).toEqual([{ context: "a", label: "x" }, { context: "b", label: "y" }, { context: "b", label: "z" }])
  })

  test("group_close in one context keeps the flat shape", async () => {
    const r = await runGroupAcrossContexts({ type: "group_close", label: "q" }, ["a", "b"], fakeSend({
      a: { success: false, error: "group 'q' not found" },
      b: { success: true, data: { label: "q", closedTabs: 2 } },
    }))
    expect(r.data).toEqual({ context: "b", label: "q", closedTabs: 2 })
  })

  test("group_close held by several contexts reports every close", async () => {
    const r = await runGroupAcrossContexts({ type: "group_close", label: "q" }, ["a", "b"], fakeSend({
      a: { success: true, data: { label: "q", closedTabs: 1 } },
      b: { success: true, data: { label: "q", closedTabs: 3 } },
    }))
    expect(r.success).toBe(true)
    expect((r.data as { closed: unknown[] }).closed).toEqual([
      { context: "a", label: "q", closedTabs: 1 },
      { context: "b", label: "q", closedTabs: 3 },
    ])
  })

  test("group_close not found anywhere is one honest error naming the contexts", async () => {
    const r = await runGroupAcrossContexts({ type: "group_close", label: "q" }, ["a", "b"], fakeSend({
      a: { success: false, error: "group 'q' not found" },
      b: { success: false, error: "group 'q' not found" },
    }))
    expect(r.success).toBe(false)
    expect(r.error).toContain("not found in any connected context (checked: a, b)")
  })
})
