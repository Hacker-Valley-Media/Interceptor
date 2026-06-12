/**
 * cli/commands/diagnose.ts — interceptor diagnose
 *
 * Surfaces a concise debugging snapshot for agent diagnosis. Call this when
 * a command fails or when an agent needs to orient itself without issuing 4-5
 * follow-up commands to reconstruct system state.
 *
 * Works without a running daemon (reports what it can locally) and surfaces
 * progressively richer context when the daemon + extension are reachable.
 */

import { readStatusSnapshot } from "../lib/status-renderer"
import { sendCommand } from "../transport"
import { listSessions } from "./monitor"

type DiagnoseSnapshot = {
  daemon: { running: boolean; pid: number | null }
  extension: { reachable: boolean; reason?: string }
  tab: { id: number; url: string; title: string } | null
  elements: number | null
  monitor: { active: number; total: number }
}

async function probeWithTimeout<T>(fn: () => Promise<T>, ms = 2000): Promise<T | null> {
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe timed out")), ms)),
    ])
  } catch {
    return null
  }
}

export async function runDiagnoseCommand(jsonMode: boolean): Promise<void> {
  const status = readStatusSnapshot()

  const snap: DiagnoseSnapshot = {
    daemon: { running: status.daemon, pid: status.pid },
    extension: { reachable: false },
    tab: null,
    elements: null,
    monitor: { active: 0, total: 0 },
  }

  if (status.daemon) {
    // Probe tab list and element tree in parallel; cap at 2 s each so
    // diagnose stays fast even on a busy page or a slow extension.
    const [tabResp, treeResp] = await Promise.all([
      probeWithTimeout(() => sendCommand({ type: "tab_list" })),
      probeWithTimeout(() =>
        sendCommand({ type: "get_a11y_tree", filter: "interactive", depth: 3, maxChars: 100_000 })
      ),
    ])

    if (tabResp?.result.success) {
      const tabs = tabResp.result.data as
        | Array<{ id: number; url: string; title: string; active: boolean }>
        | undefined
      if (Array.isArray(tabs) && tabs.length > 0) {
        const active = tabs.find(t => t.active) ?? tabs[0]
        snap.tab = { id: active.id, url: active.url, title: active.title }
        snap.extension = { reachable: true }
      } else {
        snap.extension = {
          reachable: false,
          reason: "no tabs in interceptor group — run 'interceptor open <url>'",
        }
      }
    } else {
      snap.extension = {
        reachable: false,
        reason: tabResp?.result.error || "extension not responding",
      }
    }

    if (treeResp?.result.success && typeof treeResp.result.data === "string") {
      snap.elements = (treeResp.result.data.match(/\be\d+\b/g) ?? []).length
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
    lines.push(
      `extension: ${
        snap.extension.reachable
          ? "connected"
          : `disconnected${snap.extension.reason ? `  (${snap.extension.reason})` : ""}`
      }`
    )

    if (snap.tab) {
      const { id, url, title } = snap.tab
      lines.push(`tab ${id}:     ${url}  "${title}"`)
    } else {
      lines.push("tab:       no active interceptor-group tab")
    }

    if (snap.elements !== null) {
      lines.push(`elements:  ${snap.elements} interactive`)
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
