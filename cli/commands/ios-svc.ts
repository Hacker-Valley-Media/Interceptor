/**
 * cli/commands/ios-svc.ts — `interceptor ios <diag|logs|fs|crash|profiles|notify|springboard>`
 *. Runner-free classic-Lockdown device-service introspection lane.
 * Parses the subcommands, sends `ios_svc_*` daemon actions, renders plain/JSON,
 * streams with --follow, and writes pulled bytes to disk. Called by cli/commands/ios.ts.
 */

import { sendCommand, jsonFailure, type DaemonResponse, type DaemonResult } from "../transport"

type Action = { type: string; [key: string]: unknown }

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  const v = args[idx + 1]
  if (!v || v.startsWith("--")) return undefined
  return v
}
function hasFlag(args: string[], flag: string): boolean { return args.includes(flag) }
/** Nth non-flag positional at/after index (1-based). */
function positional(args: string[], startAt: number, n = 1): string | undefined {
  let seen = 0
  for (let i = startAt; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith("--")) { i++; continue }
    if (++seen === n) return a
  }
  return undefined
}

async function send(action: Action, contextId?: string): Promise<DaemonResult> {
  try { const resp: DaemonResponse = await sendCommand(action, undefined, contextId); return resp.result }
  catch (err) { return { success: false, error: (err as Error).message } }
}

function emit(result: DaemonResult, jsonMode: boolean, plain?: (d: unknown) => string | undefined): void {
  if (jsonMode) {
        console.log(JSON.stringify(result.success ? (result.data ?? null) : jsonFailure(result))); return
  }
  if (!result.success) {
    const code = (result.data as { code?: string; next?: string } | undefined)?.code
    const next = (result.data as { next?: string } | undefined)?.next
    console.error(`error${code ? ` [${code}]` : ""}: ${result.error || "unknown error"}${next ? `\n  → ${next}` : ""}`); return
  }
  const rendered = plain?.(result.data)
  if (rendered !== undefined) { console.log(rendered); return }
  const d = result.data
  if (d === undefined || d === null) console.log("ok")
  else if (typeof d === "string") console.log(d)
  else console.log(JSON.stringify(d, null, 2))
}
function emitExit(result: DaemonResult, jsonMode: boolean, plain?: (d: unknown) => string | undefined): void {
  emit(result, jsonMode, plain); if (!result.success) process.exit(1)
}

const HELP = `interceptor ios — device-service introspection (runner-free, classic Lockdown)

  diag [battery|gestalt|ioreg|all] [--key <k>]   device facts / health
  logs [--filter <re>] [--follow]                live syslog stream
  fs ls <path> [--app <bundle>]                  list files (media, or app container)
  fs pull <remote> <local> [--app <bundle>]      copy a file off the device
  fs push <local> <remote> --app <bundle>        copy into an OWNED app container
  crash list | crash pull <name> [<out>]         crash reports
  profiles                                       installed config + provisioning profiles
  notify observe <name> [--follow] | notify post <name>   Darwin notifications
  springboard icons | springboard wallpaper [--out <path>]  home-screen state

Target a device with --on <alias|udid>.`

