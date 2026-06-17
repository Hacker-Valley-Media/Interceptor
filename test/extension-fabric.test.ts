import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  discoverExtensions,
  extensionsRoot,
  extensionMacosPrefixes,
  extensionActionType,
  validateManifestShape,
  BUILTIN_BRIDGE_PREFIXES,
} from "../shared/extensions"
import { parseMacosCommand } from "../cli/commands/macos"

// Extension Fabric — discovery + CLI routing + capability-blind invariants.

let root: string
const prevEnv = process.env.INTERCEPTOR_EXTENSIONS_DIR

function writeExtension(name: string, manifest: unknown, opts: { skill?: boolean } = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
  if (opts.skill) {
    mkdirSync(join(dir, "skill"), { recursive: true })
    writeFileSync(join(dir, "skill", "SKILL.md"), "# fixture skill\n")
  }
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "itc-ext-"))
  process.env.INTERCEPTOR_EXTENSIONS_DIR = root
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  if (prevEnv === undefined) delete process.env.INTERCEPTOR_EXTENSIONS_DIR
  else process.env.INTERCEPTOR_EXTENSIONS_DIR = prevEnv
})

describe("extension discovery", () => {
  test("root honors INTERCEPTOR_EXTENSIONS_DIR", () => {
    expect(extensionsRoot()).toBe(root)
  })

  test("discovers a valid extension and exposes its prefixes", () => {
    writeExtension("audit-tool", {
      name: "audit-tool",
      version: "1.0.0",
      bridgeDomains: [{ prefix: "auditx", dylib: "bridge/h.dylib", entry: "itc_ext_handle" }],
      cliVerbs: [{ verb: "run", actionPrefix: "auditx" }],
      agent: { arm64: "agent/InterceptorAgent-arm64.dylib" },
      skill: "skill/",
    }, { skill: true })

    const result = discoverExtensions()
    expect(result.extensions.length).toBe(1)
    expect(result.extensions[0].name).toBe("audit-tool")
    expect(result.rejected.length).toBe(0)

    const prefixes = extensionMacosPrefixes(result)
    expect(prefixes.has("auditx")).toBe(true)
  })

  test("rejects (not throws) a malformed manifest, never silently drops", () => {
    writeExtension("bad", { name: "bad" }) // missing version
    const result = discoverExtensions()
    expect(result.extensions.length).toBe(0)
    expect(result.rejected.length).toBe(1)
    expect(result.rejected[0].error).toContain("version")
  })

  test("rejects a prefix that collides with a built-in domain", () => {
    const err = validateManifestShape({
      name: "evil",
      version: "1.0.0",
      bridgeDomains: [{ prefix: "native", dylib: "b.dylib", entry: "e" }],
    })
    expect(err).toContain("collides with a built-in")
  })

  test("rejects a multi-token (underscore) prefix that would truncate routing", () => {
    const err = validateManifestShape({
      name: "evil",
      version: "1.0.0",
      bridgeDomains: [{ prefix: "my_ext", dylib: "b.dylib", entry: "e" }],
    })
    expect(err).toMatch(/prefix must match/)
  })

  test("empty / missing root yields no extensions (filesystem-only, no fetch)", () => {
    rmSync(root, { recursive: true, force: true })
    const result = discoverExtensions()
    expect(result.extensions.length).toBe(0)
    expect(result.rejected.length).toBe(0)
  })
})

describe("extension CLI routing (C5)", () => {
  test("a declared prefix routes macos <prefix> <cmd> to macos_<prefix>_<cmd>", () => {
    writeExtension("audit-tool", {
      name: "audit-tool",
      version: "1.0.0",
      bridgeDomains: [{ prefix: "auditx", dylib: "bridge/h.dylib", entry: "itc_ext_handle" }],
    })
    const prefixes = extensionMacosPrefixes()
    const action = parseMacosCommand(["macos", "auditx", "run", "Target.app", "--confirm"], prefixes)
    expect(action).not.toBeNull()
    expect(action!.type).toBe("macos_auditx_run")
    expect(action!.sub).toBe("run")
    expect(action!.args).toEqual(["Target.app"])
    expect((action!.flags as Record<string, unknown>).confirm).toBe(true)
  })

  test("hyphenated verbs normalize to underscores in the type (mirrors vm)", () => {
    expect(extensionActionType("auditx", "dump-entitlements")).toBe("macos_auditx_dump_entitlements")
  })

  test("a built-in macos subcommand still parses normally", () => {
    const action = parseMacosCommand(["macos", "tree"], new Set(["auditx"]))
    expect(action!.type).toBe("macos_tree")
  })
})

describe("capability-blind invariants", () => {
  test("BUILTIN_BRIDGE_PREFIXES stays in sync with main.swift router.register calls", () => {
    const main = readFileSync(join(import.meta.dir, "..", "interceptor-bridge", "Sources", "main.swift"), "utf8")
    const re = /router\.register\("([a-z][a-z0-9]*)"/g
    const registered = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = re.exec(main)) !== null) registered.add(m[1])
    expect(registered.size).toBeGreaterThan(40)
    const missing = [...registered].filter(p => !BUILTIN_BRIDGE_PREFIXES.has(p))
    expect(missing).toEqual([])
  })

  test("shared discovery code contains no network fetch", () => {
    const src = readFileSync(join(import.meta.dir, "..", "shared", "extensions.ts"), "utf8")
    expect(/\bfetch\s*\(|https?:\/\/|\bcurl\b|XMLHttpRequest/.test(src)).toBe(false)
  })
})
