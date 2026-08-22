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

// Codex discloses skills progressively: the agent reads SKILL.md (and sibling
// reference docs) with cat/sed/head. Those are tool-manual lookups, not browser
// commands, so they are logged separately and exempt from the command cap and
// prefix policy. Their tokens still land in input_tokens.
const VIEWERS = /^(?:cat|sed|head|tail|less|more|grep|rg|wc|ls|find)\b/

// Split a shell string on command separators (newline, ;, &&, ||, |) while
// respecting single/double quotes — a pipe inside `rg "a|b"` is part of the
// pattern, not a pipeline stage. Quote-blind splitting shattered such
// commands and mis-invalidated legitimate skill reads (P3/P7, 2026-08-21).
function splitShellSegments(inner: string): string[] {
  const segments: string[] = []
  let current = ""
  let quote: string | null = null
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue }
    if (ch === "\n" || ch === ";" || ch === "|") {
      if (ch === "|" && inner[i + 1] === "|") i++
      segments.push(current)
      current = ""
      continue
    }
    if (ch === "&" && inner[i + 1] === "&") { i++; segments.push(current); current = ""; continue }
    current += ch
  }
  segments.push(current)
  return segments.map((part) => part.trim()).filter(Boolean)
}

export function isSkillRead(command: string): boolean {
  const inner = command
    .replace(/^(?:\/bin\/)?(?:zsh|bash|sh) -lc\s+/, "")
    .replace(/^(["'])([\s\S]*)\1$/, "$2")
  const segments = splitShellSegments(inner)
  const isNoise = (part: string) => /^(?:pwd|cd\b|echo\b|true$)/.test(part)
  // Codex logs re-rendered zsh quoting ('("'^|/)SKILL'"...) that no flat
  // tokenizer can track; fragments it sheds start with punctuation, while any
  // real piped/chained command starts with a word — so punctuation-leading
  // fragments are continuations of the previous view, not commands. The skill
  // marker is checked on the whole command (SKILL\\?\.md also matches the
  // regex-escaped form agents pass to rg); each segment only has to be a
  // viewer, noise, or shrapnel — an embedded interceptor/curl/rm segment
  // still breaks the exemption.
  const isShrapnel = (part: string) => /^[^a-zA-Z]/.test(part)
  return /\/skills\/|SKILL\\?\.md/.test(inner) &&
    segments.every((part) => VIEWERS.test(part) || isNoise(part) || isShrapnel(part))
}

export function parseCodexJsonl(raw: string, wallClockSeconds: number, totalCostUsd: number | null = null): UsageMetrics {
  const telemetry = emptyTelemetry()
  let inputTokens = 0
  let cachedInput = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let turns = 0
  let commands = 0
  let errors = 0
  const commandLog: string[] = []
  const skillReadLog: string[] = []
  const toolLog: string[] = []

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
        reasoningTokens = Number(usage.reasoning_output_tokens ?? reasoningTokens)
      }
      if (entry.type === "turn.failed" || entry.type === "error") errors += 1
      if (entry.type === "item.completed") {
        const item = (entry.item ?? {}) as Record<string, unknown>
        if (item.type === "command_execution" && typeof item.command === "string") {
          const command = item.command as string
          if (isSkillRead(command)) {
            skillReadLog.push(command)
          } else {
            commands += 1
            commandLog.push(command)
            classifyInterceptor(command, telemetry)
          }
        } else if (typeof item.type === "string" && !["agent_message", "todo_list"].includes(item.type)) {
          toolLog.push(item.type)
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
    reasoning_tokens: reasoningTokens,
    total_cost_usd: totalCostUsd,
    wall_clock_seconds: wallClockSeconds,
    turn_count: turns,
    command_count: commands,
    error_count: errors,
    command_log: commandLog,
    skill_read_log: skillReadLog,
    tool_log: toolLog,
    interceptor_telemetry: telemetry,
  }
}

function classifyInterceptor(rawCommand: string, telemetry: InterceptorTelemetry): void {
  // global value flags (--context chrome, --group x, …) may sit between `interceptor` and the verb
  const command = rawCommand.replace(/ --(?:context|group|tab|frame) \S+/g, "")
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
