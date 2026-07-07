/**
 * cli/commands/csp.ts — interceptor csp off|on|status [--no-reload]
 *
 * Browser-global toggle that disables (or restores) Content-Security-Policy so
 * injected page-origin JS runs even on strict-CSP sites. It affects ALL tabs,
 * current and future — one declarativeNetRequest rule with no tab scope.
 *
 *   interceptor csp off      disable CSP on every tab (reloads open tabs to apply)
 *   interceptor csp on       restore CSP on every tab
 *   interceptor csp status   is CSP currently disabled?
 *
 * `disable`/`enable` are accepted as aliases for `off`/`on`. `--no-reload`
 * installs/removes the rule without reloading open tabs (each tab then applies
 * the change on its next navigation; new tabs are covered either way).
 */

import { sendCommand, sendCommandWs, type DaemonResponse } from "../transport"

type Result = { success: boolean; error?: string; data?: unknown }
type CspSender = (
  action: { type: string; [key: string]: unknown },
  tabId?: number,
  useWs?: boolean,
  contextId?: string
) => Promise<Result>

async function send(
  action: { type: string; [key: string]: unknown },
  tabId?: number,
  useWs = false,
  contextId?: string
): Promise<Result> {
  try {
    const resp: DaemonResponse = useWs
      ? await sendCommandWs(action, tabId, contextId)
      : await sendCommand(action, tabId, contextId)
    return resp.result
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

const USAGE =
  "error: interceptor csp requires a subcommand. Usage: interceptor csp off|on|status [--no-reload]"

export async function runCsp(
  filtered: string[],
  opts: { jsonMode?: boolean; useWs?: boolean; globalTabId?: number; contextId?: string },
  sender: CspSender = send
): Promise<void> {
  const sub = filtered[1]

  if (!sub) {
    console.error(USAGE)
    process.exit(1)
    return
  }

  const reload = !filtered.includes("--no-reload")

  let action: { type: string; [key: string]: unknown }
  switch (sub) {
    case "off":
    case "disable":
      action = { type: "csp_strip", reload }
      break
    case "on":
    case "enable":
      action = { type: "csp_restore", reload }
      break
    case "status":
      action = { type: "csp_status" }
      break
    default:
      console.error(`error: unknown csp subcommand '${sub}'. ${USAGE}`)
      process.exit(1)
      return
  }

  const result = await sender(action, opts.globalTabId, opts.useWs, opts.contextId)

  if (opts.jsonMode) {
    console.log(JSON.stringify(result, null, 2))
    if (!result.success) process.exit(1)
    return
  }

  if (!result.success) {
    console.error(`error: ${result.error}`)
    process.exit(1)
  }

  const data = (result.data ?? {}) as { cspStripped?: boolean; tabsReloaded?: number }

  if (sub === "status") {
    console.log(data.cspStripped ? "csp: disabled (all tabs)" : "csp: enabled (all tabs)")
    return
  }

  const applied =
    typeof data.tabsReloaded === "number" && data.tabsReloaded > 0
      ? `reloaded ${data.tabsReloaded} tab(s)`
      : "applies on next navigation"
  if (action.type === "csp_strip") {
    console.log(`CSP disabled for all tabs (${applied})`)
  } else {
    console.log(`CSP restored for all tabs (${applied})`)
  }
}
