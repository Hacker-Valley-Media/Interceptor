/**
 * cli/commands/compound.ts — interceptor open, read, act, inspect
 *
 * Compound commands that collapse multi-step patterns into single CLI invocations.
 * Each command issues multiple sequential daemon requests via sendCommand() and
 * combines the results into a single output.
 */

import { sendCommand, sendCommandWs, type DaemonResponse } from "../transport"
import { parseElementTarget } from "../parse"

type Action = { type: string; [key: string]: unknown }
type Result = { success: boolean; error?: string; data?: unknown; tabId?: number }

function unwrap(resp: DaemonResponse): Result {
  return resp.result
}

function textData(result: Result): string {
  if (!result.success) return ""
  if (typeof result.data === "string") return result.data
  if (result.data === undefined || result.data === null) return ""
  return JSON.stringify(result.data, null, 2)
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + "\n... (truncated)"
}

async function send(action: Action, tabId?: number, useWs = false): Promise<Result> {
  try {
    const resp = useWs
      ? await sendCommandWs(action, tabId)
      : await sendCommand(action, tabId)
    return unwrap(resp)
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ── interceptor open <url> ──────────────────────────────────────────────────────────

export async function runOpen(
  filtered: string[],
  globalTabId?: number,
  jsonMode = false,
  useWs = false
): Promise<void> {
  const url = filtered[1]
  if (!url) {
    console.error("error: interceptor open requires a URL. Usage: interceptor open <url>")
    process.exit(1)
  }

  const treeOnly = filtered.includes("--tree-only")
  const textOnly = filtered.includes("--text-only")
  const full = filtered.includes("--full")
  const noWait = filtered.includes("--no-wait")
  const timeoutIdx = filtered.indexOf("--timeout")
  const timeout = timeoutIdx !== -1 ? parseInt(filtered[timeoutIdx + 1]) : 5000

  // Step 1: Create tab
  const createResult = await send({ type: "tab_create", url }, globalTabId, useWs)
  if (!createResult.success) {
    output(jsonMode, { success: false, error: createResult.error || "failed to create tab" })
    return
  }
  const dataObj = (typeof createResult.data === "object" && createResult.data) ? createResult.data as Record<string, unknown> : {}
  const tabId = (dataObj.tabId as number) || createResult.tabId || globalTabId

  if (noWait) {
    output(jsonMode, { success: true, data: { tabId, url, message: "tab created (no-wait)" } })
    return
  }

  // Step 2: Wait for content script + DOM stability (retry for new tab load)
  const waitDeadline = Date.now() + timeout
  let waitOk = false
  while (Date.now() < waitDeadline) {
    try {
      const waitResult = await send({ type: "wait_stable", ms: 200, timeout: Math.min(3000, waitDeadline - Date.now()) }, tabId, useWs)
      if (waitResult.success) { waitOk = true; break }
    } catch {}
    await Bun.sleep(500)
  }
  if (!waitOk) {
    // Proceed anyway with whatever tree/text is available
  }

  // Step 3 & 4: Get tree and/or text
  const parts: string[] = []
  let treeData = ""
  let textContent = ""

  if (!textOnly) {
    const treeResult = await send(
      { type: "get_a11y_tree", depth: 15, filter: "interactive", maxChars: 50000 },
      tabId, useWs
    )
    treeData = textData(treeResult)
  }

  if (!treeOnly) {
    const textResult = await send({ type: "extract_text" }, tabId, useWs)
    textContent = textData(textResult)
    if (!full) textContent = truncateText(textContent, 2000)
  }

  if (jsonMode) {
    output(jsonMode, {
      success: true,
      data: { tabId, url, tree: treeData || undefined, text: textContent || undefined }
    })
    return
  }

  // Pretty output
  parts.push(`Tab: ${tabId} | ${url}`)
  if (treeData) {
    parts.push("")
    parts.push(treeData)
  }
  if (textContent && treeData) {
    parts.push("")
    parts.push("---")
  }
  if (textContent) {
    parts.push(textContent)
  }
  console.log(parts.join("\n"))
}

// ── interceptor read [ref] ──────────────────────────────────────────────────────────

export async function runRead(
  filtered: string[],
  globalTabId?: number,
  jsonMode = false,
  useWs = false
): Promise<void> {
  const treeOnly = filtered.includes("--tree-only")
  const textOnly = filtered.includes("--text-only")
  const full = filtered.includes("--full")
  const filterIdx = filtered.indexOf("--filter")
  const filterMode = filterIdx !== -1 ? filtered[filterIdx + 1] : "interactive"

  // Check for optional ref argument (skip flags)
  const refArg = filtered[1] && !filtered[1].startsWith("--") ? filtered[1] : undefined
  const target = refArg ? parseElementTarget(refArg) : {}

  const parts: string[] = []
  let treeData = ""
  let textContent = ""

  if (!textOnly) {
    const treeResult = await send(
      { type: "get_a11y_tree", depth: 15, filter: filterMode, maxChars: 50000 },
      globalTabId, useWs
    )
    treeData = textData(treeResult)
  }

  if (!treeOnly) {
    const textAction: Action = { type: "extract_text", ...target }
    const textResult = await send(textAction, globalTabId, useWs)
    textContent = textData(textResult)
    if (!full) textContent = truncateText(textContent, 2000)
  }

  if (jsonMode) {
    output(jsonMode, {
      success: true,
      data: { tree: treeData || undefined, text: textContent || undefined }
    })
    return
  }

  if (treeData) parts.push(treeData)
  if (textContent && treeData) {
    parts.push("")
    parts.push("---")
  }
  if (textContent) parts.push(textContent)
  console.log(parts.join("\n"))
}

// ── interceptor act <ref> [value] ───────────────────────────────────────────────────

export async function runAct(
  filtered: string[],
  globalTabId?: number,
  jsonMode = false,
  useWs = false
): Promise<void> {
  const ref = filtered[1]
  if (!ref) {
    console.error("error: interceptor act requires a ref. Usage: interceptor act <ref> [value]")
    process.exit(1)
  }

  const useOs = filtered.includes("--os")
  const append = filtered.includes("--append")
  const noRead = filtered.includes("--no-read")
  const keysIdx = filtered.indexOf("--keys")
  const timeoutIdx = filtered.indexOf("--timeout")
  const timeout = timeoutIdx !== -1 ? parseInt(filtered[timeoutIdx + 1]) : 2000

  // Find value: everything after ref that isn't a flag
  const flagSet = new Set(["--os", "--append", "--no-read", "--keys", "--timeout"])
  const valueArgs: string[] = []
  let skip = false
  for (let i = 2; i < filtered.length; i++) {
    if (skip) { skip = false; continue }
    if (filtered[i] === "--timeout" || filtered[i] === "--keys") { skip = true; continue }
    if (flagSet.has(filtered[i])) continue
    valueArgs.push(filtered[i])
  }
  const value = valueArgs.length > 0 ? valueArgs.join(" ") : undefined

  const target = parseElementTarget(ref)

  // Step 1: Perform the action (may throw if click navigates the page)
  let actionResult: Result
  let actionNavigated = false

  try {
  if (keysIdx !== -1) {
    const keys = filtered[keysIdx + 1]
    if (useOs) {
      const keyParts = keys.split("+")
      const key = keyParts[keyParts.length - 1]
      const modifiers = keyParts.slice(0, -1)
      actionResult = await send({ type: "os_key", key, modifiers }, globalTabId, useWs)
    } else {
      actionResult = await send({ type: "send_keys", keys }, globalTabId, useWs)
    }
  } else if (value !== undefined) {
    // Type
    if (useOs) {
      actionResult = await send({ type: "os_type", ...target, text: value }, globalTabId, useWs)
    } else if (target.semantic) {
      actionResult = await send(
        { type: "find_and_type", name: target.semantic.name, role: target.semantic.role, inputText: value, clear: !append },
        globalTabId, useWs
      )
    } else {
      actionResult = await send(
        { type: "input_text", ...target, text: value, clear: !append },
        globalTabId, useWs
      )
    }
  } else {
    // Click
    if (useOs) {
      actionResult = await send({ type: "os_click", ...target }, globalTabId, useWs)
    } else if (target.semantic) {
      actionResult = await send(
        { type: "find_and_click", name: target.semantic.name, role: target.semantic.role },
        globalTabId, useWs
      )
    } else {
      actionResult = await send({ type: "click", ...target }, globalTabId, useWs)
    }
  }

  } catch (err) {
    // Click succeeded but page navigated, breaking the response port
    const msg = (err as Error).message || ""
    if (msg.includes("back/forward cache") || msg.includes("message channel is closed") || msg.includes("timeout")) {
      actionNavigated = true
      actionResult = { success: true }
    } else {
      output(jsonMode, { success: false, error: msg })
      return
    }
  }

  if (!actionResult!.success) {
    const errMsg = actionResult!.error || "action failed"
    if (errMsg.includes("back/forward cache") || errMsg.includes("message channel is closed")) {
      actionNavigated = true
    } else {
      output(jsonMode, { success: false, error: errMsg })
      return
    }
  }

  if (actionNavigated) {
    if (jsonMode) {
      output(jsonMode, { success: true, data: { action: "ok", note: "page navigated — use interceptor read to see the new page" } })
    } else {
      console.log("ok (page navigated — use interceptor read to see the new page)")
    }
    return
  }

  if (noRead) {
    output(jsonMode, { success: true, data: "ok" })
    return
  }

  // Step 2: Wait for DOM stability (may fail if page navigated)
  let treeResult: Result = { success: false }
  let diffResult: Result = { success: false }
  try {
    await send({ type: "wait_stable", ms: 200, timeout }, globalTabId, useWs)

    // Step 3: Get updated tree + diff
    treeResult = await send(
      { type: "get_a11y_tree", depth: 15, filter: "interactive", maxChars: 50000 },
      globalTabId, useWs
    )
    diffResult = await send({ type: "diff" }, globalTabId, useWs)
  } catch {
    // Page likely navigated — action succeeded but post-read failed
    if (jsonMode) {
      output(jsonMode, { success: true, data: { action: "ok", note: "page navigated, post-action read unavailable" } })
    } else {
      console.log("ok (page navigated — use interceptor read to see the new page)")
    }
    return
  }

  const treeData = textData(treeResult)
  const diffData = textData(diffResult)

  if (jsonMode) {
    output(jsonMode, {
      success: true,
      data: { tree: treeData || undefined, diff: diffData || undefined }
    })
    return
  }

  const parts: string[] = []
  if (treeData) parts.push(treeData)
  if (diffData) {
    parts.push("")
    parts.push("--- diff ---")
    parts.push(diffData)
  }
  console.log(parts.join("\n"))
}

// ── interceptor inspect ─────────────────────────────────────────────────────────────

export async function runInspect(
  filtered: string[],
  globalTabId?: number,
  jsonMode = false,
  useWs = false
): Promise<void> {
  const netOnly = filtered.includes("--net-only")
  const limitIdx = filtered.indexOf("--limit")
  const limit = limitIdx !== -1 ? parseInt(filtered[limitIdx + 1]) : 10
  const filterIdx = filtered.indexOf("--filter")
  const filterPattern = filterIdx !== -1 ? filtered[filterIdx + 1] : undefined

  const parts: string[] = []
  let treeData = ""
  let textContent = ""

  if (!netOnly) {
    const treeResult = await send(
      { type: "get_a11y_tree", depth: 15, filter: "interactive", maxChars: 50000 },
      globalTabId, useWs
    )
    treeData = textData(treeResult)

    const textResult = await send({ type: "extract_text" }, globalTabId, useWs)
    textContent = truncateText(textData(textResult), 2000)
  }

  const netLogResult = await send(
    { type: "net_log", filter: filterPattern, limit },
    globalTabId, useWs
  )
  const netHeadersResult = await send(
    { type: "net_headers", filter: filterPattern },
    globalTabId, useWs
  )

  const netLogData = textData(netLogResult)
  const netHeadersData = textData(netHeadersResult)

  if (jsonMode) {
    output(jsonMode, {
      success: true,
      data: {
        tree: treeData || undefined,
        text: textContent || undefined,
        netLog: netLogResult.success ? netLogResult.data : undefined,
        netHeaders: netHeadersResult.success ? netHeadersResult.data : undefined
      }
    })
    return
  }

  if (treeData) parts.push(treeData)
  if (textContent) {
    parts.push("")
    parts.push("--- text ---")
    parts.push(textContent)
  }
  if (netLogData) {
    parts.push("")
    parts.push("--- network log ---")
    parts.push(netLogData)
  }
  if (netHeadersData) {
    parts.push("")
    parts.push("--- request headers ---")
    parts.push(netHeadersData)
  }
  console.log(parts.join("\n"))
}

// ── helpers ──────────────────────────────────────────────────────────────────

function output(jsonMode: boolean, result: { success: boolean; error?: string; data?: unknown }): void {
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2))
  } else if (!result.success) {
    console.error(`error: ${result.error}`)
    process.exit(1)
  } else if (typeof result.data === "string") {
    console.log(result.data)
  } else if (result.data) {
    console.log(JSON.stringify(result.data, null, 2))
  } else {
    console.log("ok")
  }
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export async function runCompoundCommand(
  cmd: string,
  filtered: string[],
  opts: { jsonMode?: boolean; useWs?: boolean; globalTabId?: number; anyTab?: boolean }
): Promise<void> {
  switch (cmd) {
    case "open":    return runOpen(filtered, opts.globalTabId, opts.jsonMode, opts.useWs)
    case "read":    return runRead(filtered, opts.globalTabId, opts.jsonMode, opts.useWs)
    case "act":     return runAct(filtered, opts.globalTabId, opts.jsonMode, opts.useWs)
    case "inspect":  return runInspect(filtered, opts.globalTabId, opts.jsonMode, opts.useWs)
    default:
      console.error(`error: unknown compound command '${cmd}'`)
      process.exit(1)
  }
}
