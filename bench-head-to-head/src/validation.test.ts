import { describe, expect, test } from "bun:test"
import type { AgentFinalMessage, ConditionDef, UsageMetrics } from "./types"
import { validateCommandPolicy, validateFinalAnswerPolicy } from "./validation"

const baseCondition: ConditionDef = {
  id: "interceptor",
  name: "interceptor-browser",
  tool: "interceptor",
  agentsMd: "# test",
  daemon: "auto",
  commandPolicy: {
    requireAnyPrefix: ["interceptor"],
    requireEveryCommandPrefix: ["interceptor"],
    forbidAnyPrefix: ["open", "rg"],
    forbidSubstrings: ["fixtures/", "../"],
    forbidToolTypes: ["web_search"],
    maxCommands: 8,
  },
}

function usage(commands: string[], toolLog: string[] = []): UsageMetrics {
  return {
    input_tokens: 0,
    input_tokens_cached: 0,
    input_tokens_uncached: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    total_cost_usd: null,
    wall_clock_seconds: 0,
    turn_count: 1,
    command_count: commands.length,
    error_count: 0,
    command_log: commands,
    skill_read_log: [],
    tool_log: toolLog,
  }
}

describe("benchmark command policy", () => {
  test("rejects shell escapes that are not the benchmark browser tool", () => {
    const violation = validateCommandPolicy(baseCondition, usage([
      "/bin/zsh -lc \"interceptor open https://example.com --json\"",
      "/bin/zsh -lc \"open -a 'Google Chrome'\"",
    ]))
    expect(violation).toContain("Command did not match required prefixes")
  })

  test("rejects forbidden tool types like web_search", () => {
    const violation = validateCommandPolicy(baseCondition, usage([
      "/bin/zsh -lc \"interceptor open https://example.com --json\"",
    ], ["web_search"]))
    expect(violation).toBe("Forbidden tool type detected: web_search")
  })

  test("rejects command counts above the configured max", () => {
    const commands = Array.from({ length: 9 }, (_, i) => `/bin/zsh -lc "interceptor read e${i + 1}"`)
    const violation = validateCommandPolicy(baseCondition, usage(commands))
    expect(violation).toBe("Command count 9 exceeded max 8")
  })
})

describe("final answer leak policy", () => {
  test("rejects local fixture source references in answer evidence", () => {
    const final: AgentFinalMessage = {
      answer: "Cedar summary: nested panel benchmark target",
      evidence: ["fixtures/spa-lab/index.html contains the answer"],
    }
    expect(validateFinalAnswerPolicy(final)).toContain("Final answer references local benchmark source")
  })
})
