/**
 * test/install-linux-container.test.ts
 *
 * Linux test harness via Apple's `container` runtime.
 *
 * macOS hosts can't natively exercise install.sh's Linux branches, but
 * Apple's `container` (research/container/docs/technical-overview.md:24-27)
 * runs Linux containers as lightweight VMs on Apple-Silicon Macs running
 * macOS 26+. Interceptor wraps the runtime via the `container_run`
 * domain (interceptor-bridge/Sources/Domains/ContainerDomain.swift) and
 * the `interceptor macos container run` CLI surface (cli/commands/macos.ts).
 *
 * This file exercises the Linux dry-run path from a macOS host by mounting
 * the repo into an Ubuntu container read-only and running install.sh inside
 * it. The container has no network (--network none — Interceptor's default
 * per ContainerDomain.swift, hermetic on macOS 15+) so no apt-get / no
 * registry calls happen during the test.
 *
 * Gates:
 *   - Skips on non-Darwin (the runtime is macOS-only).
 *   - Skips when the `container` binary is absent (CI without macOS-26 +
 *     Apple's tool installed).
 *   - Skips when the `container` system service is not running.
 *   - Skips when the `interceptor` binary isn't on $PATH (CI before the
 *     dist build runs). Will use `bun run cli/index.ts` as fallback if
 *     INTERCEPTOR_CLI is set to "bun".
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const IS_DARWIN = process.platform === "darwin"
const UBUNTU_IMAGE = "docker.io/library/ubuntu:24.04"
const BUN_IMAGE = "docker.io/oven/bun:1"

function containerBinary(): string | null {
  if (!IS_DARWIN) return null
  // Mirror ContainerDomain.swift's resolution order (Apple-Silicon Homebrew first).
  const candidates = [
    "/opt/homebrew/bin/container",
    "/usr/local/bin/container",
  ]
  for (const path of candidates) {
    const probe = spawnSync(path, ["--version"], { stdio: "ignore" })
    if (probe.status === 0) return path
  }
  // Fallback: PATH lookup.
  const which = spawnSync("which", ["container"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  if (which.status !== 0) return null
  const probe = spawnSync("container", ["--version"], { stdio: "ignore" })
  return probe.status === 0 ? which.stdout.trim() || "container" : null
}

/** True iff Apple's `container` binary exists and its system service is running. */
function containerAvailable(): boolean {
  const binary = containerBinary()
  if (!binary) return false
  const status = spawnSync(binary, ["system", "status"], { stdio: "ignore" })
  return status.status === 0
}

/**
 * Resolve how to invoke the interceptor CLI. Returns the argv array.
 *
 * Prefers `interceptor` on $PATH; falls back to `bun run cli/index.ts` when
 * the dist binary isn't built yet (common in CI before `bash scripts/build.sh`).
 * Returns null if neither is available.
 */
function interceptorArgv(): string[] | null {
  // Try the built binary first.
  if (spawnSync("which", ["interceptor"], { stdio: "ignore" }).status === 0) {
    return ["interceptor"]
  }
  // Fall back to `bun run cli/index.ts`.
  if (spawnSync("which", ["bun"], { stdio: "ignore" }).status === 0) {
    return ["bun", "run", resolve(REPO_ROOT, "cli/index.ts")]
  }
  return null
}

const SHOULD_RUN = containerAvailable() && interceptorArgv() !== null

/**
 * Run `interceptor macos container run` with the given image+command. Returns
 * the parsed wire response from the bridge — { exitCode, stdout, stderr,
 * durationMs, ... } per ContainerDomain.swift:196-204.
 */
function containerRun(image: string, cmd: string, extraArgs: string[] = []): {
  ok: boolean
  payload: Record<string, unknown>
  raw: string
  stderr: string
} {
  const argv = interceptorArgv()!
  const result = spawnSync(
    argv[0],
    [
      ...argv.slice(1),
      "macos", "container", "run", image,
      "--volume", `${REPO_ROOT}:/work:ro`,
      "--cmd", cmd,
      "--timeout", "120000",
      ...extraArgs,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  )
  let payload: Record<string, unknown> = {}
  try {
    // The CLI prints structured JSON for the container_run domain.
    payload = JSON.parse(result.stdout ?? "{}")
  } catch {
    // Fall through; payload stays empty and tests assert against raw output.
  }
  return {
    ok: result.status === 0,
    payload,
    raw: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

describe.skipIf(!SHOULD_RUN)("install.sh — Linux dry-run via Apple container", () => {
  // Bare Ubuntu container has no Chrome / Brave installed; --skip-extension
  // short-circuits the load_extension step so the test only validates the
  // platform-routing + NM-symlink generation paths (the cross-platform delta
  // PR-83 introduced).
  test("--browser-only --chrome --skip-extension --dry-run prints Linux NM dir", () => {
    const r = containerRun(UBUNTU_IMAGE,
      "bash /work/scripts/install.sh --browser-only --chrome --skip-extension --dry-run")
    expect(r.ok).toBe(true)
    expect(r.payload.exitCode).toBe(0)
    const stdout = String(r.payload.stdout ?? "")
    expect(stdout).toContain(".config/google-chrome/NativeMessagingHosts")
    // macOS NM dir convention must NOT leak when running under uname -s = Linux.
    expect(stdout).not.toContain("Library/Application Support")
  })

  test("--browser-only --brave --skip-extension --dry-run prints Linux Brave NM dir", () => {
    const r = containerRun(UBUNTU_IMAGE,
      "bash /work/scripts/install.sh --browser-only --brave --skip-extension --dry-run")
    expect(r.ok).toBe(true)
    expect(r.payload.exitCode).toBe(0)
    const stdout = String(r.payload.stdout ?? "")
    expect(stdout).toContain(".config/BraveSoftware/Brave-Browser/NativeMessagingHosts")
    expect(stdout).not.toContain("Library/Application Support")
  })

  test("--full --chrome plans the Linux provider without macOS services", () => {
    const r = containerRun(UBUNTU_IMAGE,
      "bash /work/scripts/install.sh --full --chrome --dry-run")
    expect(r.ok).toBe(true)
    expect(r.payload.exitCode).toBe(0)
    const stdout = String(r.payload.stdout ?? "")
    expect(stdout).toContain("DRY: install owned native provider")
    expect(stdout).toContain("DRY-RUN complete (Linux full mode)")
    expect(stdout).not.toContain("com.interceptor.bridge.plist")
  })

  // the daemon-crash regression. test/os-input-platform.test.ts
  // covers the macOS-host import path; this test covers the actual Linux
  // import path by running the fixture inside a Linux Bun container. The
  // fixture (test/fixtures/linux-os-input-check.ts) emits two markers:
  // "import-ok" if the dlopen gate worked, "osClick:{success:false,...}" if
  // the platform-guard sentinel is returned.
  test("daemon/os-input.ts imports cleanly on Linux + os* return UNSUPPORTED (PR-83 regression)", () => {
    const r = containerRun(BUN_IMAGE,
      "bun /work/test/fixtures/linux-os-input-check.ts")
    expect(r.ok).toBe(true)
    expect(r.payload.exitCode).toBe(0)
    const stdout = String(r.payload.stdout ?? "")
    const stderr = String(r.payload.stderr ?? "")
    expect(stdout).toContain("import-ok")
    expect(stdout).toContain('"success":false')
    expect(stdout).toContain("not supported")
    expect(stderr).not.toContain("ERR_DLOPEN_FAILED")
  })
})
