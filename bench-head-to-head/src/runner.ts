import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { startCondition, startFixtureServer, stopCondition, stopFixtureServer, runPreflight, resetInterceptorManagedTabs } from "./lifecycle"
import { writeReports } from "./reporter"
import { runJudge } from "./judge"
import { parseCodexJsonl } from "./usage"
import { validateCommandPolicy } from "./validation"
import { deterministicGrade } from "./validators"
import { artifactDirFor, BENCH_ROOT, ensureDir, fileExists, loadConfig, nowStamp, schemaPath, shellResult, writeJson, writeText } from "./utils"
import type { AgentFinalMessage, BenchConfig, ConditionDef, RunEnvironment, RunResult, RunSpec, TaskDef } from "./types"

function environment(config: BenchConfig): RunEnvironment {
  const interceptorStatus = shellResult("interceptor status", { timeoutMs: 10_000 })
  const axiHelp = shellResult("chrome-devtools-axi --version", { timeoutMs: 10_000 })
  const browser = shellResult("interceptor tabs --json", { timeoutMs: 10_000 })
  return {
    os: shellResult("sw_vers -productVersion", { timeoutMs: 10_000 }).stdout.trim() || process.platform,
    browser: browser.ok ? "browser-present" : "unknown",
    interceptorVersion: interceptorStatus.ok ? "0.1.0" : undefined,
    axiVersion: axiHelp.ok ? axiHelp.stdout.trim() : undefined,
    interceptorCommit: shellResult("git rev-parse HEAD", { timeoutMs: 10_000 }).stdout.trim() || undefined,
    axiCommit: shellResult("git -C /tmp/axi-bench.4WAiiL rev-parse HEAD", { timeoutMs: 10_000 }).stdout.trim() || undefined,
    fixtureVersion: shellResult("git rev-parse HEAD", { timeoutMs: 10_000 }).stdout.trim() || undefined,
    codexModel: config.models.agent.model,
  }
}

function workspaceFor(spec: RunSpec): string {
  return artifactDirFor(spec.condition, spec.suite, spec.taskId, spec.run)
}

function taskPrompt(task: TaskDef): string {
  const pieces = [
    task.url ? `Start URL: ${task.url}` : "",
    `Task: ${task.prompt}`,
    "Return strict JSON matching the provided schema.",
    "Use the 'answer' field for the final answer and 'evidence' for short evidence bullets.",
  ].filter(Boolean)
  return pieces.join("\n\n")
}

function codexCommand(config: BenchConfig, condition: ConditionDef, task: TaskDef, artifactDir: string): string {
  const outputPath = join(artifactDir, "final-answer.json")
  const promptPath = join(artifactDir, "prompt.txt")
  const toolName = condition.toolCommand ?? condition.tool
  const prompt = `${condition.agentsMd}\n\nUse this exact browser tool command name in shell calls: ${toolName}\nDo not substitute another installed binary with a similar name.\n\n${taskPrompt(task)}`
  writeText(promptPath, prompt)
  return [
    "codex exec",
    "--json",
    "--skip-git-repo-check",
    `--sandbox ${config.models.agent.sandbox}`,
    `-c 'approval_policy=\"${config.models.agent.approvalPolicy}\"'`,
    `-c 'model=\"${config.models.agent.model}\"'`,
    `--output-schema ${schemaPath(config.models.agent.outputSchema)}`,
    `-o ${outputPath}`,
    JSON.stringify(prompt),
  ].join(" ")
}

function parseFinal(artifactDir: string): AgentFinalMessage {
  const path = join(artifactDir, "final-answer.json")
  if (!fileExists(path)) {
    return { answer: "", evidence: [] }
  }
  return JSON.parse(readFileSync(path, "utf-8")) as AgentFinalMessage
}

