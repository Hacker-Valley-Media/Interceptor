import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureShell } from "./helpers/shell-capture"

import {
  detectClients, interceptorInvocation, mergeJson, mergeToml, serverEntry, stripTomlTable,
} from "../cli/mcp/install"

const EXE = "/usr/local/bin/interceptor"

describe("interceptorInvocation + serverEntry", () => {
  test("compiled binary path is used verbatim", () => {
    expect(interceptorInvocation(EXE)).toEqual({ command: EXE, args: ["mcp", "serve"] })
  })
  test("dev/bun falls back to PATH lookup", () => {
    expect(interceptorInvocation("/opt/homebrew/bin/bun")).toEqual({ command: "interceptor", args: ["mcp", "serve"] })
  })
  test("allow becomes an env block", () => {
    expect(serverEntry("destructive", EXE)).toEqual({ command: EXE, args: ["mcp", "serve"], env: { INTERCEPTOR_MCP_ALLOW: "destructive" } })
    expect(serverEntry(undefined, EXE).env).toBeUndefined()
  })
})

describe("mergeJson", () => {
  test("adds interceptor, preserves unrelated keys + other servers", () => {
    const existing = JSON.stringify({ foo: 1, mcpServers: { other: { command: "x" } } })
    const out = JSON.parse(mergeJson(existing, undefined, false, EXE))
    expect(out.foo).toBe(1)
    expect(out.mcpServers.other).toEqual({ command: "x" })
    expect(out.mcpServers.interceptor.command).toBe(EXE)
  })
  test("creates config when none exists", () => {
    const out = JSON.parse(mergeJson(null, undefined, false, EXE))
    expect(out.mcpServers.interceptor.args).toEqual(["mcp", "serve"])
  })
  test("idempotent", () => {
    const a = mergeJson(null, undefined, false, EXE)
    const b = mergeJson(a, undefined, false, EXE)
    expect(b).toBe(a)
  })
  test("remove deletes only interceptor", () => {
    const seeded = mergeJson(JSON.stringify({ mcpServers: { other: { command: "x" } } }), undefined, false, EXE)
    const removed = JSON.parse(mergeJson(seeded, undefined, true, EXE))
    expect(removed.mcpServers.interceptor).toBeUndefined()
    expect(removed.mcpServers.other).toEqual({ command: "x" })
  })
  test("refuses to clobber invalid JSON", () => {
    expect(() => mergeJson("{not json", undefined, false, EXE)).toThrow()
  })
})

describe("stripTomlTable + mergeToml", () => {
  test("strip removes the table and its env subtable, keeps others", () => {
    const t = `[foo]\na = 1\n\n[mcp_servers.interceptor]\ncommand = "x"\n\n[mcp_servers.interceptor.env]\nK = "v"\n\n[bar]\nb = 2\n`
    const s = stripTomlTable(t, "mcp_servers.interceptor")
    expect(s).toContain("[foo]")
    expect(s).toContain("[bar]")
    expect(s).not.toContain("mcp_servers.interceptor")
  })
  test("merge adds table + env, preserves other tables", () => {
    const out = mergeToml(`[model]\nname = "gpt"\n`, "destructive", false, EXE)
    expect(out).toContain("[model]")
    expect(out).toContain("[mcp_servers.interceptor]")
    expect(out).toContain(`command = "${EXE}"`)
    expect(out).toContain('args = ["mcp","serve"]')
    expect(out).toContain("[mcp_servers.interceptor.env]")
    expect(out).toContain('INTERCEPTOR_MCP_ALLOW = "destructive"')
  })
  test("re-merge does not duplicate the table", () => {
    const once = mergeToml("", undefined, false, EXE)
    const twice = mergeToml(once, undefined, false, EXE)
    expect((twice.match(/\[mcp_servers\.interceptor\]/g) || []).length).toBe(1)
  })
  test("remove strips the table", () => {
    const seeded = mergeToml(`[model]\nname = "gpt"\n`, undefined, false, EXE)
    const removed = mergeToml(seeded, undefined, true, EXE)
    expect(removed).toContain("[model]")
    expect(removed).not.toContain("mcp_servers.interceptor")
  })
})

describe("detectClients", () => {
  test("detects only runtimes whose home dir exists", () => {
    const home = mkdtempSync(join(tmpdir(), "itc-mcp-"))
    mkdirSync(join(home, ".gemini"))
    mkdirSync(join(home, ".cursor"))
    const ids = detectClients(home, {}).map(c => c.id)
    expect(ids).toContain("gemini")
    expect(ids).toContain("cursor")
    expect(ids).not.toContain("codex")
    expect(ids).not.toContain("claude")
  })
})

// cli/index.ts strips --json from the argv it hands commands; mcp must still print JSON.
describe("interceptor mcp status --json through the CLI entry point", () => {
  test("prints a JSON array, not the text table", () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-status-json-"))
    mkdirSync(join(home, ".codex"))
    const r = captureShell(process.execPath, [join(import.meta.dir, "../cli/index.ts"), "mcp", "status", "--json"], {
      timeout: 30000,
      env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), INTERCEPTOR_NO_SKILLS_HINT: "1" },
    })
    const rows = JSON.parse(String(r.stdout)) as { id: string; detected: boolean; configured: boolean }[]
    expect(rows.find(row => row.id === "codex")).toMatchObject({ detected: true, configured: false })
  })
})
