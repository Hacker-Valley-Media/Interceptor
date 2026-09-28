/**
 * cli/commands/override.ts — interceptor override <urlPattern> key=value [...]
 *
 * Clean CLI surface for passive request overrides.
 * Replaces the need for: interceptor raw '{"type":"net_override_set",...}'
 */

import { sendCommand, sendCommandWs, type DaemonResponse } from "../transport"

type Result = { success: boolean; error?: string; data?: unknown }
type OverrideSender = (
  action: { type: string; [key: string]: unknown },
  tabId?: number,
  useWs?: boolean,
  contextId?: string
) => Promise<Result>

function unwrap(resp: DaemonResponse): Result {
  return resp.result
}

async function send(
  action: { type: string; [key: string]: unknown },
  tabId?: number,
  useWs = false,
  contextId?: string
): Promise<Result> {
  try {
    const resp = useWs
      ? await sendCommandWs(action, tabId, contextId)
      : await sendCommand(action, tabId, contextId)
    return unwrap(resp)
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

const RESPONSE_FLAGS = new Set(["--status", "--body", "--delay", "--content-type"])

export async function runOverride(
  filtered: string[],
  opts: { jsonMode?: boolean; useWs?: boolean; globalTabId?: number; contextId?: string },
  sender: OverrideSender = send
): Promise<void> {
  const sub = filtered[1]

  if (!sub) {
    console.error("error: interceptor override requires a URL pattern or 'clear'. Usage: interceptor override \"*pattern*\" key=value")
    process.exit(1)
  }

  if (sub === "clear") {
    const result = await sender({ type: "clear_net_overrides" }, opts.globalTabId, opts.useWs, opts.contextId)
    if (opts.jsonMode) {
      console.log(JSON.stringify(result, null, 2))
    } else if (result.success) {
      console.log("overrides cleared")
    } else {
      console.error(`error: ${result.error}`)
      process.exit(1)
    }
    return
  }

  const urlPattern = sub
  const queryAddOrReplace: Record<string, string> = {}
  const response: { status?: number; body?: string; contentType?: string; delayMs?: number } = {}
  const fail = (msg: string): never => {
    console.error(`error: ${msg}`)
    process.exit(1)
  }

  for (let i = 2; i < filtered.length; i++) {
    const arg = filtered[i]
    if (RESPONSE_FLAGS.has(arg)) {
      const value = filtered[++i]
      if (value === undefined || RESPONSE_FLAGS.has(value)) fail(`${arg} needs a value`)
      if (arg === "--status") {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 200 || n > 599) fail(`--status must be an integer from 200 to 599, got '${value}'`)
        response.status = n
      } else if (arg === "--delay") {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 0 || n > 600_000) fail(`--delay must be milliseconds from 0 to 600000, got '${value}'`)
        response.delayMs = n
      } else if (arg === "--body") {
        response.body = value
      } else {
        response.contentType = value
      }
      continue
    }
    if (arg.startsWith("--")) continue
    const eqIdx = arg.indexOf("=")
    if (eqIdx <= 0) {
      console.error(`error: invalid key=value pair: '${arg}'. Each override must be key=value.`)
      process.exit(1)
    }
    const key = arg.slice(0, eqIdx)
    const value = arg.slice(eqIdx + 1)
    queryAddOrReplace[key] = value
    // key=value always rewrites the query string; say so when it looks like a response override.
    if (key === "status" || key === "delay" || key === "body") {
      console.error(`note: ${key}=${value} rewrites the query parameter '${key}'. To change the response, use --${key} ${value}.`)
    }
  }

  if (Object.keys(queryAddOrReplace).length === 0 && Object.keys(response).length === 0) {
    fail("interceptor override needs a key=value query pair or a response flag. Usage: interceptor override \"*pattern*\" count=5 | --status 500 [--body <text>] [--delay <ms>]")
  }
  if (response.contentType !== undefined && response.status === undefined && response.body === undefined) {
    fail("--content-type only applies with --status or --body")
  }

  const rules = [{ urlPattern, ...(Object.keys(queryAddOrReplace).length ? { queryAddOrReplace } : {}), ...response }]
  const result = await sender({ type: "set_net_overrides", rules }, opts.globalTabId, opts.useWs, opts.contextId)

  if (opts.jsonMode) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result.success) {
    const parts = Object.entries(queryAddOrReplace).map(([k, v]) => `${k}=${v}`)
    if (response.status !== undefined || response.body !== undefined) {
      parts.push(`respond ${response.status ?? 200}${response.body !== undefined ? ` (${response.body.length} chars)` : ""} without sending`)
    }
    if (response.delayMs !== undefined) parts.push(`delay ${response.delayMs} ms`)
    console.log(`override set: ${urlPattern} → ${parts.join(", ")}`)
  } else {
    console.error(`error: ${result.error}`)
    process.exit(1)
  }
}
