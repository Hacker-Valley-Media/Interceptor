import { captureSubprocess } from "../../daemon/subprocess"

/**
 * cli/mcp/adapter.ts — the subprocess seam.
 *
 * The MCP server re-implements no verb: every tool call shells out to the same
 * `interceptor` binary the server itself runs as. That reuses arg parsing,
 * compound fan-out, group injection, daemon auto-spawn, upload chunking, and
 * result formatting (cli/index.ts) for free. Each call is its own process → its
 * own one-shot socket connection → concurrency + group isolation inherited.
 */

/**
 * How to re-invoke the CLI. When compiled (`bun build --compile`), argv[1] is
 * absent and process.execPath IS the interceptor binary → run it directly. In
 * dev (`bun run cli/index.ts mcp serve`), execPath is bun and argv[1] is the
 * script → run `bun <script> …`.
 */
function selfPrefix(): string[] {
  const argv1 = process.argv[1]
  if (argv1 && (argv1.endsWith(".ts") || argv1.endsWith(".js"))) {
    return [process.execPath, argv1]
  }
  return [process.execPath]
}

export type RunResult = { stdout: string; stderr: string; code: number }

/** Run `interceptor <args>` and capture stdout/stderr/exit code. Never throws. */
export async function runInterceptor(args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  const cmd = [...selfPrefix(), ...args]
  // Preserve the model-driven marker, public result fields and error wording.
  return captureSubprocess(cmd, { ...opts, name: "interceptor", timeoutLabel: "interceptor-mcp", env: { ...process.env, INTERCEPTOR_MCP: "1" } })
}

/**
 * Warm the daemon at session start. `interceptor contexts` uses the Unix-socket
 * path (not in NO_DAEMON), so it triggers ensureDaemon() — guaranteeing the
 * WS-only `screenshot`/`save` verbs (which skip auto-spawn) find a live daemon.
 * Best-effort: a missing browser is fine, we only need the daemon up.
 */
export async function warmDaemon(): Promise<void> {
  try { await runInterceptor(["contexts"], { timeoutMs: 20_000 }) } catch {}
}

/** Inject session-scoped global flags the model shouldn't have to remember. */
export function withGlobalFlags(
  args: string[],
  opts: { group?: string; context?: string; tab?: number; device?: string; session?: string },
): string[] {
  const out = [...args]
  const end = out.indexOf("--"), literalArgs = end < 0 ? [] : out.splice(end)
  const has = (f: string) => out.includes(f)
  if (opts.group && !has("--group")) out.push("--group", opts.group)
  if (opts.context && !has("--context")) out.push("--context", opts.context)
  if (opts.tab !== undefined && !has("--tab")) out.push("--tab", String(opts.tab))
  if (opts.device && !has("--on") && !has("--context")) out.push("--on", opts.device)
  if (opts.session && !has("--session")) out.push("--session", opts.session)
  return [...out, ...literalArgs]
}