export function runOne(spec: RunSpec, config = loadConfig()): RunResult {
  const task = config.suites[spec.suite].find((entry) => entry.id === spec.taskId)
  if (!task) throw new Error(`Unknown task ${spec.taskId}`)
  const condition = config.conditions[spec.condition]
  const artifactDir = workspaceFor(spec)
  const env = environment(config)

  startFixtureServer()
  writeJson(join(artifactDir, "condition.json"), condition)
  writeJson(join(artifactDir, "task.json"), task)
  writeJson(join(artifactDir, "environment.json"), env)

  let setupError: string | undefined
  try {
    startCondition(condition)
    runPreflight(condition)
    if (config.runPolicy.freshStatePerRun && condition.id === "interceptor") resetInterceptorManagedTabs()
  } catch (error) {
    setupError = error instanceof Error ? error.message : String(error)
  }

  let agentResult = { ok: false, stdout: "", stderr: "" }
  let wallClock = 0
  if (!setupError) {
    const started = Date.now()
    agentResult = shellResult(codexCommand(config, condition, task, artifactDir), { cwd: BENCH_ROOT, timeoutMs: config.runPolicy.timeoutSeconds * 1000 })
    wallClock = (Date.now() - started) / 1000
  }

  writeText(join(artifactDir, "agent-output.jsonl"), agentResult.stdout)
  writeText(join(artifactDir, "stderr.txt"), setupError ? `${setupError}\n${agentResult.stderr}` : agentResult.stderr)

  const usage = parseCodexJsonl(agentResult.stdout, wallClock, config.models.costModel.enabled ? 0 : null)
  const final = parseFinal(artifactDir)
  const policyViolation = !setupError ? validateCommandPolicy(condition, usage.command_log) : null
  const grade = setupError
    ? { pass: false, score: 0, reason: `Setup failure: ${setupError}`, mode: "deterministic" as const }
    : policyViolation
      ? { pass: false, score: 0, reason: policyViolation, mode: "deterministic" as const }
      : deterministicGrade(task, final) ?? runJudge(task, final, config.models, artifactDir)

  writeJson(join(artifactDir, "usage.json"), usage)
  writeJson(join(artifactDir, "grade.json"), grade)
  if (setupError) writeText(join(artifactDir, "setup-error.txt"), `${setupError}\n`)

  const result: RunResult = {
    suite: spec.suite,
    condition: spec.condition,
    taskId: task.id,
    taskName: task.name,
    run: spec.run,
    timestamp: nowStamp(),
    model: config.models.agent.model,
    environment: env,
    usage,
    grade,
    final,
    artifactDir,
    setupError,
  }

  ensureDir(configPathRoot())
  appendFileSync(join(configPathRoot(), `${spec.condition}.jsonl`), JSON.stringify(result) + "\n")
  stopCondition(condition)
  return result
}

function configPathRoot(): string {
  return join(BENCH_ROOT, "results")
}

function shuffle<T>(array: T[]): T[] {
  const copy = [...array]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

export function runMatrix(options: { suite?: string; condition?: string; repeat?: number } = {}): RunResult[] {
  const config = loadConfig()
  const suites = (options.suite ? [options.suite] : ["public_parity", "interceptor_differentiation"]) as Array<keyof BenchConfig["suites"]>
  const conditions = (options.condition ? [options.condition] : ["interceptor", "axi"]) as Array<keyof BenchConfig["conditions"]>
  const repeat = options.repeat ?? config.runPolicy.defaultRepeats
  const results: RunResult[] = []

  let specs: RunSpec[] = []
  for (const suite of suites) {
    for (const task of config.suites[suite]) {
      for (const condition of conditions) {
        for (let run = 1; run <= repeat; run++) {
          specs.push({ suite, condition, taskId: task.id, run })
        }
      }
    }
  }

  if (config.runPolicy.randomizeOrder) {
    specs = shuffle(specs)
  }

  for (const spec of specs) {
    results.push(runOne(spec, config))
  }

  stopFixtureServer()
  writeReports()
  return results
}
