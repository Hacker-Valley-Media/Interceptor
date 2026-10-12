/**
 * cli/commands/ios-dev.ts — `interceptor ios <proc|top|spawn|kill|location|gpu|
 * shot|backup|screen|axtree>`. The Instruments/DTX + telemetry +
 * developer-service lanes. Parses subcommands, sends `ios_dev_*` daemon actions,
 * renders plain/JSON, streams with --follow, writes bytes to disk. Called by
 * cli/commands/ios.ts. (oslog/pcap temporarily removed — see shared/ios-dev.ts.)
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

const HELP = `interceptor ios — developer, Instruments & telemetry lanes (runner-free)

  proc                                     running process list (Instruments deviceinfo)
  top [--follow]                           per-process CPU/mem samples (sysmontap)
  spawn <bundle> [--env K=V ...] [--arg X ...]   launch an app with env/args (processcontrol)
  kill <pid>                               kill a process by pid
  location set <lat> <lon> | location clear      simulate / clear GPS
  gpu [--follow]                           FPS / GPU sampling (graphics.opengl)
  shot [<out.png>]                         one-shot screenshot (screenshotr, else on-device runner)
  backup                                   mobilebackup2 handshake + protocol info
  screen [--out <dir>] [--seconds N] [--fps F]   live screen frames via the on-device runner
  axtree                                   runner-free accessibility probe (axAuditDaemon)

Target a device with --on <alias|udid>.`

export async function runIosDevCommand(filtered: string[], opts: { jsonMode?: boolean; contextId?: string }): Promise<void> {
  const sub = filtered[1]
  const args = filtered
  const jsonMode = opts.jsonMode === true
  const contextId = opts.contextId ?? flagValue(filtered, "--on") ?? flagValue(filtered, "--context")

  switch (sub) {
    case "proc": case "ps": {
      emitExit(await send({ type: "ios_proc" }, contextId), jsonMode, (d) => {
        const ps = (d as { processes?: Array<{ pid: number; name: string }> }).processes ?? []
        return ps.map((p) => `  ${String(p.pid).padStart(6)}  ${p.name}`).join("\n")
      })
      return
    }
    case "spawn": {
      const bundle = positional(args, 2)
      if (!bundle) { console.error("usage: interceptor ios spawn <bundle> [--env K=V ...] [--arg X ...]"); process.exit(1) }
      const env: Record<string, string> = {}
      for (let i = 0; i < args.length; i++) if (args[i] === "--env" && args[i + 1]) { const [k, ...r] = args[i + 1].split("="); env[k] = r.join("=") }
      const spawnArgs: string[] = []
      for (let i = 0; i < args.length; i++) if (args[i] === "--arg" && args[i + 1]) spawnArgs.push(args[i + 1])
      emitExit(await send({ type: "ios_spawn", bundle, env, args: spawnArgs, suspended: hasFlag(args, "--suspended") }, contextId), jsonMode,
        (d) => `launched ${(d as { bundleId?: string }).bundleId} → pid ${(d as { pid?: number }).pid}`)
      return
    }
    case "kill": {
      const pid = positional(args, 2)
      if (!pid) { console.error("usage: interceptor ios kill <pid>"); process.exit(1) }
      emitExit(await send({ type: "ios_kill", pid: Number(pid) }, contextId), jsonMode, (d) => `killed pid ${(d as { killed?: number }).killed}`)
      return
    }
    case "location": {
      const op = positional(args, 2) ?? "set"
      if (op === "clear") { emitExit(await send({ type: "ios_location", op: "clear" }, contextId), jsonMode, () => "location simulation cleared"); return }
      const lat = positional(args, 2, 2), lon = positional(args, 2, 3)
      if (!lat || !lon) { console.error("usage: interceptor ios location set <lat> <lon>"); process.exit(1) }
      emitExit(await send({ type: "ios_location", op: "set", lat: Number(lat), lon: Number(lon) }, contextId), jsonMode,
        (d) => `location set → ${(d as { lat?: number }).lat}, ${(d as { lon?: number }).lon}`)
      return
    }
    case "top": case "gpu": {
      const type = sub === "top" ? "ios_top" : "ios_gpu"
      if (hasFlag(args, "--follow")) { await followStream(type, {}, contextId, jsonMode, (e) => JSON.stringify((e as { sample?: unknown }).sample ?? e)); return }
      await send({ type, operation: "start" }, contextId)
      await sleep(1500)
      const r = await send({ type, operation: "read" }, contextId)
      await send({ type, operation: "stop" }, contextId)
      emitExit(r, jsonMode, (d) => renderEvents(d, (e) => JSON.stringify((e as { sample?: unknown }).sample ?? e)))
      return
    }
    case "shot": {
      const out = positional(args, 2) ?? `ios-shot-${stamp()}.png`
      await writePulled(await send({ type: "ios_shot" }, contextId), out, jsonMode)
      return
    }
    case "backup": {
      emitExit(await send({ type: "ios_backup" }, contextId), jsonMode,
        (d) => { const b = d as { ready?: boolean; protocolVersion?: number }; return `mobilebackup2 ready=${b.ready} protocolVersion=${b.protocolVersion ?? "?"}` })
      return
    }
    case "screen": {
      // Live screen as a frame sequence via the on-device runner (XCUIScreen).
      const out = flagValue(args, "--out")
      const seconds = Math.max(1, Number(flagValue(args, "--seconds") ?? "3"))
      const fps = Math.max(1, Number(flagValue(args, "--fps") ?? "2"))
      const start = await send({ type: "ios_screen", operation: "start", fps }, contextId)
      if (!start.success) { emitExit(start, jsonMode); return }
      await sleep(seconds * 1000)
      const r = await send({ type: "ios_screen", operation: "read" }, contextId)
      await send({ type: "ios_screen", operation: "stop" }, contextId)
      const frames = ((r.data as { events?: Array<{ base64?: string; format?: string }> })?.events) ?? []
      if (out && r.success && frames.length) {
        const dir = out.replace(/\/$/, "")
        let i = 0
        for (const f of frames) { i++; await Bun.write(`${dir}/frame-${String(i).padStart(4, "0")}.${f.format || "png"}`, Buffer.from(f.base64 ?? "", "base64")) }
        if (jsonMode) console.log(JSON.stringify({ dir, frames: frames.length, fps }))
        else console.log(`saved ${frames.length} frame(s) → ${dir}/ (${fps} fps)`)
        return
      }
      emitExit(r, jsonMode, (d) => `captured ${((d as { events?: unknown[] }).events ?? []).length} live frames (use --out <dir> to save the sequence)`)
      return
    }
    case "axtree": {
      emitExit(await send({ type: "ios_axtree" }, contextId), jsonMode)
      return
    }
    default:
      console.log(HELP)
  }
}

// ── streaming (--follow) ──────────────────────────────────────────────────────

async function followStream(
  type: string, startExtra: Record<string, unknown>, contextId: string | undefined, jsonMode: boolean,
  line: (e: unknown) => string,
): Promise<void> {
  await send({ type, operation: "start", ...startExtra }, contextId)
  let running = true
  const stop = async () => { running = false; await send({ type, operation: "stop" }, contextId); process.exit(0) }
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
function stamp(): string { return new Date().toISOString().replace(/[:.]/g, "-") }

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
