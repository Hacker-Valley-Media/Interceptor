import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/**
 * `interceptor ios <sub> --help` must print help and exit without sending a
 * daemon request. The top-level CLI routes every `ios … --help` into
 * runIosCommand expecting exactly that; before the guard, `ios setup --help`
 * performed a full build/sign/install on the phone.
 *
 * The socket path points at a nonexistent file inside a scratch TMPDIR, so a
 * regression (help falling through to dispatch) shows up as a connection
 * error + exit 1, never as a request to the real daemon.
 */
function runIosHelp(...args: string[]): { exitCode: number; stdout: string; stderr: string; ms: number } {
  const scratch = mkdtempSync(join(tmpdir(), "ios-cli-help-"))
  const started = Date.now()
  try {
    const result = Bun.spawnSync([process.execPath, resolve("cli/index.ts"), "ios", ...args], {
      env: {
        ...process.env,
        TMPDIR: scratch,
        INTERCEPTOR_SOCKET_PATH: join(scratch, "nope", "interceptor.sock"),
      },
      stdin: "ignore",
    })
    return {
      exitCode: result.exitCode ?? -1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      ms: Date.now() - started,
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

describe("interceptor ios <sub> --help never dispatches", () => {
  for (const sub of ["setup", "refresh", "install", "unlock", "type", "keys", "tree"]) {
    test(`ios ${sub} --help prints usage and exits 0`, () => {
      const r = runIosHelp(sub, "--help")
      expect(r.exitCode, r.stderr).toBe(0)
      expect(r.stdout).toContain("interceptor ios")
      expect(r.stderr).not.toContain("error:")
    })
  }

  test("ios setup -h is the same short-circuit", () => {
    const r = runIosHelp("setup", "-h")
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).toContain("interceptor ios setup")
  })

  test("a subcommand without a curated help line still gets the full ios page", () => {
    const r = runIosHelp("refresh", "--help")
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).toContain("refresh")
    expect(r.stdout).toContain("Setup:")
  })

  test("ios web --help keeps the WebKit lane's own help page", () => {
    const r = runIosHelp("web", "--help")
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout.toLowerCase()).toContain("web")
  })
})

describe("the XCTest authorization sheet is documented as a human gate", () => {
  const skill = readFileSync(resolve(".agents/skills/interceptor-ios/SKILL.md"), "utf8")
  const catalog = readFileSync(resolve(".agents/skills/interceptor-ios/references/command-catalog.md"), "utf8")
  const workflow = readFileSync(resolve(".agents/skills/interceptor-ios/workflows/drive-iphone-app.md"), "utf8")
  const help = readFileSync(resolve("cli/commands/ios.ts"), "utf8")
  const manual = readFileSync(resolve("AGENTS.md"), "utf8")

  test("skill, catalog, workflow, help, and manual all carry the stop-and-ask rule", () => {
    for (const [name, text] of Object.entries({ skill, catalog, workflow, help, manual })) {
      expect(text, name).toMatch(/Enable\s+UI\s+Automation/)
      expect(text.toLowerCase(), name).toMatch(/stop and ask|stop and report|report the sheet/)
      expect(text, name).toMatch(/Switch\s+Control/)
      expect(text, name).toMatch(/iPhone\s+Mirroring/)
    }
  })

  test("the help names both new launch failure modes", () => {
    expect(catalog).toContain("run: interceptor ios setup")
    expect(catalog).toContain("exit code")
    expect(manual).toContain("xcodebuild exited with code")
  })
})
