import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { captureShell } from "./helpers/shell-capture"

const SCRIPT = resolve(import.meta.dir, "../scripts/get-interceptor.sh")
const dir = mkdtempSync(join(tmpdir(), "get-interceptor-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// Source the installer's functions without running main, then run one command.
function lib(command: string) {
  return captureShell("/bin/bash", ["-c", `set -euo pipefail; source "$1"; ${command}`, "lib", SCRIPT], {
    timeout: 10000,
    env: { ...process.env, GET_INTERCEPTOR_LIB: "1" },
  })
}

describe("get-interceptor.sh", () => {
  test("picks the release asset for each OS, CPU and edition", () => {
    const r = lib(`asset_name Darwin arm64 full 2.1.5; asset_name Darwin arm64 browser 2.1.5; asset_name Linux x64 browser 2.1.5; asset_name Linux arm64 full 2.1.5`)
    expect(r.status).toBe(0)
    expect(r.stdout.trim().split("\n")).toEqual([
      "Interceptor-Full-2.1.5.pkg",
      "Interceptor-Browser-2.1.5.pkg",
      "Interceptor-Browser-2.1.5-linux-x64.tar.gz",
      "Interceptor-Full-2.1.5-linux-arm64.tar.gz",
    ])
  })

  test("names the version-less /latest/ link for each OS, CPU and edition", () => {
    const r = lib(`latest_name Darwin arm64 full; latest_name Darwin arm64 browser; latest_name Linux x64 browser; latest_name Linux arm64 full`)
    expect(r.status).toBe(0)
    expect(r.stdout.trim().split("\n")).toEqual([
      "Interceptor-Full.pkg",
      "Interceptor-Browser.pkg",
      "Interceptor-Browser-linux-x64.tar.gz",
      "Interceptor-Full-linux-arm64.tar.gz",
    ])
  })

  test("accepts a matching SHA-256, including a CRLF checksum file", () => {
    const file = join(dir, "Interceptor-Full-9.9.9.pkg")
    writeFileSync(file, "payload")
    const digest = createHash("sha256").update("payload").digest("hex")
    writeFileSync(join(dir, "SUMS"), `${"0".repeat(64)}  other.pkg\r\n${digest}  Interceptor-Full-9.9.9.pkg\r\n`)
    const r = lib(`check_sum "${file}" "${join(dir, "SUMS")}" && echo ok`)
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe("ok")
  })

  test("stops on a checksum mismatch before installing anything", () => {
    const file = join(dir, "Interceptor-Browser-9.9.9.pkg")
    writeFileSync(file, "tampered")
    writeFileSync(join(dir, "BAD"), `${"a".repeat(64)}  Interceptor-Browser-9.9.9.pkg\n`)
    const r = lib(`check_sum "${file}" "${join(dir, "BAD")}"; echo reached`)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("checksum mismatch")
    expect(r.stdout).not.toContain("reached")
  })

  test("stops when the file is not listed in the checksum file", () => {
    const file = join(dir, "Interceptor-Full-1.0.0.pkg")
    writeFileSync(file, "x")
    const r = lib(`check_sum "${file}" "${join(dir, "BAD")}"`)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("is not listed")
  })

  test.if(process.platform === "darwin")("stops on a package that Hacker Valley Media did not sign", () => {
    const file = join(dir, "unsigned.pkg")
    writeFileSync(file, "not a package")
    const r = lib(`check_pkg "${file}"; echo reached`)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("nothing was installed")
    expect(r.stdout).not.toContain("reached")
  })

  // A fake archive whose install.sh only records its flag: checks the fixed folder and the
  // ~/.local/bin link a Browser install adds and a Full install must remove first
  // (scripts/install-desktop-linux.sh refuses a CLI link it did not make).
  test("Linux: Browser links the CLI from a fixed folder; switching to Full drops that link first", () => {
    const home = mkdtempSync(join(dir, "home-"))
    const src = join(dir, "archive/Interceptor-Browser-9.9.9-linux-arm64")
    mkdirSync(join(src, "scripts"), { recursive: true })
    mkdirSync(join(src, "dist"), { recursive: true })
    writeFileSync(join(src, "dist/interceptor"), "#!/bin/sh\necho interceptor 9.9.9 (test)\n", { mode: 0o755 })
    writeFileSync(join(src, "scripts/install.sh"), `#!/bin/bash\necho "flag=$1 link=$( [ -L "$HOME/.local/bin/interceptor" ] && echo yes || echo no )" >> "$HOME/calls"\n`)
    const tarball = join(dir, "fake.tar.gz")
    expect(captureShell("/usr/bin/tar", ["-czf", tarball, "-C", join(dir, "archive"), "Interceptor-Browser-9.9.9-linux-arm64"]).status).toBe(0)
    const run = (mode: string) => captureShell("/bin/bash", ["-c", `set -euo pipefail; source "$1"; install_linux "$2" "$3"`, "lib", SCRIPT, tarball, mode], {
      timeout: 10000,
      env: { ...process.env, GET_INTERCEPTOR_LIB: "1", HOME: home, XDG_DATA_HOME: join(home, ".local/share") },
    })
    const link = join(home, ".local/bin/interceptor")
    const current = join(home, ".local/share/interceptor-release/current")

    expect(run("browser").status).toBe(0)
    expect(readlinkSync(link)).toBe(join(current, "dist/interceptor"))
    expect(run("browser").status).toBe(0) // a re-run replaces the folder and keeps the link
    expect(readlinkSync(link)).toBe(join(current, "dist/interceptor"))
    expect(run("full").status).toBe(0)
    expect(existsSync(link)).toBe(false) // the Full installer makes its own link
    expect(readFileSync(join(home, "calls"), "utf8")).toBe("flag=--browser-only link=no\nflag=--browser-only link=yes\nflag=--full link=no\n")
  })

  test("offers the MCP server only to AI apps found without it", () => {
    const fake = join(dir, "fake-cli")
    writeFileSync(fake, [
      "#!/bin/sh",
      "printf '%s\\n' '○ Claude Code      detected (run: interceptor mcp install)'",
      "printf '%s\\n' '✓ Codex            configured'",
      "printf '%s\\n' '· Gemini CLI       not installed'",
      "printf '%s\\n' '○ Claude Desktop   detected (run: interceptor mcp install)'",
    ].join("\n") + "\n", { mode: 0o755 })
    const r = lib(`mcp_targets "${fake}"`)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe("claude,claude-desktop|Claude Code, Claude Desktop")
    writeFileSync(fake, "#!/bin/sh\nprintf '%s\\n' '✓ Codex            configured'\n", { mode: 0o755 })
    expect(lib(`mcp_targets "${fake}"`).stdout).toBe("|")
  })

  test("rejects an unknown option before touching the network", () => {
    const r = captureShell("/bin/bash", [SCRIPT, "--bogus"], { timeout: 10000 })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("unknown option '--bogus'")
  })

  test("--help lists every option", () => {
    const r = captureShell("/bin/bash", [SCRIPT, "--help"], { timeout: 10000 })
    expect(r.status).toBe(0)
    for (const flag of ["--full", "--browser", "--safari", "--mcp", "--mcp=LIST", "--no-mcp", "--no-skills"]) expect(r.stdout).toContain(flag)
  })
})
