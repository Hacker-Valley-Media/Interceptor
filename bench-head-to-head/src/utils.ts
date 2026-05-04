import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { BenchConfig, ConditionDef, ModelsConfig, RunPolicy, ScoringConfig, TaskDef, TaskSuiteFile } from "./types"

export const BENCH_ROOT = resolve(import.meta.dirname, "..")
export const REPO_ROOT = resolve(BENCH_ROOT, "..")
export const CONFIG_DIR = join(BENCH_ROOT, "config")
export const FIXTURES_DIR = join(BENCH_ROOT, "fixtures")
export const RESULTS_DIR = join(BENCH_ROOT, "results")
export const SLOP_BIN = join(REPO_ROOT, "dist", "interceptor")

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

export function writeText(path: string, content: string): void {
  ensureDir(dirname(path))
  writeFileSync(path, content)
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value, null, 2) + "\n")
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T
}

export function loadConfig(): BenchConfig {
  const conditions = readJson<{ conditions: Record<string, ConditionDef> }>(join(CONFIG_DIR, "conditions.json")).conditions as BenchConfig["conditions"]
  const models = readJson<ModelsConfig>(join(CONFIG_DIR, "models.json"))
  const runPolicy = readJson<RunPolicy>(join(CONFIG_DIR, "run-policy.json"))
  const scoring = readJson<ScoringConfig>(join(CONFIG_DIR, "scoring.json"))
  const pub = readJson<TaskSuiteFile>(join(CONFIG_DIR, "tasks-public.json"))
  const interceptorTasksPath = fileExists(join(CONFIG_DIR, "tasks-interceptor.json"))
    ? join(CONFIG_DIR, "tasks-interceptor.json")
    : join(CONFIG_DIR, "tasks-slop.json")
  const interceptor = readJson<TaskSuiteFile>(interceptorTasksPath)
  return {
    conditions,
    models,
    runPolicy,
    scoring,
    suites: {
      public_parity: pub.tasks,
      interceptor_differentiation: interceptor.tasks,
    },
  }
}

export function getTask(config: BenchConfig, suite: keyof BenchConfig["suites"], taskId: string): TaskDef {
  const task = config.suites[suite].find((entry) => entry.id === taskId)
  if (!task) throw new Error(`Unknown task ${taskId} in suite ${suite}`)
  return task
}

// Bun.spawnSync over Node's execSync: native timeout + killSignal, faster
// spawn, argv as a real array (no multi-MB inline argv in `ps` for child
// processes carrying long prompts), and no event-loop blocking on the syscall.
// Sync signature is retained to avoid an async ripple through every caller;
// AbortSignal support (Bun.spawn-only) can be a follow-up when cooperative
// cancellation is needed beyond the timeout-driven SIGTERM.
export function shellResult(
  command: string,
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ["sh", "-c", command],
    cwd: opts.cwd,
    env: {
      ...process.env,
      PATH: `${join(REPO_ROOT, "dist")}:${process.env.PATH ?? ""}`,
      ...(opts.env ?? {}),
    },
    timeout: opts.timeoutMs,
    killSignal: "SIGTERM",
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    ok: proc.success,
    stdout: proc.stdout?.toString("utf-8") ?? "",
    stderr: proc.stderr?.toString("utf-8") ?? "",
  }
}

// Kept for backward compat with any caller that needed the throwing variant.
// Returns stdout on success; throws { stdout, stderr, exitCode } on failure.
export function shell(command: string, opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): string {
  const r = shellResult(command, opts)
  if (!r.ok) {
    const err = new Error(`shell failed: ${command}`) as Error & { stdout: string; stderr: string }
    err.stdout = r.stdout
    err.stderr = r.stderr
    throw err
  }
  return r.stdout
}

export function nowStamp(): string {
  return new Date().toISOString().replace(/[.:]/g, "-")
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0)
}

export function artifactDirFor(condition: string, suite: string, taskId: string, run: number): string {
  const dir = join(RESULTS_DIR, condition, suite, taskId, `run${run}`)
  ensureDir(dir)
  return dir
}

export function schemaPath(relPath: string): string {
  return join(CONFIG_DIR, relPath)
}

export function fileExists(path: string): boolean {
  return existsSync(path)
}
