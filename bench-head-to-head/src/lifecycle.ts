import { spawn, type ChildProcess } from "node:child_process"
import { shellResult, FIXTURES_DIR } from "./utils"
import type { ConditionDef } from "./types"
import { FIXTURE_PAGES, validateFixtureHtml } from "./fixtures"

let fixtureServer: ChildProcess | null = null

export function startFixtureServer(): void {
  if (fixtureServer && fixtureServer.pid && fixtureServerHealthy()) return
  if (fixtureServerHealthy()) return
  stopProcessOnFixturePort()
  fixtureServer = spawn("bun", ["run", "src/server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, BENCH_FIXTURES_DIR: FIXTURES_DIR, BENCH_FIXTURE_PORT: "3241" },
  })
  fixtureServer.unref()

  while (!fixtureServerHealthy()) {}
}

export function stopFixtureServer(): void {
  if (fixtureServer?.pid) {
    try {
      process.kill(-fixtureServer.pid, "SIGTERM")
    } catch {
      fixtureServer.kill()
    }
  }
  stopProcessOnFixturePort()
  fixtureServer = null
}

export function startCondition(condition: ConditionDef): void {
  if (condition.daemon === "explicit" && condition.daemonStart) {
    shellResult(condition.daemonStart)
  }
  waitForHealth(condition)
}

export function stopCondition(condition: ConditionDef): void {
  if (condition.id === "interceptor") {
    resetInterceptorManagedTabs()
  }
  if (condition.daemon === "explicit" && condition.daemonStop) {
    shellResult(condition.daemonStop)
  }
}

export function waitForHealth(condition: ConditionDef): void {
  if (!condition.healthCommand) return
  const deadline = Date.now() + 60_000
  while (!shellResult(condition.healthCommand, { timeoutMs: 30_000 }).ok) {
    if (Date.now() > deadline) {
      throw new Error(`Health check timed out for ${condition.id}: ${condition.healthCommand}`)
    }
  }
}

export function runPreflight(condition: ConditionDef): void {
  for (const command of condition.preflight?.commands ?? []) {
    let lastErr = ""
    let ok = false
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = shellResult(command, { timeoutMs: 30_000 })
      if (result.ok) { ok = true; break }
      lastErr = result.stderr || result.stdout
      shellResult(`sleep ${attempt}`)
    }
    if (!ok) {
      throw new Error(`Preflight failed for ${condition.id}: ${command}\n${lastErr}`)
    }
  }
}

function fixtureServerHealthy(): boolean {
  const health = shellResult("curl -sf http://127.0.0.1:3241/health")
  if (!health.ok) return false
  try {
    const parsed = JSON.parse(health.stdout) as { ok?: boolean; fixtureRoot?: string; fixtures?: Record<string, boolean> }
    if (parsed.fixtureRoot !== FIXTURES_DIR) return false
    if (parsed.ok !== true) return false
    for (const page of FIXTURE_PAGES) {
      if (parsed.fixtures?.[page.path] !== true) return false
      const pageResp = shellResult(`curl -sf http://127.0.0.1:3241${page.path}`)
      if (!pageResp.ok) return false
      if (validateFixtureHtml(page, pageResp.stdout)) return false
    }
    return true
  } catch {
    return false
  }
}

function stopProcessOnFixturePort(): void {
  const pids = shellResult("lsof -ti tcp:3241")
  if (!pids.ok || !pids.stdout.trim()) return
  for (const pid of pids.stdout.trim().split(/\s+/)) {
    if (/^\d+$/.test(pid)) {
      shellResult(`kill ${pid}`)
    }
  }
}

export function resetInterceptorManagedTabs(): void {
  const tabs = shellResult("interceptor tabs --json")
  if (!tabs.ok) return
  try {
    const parsed = JSON.parse(tabs.stdout) as { data?: Array<{ id: number; managed?: boolean }> }
    for (const tab of parsed.data ?? []) {
      if (tab.managed) shellResult(`interceptor tab close ${tab.id}`)
    }
  } catch {
  }
  shellResult("interceptor net clear")
}
