/**
 * cli/commands/group.ts — named per-agent tab groups.
 *
 *   interceptor group list             All live tab groups (label, title, color, tab count)
 *   interceptor group close <label>    Atomically close every tab in a named group
 *
 * Scoping day-to-day work into a group is the global `--group <label>` flag
 * (or $INTERCEPTOR_GROUP), not a subcommand here.
 */

import { GROUP_LABEL_RE } from "../parse"
import type { DaemonResponse, DaemonResult } from "../transport"

type Action = { type: string; [key: string]: unknown }

type SendFn = (action: Action, tabId?: number, contextId?: string) => Promise<DaemonResponse>

/** Browser-extension context ids the daemon currently holds (daemon-local). */
export async function listExtensionContextIds(send: SendFn): Promise<string[]> {
  try {
    const resp = await Promise.race([
      send({ type: "contexts", verbose: true }, undefined, undefined),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("contexts probe timed out after 2s")), 2000)),
    ])
    const data = resp.result?.data
    if (!Array.isArray(data)) return []
    return data
      .map(e => typeof e === "string" ? { contextId: e, kind: "extension" } : e as { contextId: string; kind?: string })
      .filter(e => (e.kind ?? "extension") === "extension")
      .map(e => e.contextId)
  } catch {
    return []
  }
}

/**
 * Tab groups live per browser profile, and an agent cleaning up rarely knows
 * which profile holds its group: `group list` / `group close` without
 * --context were refused 163 times in the 2026-09-10 review. With several
 * extension contexts connected and no context resolved, fan out: `list`
 * merges every context's groups tagged with `context`; `close` closes the
 * group wherever it exists and says where.
 */
export async function runGroupAcrossContexts(action: Action, contextIds: string[], send: SendFn): Promise<DaemonResult> {
  const results = await Promise.all(contextIds.map(async contextId => {
    try {
      const resp = await send(action, undefined, contextId)
      return { contextId, result: resp.result }
    } catch (err) {
      return { contextId, result: { success: false, error: (err as Error).message } as DaemonResult }
    }
  }))

  if (action.type === "group_list") {
    const merged: unknown[] = []
    const failures: string[] = []
    for (const { contextId, result } of results) {
      if (result.success && Array.isArray(result.data)) {
        for (const g of result.data) merged.push({ context: contextId, ...(g as Record<string, unknown>) })
      } else if (!result.success) {
        failures.push(`${contextId}: ${result.error ?? "group_list failed"}`)
      }
    }
    if (merged.length === 0 && failures.length === results.length) {
      return { success: false, error: `group list failed in every context (${failures.join("; ")})` }
    }
    return { success: true, data: merged, ...(failures.length ? { warning: `unreachable: ${failures.join("; ")}` } : {}) } as DaemonResult
  }

  // group_close: the first context that closed it wins; "not found" everywhere
  // is one honest error; any other failure is reported as is.
  // Every context that held the group closed it. One context keeps the flat
  // shape; several are listed so the caller sees each close.
  const closed = results.filter(r => r.result.success)
  const dataOf = (r: DaemonResult) => (typeof r.data === "object" && r.data) ? r.data as Record<string, unknown> : {}
  if (closed.length === 1) return { success: true, data: { context: closed[0].contextId, ...dataOf(closed[0].result) } }
  if (closed.length > 1) return { success: true, data: { closed: closed.map(c => ({ context: c.contextId, ...dataOf(c.result) })) } }
  const notFound = results.every(r => /not found/.test(r.result.error ?? ""))
  if (notFound) {
    return { success: false, error: `group '${String(action.label)}' not found in any connected context (checked: ${contextIds.join(", ")})` }
  }
  const first = results.find(r => !/not found/.test(r.result.error ?? ""))
  return { success: false, error: `${first?.contextId}: ${first?.result.error ?? "group_close failed"}` }
}

export function parseGroupCommand(filtered: string[]): Action {
  const sub = filtered[1]

  if (sub === "list" || sub === undefined) {
    return { type: "group_list" }
  }

  if (sub === "close") {
    const label = filtered[2]
    if (!label || !GROUP_LABEL_RE.test(label)) {
      console.error("error: usage: interceptor group close <label>   (label: [A-Za-z0-9_-]{1,32})")
      process.exit(1)
    }
    return { type: "group_close", label }
  }

  console.error("error: usage: interceptor group list | interceptor group close <label>")
  process.exit(1)
}
