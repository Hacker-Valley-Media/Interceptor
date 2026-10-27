/**
 * cli/commands/mcp.ts — `interceptor mcp {serve|install|uninstall|status}`.
 *
 * `serve` boots the MCP server over stdio (server + SDK are dynamically imported
 * so `install`/`status` stay SDK-free and fast). `install` auto-registers the
 * server into every detected AI runtime (Claude Code, Codex, Gemini, Cursor,
 * Claude Desktop) — the one-command setup, mirroring `skills adopt`.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import {
  applyClient, CLIENTS, detectClients, printSnippets, SERVER_NAME, type Client,
} from "../mcp/install"

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : undefined
}

function parseInto(args: string[]): string[] | undefined {
  const v = flagValue(args, "--into")
  return v ? v.split(",").map(s => s.trim()).filter(Boolean) : undefined
}

function clientsFor(into: string[] | undefined): Client[] {
  if (into) return CLIENTS.filter(c => into.includes(c.id))
  return detectClients()
}

function isConfigured(client: Client): boolean {
  const path = client.configPath(homedir(), process.env)
  if (!existsSync(path)) return false
  try {
    const text = readFileSync(path, "utf-8")
    if (client.fmt === "json") {
      const obj = JSON.parse(text)
      return !!(obj?.mcpServers && obj.mcpServers[SERVER_NAME])
    }
    return new RegExp(`\\[\\s*mcp_servers\\.${SERVER_NAME}\\s*\\]`).test(text)
  } catch { return false }
}

function runInstall(args: string[], jsonMode: boolean, remove: boolean): void {
  const allow = flagValue(args, "--allow")
  const into = parseInto(args)

  if (!remove && args.includes("--print")) {
    console.log(printSnippets(allow))
    return
  }

  const clients = clientsFor(into)
  if (clients.length === 0) {
    if (into) console.error(`error: no known clients match --into ${into.join(",")}. Known: ${CLIENTS.map(c => c.id).join(", ")}`)
    else console.error("no AI runtimes detected (~/.claude, ~/.codex, ~/.gemini, ~/.cursor, Claude Desktop).\n" +
      "Run 'interceptor mcp install --print' for copy-paste config, or '--into <id>' to target one explicitly.")
    process.exit(into ? 1 : 0)
  }

  const results = clients.map(c => applyClient(c, { allow, remove }))
  if (jsonMode) { console.log(JSON.stringify(results, null, 2)); return }

  for (const r of results) {
    const mark = r.action === "error" ? "✗" : r.action === "unchanged" ? "•" : "✓"
    console.log(`${mark} ${r.label.padEnd(16)} ${r.action.padEnd(10)} ${r.path}${r.detail ? " — " + r.detail : ""}`)
  }
  if (!remove) {
    console.log("\nRestart the client (or reload its MCP servers) to pick up `interceptor`.")
    if (!allow) console.log("Only read+mutate verbs run by default. To allow destructive/exec verbs, re-run with --allow destructive,arbitrary-exec.")
  }
}

function runStatus(jsonMode: boolean): void {
  const rows = CLIENTS.map(c => ({
    id: c.id, label: c.label,
    detected: c.detect(homedir(), process.env),
    configured: isConfigured(c),
    path: c.configPath(homedir(), process.env),
  }))
  if (jsonMode) { console.log(JSON.stringify(rows, null, 2)); return }
  for (const r of rows) {
    const state = r.configured ? "configured" : r.detected ? "detected (run: interceptor mcp install)" : "not installed"
    console.log(`${(r.configured ? "✓" : r.detected ? "○" : "·")} ${r.label.padEnd(16)} ${state}`)
  }
}

export async function runMcpCommand(argv: string[], opts: { jsonMode?: boolean } = {}): Promise<void> {
  const sub = argv[1] || "help"
  // cli/index.ts strips global flags (--json among them) from argv, so it passes jsonMode here.
  const jsonMode = opts.jsonMode ?? argv.includes("--json")

  if (sub === "install") return runInstall(argv, jsonMode, false)
  if (sub === "uninstall") return runInstall(argv, jsonMode, true)
  if (sub === "status") return runStatus(jsonMode)

  if (sub === "serve") {
    process.stderr.write("interceptor mcp: warming daemon…\n")
    const { buildServer, warmDaemon } = await import("../mcp/server")
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js")
    await warmDaemon()
    const server = buildServer()
    const transport = new StdioServerTransport()
    await server.connect(transport)
    process.stderr.write("interceptor mcp: serving over stdio (Ctrl-C to stop)\n")
    // StdioServerTransport keeps process.stdin open, holding the event loop alive.
    return
  }

  if (sub === "help" || sub === "--help" || sub === "-h") {
    console.log([
      "interceptor mcp — expose Interceptor over the Model Context Protocol",
      "",
      "  interceptor mcp install [--into <ids>] [--allow <tiers>] [--print] [--json]",
      "      Auto-register the server into every detected AI runtime",
      "      (claude, codex, gemini, cursor, claude-desktop). --print dumps config",
      "      snippets without writing. --allow sets INTERCEPTOR_MCP_ALLOW.",
      "  interceptor mcp uninstall [--into <ids>] [--json]   Remove the registration",
      "  interceptor mcp status [--json]                     Where it's configured",
      "  interceptor mcp serve                               Run the server (stdio)",
      "",
      "Docs: docs/mcp.md",
    ].join("\n"))
    return
  }

  console.error(`error: unknown mcp subcommand '${sub}'.\nUsage: interceptor mcp {serve|install|uninstall|status}`)
  process.exit(1)
}
