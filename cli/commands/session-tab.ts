/**
 * cli/commands/session-tab.ts — the "designated" working tab.
 *
 * Agents that open a tab get back a numeric id they'd otherwise have to
 * thread through every later command by hand. `tab designate` pins one tab
 * id here; `tab self` (and `read`'s no-tab fallback) read it back.
 *
 * Mirrors the ~/.interceptor/<subsystem>/state.json convention used by the
 * iOS surface (daemon/ios/state.ts) — a single global file, not per-PID,
 * since the CLI is a fresh process per invocation with no other place to
 * remember "which tab am I working in" across commands.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Resolve the user's home directory.
 *
 * Bun's os.homedir() resolves from the OS user database and ignores a
 * runtime override of $HOME, unlike Node — so honor $HOME explicitly. This
 * also happens to be the right Unix convention, and it's what makes this
 * module overridable in tests without touching the real machine's state.
 */
function resolveHome(): string {
  return process.env.HOME || homedir()
}

/** Return (and ensure) the `~/.interceptor` directory under `home`. */
function sessionTabDir(home: string): string {
  const dir = join(home, ".interceptor")
  try { mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

/** Path to the designated-tab state file under `home`. */
function sessionTabPath(home: string): string {
  return join(sessionTabDir(home), "session-tab.json")
}

/** Read the currently designated tab id, or `undefined` if none is set. */
export function loadDesignatedTab(home = resolveHome()): number | undefined {
  try {
    const raw = JSON.parse(readFileSync(sessionTabPath(home), "utf-8")) as { tabId?: number }
    return typeof raw.tabId === "number" ? raw.tabId : undefined
  } catch {
    return undefined
  }
}

/** Persist `tabId` as the session's designated working tab. */
export function saveDesignatedTab(tabId: number, home = resolveHome()): void {
  try {
    writeFileSync(sessionTabPath(home), JSON.stringify({ tabId }, null, 2))
  } catch (err) {
    console.error(`error: failed to save designated tab: ${(err as Error).message}`)
    process.exit(1)
  }
}

/** Clear the designated tab, if one is set. */
export function clearDesignatedTab(home = resolveHome()): void {
  try { unlinkSync(sessionTabPath(home)) } catch {}
}
