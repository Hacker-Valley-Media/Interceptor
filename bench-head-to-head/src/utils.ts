import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { execSync } from "node:child_process"
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
  const interceptor = readJson<TaskSuiteFile>(join(CONFIG_DIR, "tasks-interceptor.json"))
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

export function shell(command: string, opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): string {
  return execSync(command, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 30_000,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      PATH: `${join(REPO_ROOT, "dist")}:${process.env.PATH ?? ""}`,
      ...(opts.env ?? {}),
    },
  })
}

export function shellResult(command: string, opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = shell(command, opts)
    return { ok: true, stdout, stderr: "" }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string }
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "" }
  }
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
