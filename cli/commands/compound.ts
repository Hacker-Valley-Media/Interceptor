/**
 * cli/commands/compound.ts — interceptor open, read, act, inspect
 *
 * Compound commands that collapse multi-step patterns into single CLI invocations.
 * Each command issues multiple sequential daemon requests via sendCommand() and
 * combines the results into a single output.
 */

import { sendCommand, sendCommandWs, type DaemonResponse } from "../transport"
import { parseElementTarget } from "../parse"
import { hasTrustedFlag } from "./flags"
import { maybeEmitResearchHint } from "./research"

type Action = { type: string; [key: string]: unknown }
type Result = { success: boolean; error?: string; data?: unknown; tabId?: number }
type ReadAggregate = {
  success: boolean
  tree?: string
  text?: string
  error?: string
  warnings?: string[]
}

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
  // Explicit truncation marker so agents know to scope or widen instead of
  // escaping to ?action=raw / view-source when rendered text appears missing.
  return text.slice(0, maxChars) +
    `\n... (truncated: showed ${maxChars} of ${text.length} chars. Pass --full to see all, or 'read e<ref> --text-only' to scope, or 'find "<term>"' to jump.)`
}

async function send(action: Action, tabId?: number, useWs = false, contextId?: string): Promise<Result> {
  try {
    const resp = useWs
      ? await sendCommandWs(action, tabId, contextId)
      : await sendCommand(action, tabId, contextId)
    return unwrap(resp)
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export function aggregateReadResults(opts: {
  treeRequested: boolean
  textRequested: boolean
  treeResult?: Result
  textResult?: Result
  full?: boolean
}): ReadAggregate {
  const warnings: string[] = []
  let tree = ""
  let text = ""

  if (opts.treeRequested) {
    if (opts.treeResult?.success) tree = textData(opts.treeResult)
    else if (opts.treeResult?.error) warnings.push(`tree: ${opts.treeResult.error}`)
  }

  if (opts.textRequested) {
    if (opts.textResult?.success) {
      text = textData(opts.textResult)
      // Default text cap is 8,000 chars — large enough to fit a mid-sized
      // page intro without forcing --full. --full unlocks the full 200K
      // cap from the extension side.
      if (!opts.full) text = truncateText(text, 8000)
    } else if (opts.textResult?.error) {
      warnings.push(`text: ${opts.textResult.error}`)
    }
  }

  const anyRequested = opts.treeRequested || opts.textRequested
  const anySucceeded = (!!tree && opts.treeRequested) || (!!text && opts.textRequested)

  if (anyRequested && !anySucceeded && warnings.length > 0) {
    return { success: false, error: warnings.join("; "), warnings }
  }

  return { success: true, tree: tree || undefined, text: text || undefined, warnings }
}

type ReadTarget = ReturnType<typeof parseElementTarget> | Record<string, never>

export function buildReadTreeAction(opts: {
  target: ReadTarget
  filterMode: string
  includeStyle: boolean
  includeFrames: boolean
  treeFormat?: "verbose" | "compact"
}): Action {
  const base: Omit<Action, "type"> = {
    depth: 15,
    filter: opts.filterMode,
    maxChars: 50000,
    includeStyle: opts.includeStyle,
    ...(opts.treeFormat === "compact" ? { treeFormat: "compact" } : {})
  }

  if (opts.includeFrames) {
    const action: Action = { type: "frames_read_tree", ...base }
    if ("frameId" in opts.target && typeof opts.target.frameId === "number") {
      action.frameId = opts.target.frameId
    } else if ("ref" in opts.target && typeof opts.target.ref === "string") {
      action.frameId = 0
    }
    if ("index" in opts.target && typeof opts.target.index === "number") action.index = opts.target.index
    if ("ref" in opts.target && typeof opts.target.ref === "string") action.ref = opts.target.ref
    return action
  }

  return { type: "get_a11y_tree", ...base, ...opts.target }
}

// ── interceptor open <url> ──────────────────────────────────────────────────────────

export type TabCreateAction = {
  type: "tab_create"
  url: string
  reuse?: boolean
  reusePolicy?: boolean
  active?: boolean
}

export function buildTabCreateAction(
  filtered: string[],
  url: string,
  opts?: { policyDefault?: boolean }
): TabCreateAction {
  const action: TabCreateAction = { type: "tab_create", url }
  // --reuse / --no-reuse are the explicit per-call decisions. Without either,
  // `open` (policyDefault) marks the action reuse-undecided via `reusePolicy`
  // and the extension's resolved tabLifecycle policy decides — named groups
  // only. `tab new` never sets policyDefault: it is the ⌘T verb and
  // always creates unless --reuse is passed.
  if (filtered.includes("--reuse")) action.reuse = true
  else if (filtered.includes("--no-reuse")) action.reuse = false
  else if (opts?.policyDefault) action.reusePolicy = true
  // --activate is the explicit opt-in for foregrounding the new tab.
  // Default is background-first; the extension's tab_create handler reads
  // `action.active === true` and only then passes `active: true` to
  // chrome.tabs.create.
  if (filtered.includes("--activate")) action.active = true
  return action
}

export async function runOpen(
  filtered: string[],
  globalTabId?: number,
  jsonMode = false,
  useWs = false,
  contextId?: string
): Promise<void> {
  const url = filtered[1]
  if (!url) {
    console.error("error: interceptor open requires a URL. Usage: interceptor open <url>")
    process.exit(1)
  }

  const treeOnly = filtered.includes("--tree-only")
  const textOnly = filtered.includes("--text-only")
  const markdown = filtered.includes("--markdown")
  const full = filtered.includes("--full")
  const noWait = filtered.includes("--no-wait")
  const timeoutIdx = filtered.indexOf("--timeout")
  const timeout = timeoutIdx !== -1 ? parseInt(filtered[timeoutIdx + 1]) : 5000

  // Step 1: Create tab (or reuse an existing managed one when --reuse is set,
  // or by policy default for named-group calls)
  const createAction = buildTabCreateAction(filtered, url, { policyDefault: true })
  const createResult = await send(createAction, globalTabId, useWs, contextId)
  if (!createResult.success) {
    output(jsonMode, { success: false, error: createResult.error || "failed to create tab" })
    return
  }
  const dataObj = (typeof createResult.data === "object" && createResult.data) ? createResult.data as Record<string, unknown> : {}
  const tabId = (dataObj.tabId as number) || createResult.tabId || globalTabId
  const reused = dataObj.reused === true

  if (noWait) {
    output(jsonMode, { success: true, data: { tabId, url, reused, message: reused ? "tab reused (no-wait)" : "tab created (no-wait)" } })
    return
  }

  // Step 2: Wait for content script + DOM stability (retry for new tab load)
  const waitDeadline = Date.now() + timeout
  let waitOk = false
  while (Date.now() < waitDeadline) {
    try {
      const waitResult = await send({ type: "wait_stable", ms: 200, timeout: Math.min(3000, waitDeadline - Date.now()) }, tabId, useWs, contextId)
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
  let treeResult: Result | undefined
  let textResult: Result | undefined

  if (!textOnly) {
    treeResult = await send(
      { type: "get_a11y_tree", depth: 15, filter: "interactive", maxChars: 50000 },
      tabId, useWs, contextId
    )
  }

  if (!treeOnly) {
    const textActionType: "extract_text" | "extract_markdown" = markdown ? "extract_markdown" : "extract_text"
    textResult = await send({ type: textActionType }, tabId, useWs, contextId)
  }

  const aggregate = aggregateReadResults({
    treeRequested: !textOnly,
    textRequested: !treeOnly,
    treeResult,
    textResult,
    full
  })

  if (!aggregate.success) {
    output(jsonMode, { success: false, error: aggregate.error || "could not read page" })
    return
  }
  treeData = aggregate.tree || ""
  textContent = aggregate.text || ""

  if (jsonMode) {
    const result: { success: boolean; data?: unknown; warning?: string } = {
      success: true,
      data: { tabId, url, reused, tree: treeData || undefined, text: textContent || undefined }
    }
    if (aggregate.warnings?.length) result.warning = aggregate.warnings.join("; ")
    output(jsonMode, result)
    return
  }

  if (aggregate.warnings?.length) console.error(`warning: ${aggregate.warnings.join("; ")}`)

  // Pretty output
  parts.push(`Tab: ${tabId} | ${url}${reused ? " (reused)" : ""}`)
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

  // Layer C: one rate-limited, opt-out hint to stderr when an agent opens a
  // search engine and no research ledger is active. Information, not coercion —
  // it changes nothing about the command's behavior or output.
  maybeEmitResearchHint(url, filtered)
}

// ── interceptor read [ref] ──────────────────────────────────────────────────────────

export async function runRead(
  filtered: string[],
  globalTabId?: number,
  jsonMode = false,
  useWs = false,
  contextId?: string
): Promise<void> {
  const treeOnly = filtered.includes("--tree-only")
  const textOnly = filtered.includes("--text-only")
  const markdown = filtered.includes("--markdown")
  const full = filtered.includes("--full")
  const includeStyle = filtered.includes("--include-style")
  const includeFrames = filtered.includes("--include-frames")
  const filterIdx = filtered.indexOf("--filter")
  const filterMode = filterIdx !== -1 ? filtered[filterIdx + 1] : "interactive"
  const treeFormatIdx = filtered.indexOf("--tree-format")
  const treeFormat: "verbose" | "compact" =
    treeFormatIdx !== -1 && filtered[treeFormatIdx + 1] === "compact" ? "compact" : "verbose"

  // Check for optional ref argument (skip flags)
  const refArg = filtered[1] && !filtered[1].startsWith("--") ? filtered[1] : undefined
  const target = refArg ? parseElementTarget(refArg) : {}

  const parts: string[] = []
  let treeData = ""
  let textContent = ""
  let treeResult: Result | undefined
  let textResult: Result | undefined

  if (!textOnly) {
    if (includeFrames) {
      const framesResp = await send(
        buildReadTreeAction({ target, filterMode, includeStyle, includeFrames, treeFormat }),
        globalTabId, useWs, contextId
      )
      if (framesResp.success && framesResp.data && typeof framesResp.data === "object" && Array.isArray((framesResp.data as { frames?: unknown[] }).frames)) {
        type FrameEntry = { frameId: number; parentFrameId: number; url: string; opaque?: true; error?: string; tree?: string }
        const frames = (framesResp.data as { frames: FrameEntry[] }).frames
        const parts: string[] = []
        for (const frame of frames) {
          const header = frame.frameId === 0
            ? `# frame 0 (top): ${frame.url}`
            : `# frame ${frame.frameId} (parent=${frame.parentFrameId}): ${frame.url}`
          parts.push(header)
          if (frame.opaque) {
            parts.push(`  (opaque/cross-origin — ${frame.error || "unreachable"})`)
          } else if (frame.tree) {
            parts.push(frame.tree)
          }
          parts.push("")
        }
        treeResult = { success: true, data: parts.join("\n").trimEnd(), tabId: framesResp.tabId }
      } else {
        treeResult = framesResp
      }
    } else {
      treeResult = await send(
        buildReadTreeAction({ target, filterMode, includeStyle, includeFrames, treeFormat }),
        globalTabId, useWs, contextId
      )
    }
  }

  if (!treeOnly) {
    const textAction: Action = { type: markdown ? "extract_markdown" : "extract_text", ...target }
    textResult = await send(textAction, globalTabId, useWs, contextId)
  }

  const aggregate = aggregateReadResults({
    treeRequested: !textOnly,
    textRequested: !treeOnly,
    treeResult,
    textResult,
    full
  })

  if (!aggregate.success) {
    output(jsonMode, { success: false, error: aggregate.error || "could not read page" })
    return
  }
  treeData = aggregate.tree || ""
  textContent = aggregate.text || ""

  if (jsonMode) {
    const result: { success: boolean; data?: unknown; warning?: string } = {
      success: true,
      data: { tree: treeData || undefined, text: textContent || undefined }
    }
    if (aggregate.warnings?.length) result.warning = aggregate.warnings.join("; ")
    output(jsonMode, result)
    return
  }

  if (aggregate.warnings?.length) console.error(`warning: ${aggregate.warnings.join("; ")}`)

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
  useWs = false,
  contextId?: string
): Promise<void> {
  const ref = filtered[1]
  if (!ref) {
    console.error("error: interceptor act requires a ref. Usage: interceptor act <ref> [value]")
    process.exit(1)
  }

  const useOs = hasTrustedFlag(filtered)
  const append = filtered.includes("--append")
  const noRead = filtered.includes("--no-read")
  const keysIdx = filtered.indexOf("--keys")
  const timeoutIdx = filtered.indexOf("--timeout")
  const timeout = timeoutIdx !== -1 ? parseInt(filtered[timeoutIdx + 1]) : 2000

  // Find value: everything after ref that isn't a flag
  const flagSet = new Set(["--trusted", "--os", "--append", "--no-read", "--keys", "--timeout"])
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
      actionResult = await send({ type: "os_key", key, modifiers }, globalTabId, useWs, contextId)
    } else {
      actionResult = await send({ type: "send_keys", keys }, globalTabId, useWs, contextId)
    }
  } else if (value !== undefined) {
    // Type
    if (useOs) {
      actionResult = await send({ type: "os_type", ...target, text: value }, globalTabId, useWs, contextId)
    } else if (target.semantic) {
      actionResult = await send(
        { type: "find_and_type", name: target.semantic.name, role: target.semantic.role, inputText: value, clear: !append },
        globalTabId, useWs, contextId
      )
    } else {
      actionResult = await send(
        { type: "input_text", ...target, text: value, clear: !append },
        globalTabId, useWs, contextId
      )
    }
  } else {
    // Click
    if (useOs) {
      actionResult = await send({ type: "os_click", ...target }, globalTabId, useWs, contextId)
    } else if (target.semantic) {
      actionResult = await send(
        { type: "find_and_click", name: target.semantic.name, role: target.semantic.role },
        globalTabId, useWs, contextId
      )
    } else {
      actionResult = await send({ type: "click", ...target }, globalTabId, useWs, contextId)
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
    await send({ type: "wait_stable", ms: 200, timeout }, globalTabId, useWs, contextId)

    // Step 3: Get updated tree + diff
    treeResult = await send(
      { type: "get_a11y_tree", depth: 15, filter: "interactive", maxChars: 50000 },
      globalTabId, useWs, contextId
    )
    diffResult = await send({ type: "diff" }, globalTabId, useWs, contextId)
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
  useWs = false,
  contextId?: string
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
      globalTabId, useWs, contextId
    )
    treeData = textData(treeResult)

    const textResult = await send({ type: "extract_text" }, globalTabId, useWs, contextId)
    textContent = truncateText(textData(textResult), 2000)
  }

  const netLogResult = await send(
    { type: "net_log", filter: filterPattern, limit },
    globalTabId, useWs, contextId
  )
  const netHeadersResult = await send(
    { type: "net_headers", filter: filterPattern },
    globalTabId, useWs, contextId
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
  opts: { jsonMode?: boolean; useWs?: boolean; globalTabId?: number; anyTab?: boolean; contextId?: string }
): Promise<void> {
  switch (cmd) {
    case "open":    return runOpen(filtered, opts.globalTabId, opts.jsonMode, opts.useWs, opts.contextId)
    case "read":    return runRead(filtered, opts.globalTabId, opts.jsonMode, opts.useWs, opts.contextId)
    case "act":     return runAct(filtered, opts.globalTabId, opts.jsonMode, opts.useWs, opts.contextId)
    case "inspect":  return runInspect(filtered, opts.globalTabId, opts.jsonMode, opts.useWs, opts.contextId)
    default:
      console.error(`error: unknown compound command '${cmd}'`)
      process.exit(1)
  }
}
