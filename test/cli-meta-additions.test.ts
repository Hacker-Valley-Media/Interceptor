/**
 * test/cli-meta-additions.test.ts
 *
 * Smoke tests for the additions to the meta CLI surface:
 *   - per-command --help and -h short-circuits (was: only global `interceptor help`)
 *   - status --verbose annotated output
 *   - init command reuses status renderer
 *   - CSP-blocked-eval error rewritten to actionable message
 *
 * These are pure-CLI tests — they invoke the source CLI via `bun run` so the
 * compiled binary doesn't need to exist. No daemon is spawned; no extension
 * messaging happens.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

import { rewriteCspEvalError } from "../cli/format"
import { helpForCommand } from "../cli/help"
import { formatStatus, type StatusSnapshot } from "../cli/lib/status-renderer"

const REPO_ROOT = resolve(import.meta.dir, "..")
const CLI_ENTRY = resolve(REPO_ROOT, "cli/index.ts")

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const proc = spawnSync("bun", ["run", CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  })
  return {
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
    status: proc.status ?? -1,
  }
}

describe("rewriteCspEvalError (#54)", () => {
  test("rewrites a Chrome unsafe-eval CSP error into the actionable message", () => {
    const raw =
      "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self'\"."
    const out = rewriteCspEvalError(raw)
    expect(out).toBeDefined()
    expect(out).toContain("page CSP blocks eval")
    expect(out).toContain("interceptor html")
    expect(out).toContain("interceptor read")
    expect(out).not.toContain("chrome-extension://")
  })

  test("strips a leaked chrome-extension:// URL from output", () => {
    const raw =
      "Refused to evaluate a string as JavaScript at chrome-extension://hkjbaciefhhgekldhncknbjkofbpenng/ because the page's Content Security Policy denies unsafe-eval."
    const out = rewriteCspEvalError(raw)
    expect(out).not.toContain("chrome-extension://")
    expect(out).toContain("page CSP blocks eval")
  })

  test("passes through non-CSP errors unchanged", () => {
    const raw = "ReferenceError: foo is not defined"
    expect(rewriteCspEvalError(raw)).toBe(raw)
  })

  test("passes through undefined", () => {
    expect(rewriteCspEvalError(undefined)).toBeUndefined()
  })
})

describe("helpForCommand (#51)", () => {
  test("returns the per-command slice for `open`", () => {
    const help = helpForCommand("open")
    expect(help).toBeDefined()
    expect(help).toContain("interceptor open <url>")
    expect(help).toContain("--tree-only")
    expect(help).toContain("--text-only")
  })

  test("returns the per-command slice for `act`", () => {
    const help = helpForCommand("act")
    expect(help).toBeDefined()
    expect(help).toContain("interceptor act <ref>")
    expect(help).toContain("--os")
  })

  test("returns null for an unknown command", () => {
    expect(helpForCommand("not-a-real-command-xyz")).toBeNull()
  })

  test("CLI: `<cmd> --help` short-circuits without spawning daemon", () => {
    const r = runCli(["open", "--help"])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("interceptor open <url>")
    // Should NOT contain the full HELP — only the open block.
    // The full HELP includes a Canvas section; per-command help shouldn't.
    expect(r.stdout).not.toContain("interceptor canvas list")
    expect(r.stderr).not.toContain("daemon not running")
  })

  test("CLI: `<cmd> -h` is an alias for --help", () => {
    const r = runCli(["act", "-h"])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("interceptor act <ref>")
  })

  test("CLI: bare `--help` falls back to full HELP", () => {
    const r = runCli(["--help"])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("interceptor — browser control CLI")
    expect(r.stdout).toContain("Compound (agent-optimized)")
  })
})

describe("formatStatus (#49 + #52)", () => {
  function fakeSnapshot(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
    return {
      mode: "browser-only",
      daemon: false,
      pid: null,
      socket: null,
      transport: "unix:/tmp/interceptor.sock",
      bridge: false,
      bridgePid: null,
      bridgeSocket: null,
      launchAgentInstalled: false,
      ...over,
    }
  }

  test("default (terse) mirrors the legacy field names — backwards compat", () => {
    const out = formatStatus(fakeSnapshot(), { verbose: false })
    expect(out).toMatch(/^mode: browser-only/)
    expect(out).toContain("daemon: not running")
    expect(out).toContain("transport: unix:/tmp/interceptor.sock")
    // Default output must NOT include the verbose annotations.
    expect(out).not.toContain("(long-lived host process bridging CLI")
    expect(out).not.toContain("(Unix socket the CLI uses to reach the daemon)")
  })

  test("--verbose annotates each layer", () => {
    const out = formatStatus(fakeSnapshot(), { verbose: true })
    expect(out).toContain("daemon (long-lived host process bridging CLI and the browser extension)")
    expect(out).toContain("socket (Unix socket the CLI uses to reach the daemon)")
    expect(out).toContain("transport (how the CLI reaches the daemon)")
  })

  test("renders browser-config block when present", () => {
    const out = formatStatus(
      fakeSnapshot({
        browser: { configured: ["brave"], systemDefault: "chrome", matches: false },
      }),
      { verbose: true },
    )
    expect(out).toContain("browser")
    expect(out).toContain("configured:     brave")
    expect(out).toContain("system default: chrome")
    expect(out).toContain("⚠ mismatch")
  })

  test("renders extension-reachable block when probed", () => {
    const out = formatStatus(
      fakeSnapshot({
        daemon: true,
        extension: { probed: true, reachable: true },
      }),
      { verbose: true },
    )
    expect(out).toContain("extension: reachable")
  })

  test("renders extension-not-reachable block with reason", () => {
    const out = formatStatus(
      fakeSnapshot({
        daemon: true,
        extension: { probed: true, reachable: false, reason: "no tabs in interceptor group" },
      }),
      { verbose: true },
    )
    expect(out).toContain("extension: not reachable")
    expect(out).toContain("no tabs in interceptor group")
  })

  test("bridge block only renders when mode != browser-only", () => {
    const browserOnly = formatStatus(fakeSnapshot({ mode: "browser-only" }), { verbose: false })
    expect(browserOnly).not.toContain("bridge:")

    const full = formatStatus(fakeSnapshot({ mode: "full", launchAgentInstalled: true }), { verbose: false })
    expect(full).toContain("bridge:")
  })
})

describe("init command (#50)", () => {
  test("init is a recognized command and --help returns its slice", () => {
    // We can't actually run init without potentially spawning the daemon,
    // but we can check that --help short-circuits cleanly: that confirms
    // init is wired into the dispatcher AND has an entry in HELP.
    const r = runCli(["init", "--help"])
    expect(r.status).toBe(0)
    // Per-command slice header + at least one matching line.
    expect(r.stdout).toContain("interceptor init — usage")
    expect(r.stdout).toMatch(/interceptor init\s/)
  })
})
