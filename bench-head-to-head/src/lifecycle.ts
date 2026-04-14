import { spawn, type ChildProcess } from "node:child_process"
import { shellResult, FIXTURES_DIR } from "./utils"
import type { ConditionDef } from "./types"

let fixtureServer: ChildProcess | null = null

export function startFixtureServer(): void {
  if (fixtureServer && fixtureServer.pid) return
  fixtureServer = spawn("bun", ["run", "src/server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, BENCH_FIXTURES_DIR: FIXTURES_DIR, BENCH_FIXTURE_PORT: "3241" },
  })
  fixtureServer.unref()

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const probe = shellResult("curl -sf http://127.0.0.1:3241/health", { timeoutMs: 2_000 })
    if (probe.ok) return
    shellResult("sleep 0.25", { timeoutMs: 2_000 })
  }
  throw new Error("Fixture server failed to become healthy on :3241")
}

export function stopFixtureServer(): void {
  if (!fixtureServer?.pid) return
  try {
    process.kill(-fixtureServer.pid, "SIGTERM")
  } catch {
    fixtureServer.kill()
  }
  fixtureServer = null
}

export function startCondition(condition: ConditionDef): void {
  if (condition.id === "interceptor") {
    shellResult("interceptor reload", { timeoutMs: 10_000 })
    shellResult("sleep 2", { timeoutMs: 5_000 })
  }
  if (condition.daemon === "explicit" && condition.daemonStart) {
    shellResult(condition.daemonStart, { timeoutMs: 30_000 })
  }
  waitForHealth(condition)
}

export function stopCondition(condition: ConditionDef): void {
  if (condition.id === "interceptor") {
    resetInterceptorManagedTabs()
  }
  if (condition.daemon === "explicit" && condition.daemonStop) {
    shellResult(condition.daemonStop, { timeoutMs: 15_000 })
  }
}

export function waitForHealth(condition: ConditionDef): void {
  if (!condition.healthCommand) return
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const health = shellResult(condition.healthCommand, { timeoutMs: 5_000 })
    if (health.ok) return
    shellResult("sleep 0.25", { timeoutMs: 2_000 })
  }
  throw new Error(`Condition ${condition.id} failed health check: ${condition.healthCommand}`)
}

export function runPreflight(condition: ConditionDef): void {
  const maxAttempts = condition.id === "interceptor" ? 3 : 1
  let lastError = ""
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let failed = false
    for (const command of condition.preflight?.commands ?? []) {
      const result = shellResult(command, { timeoutMs: 30_000 })
      if (!result.ok) {
        lastError = `Preflight failed for ${condition.id}: ${command}\n${result.stderr || result.stdout}`
        failed = true
        break
      }
    }
    if (!failed) return
    if (attempt < maxAttempts) {
      shellResult("sleep 5", { timeoutMs: 10_000 })
    }
  }
  throw new Error(lastError)
}

export function resetInterceptorManagedTabs(): void {
  const tabs = shellResult("interceptor tabs --json", { timeoutMs: 10_000 })
  if (!tabs.ok) return
  try {
    const parsed = JSON.parse(tabs.stdout) as { data?: Array<{ id: number; managed?: boolean }> }
    for (const tab of parsed.data ?? []) {
      if (tab.managed) shellResult(`interceptor tab close ${tab.id}`, { timeoutMs: 5_000 })
    }
  } catch {
  }
  shellResult("interceptor net clear", { timeoutMs: 5_000 })
}
