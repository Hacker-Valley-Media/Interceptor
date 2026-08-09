/**
 * test/compiled-stdout-pipe.test.ts
 *
 * Regression guard for issue #183: compiled CLI binaries silently truncated
 * piped stdout at 65,536 bytes (exit 0) while file/tty output was complete.
 *
 * Root cause: a Bun `build --compile` bug (present in 1.3.11 and 1.3.14) —
 * if ANY bundled module contains `import process from "node:process"`, even a
 * module that never executes (behind a dynamic import in dead code), the
 * compiled binary drops piped-stdout bytes past 64 KiB on natural exit,
 * including `console.log` output. The only such modules in our bundle graph
 * are the MCP SDK's stdio transports, de-poisoned via patches/ +
 * package.json "patchedDependencies".
 *
 * Two layers:
 *   1. Patch guard — the installed SDK files must not contain the poison
 *      import. Catches a silent patch drop on an SDK version bump (bun
 *      refuses to apply a stale patch, and a bare `bun add` bump would
 *      otherwise reintroduce the truncation everywhere).
 *   2. End-to-end — compile a fixture that dead-dynamic-imports the SDK
 *      server stdio transport (the exact minimal trigger), pipe ~300 KB of
 *      console.log output through a subprocess pipe, and assert every byte
 *      arrives. Fails if the patch stops working OR a Bun upgrade
 *      reintroduces the bug through another path.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const SDK_DIST = resolve(REPO_ROOT, "node_modules/@modelcontextprotocol/sdk/dist")

const SDK_STDIO_FILES = [
  "esm/server/stdio.js",
  "esm/client/stdio.js",
  "cjs/server/stdio.js",
  "cjs/client/stdio.js",
]

const PAYLOAD_CHARS = 300_000

describe("compiled stdout pipe integrity (issue #183)", () => {
  test("MCP SDK stdio transports are de-poisoned of node:process imports", () => {
    for (const rel of SDK_STDIO_FILES) {
      const path = join(SDK_DIST, rel)
      expect(existsSync(path)).toBe(true)
      const src = readFileSync(path, "utf-8")
      expect(src.includes("node:process")).toBe(false)
      expect(src.includes("globalThis.process")).toBe(true)
    }
  })

  test("compiled binary with dead dynamic SDK import delivers full output through a pipe", async () => {
    // The entry must live inside the repo tree: bun resolves the package
    // specifier by walking up from the ENTRY file, and the package-specifier
    // form is the exact trigger — an absolute-path import of the same file
    // does NOT reproduce the truncation (verified by negative control).
    const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-pipe-guard-"))
    const outdir = mkdtempSync(join(tmpdir(), "ic-pipe-guard-"))
    try {
      const entry = join(dir, "fixture.ts")
      // Dead dynamic import = the minimal trigger for the Bun compile bug.
      // The branch never runs; before the patch its mere presence in the
      // bundle truncated the console.log below at exactly 65,536 bytes.
      writeFileSync(entry, [
        `async function main() {`,
        `  if (process.env.IC_PIPE_GUARD_NEVER_SET) {`,
        `    await import("@modelcontextprotocol/sdk/server/stdio.js")`,
        `  }`,
        `  console.log("x".repeat(${PAYLOAD_CHARS}))`,
        `}`,
        `main()`,
      ].join("\n"))

      const outfile = join(outdir, "fixture-bin")
      const build = Bun.spawnSync(["bun", "build", "--compile", entry, "--outfile", outfile], {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(build.exitCode).toBe(0)

      // Must be a real shell pipe: Bun.spawn's own stdout pipe drains
      // aggressively enough that the truncation does not manifest there
      // (verified by negative control) — `| wc -c` through /bin/sh matches
      // the failing consumer topology from the issue.
      const run = Bun.spawnSync(["/bin/sh", "-c", '"$1" | wc -c', "_", outfile], {
        stdout: "pipe",
        stderr: "ignore",
      })
      expect(run.exitCode).toBe(0)
      // payload + trailing newline from console.log
      expect(parseInt(run.stdout.toString().trim(), 10)).toBe(PAYLOAD_CHARS + 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outdir, { recursive: true, force: true })
    }
  }, 30_000)
})
