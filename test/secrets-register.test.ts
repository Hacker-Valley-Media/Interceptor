/**
 * test/secrets-register.test.ts — issue #244 registration and CLI surface:
 * the box path forwards name/gate/targets (never a value), values never ride
 * argv, and the sudo leg pipes the password to stdin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseMacosCommand } from "../cli/commands/macos"
import { parseActionsCommand } from "../cli/commands/actions"
import { normalizeArgsSplit } from "../cli/normalize"
import { runSudo } from "../daemon/secrets"

let exitCode: number | undefined
let errors: string[] = []
const realExit = process.exit
const realConsoleError = console.error

beforeEach(() => {
  exitCode = undefined
  errors = []
  process.exit = ((code?: number) => { exitCode = code; throw new Error(`__exit_${code}`) }) as never
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")) }
})
afterEach(() => { process.exit = realExit; console.error = realConsoleError })

describe("macos secret CLI shape", () => {
  test("register forwards name, gate, targets, reuse and never a value", () => {
    const a = parseMacosCommand(["macos", "secret", "register", "admin", "--gate", "touchid", "--target", "sudo", "--target", "macos:com.apple.SecurityAgent,browser:x.com", "--reuse", "300"]) as Record<string, unknown>
    expect(a).toEqual({ type: "macos_secret", sub: "register", name: "admin", gate: "touchid", targets: ["sudo", "macos:com.apple.SecurityAgent", "browser:x.com"], reuseSeconds: 300 })
    expect(JSON.stringify(a)).not.toContain("value")
  })

  test("a value on argv is refused for register and set", () => {
    expect(() => parseMacosCommand(["macos", "secret", "set", "admin", "hunter2"])).toThrow("__exit_1")
    expect(errors.join("\n")).toContain("never pass the secret value on argv")
    expect(() => parseMacosCommand(["macos", "secret", "register", "admin", "hunter2"])).toThrow("__exit_1")
  })

  test("set --stdin marks the stdin path; other verbs parse", () => {
    expect(parseMacosCommand(["macos", "secret", "set", "admin", "--stdin"])).toEqual({ type: "macos_secret", sub: "set", name: "admin", stdin: true })
    expect(parseMacosCommand(["macos", "secret", "list"])).toEqual({ type: "macos_secret", sub: "list" })
    expect(parseMacosCommand(["macos", "secret", "status"])).toEqual({ type: "macos_secret", sub: "status" })
    expect(parseMacosCommand(["macos", "secret", "rm", "admin"])).toEqual({ type: "macos_secret", sub: "rm", name: "admin" })
    expect(parseMacosCommand(["macos", "secret", "unlock", "admin", "--for", "30m"])).toEqual({ type: "macos_secret", sub: "unlock", name: "admin", for: "30m" })
    expect(parseMacosCommand(["macos", "secret", "lock"])).toEqual({ type: "macos_secret", sub: "lock" })
    expect(parseMacosCommand(["macos", "secret", "reveal", "admin"])).toEqual({ type: "macos_secret", sub: "reveal", name: "admin" })
    expect(() => parseMacosCommand(["macos", "secret", "unlock", "admin"])).toThrow("__exit_1")
    expect(() => parseMacosCommand(["macos", "secret", "frobnicate"])).toThrow("__exit_1")
    expect(() => parseMacosCommand(["macos", "secret", "rm"])).toThrow("__exit_1")
  })

  test("macos type --secret is by name and refuses literal text", () => {
    expect(parseMacosCommand(["macos", "type", "--secret", "admin"])).toEqual({ type: "macos_type", secret: "admin" })
    expect(parseMacosCommand(["macos", "type", "e4", "--secret", "admin", "--app", "TextEdit"])).toEqual({ type: "macos_type", secret: "admin", ref: "e4", app: "TextEdit" })
    expect(() => parseMacosCommand(["macos", "type", "e4", "hello", "--secret", "admin"])).toThrow("__exit_1")
    expect(errors.join("\n")).toContain("mutually exclusive")
    // the literal path is unchanged
    expect(parseMacosCommand(["macos", "type", "e4", "hello"])).toEqual({ type: "macos_type", ref: "e4", text: "hello" })
  })

  test("macos sudo needs --secret and a command after --", () => {
    expect(parseMacosCommand(["macos", "sudo", "--secret", "admin", "--keep", "--", "installer", "-pkg", "x.pkg", "-target", "/"]))
      .toEqual({ type: "macos_sudo", secret: "admin", keep: true, cmd: ["installer", "-pkg", "x.pkg", "-target", "/"] })
    expect(() => parseMacosCommand(["macos", "sudo", "--", "id"])).toThrow("__exit_1")
    expect(() => parseMacosCommand(["macos", "sudo", "--secret", "admin"])).toThrow("__exit_1")
  })

  test("macos authdialog shapes", () => {
    expect(parseMacosCommand(["macos", "authdialog", "status"])).toEqual({ type: "macos_authdialog", sub: "status" })
    expect(parseMacosCommand(["macos", "authdialog", "fill", "--secret", "admin", "--submit"])).toEqual({ type: "macos_authdialog", sub: "fill", secret: "admin", submit: true })
    expect(() => parseMacosCommand(["macos", "authdialog", "fill"])).toThrow("__exit_1")
  })
})

describe("browser type --secret", () => {
  test("normalizer accepts --secret as a value flag and the parser emits a by-name action", () => {
    const n = normalizeArgsSplit(["type", "e3", "--secret", "site-pw"])
    expect(n.argv).toEqual(["type", "e3", "--secret", "site-pw"])
    expect(n.positionalCount).toBe(1)
    expect(parseActionsCommand(n.argv, n.positionalCount)).toEqual({ type: "input_text", ref: "e3", secret: "site-pw", clear: true })
    const os = normalizeArgsSplit(["type", "e3", "--secret", "site-pw", "--trusted"])
    expect(parseActionsCommand(os.argv, os.positionalCount)).toEqual({ type: "os_type", ref: "e3", secret: "site-pw" })
    const sem = normalizeArgsSplit(["type", "textbox:Password", "--secret", "site-pw", "--append"])
    expect(parseActionsCommand(sem.argv, sem.positionalCount)).toMatchObject({ type: "find_and_type", secret: "site-pw", clear: false })
  })

  test("literal text plus --secret is a hard error; literal path unchanged", () => {
    const n = normalizeArgsSplit(["type", "e3", "hello", "--secret", "site-pw"])
    expect(() => parseActionsCommand(n.argv, n.positionalCount)).toThrow("__exit_1")
    expect(errors.join("\n")).toContain("mutually exclusive")
    const plain = normalizeArgsSplit(["type", "e3", "hello", "world"])
    expect(parseActionsCommand(plain.argv, plain.positionalCount)).toEqual({ type: "input_text", ref: "e3", text: "hello world", clear: true })
  })
})

describe("sudo delivery leg", () => {
  test("pipes the value to stdin with -S -k and classifies a rejected password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "interceptor-sudo-"))
    const fake = join(dir, "sudo")
    // A stand-in for /usr/bin/sudo: records argv, reads the password from
    // stdin, accepts exactly "right", and mimics sudo's failure text otherwise.
    writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$*" > "${dir}/argv"
read -r pw
if [ "$pw" = "right" ]; then shift; while [ "$1" != "--" ]; do shift; done; shift; exec "$@"; fi
echo "Sorry, try again." >&2
echo "sudo: 1 incorrect password attempt" >&2
exit 1
`)
    chmodSync(fake, 0o755)
    try {
      const ok = await runSudo("right", ["/bin/echo", "root-ran"], { sudoPath: fake })
      expect(ok.success).toBe(true)
      expect(ok.data?.stdout.trim()).toBe("root-ran")
      const argv = (await Bun.file(join(dir, "argv")).text()).trim()
      expect(argv).toBe("-S -k -p  -- /bin/echo root-ran")
      expect(argv).not.toContain("right")

      const keep = await runSudo("right", ["/bin/echo", "x"], { sudoPath: fake, keep: true })
      expect(keep.success).toBe(true)
      expect((await Bun.file(join(dir, "argv")).text()).trim()).toBe("-S -p  -- /bin/echo x")

      const bad = await runSudo("wrong", ["/bin/echo", "never"], { sudoPath: fake })
      expect(bad.success).toBe(false)
      expect(bad.error).toContain("rejected the stored password")
      expect(bad.data?.stdout).toBe("")

      const none = await runSudo("right", [], { sudoPath: fake })
      expect(none.success).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
