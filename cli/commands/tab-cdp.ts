/**
 * cli/commands/tab-cdp.ts — `interceptor tab cdp <sub>`: raw CDP on a browser tab.
 *
 * The extension relays chrome.debugger: `send` runs any CDP method, `events`
 * streams the tab's CDP events as NDJSON, `attach`/`detach` hold the debugger
 * across calls. `interceptor macos cdp` is a different surface (Electron apps
 * over their own debug port).
 *
 * These verbs use the IPC socket only. The daemon refuses raw CDP on its
 * loopback WebSocket, which a web page can reach.
 */

import { sendCommand, openDaemonStream, type DaemonResult } from "../transport"
import { formatResult } from "../format"
import { staleExtensionHint } from "./diagnose"
import { VERSION } from "../version"

type Action = { type: string; [key: string]: unknown }
type Opts = { jsonMode: boolean; globalTabId?: number; anyTab?: boolean; contextId?: string }

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i === -1) return undefined
  return args[i + 1]
}

/** An extension from before raw CDP answers "unknown action type"; name the fix for that copy. */
async function reportFailure(result: DaemonResult, opts: Opts): Promise<never> {
  if (typeof result.error === "string" && result.error.startsWith("unknown action type:")) {
    process.stderr.write(`${await staleExtensionHint(VERSION, opts.contextId)}\n`)
  }
  console.error(formatResult(result, opts.jsonMode))
  process.exit(1)
}

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

function positiveInt(args: string[], flag: string): number | undefined {
  const raw = flagValue(args, flag)
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw) || Number(raw) === 0) fail(`${flag} must be a positive integer`)
  return Number(raw)
}

/** Parse the one-shot verbs into their action; exported for tests. */
export function parseTabCdpCommand(filtered: string[]): Action | { error: string } {
  const sub = filtered[1]
  switch (sub) {
    case "attach": return { type: "cdp_tab_attach" }
    case "detach": return { type: "cdp_tab_detach" }
    case "status": return { type: "cdp_tab_status" }
    case "send": {
      const method = filtered[2]
      if (!method || method.startsWith("--")) return { error: "usage: interceptor tab cdp send <Domain.method> [jsonParams] [--tab <id>]" }
      const rawParams = filtered[3] && !filtered[3].startsWith("--") ? filtered[3] : undefined
      let params: unknown
      if (rawParams !== undefined) {
        try { params = JSON.parse(rawParams) } catch (err) {
          return { error: `params are not valid JSON: ${(err as Error).message}` }
        }
        if (params === null || typeof params !== "object" || Array.isArray(params)) {
          return { error: "params must be a JSON object, for example '{\"format\":\"jpeg\"}'" }
        }
      }
      const sessionId = flagValue(filtered, "--session")
      return { type: "cdp_tab_send", method, ...(params !== undefined ? { params } : {}), ...(sessionId ? { sessionId } : {}) }
    }
    default:
      return { error: `unknown tab cdp subcommand '${sub}'. Try: send, events, attach, detach, status.` }
  }
}

async function runEvents(filtered: string[], opts: Opts): Promise<void> {
  const filter = flagValue(filtered, "--filter")
  const limit = positiveInt(filtered, "--limit")
  const timeoutMs = positiveInt(filtered, "--timeout")
  const action: Action = {
    type: "cdp_tab_events",
    ...(filter ? { filter: filter.split(",").map(f => f.trim()).filter(Boolean) } : {}),
    ...(filtered.includes("--no-attach") ? { attach: false } : {}),
    ...(opts.anyTab ? { anyTab: true } : {}),
  }
  let seen = 0
  let stream: Awaited<ReturnType<typeof openDaemonStream>> | undefined
  // The subscription can deliver before its opening answer is handled here.
  const early: string[] = []
  const emit = (line: string): void => {
    process.stdout.write(line + "\n")
    seen += 1
    if (limit !== undefined && seen >= limit) stream?.close()
  }
  try {
    stream = await openDaemonStream(action, opts.globalTabId, opts.contextId, (frame) => {
      if (frame.type !== "cdp_event") return
      const { type: _type, subscription: _subscription, ...event } = frame
      const line = JSON.stringify(event)
      if (stream) emit(line)
      else early.push(line)
    })
  } catch (err) {
    fail((err as Error).message)
  }
  const result = stream.response.result
  if (!result.success) {
    stream.close()
    await reportFailure(result, opts)
  }
  const data = (result.data ?? {}) as { tabId?: number; attached?: boolean }
  process.stderr.write(`subscribed: tab ${data.tabId ?? "?"}, debugger ${data.attached ? "attached" : "not attached"}; Ctrl-C to stop\n`)
  for (const line of early) emit(line)
  // A reader that goes away (`| head`) ends the subscription.
  process.stdout.on("error", () => stream.close())
  process.on("SIGINT", () => stream.close())
  process.on("SIGTERM", () => stream.close())
  const timer = timeoutMs !== undefined ? setTimeout(() => stream.close(), timeoutMs) : undefined
  await stream.closed
  if (timer) clearTimeout(timer)
  process.exit(0)
}

export async function runTabCdpCommand(filtered: string[], opts: Opts): Promise<void> {
  const sub = filtered[1]
  if (!sub || sub === "help") {
    console.log(TAB_CDP_HELP)
    return
  }
  if (sub === "events") {
    await runEvents(filtered, opts)
    return
  }
  const action = parseTabCdpCommand(filtered)
  if ("error" in action) fail(action.error as string)
  if (opts.anyTab) action.anyTab = true
  let result: DaemonResult
  try {
    result = (await sendCommand(action as Action, opts.globalTabId, opts.contextId)).result
  } catch (err) {
    fail((err as Error).message)
  }
  if (!result.success) await reportFailure(result, opts)
  console.log(formatResult(result, opts.jsonMode))
}

export const TAB_CDP_HELP = `interceptor tab cdp — raw Chrome DevTools Protocol on a browser tab

Usage:
  interceptor tab cdp send <Domain.method> [jsonParams] [--session <id>]   Run one CDP method, print its result
  interceptor tab cdp events [--filter Page.,Fetch.] [--no-attach] [--limit N] [--timeout ms]
                                                                    Stream the tab's CDP events as NDJSON
  interceptor tab cdp attach                                             Keep the debugger attached across calls
  interceptor tab cdp detach                                             End the tab's raw session
  interceptor tab cdp status                                             List raw sessions in this profile

send      Without a session the debugger attaches, runs the method and detaches.
          With one (after 'tab cdp attach', or while 'tab cdp events' runs) it stays
          attached, which Page.startScreencast and Fetch.enable need.
events    One JSON object per line: {tabId, method, params[, sessionId]}. Holds
          the debugger attached until the stream ends (--no-attach: listen only).
          --filter keeps methods that start with one of the prefixes. Session
          events always pass: Interceptor.detached {reason}, Interceptor.tabCreated
          {tabId, openerTabId, url}, Interceptor.tabRemoved {tabId},
          Interceptor.subscriptionEnded {reason}.
attach    Stays attached until 'tab cdp detach', the tab closes, or the person
          clicks Cancel on Chrome's debugging bar. Not released when the caller
          exits; 'tab cdp events' is.

Target the tab with --tab <id>. Nothing here activates a tab or focuses a
window. Chrome shows its "started debugging this browser" bar while attached.
A tab takes one debugger client: a tab another extension has attached is refused.
Chromium browsers only. These verbs always use the local IPC socket.
`
