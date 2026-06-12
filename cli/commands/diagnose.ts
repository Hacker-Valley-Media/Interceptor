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
 *
 * Binary mismatch detection: compares the execPath recorded in the lock file
 * (which binary the socket daemon is actually running) against the path in
 * each browser's NMH manifest (which binary Chrome/Brave will spawn on
 * extension connect). A mismatch means the extension and CLI are talking to
 * different daemon processes — the root cause of "no extensions connected"
 * when Chrome appears open and the extension appears loaded.
 */

import { existsSync, readFileSync } from "node:fs"
import { readStatusSnapshot } from "../lib/status-renderer"
import { sendCommand } from "../transport"
import { listSessions } from "./monitor"
import { readLockFile, type LockFileData } from "../../daemon/lifecycle"
import { LOCK_PATH } from "../../shared/platform"

const NMH_PATHS: Record<string, string> = {
  chrome: `${process.env.HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.interceptor.host.json`,
  brave:  `${process.env.HOME}/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.interceptor.host.json`,
}

type BinaryMismatch = {
  browser: string
  manifestPath: string
  runningPath: string
}

type ContextProbe = {
  contextId: string
  extension: { reachable: boolean; reason?: string }
  tab: { id: number; url: string; title: string } | null
  elements: number | null
}

type DiagnoseSnapshot = {
  daemon: { running: boolean; pid: number | null; execPath?: string; version?: string; startedAt?: string }
  binaryMismatches: BinaryMismatch[]
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

function readNmhManifestPath(manifestFile: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf-8")) as { path?: string }
    return manifest.path ?? null
  } catch {
    return null
  }
}

function detectBinaryMismatches(lock: LockFileData | null): BinaryMismatch[] {
  if (!lock?.execPath) return []
  const mismatches: BinaryMismatch[] = []
  for (const [browser, manifestFile] of Object.entries(NMH_PATHS)) {
    if (!existsSync(manifestFile)) continue
    const manifestPath = readNmhManifestPath(manifestFile)
    if (manifestPath && manifestPath !== lock.execPath) {
      mismatches.push({ browser, manifestPath, runningPath: lock.execPath })
    }
  }
  return mismatches
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
  const lock = readLockFile(LOCK_PATH)

  const snap: DiagnoseSnapshot = {
    daemon: {
      running: status.daemon,
      pid: status.pid,
      ...(lock ? { execPath: lock.execPath, version: lock.version, startedAt: lock.startedAt } : {}),
    },
    binaryMismatches: detectBinaryMismatches(lock),
    contexts: [],
    monitor: { active: 0, total: 0 },
  }

  if (status.daemon) {
    if (contextId) {
      snap.contexts = [await probeContext(contextId)]
    } else {
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

  // Daemon block — include binary path when lock file is present
  if (status.daemon) {
    const daemonDetail = lock?.execPath
      ? `running  (pid ${status.pid}, ${lock.execPath})`
      : `running  (pid ${status.pid})`
    lines.push(`daemon:    ${daemonDetail}`)
  } else {
    lines.push("daemon:    not running  — open Chrome with the Interceptor extension, then run 'interceptor init'")
  }

  // Binary mismatch warning — the root cause of "no extensions connected" when
  // Chrome is open. Surface it immediately after the daemon line so it's impossible to miss.
  for (const m of snap.binaryMismatches) {
    lines.push(`⚠ binary mismatch (${m.browser}):`)
    lines.push(`    socket daemon: ${m.runningPath}`)
    lines.push(`    NMH manifest:  ${m.manifestPath}`)
    lines.push(`    Chrome will spawn the manifest binary; CLI talks to the socket binary.`)
    lines.push(`    Fix: run 'interceptor init' or update the NMH manifest to match.`)
  }

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
