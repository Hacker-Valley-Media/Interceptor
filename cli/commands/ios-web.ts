/**
 * cli/commands/ios-web.ts — `interceptor ios web <sub>`.
 *
 * The web lane drives inspectable web content on a paired iOS device WITHOUT
 * Safari, Xcode, or the XCUITest runner (except native-mode input/screenshot).
 * Parses the `ios web` surface, sends `ios_web_*` daemon actions, and renders
 * terse plain output (or --json). Called by cli/commands/ios.ts.
 */

import { sendCommand, type DaemonResponse, type DaemonResult } from "../transport"

type Action = { type: string; [key: string]: unknown }

/** `--timeout` is documented in seconds; the daemon session wants milliseconds. */
export function timeoutMsFlag(args: string[]): number | undefined {
  const v = flagValue(args, "--timeout")
  const s = v === undefined ? NaN : Number(v)
  return !Number.isFinite(s) || s <= 0 ? undefined : Math.round(s * 1000)
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  const v = args[idx + 1]
  if (!v || v.startsWith("--")) return undefined
  return v
}
function hasFlag(args: string[], flag: string): boolean { return args.includes(flag) }
function numFlag(args: string[], flag: string): number | undefined {
  const v = flagValue(args, flag)
  if (v === undefined) return undefined
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}
/** First positional arg after the subcommand that is not a flag or flag-value. */
function positional(args: string[], startAt: number): string | undefined {
  for (let i = startAt; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith("--")) { i++; continue } // skip flag + its value
    return a
  }
  return undefined
}

