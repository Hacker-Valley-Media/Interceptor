import { readFileSync } from "node:fs"
import { shellResult, schemaPath, writeText } from "./utils"
import type { AgentFinalMessage, JudgeGrade, ModelsConfig, TaskDef } from "./types"

function judgePrompt(task: TaskDef, final: AgentFinalMessage): string {
  return [
    "You are grading a benchmark run between browser automation conditions.",
    `Task: ${task.prompt}`,
    task.judgeHint ? `Judge hint: ${task.judgeHint}` : "",
    `Agent final answer: ${final.answer}`,
    `Agent evidence: ${final.evidence.join(" | ")}`,
    "Return strict JSON that matches the provided schema.",
    "Use pass=true only if the answer is correct and complete for the task.",
    "Use score as 1 for a clear pass, 0 for a fail, and fractional values only for materially partial but credible answers."
  ].filter(Boolean).join("\n\n")
}

export function runJudge(task: TaskDef, final: AgentFinalMessage, models: ModelsConfig, artifactDir: string): JudgeGrade {
  const prompt = judgePrompt(task, final)
  const promptPath = `${artifactDir}/judge-prompt.txt`
  writeText(promptPath, prompt)
  const outputPath = `${artifactDir}/judge-last.json`
  const command = [
    "codex exec",
    "--json",
    "--skip-git-repo-check",
    `--sandbox ${models.judge.sandbox}`,
    `-c 'approval_policy=\"${models.judge.approvalPolicy}\"'`,
    `-c 'model=\"${models.judge.model}\"'`,
    `--output-schema ${schemaPath(models.judge.outputSchema)}`,
    `-o ${outputPath}`,
    JSON.stringify(prompt),
  ].join(" ")
  const result = shellResult(command, { timeoutMs: 180_000 })
  writeText(`${artifactDir}/judge-output.jsonl`, result.stdout)
  writeText(`${artifactDir}/judge-stderr.txt`, result.stderr)
  if (!result.ok) {
    return {
      pass: false,
      score: 0,
      reason: `Judge invocation failed: ${result.stderr || result.stdout}`,
      confidence: "low",
      mode: "judge",
      judge_model: models.judge.model,
    }
  }
  const parsed = JSON.parse(readFileSync(outputPath, "utf-8")) as { pass: boolean; score: number; reason: string; confidence: string }
  return {
    ...parsed,
    mode: "judge",
    judge_model: models.judge.model,
  }
}
