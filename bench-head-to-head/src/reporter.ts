import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { HeadlineSummaryRow, RunResult, SuiteId } from "./types"
import { RESULTS_DIR, mean, sum, writeJson, writeText } from "./utils"

function loadResults(): RunResult[] {
  const rows: RunResult[] = []
  try {
    for (const file of readdirSync(RESULTS_DIR)) {
      if (!file.endsWith(".jsonl")) continue
      const raw = readFileSync(join(RESULTS_DIR, file), "utf-8")
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue
        rows.push(JSON.parse(line) as RunResult)
      }
    }
  } catch {
    return []
  }
  return rows
}

function summarize(results: RunResult[]): HeadlineSummaryRow[] {
  const groups = new Map<string, RunResult[]>()
  for (const result of results) {
    const key = `${result.condition}:${result.suite}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(result)
  }
  return [...groups.entries()].map(([key, rows]) => {
    const [condition, suite] = key.split(":") as [HeadlineSummaryRow["condition"], SuiteId]
    const costs = rows.map((row) => row.usage.total_cost_usd).filter((value): value is number => value !== null)
    return {
      condition,
      suite,
      successRate: rows.filter((row) => row.grade.pass).length / rows.length,
      avgSeconds: mean(rows.map((row) => row.usage.wall_clock_seconds)),
      avgTurns: mean(rows.map((row) => row.usage.turn_count)),
      avgCommands: mean(rows.map((row) => row.usage.command_count)),
      avgInputTokens: mean(rows.map((row) => row.usage.input_tokens)),
      avgOutputTokens: mean(rows.map((row) => row.usage.output_tokens)),
      avgCost: costs.length > 0 ? mean(costs) : null,
    }
  })
}

function markdown(results: RunResult[]): string {
  const lines: string[] = []
  const summary = summarize(results)
  lines.push("# Codex Head-to-Head Results — interceptor vs axi\n")
  lines.push("## Table A — Headline Summary\n")
  lines.push("| Condition | Suite | Success % | Avg Seconds | Avg Turns | Avg Commands | Avg Input Tokens | Avg Output Tokens | Avg Cost |")
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|")
  for (const row of summary) {
    lines.push(`| ${row.condition} | ${row.suite} | ${(row.successRate * 100).toFixed(0)} | ${row.avgSeconds.toFixed(1)} | ${row.avgTurns.toFixed(1)} | ${row.avgCommands.toFixed(1)} | ${row.avgInputTokens.toFixed(0)} | ${row.avgOutputTokens.toFixed(0)} | ${row.avgCost === null ? "n/a" : `$${row.avgCost.toFixed(4)}`} |`)
  }

  lines.push("\n## Table B — Per-Task Result Table\n")
  lines.push("| Task ID | Task Name | Condition | Pass/Fail | Seconds | Turns | Commands | Input Tokens | Output Tokens | Cost | Judge Mode | Notes |")
  lines.push("|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|")
  for (const result of results) {
    lines.push(`| ${result.taskId} | ${result.taskName} | ${result.condition} | ${result.grade.pass ? "PASS" : "FAIL"} | ${result.usage.wall_clock_seconds.toFixed(1)} | ${result.usage.turn_count} | ${result.usage.command_count} | ${result.usage.input_tokens} | ${result.usage.output_tokens} | ${result.usage.total_cost_usd === null ? "n/a" : `$${result.usage.total_cost_usd.toFixed(4)}`} | ${result.grade.mode} | ${result.grade.reason.replace(/\|/g, "/")} |`)
  }

  lines.push("\n## Table C — Win/Loss Matrix\n")
  lines.push("| Task ID | Task Name | Better on Success | Better on Speed | Better on Tokens | Better Overall | Why |")
  lines.push("|---|---|---|---|---|---|---|")
  const taskIds = [...new Set(results.map((r) => r.taskId))]
  for (const taskId of taskIds) {
    const interceptorRuns = results.filter((r) => r.taskId === taskId && r.condition === "interceptor")
    const axiRuns = results.filter((r) => r.taskId === taskId && r.condition === "axi")
    if (interceptorRuns.length === 0 || axiRuns.length === 0) continue
    const taskName = interceptorRuns[0].taskName
    const interceptorSuccess = interceptorRuns.filter((r) => r.grade.pass).length / interceptorRuns.length
    const axiSuccess = axiRuns.filter((r) => r.grade.pass).length / axiRuns.length
    const interceptorSpeed = mean(interceptorRuns.map((r) => r.usage.wall_clock_seconds))
    const axiSpeed = mean(axiRuns.map((r) => r.usage.wall_clock_seconds))
    const interceptorTokens = mean(interceptorRuns.map((r) => r.usage.input_tokens + r.usage.output_tokens))
    const axiTokens = mean(axiRuns.map((r) => r.usage.input_tokens + r.usage.output_tokens))
    const betterSuccess = interceptorSuccess > axiSuccess ? "interceptor" : axiSuccess > interceptorSuccess ? "axi" : "tie"
    const betterSpeed = interceptorSpeed < axiSpeed ? "interceptor" : axiSpeed < interceptorSpeed ? "axi" : "tie"
    const betterTokens = interceptorTokens < axiTokens ? "interceptor" : axiTokens < interceptorTokens ? "axi" : "tie"
    const wins = [betterSuccess, betterSpeed, betterTokens]
    const interceptorWins = wins.filter((w) => w === "interceptor").length
    const axiWins = wins.filter((w) => w === "axi").length
    const betterOverall = interceptorWins > axiWins ? "interceptor" : axiWins > interceptorWins ? "axi" : "tie"
    const reasons: string[] = []
    if (betterSuccess !== "tie") reasons.push(`${betterSuccess} higher success`)
    if (betterSpeed !== "tie") reasons.push(`${betterSpeed} faster`)
    if (betterTokens !== "tie") reasons.push(`${betterTokens} fewer tokens`)
    lines.push(`| ${taskId} | ${taskName} | ${betterSuccess} | ${betterSpeed} | ${betterTokens} | ${betterOverall} | ${reasons.join("; ") || "identical"} |`)
  }

  lines.push("\n## Table D — interceptor Telemetry Table\n")
  lines.push("| Task ID | tree | text | state | diff | net log | net headers | scene | os input | monitor | replay used |")
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|")
  for (const result of results.filter((row) => row.condition === "interceptor")) {
    const t = result.usage.interceptor_telemetry
    lines.push(`| ${result.taskId} | ${t?.tree_count ?? 0} | ${t?.text_count ?? 0} | ${t?.state_count ?? 0} | ${t?.diff_count ?? 0} | ${t?.net_log_count ?? 0} | ${t?.net_headers_count ?? 0} | ${t?.scene_count ?? 0} | ${t?.os_input_count ?? 0} | ${t?.monitor_count ?? 0} | ${t?.replay_used ? "yes" : "no"} |`)
  }

  const costs = results.map((row) => row.usage.total_cost_usd).filter((value): value is number => value !== null)
  lines.push("\n## Notes\n")
  lines.push(`- Runs captured: ${results.length}`)
  lines.push(`- Total cost recorded: ${costs.length > 0 ? `$${sum(costs).toFixed(4)}` : "n/a"}`)
  lines.push("- Cost remains n/a until a verified Codex pricing table is configured.")
  return lines.join("\n") + "\n"
}

function csv(results: RunResult[]): string {
  const header = ["suite", "condition", "taskId", "taskName", "run", "pass", "seconds", "turns", "commands", "input_tokens", "output_tokens", "cost", "judge_mode"]
  const rows = [header.join(",")]
  for (const result of results) {
    rows.push([
      result.suite,
      result.condition,
      result.taskId,
      JSON.stringify(result.taskName),
      String(result.run),
      String(result.grade.pass),
      result.usage.wall_clock_seconds.toFixed(3),
      String(result.usage.turn_count),
      String(result.usage.command_count),
      String(result.usage.input_tokens),
      String(result.usage.output_tokens),
      result.usage.total_cost_usd === null ? "" : String(result.usage.total_cost_usd),
      result.grade.mode,
    ].join(","))
  }
  return rows.join("\n") + "\n"
}

export function writeReports(): void {
  const results = loadResults()
  writeText(join(RESULTS_DIR, "report.md"), markdown(results))
  writeText(join(RESULTS_DIR, "report.csv"), csv(results))
  writeJson(join(RESULTS_DIR, "report.json"), results)
}