export async function runIosSvcCommand(filtered: string[], opts: { jsonMode?: boolean; contextId?: string }): Promise<void> {
  // filtered = ["ios", <sub>, ...args]
  const sub = filtered[1]
  const args = filtered
  const jsonMode = opts.jsonMode === true
  const contextId = opts.contextId ?? flagValue(filtered, "--on") ?? flagValue(filtered, "--context")

  switch (sub) {
    case "diag": {
      const kind = positional(args, 2) ?? "all"
      const key = flagValue(args, "--key")
      emitExit(await send({ type: "ios_diag", kind, keys: key ? [key] : undefined }, contextId), jsonMode,
        (d) => renderKV((d as { diagnostics?: Record<string, unknown> })?.diagnostics))
      return
    }

    case "logs": {
      if (hasFlag(args, "--follow")) { await followStream("ios_logs", { filter: flagValue(args, "--filter") }, contextId, jsonMode, (e) => (e as { line?: string }).line ?? JSON.stringify(e)); return }
      // one-shot: start → settle → read → stop
      await send({ type: "ios_logs", operation: "start", filter: flagValue(args, "--filter") }, contextId)
      await sleep(1500)
      const r = await send({ type: "ios_logs", operation: "read" }, contextId)
      await send({ type: "ios_logs", operation: "stop" }, contextId)
      emitExit(r, jsonMode, (d) => renderEvents(d, (e) => (e as { line?: string }).line ?? ""))
      return
    }

    case "fs": {
      const op = positional(args, 2)
      const app = flagValue(args, "--app")
      if (op === "ls") {
        const path = positional(args, 3) ?? "."
        emitExit(await send({ type: "ios_fs", op: "ls", path, app }, contextId), jsonMode,
          (d) => ((d as { entries?: string[] })?.entries ?? []).join("\n"))
        return
      }
      if (op === "pull") {
        const remote = positional(args, 3); const local = positional(args, 3, 2)
        if (!remote) { console.error("usage: interceptor ios fs pull <remote> <local> [--app <bundle>]"); process.exit(1) }
        const r = await send({ type: "ios_fs", op: "pull", path: remote, app }, contextId)
        await writePulled(r, local ?? basenameOf(remote), jsonMode); return
      }
      if (op === "push") {
        const local = positional(args, 3); const remote = positional(args, 3, 2)
        if (!local || !remote || !app) { console.error("usage: interceptor ios fs push <local> <remote> --app <bundle>"); process.exit(1) }
        const base64 = Buffer.from(await Bun.file(local!).arrayBuffer()).toString("base64")
        emitExit(await send({ type: "ios_fs", op: "push", path: remote, app, base64 }, contextId), jsonMode)
        return
      }
      console.error("usage: interceptor ios fs ls|pull|push …"); process.exit(1)
    }

    case "crash": {
      const op = positional(args, 2) ?? "list"
      if (op === "list") {
        emitExit(await send({ type: "ios_crash", op: "list" }, contextId), jsonMode,
          (d) => ((d as { entries?: string[] })?.entries ?? []).join("\n"))
        return
      }
      const name = positional(args, 3); const out = positional(args, 3, 2)
      if (!name) { console.error("usage: interceptor ios crash pull <name> [<out>]"); process.exit(1) }
      const r = await send({ type: "ios_crash", op: "pull", name }, contextId)
      await writePulled(r, out ?? name!, jsonMode); return
    }

    case "profiles":
      emitExit(await send({ type: "ios_profiles" }, contextId), jsonMode, (d) => {
        const p = d as { config?: unknown[]; provisioning?: unknown[] }
        return `config profiles: ${p?.config?.length ?? 0}\nprovisioning profiles: ${p?.provisioning?.length ?? 0}`
      })
      return

    case "notify": {
      const op = positional(args, 2)
      if (op === "post") {
        const name = positional(args, 3)
        if (!name) { console.error("usage: interceptor ios notify post <name>"); process.exit(1) }
        emitExit(await send({ type: "ios_notify", operation: "post", name }, contextId), jsonMode); return
      }
      if (op === "observe") {
        const name = positional(args, 3)
        if (!name) { console.error("usage: interceptor ios notify observe <name> [--follow]"); process.exit(1) }
        if (hasFlag(args, "--follow")) { await followStream("ios_notify", { operation: "start", name }, contextId, jsonMode, (e) => (e as { name?: string }).name ?? "", { name }); return }
        await send({ type: "ios_notify", operation: "start", name }, contextId)
        await sleep(1500)
        const r = await send({ type: "ios_notify", operation: "read" }, contextId)
        await send({ type: "ios_notify", operation: "stop" }, contextId)
        emitExit(r, jsonMode, (d) => renderEvents(d, (e) => (e as { name?: string }).name ?? "")); return
      }
      console.error("usage: interceptor ios notify observe|post …"); process.exit(1)
    }

    case "springboard": {
      const s = positional(args, 2) ?? "icons"
      if (s === "wallpaper") {
        const r = await send({ type: "ios_springboard", sub: "wallpaper" }, contextId)
        await writePulled(r, flagValue(args, "--out") ?? `ios-wallpaper-${Date.now()}.png`, jsonMode); return
      }
      emitExit(await send({ type: "ios_springboard", sub: "icons" }, contextId), jsonMode)
      return
    }

    default:
      console.log(HELP)
  }
}

// ── streaming (--follow) ──────────────────────────────────────────────────────

async function followStream(
  type: string, startExtra: Record<string, unknown>, contextId: string | undefined, jsonMode: boolean,
  line: (e: unknown) => string, stopExtra: Record<string, unknown> = {},
): Promise<void> {
  await send({ type, operation: startExtra.operation ? String(startExtra.operation) : "start", ...startExtra }, contextId)
  let running = true
  const stop = async () => { running = false; await send({ type, operation: "stop", ...stopExtra }, contextId); process.exit(0) }
  process.on("SIGINT", () => { void stop() })
  while (running) {
    const r = await send({ type, operation: "read" }, contextId)
    if (r.success && r.data && typeof r.data === "object") {
      const events = (r.data as { events?: unknown[] }).events ?? []
      for (const e of events) console.log(jsonMode ? JSON.stringify(e) : line(e))
      if ((r.data as { closed?: boolean }).closed) { running = false; break }
    }
    await sleep(500)
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
function basenameOf(p: string): string { return p.split("/").pop() || "pulled.bin" }

async function writePulled(result: DaemonResult, outPath: string, jsonMode: boolean): Promise<void> {
  if (result.success && result.data && typeof result.data === "object") {
    const d = result.data as { base64?: string; bytes?: number }
    if (typeof d.base64 === "string") {
      await Bun.write(outPath, Buffer.from(d.base64, "base64"))
      if (jsonMode) console.log(JSON.stringify({ filePath: outPath, bytes: d.bytes }))
      else console.log(`saved: ${outPath} (${d.bytes ?? 0} bytes)`)
      return
    }
  }
  emitExit(result, jsonMode)
}

function renderEvents(d: unknown, line: (e: unknown) => string): string | undefined {
  const data = d as { events?: unknown[]; dropped?: number }
  if (!Array.isArray(data?.events)) return undefined
  const head = data.dropped ? `(+${data.dropped} dropped — buffer_overflow)` : ""
  return [head, ...data.events!.map(line)].filter(Boolean).join("\n")
}

function renderKV(obj: Record<string, unknown> | undefined): string | undefined {
  if (!obj || typeof obj !== "object") return undefined
  return Object.entries(obj).slice(0, 60).map(([k, v]) => `  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("\n")
}