async function send(action: Action, contextId?: string, sessionId?: string): Promise<DaemonResult> {
  const withSession = sessionId ? { ...action, sessionId } : action
  try {
    const resp: DaemonResponse = await sendCommand(withSession, undefined, contextId)
    return resp.result
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

function emit(result: DaemonResult, jsonMode: boolean, plain?: (data: unknown) => string | undefined): void {
  if (jsonMode) {
    const errPayload =
      result.data && typeof result.data === "object" && !Array.isArray(result.data)
        ? { error: result.error, ...(result.data as Record<string, unknown>) }
        : { error: result.error }
    console.log(JSON.stringify(result.success ? (result.data ?? null) : errPayload))
    return
  }
  if (!result.success) {
    const code = (result.data as { code?: string; next?: string } | undefined)?.code
    const next = (result.data as { next?: string } | undefined)?.next
    console.error(`error${code ? ` [${code}]` : ""}: ${result.error || "unknown error"}${next ? `\n  → ${next}` : ""}`)
    return
  }
  const rendered = plain?.(result.data)
  if (rendered !== undefined) { console.log(rendered); return }
  const data = result.data
  if (data === undefined || data === null) console.log("ok")
  else if (typeof data === "string") console.log(data)
  else console.log(JSON.stringify(data, null, 2))
}

function emitExit(result: DaemonResult, jsonMode: boolean, plain?: (data: unknown) => string | undefined): void {
  emit(result, jsonMode, plain)
  if (!result.success) process.exit(1)
}

const WEB_HELP = `interceptor ios web — inspect & drive web content on a paired iPhone (no Safari, no Xcode)

Discovery & lifecycle (no runner needed):
  targets [--watch]                 list inspectable apps/pages/workers
  attach <target-id> [--replace]    open a WIP session on a target (iwt_…)
  detach [--session <id>]           close the session
  status [--session <id>]           transport, target, domains, native-lane health
  explain                           diagnose pairing / setting / service / target / protocol

Read (no runner needed):
  read   [--session <id>]           DOM-derived tree with wN refs
  text   [--session <id>]           visible document text
  find   <query> [--role <role>]    find nodes → wN refs
  inspect <wN>                      node attributes, box, styles

Protocol (no runner needed):
  eval   <expression> [--timeout <s>]   Runtime.evaluate
  call   <Domain.method> [--params-json <json>] [--timeout <s>]   raw WIP (unredacted)
  console start|log|stop            buffered console events
  network start|log|stop            buffered network events (redacted)

Actions ( --mode dom|native|auto ; native needs the runner + calibration):
  click  <wN> [--mode …]            default dom (synthetic, not a trusted tap)
  type   <wN> <text> [--mode …]
  keys   <text> [--mode …]
  scroll [--ref <wN>] [--dx N] [--dy N] [--mode …]
  calibrate [--webview <eN>]        validate DOM→device mapping (runner)
  screenshot [--out <path>]         whole-device screenshot (runner)

Target a device with --on <alias|udid>. Web sessions are addressed with --session <iws_…>.`

export async function runIosWebCommand(
  filtered: string[],
  opts: { jsonMode?: boolean; contextId?: string },
): Promise<void> {
  // filtered = ["ios", "web", <sub>, ...args]
  const sub = filtered[2]
  const args = filtered
  const jsonMode = opts.jsonMode === true
  const contextId = opts.contextId ?? flagValue(filtered, "--on") ?? flagValue(filtered, "--context")
  const sessionId = flagValue(args, "--session")

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") { console.log(WEB_HELP); return }

  switch (sub) {
    case "targets": {
      if (hasFlag(args, "--watch")) { await watchTargets(contextId, jsonMode); return }
      emitExit(await send({ type: "ios_web_targets" }, contextId), jsonMode, renderTargets)
      return
    }

    case "attach": {
      const targetId = positional(args, 3)
      if (!targetId) { console.error("usage: interceptor ios web attach <target-id>  (from 'ios web targets')"); process.exit(1) }
      emitExit(await send({ type: "ios_web_attach", targetId, replace: hasFlag(args, "--replace") }, contextId), jsonMode, renderAttach)
      return
    }

    case "detach":
      emitExit(await send({ type: "ios_web_detach" }, contextId, sessionId), jsonMode)
      return

    case "status":
      emitExit(await send({ type: "ios_web_status" }, contextId, sessionId), jsonMode, renderStatus)
      return

    case "explain":
      emitExit(await send({ type: "ios_web_explain" }, contextId), jsonMode, renderExplain)
      return

    case "read":
      emitExit(await send({ type: "ios_web_read" }, contextId, sessionId), jsonMode, (d) => (d as { tree?: string })?.tree)
      return

    case "text":
      emitExit(await send({ type: "ios_web_text" }, contextId, sessionId), jsonMode, (d) => (d as { text?: string })?.text)
      return

    case "find": {
      const query = positional(args, 3)
      if (!query) { console.error("usage: interceptor ios web find <query> [--role <role>]"); process.exit(1) }
      emitExit(await send({ type: "ios_web_find", query, role: flagValue(args, "--role") }, contextId, sessionId), jsonMode, renderFind)
      return
    }

    case "inspect": {
      const ref = positional(args, 3)
      if (!ref) { console.error("usage: interceptor ios web inspect <wN>"); process.exit(1) }
      emitExit(await send({ type: "ios_web_inspect", ref }, contextId, sessionId), jsonMode)
      return
    }

    case "eval": {
      const expression = positional(args, 3)
      if (!expression) { console.error("usage: interceptor ios web eval <expression>"); process.exit(1) }
      emitExit(await send({ type: "ios_web_eval", expression, timeout: timeoutMsFlag(args) }, contextId, sessionId), jsonMode,
        (d) => JSON.stringify((d as { result?: unknown })?.result))
      return
    }

    case "call": {
      const method = positional(args, 3)
      if (!method || !method.includes(".")) { console.error("usage: interceptor ios web call <Domain.method> [--params-json <json>]"); process.exit(1) }
      let params: unknown
      const raw = flagValue(args, "--params-json")
      if (raw) { try { params = JSON.parse(raw) } catch { console.error("error: --params-json is not valid JSON"); process.exit(1) } }
      emitExit(await send({ type: "ios_web_call", method, params, timeout: timeoutMsFlag(args), mutating: hasFlag(args, "--mutating") }, contextId, sessionId), jsonMode,
        (d) => JSON.stringify((d as { result?: unknown })?.result, null, 2))
      return
    }

    case "click":
    case "type":
    case "keys":
    case "scroll": {
      const mode = flagValue(args, "--mode")
      const action: Action = { type: `ios_web_${sub}`, mode }
      if (sub === "click") action.ref = positional(args, 3)
      else if (sub === "type") { action.ref = positional(args, 3); action.text = positionalNth(args, 3, 2) }
      else if (sub === "keys") action.text = positional(args, 3)
      else { action.ref = flagValue(args, "--ref"); action.dx = numFlag(args, "--dx"); action.dy = numFlag(args, "--dy") }
      emitExit(await send(action, contextId, sessionId), jsonMode, renderAction)
      return
    }

    case "calibrate":
      emitExit(await send({ type: "ios_web_calibrate", webview: flagValue(args, "--webview") }, contextId, sessionId), jsonMode)
      return

    case "console":
    case "network": {
      const operation = positional(args, 3) ?? "log"
      if (!["start", "log", "stop"].includes(operation)) { console.error(`usage: interceptor ios web ${sub} start|log|stop`); process.exit(1) }
      emitExit(await send({ type: `ios_web_${sub}`, operation }, contextId, sessionId), jsonMode, renderEvents)
      return
    }

    case "screenshot": {
      const result = await send({ type: "ios_web_screenshot", targetMaxLongEdge: numFlag(args, "--target-max-long-edge") }, contextId, sessionId)
      if (result.success && result.data && typeof result.data === "object") {
        const d = result.data as { dataUrl?: string; format?: string }
        if (d.dataUrl) {
          const base64 = d.dataUrl.split(",")[1] ?? ""
          const ext = d.format === "png" ? "png" : "jpg"
          const filename = flagValue(args, "--out") ?? `interceptor-ios-web-screenshot-${Date.now()}.${ext}`
          await Bun.write(filename, Buffer.from(base64, "base64"))
          if (jsonMode) console.log(JSON.stringify({ filePath: filename, format: d.format }))
          else console.log(`saved: ${filename}`)
          return
        }
      }
      emitExit(result, jsonMode)
      return
    }

    default:
      console.log(WEB_HELP)
  }
}

/** For `type <ref> <text>`: the Nth positional (1-based) starting at index. */
function positionalNth(args: string[], startAt: number, n: number): string | undefined {
  let seen = 0
  for (let i = startAt; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith("--")) { i++; continue }
    if (++seen === n) return a
  }
  return undefined
}

// ── plain renderers ────────────────────────────────────────────────────────────

function renderTargets(data: unknown): string | undefined {
  const d = data as { deviceContextId?: string; transport?: string; applications?: Array<{ name?: string; bundleId?: string; targets?: Array<{ targetId: string; type: string; title?: string; url?: string }> }> }
  if (!d?.applications) return undefined
  const lines: string[] = [`device ${d.deviceContextId ?? "?"} (transport: ${d.transport ?? "?"})`]
  if (d.applications.length === 0) lines.push("  (no inspectable targets — open/foreground a Safari page or an inspectable WKWebView)")
  for (const app of d.applications) {
    lines.push(`  ${app.name ?? app.bundleId ?? "app"}${app.bundleId ? ` (${app.bundleId})` : ""}`)
    for (const t of app.targets ?? []) lines.push(`    ${t.targetId}  ${t.type}  ${t.title ?? ""}${t.url ? `  ${t.url}` : ""}`)
  }
  return lines.join("\n")
}

function renderAttach(data: unknown): string | undefined {
  const d = data as { sessionId?: string; target?: { type?: string; title?: string }; capabilities?: { nativeLane?: boolean } }
  if (!d?.sessionId) return undefined
  return `attached ${d.sessionId} → ${d.target?.type ?? "target"} ${d.target?.title ?? ""}\n  native lane: ${d.capabilities?.nativeLane ? "available" : "unavailable (web lane only)"}`
}

function renderStatus(data: unknown): string | undefined {
  const d = data as { sessionId?: string; session?: null; transport?: string; envelopeMode?: string; setupVariant?: string; nativeLaneAvailable?: boolean }
  if (d?.session === null) return `no web session on ${(d as { deviceContextId?: string }).deviceContextId ?? "device"} — native lane: ${d.nativeLaneAvailable ? "available" : "unavailable"}`
  if (!d?.sessionId) return undefined
  return `session ${d.sessionId}\n  transport: ${d.transport}  envelope: ${d.envelopeMode}  setup: ${d.setupVariant}\n  native lane: ${d.nativeLaneAvailable ? "available" : "unavailable"}`
}

function renderExplain(data: unknown): string | undefined {
  const d = data as { checks?: Array<{ step: string; ok: boolean; detail?: string }> }
  if (!d?.checks) return undefined
  return d.checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${c.step}${c.detail ? ` — ${c.detail}` : ""}`).join("\n")
}

function renderFind(data: unknown): string | undefined {
  const d = data as { matches?: Array<{ ref: string; role?: string; name?: string; text?: string }> }
  if (!d?.matches) return undefined
  if (d.matches.length === 0) return "(no matches)"
  return d.matches.map((m) => `  ${m.ref}  ${m.role ?? ""}  ${m.name ?? m.text ?? ""}`).join("\n")
}

function renderAction(data: unknown): string | undefined {
  const d = data as { mode?: { modeUsed?: string; trustedInput?: boolean; fallbackReason?: string }; result?: unknown }
  if (!d?.mode) return undefined
  const trust = d.mode.trustedInput ? "trusted native" : "synthetic (not a trusted tap)"
  return `${d.mode.modeUsed} — ${trust}${d.mode.fallbackReason ? ` [${d.mode.fallbackReason}]` : ""}`
}

function renderEvents(data: unknown): string | undefined {
  const d = data as { events?: unknown[]; dropped?: number; started?: boolean; stopped?: boolean }
  if (d?.started) return "started"
  if (d?.stopped) return "stopped"
  if (!Array.isArray(d?.events)) return undefined
  const head = `${d.events!.length} event(s)${d.dropped ? ` (+${d.dropped} dropped — buffer_overflow)` : ""}`
  return [head, ...d.events!.map((e) => "  " + JSON.stringify(e))].join("\n")
}

// ── targets --watch (CLI polling; no new daemon protocol) ──────────

async function watchTargets(contextId: string | undefined, jsonMode: boolean): Promise<void> {
  let prev = new Map<string, string>()
  let running = true
  const stop = () => { running = false }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)

  while (running) {
    const result = await send({ type: "ios_web_targets" }, contextId)
    if (result.success && result.data && typeof result.data === "object") {
      const d = result.data as { deviceContextId?: string; applications?: Array<{ targets?: Array<Record<string, unknown>> }> }
      const next = new Map<string, string>()
      const observedAt = new Date().toISOString()
      for (const app of d.applications ?? []) {
        for (const t of app.targets ?? []) {
          const id = String((t as { targetId?: string }).targetId ?? "")
          next.set(id, JSON.stringify({ title: (t as { title?: string }).title, url: (t as { url?: string }).url }))
          if (!prev.has(id)) emitWatch("added", d.deviceContextId, t, observedAt, jsonMode)
          else if (prev.get(id) !== next.get(id)) emitWatch("changed", d.deviceContextId, t, observedAt, jsonMode)
        }
      }
      for (const [id, val] of prev) {
        if (!next.has(id)) emitWatch("removed", d.deviceContextId, { targetId: id, ...JSON.parse(val) }, observedAt, jsonMode)
      }
      prev = next
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

function emitWatch(event: string, deviceContextId: string | undefined, target: unknown, observedAt: string, jsonMode: boolean): void {
  if (jsonMode) { console.log(JSON.stringify({ event, deviceContextId, target, observedAt })); return }
  const t = target as { targetId?: string; title?: string; url?: string }
  console.log(`${observedAt} ${event.padEnd(7)} ${t.targetId ?? ""} ${t.title ?? ""}${t.url ? ` ${t.url}` : ""}`)
}
