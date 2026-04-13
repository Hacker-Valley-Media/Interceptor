/**
 * cli/commands/override.ts — interceptor override <urlPattern> key=value [...]
 *
 * Clean CLI surface for passive request overrides.
 * Replaces the need for: interceptor raw '{"type":"net_override_set",...}'
 */

import { sendCommand, sendCommandWs, type DaemonResponse } from "../transport"

type Result = { success: boolean; error?: string; data?: unknown }

function unwrap(resp: DaemonResponse): Result {
  return resp.result
}

async function send(
  action: { type: string; [key: string]: unknown },
  tabId?: number,
  useWs = false
): Promise<Result> {
  try {
    const resp = useWs
      ? await sendCommandWs(action, tabId)
      : await sendCommand(action, tabId)
    return unwrap(resp)
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export async function runOverride(
  filtered: string[],
  opts: { jsonMode?: boolean; useWs?: boolean; globalTabId?: number }
): Promise<void> {
  const sub = filtered[1]

  if (!sub) {
    console.error("error: interceptor override requires a URL pattern or 'clear'. Usage: interceptor override \"*pattern*\" key=value")
    process.exit(1)
  }

  if (sub === "clear") {
    const result = await send({ type: "clear_net_overrides" }, opts.globalTabId, opts.useWs)
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

  for (let i = 2; i < filtered.length; i++) {
    const arg = filtered[i]
    if (arg.startsWith("--")) continue
    const eqIdx = arg.indexOf("=")
    if (eqIdx <= 0) {
      console.error(`error: invalid key=value pair: '${arg}'. Each override must be key=value.`)
      process.exit(1)
    }
    const key = arg.slice(0, eqIdx)
    const value = arg.slice(eqIdx + 1)
    queryAddOrReplace[key] = value
  }

  if (Object.keys(queryAddOrReplace).length === 0) {
    console.error("error: interceptor override requires at least one key=value pair. Usage: interceptor override \"*pattern*\" count=5")
    process.exit(1)
  }

  const rules = [{ urlPattern, queryAddOrReplace }]
  const result = await send({ type: "set_net_overrides", rules }, opts.globalTabId, opts.useWs)

  if (opts.jsonMode) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result.success) {
    const pairs = Object.entries(queryAddOrReplace).map(([k, v]) => `${k}=${v}`).join(", ")
    console.log(`override set: ${urlPattern} → ${pairs}`)
  } else {
    console.error(`error: ${result.error}`)
    process.exit(1)
  }
}
