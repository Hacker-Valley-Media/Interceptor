import type { InterceptorTelemetry, UsageMetrics } from "./types"

function emptyTelemetry(): InterceptorTelemetry {
  return {
    tree_count: 0,
    text_count: 0,
    state_count: 0,
    diff_count: 0,
    net_log_count: 0,
    net_headers_count: 0,
    scene_count: 0,
    os_input_count: 0,
    monitor_count: 0,
    replay_generated: false,
    replay_used: false,
  }
}

export function parseCodexJsonl(raw: string, wallClockSeconds: number, totalCostUsd: number | null = null): UsageMetrics {
  const telemetry = emptyTelemetry()
  let inputTokens = 0
  let cachedInput = 0
  let outputTokens = 0
  let turns = 0
  let commands = 0
  let errors = 0
  const commandLog: string[] = []

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.type === "turn.started") turns += 1
      if (entry.type === "turn.completed") {
        const usage = (entry.usage ?? {}) as Record<string, unknown>
        inputTokens = Number(usage.input_tokens ?? inputTokens)
        cachedInput = Number(usage.cached_input_tokens ?? cachedInput)
        outputTokens = Number(usage.output_tokens ?? outputTokens)
      }
      if (entry.type === "turn.failed" || entry.type === "error") errors += 1
      if (entry.type === "item.completed") {
        const item = (entry.item ?? {}) as Record<string, unknown>
        if (item.type === "command_execution" && typeof item.command === "string") {
          commands += 1
          const command = item.command as string
          commandLog.push(command)
          classifyInterceptor(command, telemetry)
        }
      }
    } catch {
      continue
    }
  }

  return {
    input_tokens: inputTokens,
    input_tokens_cached: cachedInput,
    input_tokens_uncached: Math.max(0, inputTokens - cachedInput),
    output_tokens: outputTokens,
    reasoning_tokens: 0,
    total_cost_usd: totalCostUsd,
    wall_clock_seconds: wallClockSeconds,
    turn_count: turns,
    command_count: commands,
    error_count: errors,
    command_log: commandLog,
    interceptor_telemetry: telemetry,
  }
}

function classifyInterceptor(command: string, telemetry: InterceptorTelemetry): void {
  if (!command.includes("interceptor")) return
  if (/\binterceptor tree\b/.test(command)) telemetry.tree_count += 1
  if (/\binterceptor text\b/.test(command)) telemetry.text_count += 1
  if (/\binterceptor state\b/.test(command)) telemetry.state_count += 1
  if (/\binterceptor diff\b/.test(command)) telemetry.diff_count += 1
  if (/\binterceptor net log\b/.test(command)) telemetry.net_log_count += 1
  if (/\binterceptor net headers\b/.test(command)) telemetry.net_headers_count += 1
  if (/\binterceptor scene\b/.test(command)) telemetry.scene_count += 1
  if (/--os\b/.test(command)) telemetry.os_input_count += 1
  if (/\binterceptor monitor\b/.test(command)) telemetry.monitor_count += 1
  if (/\binterceptor monitor export\b.*--plan/.test(command)) telemetry.replay_generated = true
  if (/\binterceptor batch\b/.test(command) || /replay/i.test(command)) telemetry.replay_used = true
}
