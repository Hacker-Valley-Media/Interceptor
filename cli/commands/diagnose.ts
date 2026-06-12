/**
 * cli/commands/diagnose.ts — interceptor diagnose
 *
 * Surfaces a concise debugging snapshot for agent diagnosis. Call this when
 * a command fails or when an agent needs to orient itself without issuing 4-5
 * follow-up commands to reconstruct system state.
 *
 * Works without a running daemon (reports what it can locally) and surfaces
 * progressively richer context when the daemon + extension are reachable.
 *
 * Context-aware: without --context, enumerates ALL connected browser contexts
 * and probes each one. In a dual-browser setup (Chrome + Brave) you see both
 * contexts side-by-side, making context mismatches immediately visible.
 */

import { readStatusSnapshot } from "../lib/status-renderer"
import { sendCommand } from "../transport"
import { listSessions } from "./monitor"

type ContextProbe = {
  contextId: string
  extension: { reachable: boolean; reason?: string }
  tab: { id: number; url: string; title: string } | null
  elements: number | null
}

type DiagnoseSnapshot = {
  daemon: { running: boolean; pid: number | null }
  contexts: ContextProbe[]
  monitor: { active: number; total: number }
}

// Clear the timer in `finally` so it never keeps the process alive after
// fn() resolves — the original race left the timer running until it fired.
async function probeWithTimeout<T>(fn: () => Promise<T>, ms = 2000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timed out")), ms)
      }),
    ])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function probeContext(contextId: string | undefined): Promise<ContextProbe> {
  const label = contextId ?? "default"

  const [tabResp, treeResp] = await Promise.all([
    probeWithTimeout(() => sendCommand({ type: "tab_list" }, undefined, contextId)),
    probeWithTimeout(() =>
      sendCommand({ type: "get_a11y_tree", filter: "interactive", depth: 3, maxChars: 100_000 }, undefined, contextId)
    ),
  ])

  let extension: ContextProbe["extension"] = { reachable: false }
  let tab: ContextProbe["tab"] = null
  let elements: number | null = null

  if (tabResp?.result.success) {
    const tabs = tabResp.result.data as
      | Array<{ id: number; url: string; title: string; active: boolean }>
      | undefined
    if (Array.isArray(tabs) && tabs.length > 0) {
      const active = tabs.find(t => t.active) ?? tabs[0]
      tab = { id: active.id, url: active.url, title: active.title }
      extension = { reachable: true }
    } else {
      extension = { reachable: false, reason: "no tabs in interceptor group — run 'interceptor open <url>'" }
    }
  } else {
    extension = { reachable: false, reason: tabResp?.result.error || "extension not responding" }
  }

  if (treeResp?.result.success && typeof treeResp.result.data === "string") {
    elements = (treeResp.result.data.match(/\be\d+\b/g) ?? []).length
  }

  return { contextId: label, extension, tab, elements }
}

export async function runDiagnoseCommand(jsonMode: boolean, contextId?: string): Promise<void> {
  const status = readStatusSnapshot()

  const snap: DiagnoseSnapshot = {
    daemon: { running: status.daemon, pid: status.pid },
    contexts: [],
    monitor: { active: 0, total: 0 },
  }

  if (status.daemon) {
    if (contextId) {
      snap.contexts = [await probeContext(contextId)]
    } else {
      // Enumerate all contexts so dual-browser setups are visible.
      const contextsResp = await probeWithTimeout(() => sendCommand({ type: "contexts" }))
      const contextIds =
        contextsResp?.result.success && Array.isArray(contextsResp.result.data)
          ? (contextsResp.result.data as string[])
          : []

      snap.contexts = await Promise.all(
        contextIds.length > 0
          ? contextIds.map(id => probeContext(id))
          : [probeContext(undefined)]
      )
    }
  }

  // Monitor session state lives on disk — readable without a daemon.
  try {
    const sessions = listSessions()
    snap.monitor = {
      active: sessions.filter(s => s.status === "active").length,
      total: sessions.length,
    }
  } catch {
    // monitor artifacts absent or unreadable; leave defaults
  }

  if (jsonMode) {
    console.log(JSON.stringify(snap, null, 2))
    return
  }

  const lines: string[] = []

  lines.push(
    `daemon:    ${
      status.daemon
        ? `running  (pid ${status.pid})`
        : "not running  — open Chrome with the Interceptor extension, then run 'interceptor init'"
    }`
  )

  if (status.daemon) {
    const multiCtx = snap.contexts.length > 1 || snap.contexts[0]?.contextId !== "default"

    for (const ctx of snap.contexts) {
      if (multiCtx) lines.push(`context ${ctx.contextId}:`)
      const indent = multiCtx ? "  " : ""

      lines.push(
        `${indent}extension: ${
          ctx.extension.reachable
            ? "connected"
            : `disconnected${ctx.extension.reason ? `  (${ctx.extension.reason})` : ""}`
        }`
      )

      if (ctx.tab) {
        const { id, url, title } = ctx.tab
        lines.push(`${indent}tab ${id}:     ${url}  "${title}"`)
      } else {
        lines.push(`${indent}tab:       no active interceptor-group tab`)
      }

      if (ctx.elements !== null) {
        lines.push(`${indent}elements:  ${ctx.elements} interactive`)
      }
    }
  }

  lines.push(
    `monitor:   ${
      snap.monitor.active > 0
        ? `${snap.monitor.active} active  (${snap.monitor.total} total)`
        : snap.monitor.total > 0
        ? `none active  (${snap.monitor.total} stopped)`
        : "no sessions"
    }`
  )

  console.log(lines.join("\n"))
}
