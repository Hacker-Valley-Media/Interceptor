/**
 * cli/commands/monitor.ts — slop monitor start/stop/status/pause/resume/tail/list/export
 *
 * Subcommands that hit the daemon return an Action object.
 * Subcommands that read EVENTS_PATH directly (tail, list, export) return null
 * after handling their own output, matching the pattern in cli/commands/meta.ts case "events".
 */

import { existsSync, readFileSync } from "node:fs"
import { EVENTS_PATH } from "../../shared/platform"

type Action = { type: string; [key: string]: unknown }

interface MonEvent {
  timestamp?: string
  event?: string
  sid?: string
  s?: number
  t?: number
  tid?: number
  url?: string
  ins?: string
  ref?: string
  r?: string
  n?: string
  tg?: string
  x?: number
  y?: number
  v?: string
  ic?: boolean
  tr?: boolean
  kc?: string
  sx?: number
  sy?: number
  c?: number
  add?: number
  rem?: number
  attr?: number
  txt?: number
  tgts?: string[]
  u?: string
  m?: string
  st?: number
  bz?: number
  ct?: string
  typ?: string
  cause?: number
  evt?: number
  mut?: number
  net?: number
  nav?: number
  dur?: number
  reason?: string
  fid?: number
  [key: string]: unknown
}

const MON_KINDS = new Set([
  "mon_start", "mon_stop", "mon_pause", "mon_resume",
  "click", "dblclick", "rclick", "input", "change", "submit",
  "key", "scroll", "focus", "blur", "copy", "paste",
  "mut", "fetch", "xhr", "nav", "reload", "error"
])

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i === -1) return undefined
  return args[i + 1]
}

function flagPresent(args: string[], flag: string): boolean {
  return args.indexOf(flag) !== -1
}

export function readMonEvents(filterSid?: string): MonEvent[] {
  if (!existsSync(EVENTS_PATH)) return []
  const content = readFileSync(EVENTS_PATH, "utf-8")
  if (!content.trim()) return []
  const out: MonEvent[] = []
  for (const line of content.split("\n")) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line) as MonEvent
      if (!ev.event || !MON_KINDS.has(ev.event)) continue
      if (filterSid && ev.sid !== filterSid) continue
      out.push(ev)
    } catch {}
  }
  return out
}

export function listSessions(): Array<{
  sid: string; tid?: number; url?: string; ins?: string;
  startedAt: number; endedAt?: number; evt: number; mut: number;
  net: number; dur?: number; status: "active" | "stopped"
}> {
  const events = readMonEvents()
  const map = new Map<string, ReturnType<typeof listSessions>[number]>()
  for (const ev of events) {
    if (!ev.sid) continue
    let rec = map.get(ev.sid)
    if (!rec) {
      rec = {
        sid: ev.sid,
        tid: undefined,
        url: undefined,
        ins: undefined,
        startedAt: ev.t || 0,
        endedAt: undefined,
        evt: 0,
        mut: 0,
        net: 0,
        dur: undefined,
        status: "active"
      }
      map.set(ev.sid, rec)
    }
    rec.evt += 1
    if (ev.event === "mut") rec.mut += 1
    if (ev.event === "fetch" || ev.event === "xhr") rec.net += 1
    if (ev.event === "mon_start") {
      rec.startedAt = ev.t || rec.startedAt
      rec.tid = ev.tid
      rec.url = ev.url
      rec.ins = ev.ins
    }
    if (ev.event === "mon_stop") {
      rec.endedAt = ev.t
      rec.dur = ev.dur
      rec.status = "stopped"
    }
  }
  return Array.from(map.values()).sort((a, b) => a.startedAt - b.startedAt)
}

function pad(s: string, w: number, right = false): string {
  if (s.length >= w) return s
  const fill = " ".repeat(w - s.length)
  return right ? fill + s : s + fill
}

function relSeconds(t: number, base: number): string {
  const d = (t - base) / 1000
  const sign = d >= 0 ? "+" : "-"
  return `[${sign}${Math.abs(d).toFixed(3)}]`
}

function shortUrl(u: string): string {
  try {
    const parsed = new URL(u)
    return parsed.pathname + parsed.search
  } catch {
    return u
  }
}

export function renderEvent(ev: MonEvent, base: number): string {
  const rel = relSeconds(ev.t || base, base)
  const k = pad(ev.event || "?", 9)
  switch (ev.event) {
    case "mon_start":
      return `  ${rel}  ${k}  ${ev.sid?.slice(0, 8) || ""}  tab ${ev.tid || ""}  ${ev.url || ""}${ev.ins ? `\n            instruction: ${ev.ins}` : ""}`
    case "mon_stop":
      return `  ${rel}  ${k}  reason=${ev.reason || "?"}  ${ev.evt}evt ${ev.mut}mut ${ev.net}net ${ev.nav || 0}nav  ${((ev.dur || 0) / 1000).toFixed(3)}s`
    case "mon_pause":
    case "mon_resume":
      return `  ${rel}  ${k}`
    case "click":
    case "dblclick":
    case "rclick": {
      const trusted = ev.tr === false ? " synthetic" : ""
      const ref = ev.ref ? pad(ev.ref, 5) : pad("?", 5)
      const role = pad(ev.r || ev.tg || "?", 10)
      const name = ev.n ? `"${ev.n}"` : ""
      const at = ev.x !== undefined && ev.y !== undefined ? `(${ev.x},${ev.y})` : ""
      return `  ${rel}  ${k}  ${ref} ${role} ${name}  ${at}${trusted}`
    }
    case "input":
    case "change": {
      const ref = ev.ref ? pad(ev.ref, 5) : pad("?", 5)
      const role = pad(ev.r || ev.tg || "?", 10)
      const name = ev.n ? `"${ev.n}"` : ""
      const val = ev.v !== undefined ? `v="${ev.v}"` : ""
      return `  ${rel}  ${k}  ${ref} ${role} ${name}  ${val}`
    }
    case "key":
      return `  ${rel}  ${k}  ${ev.kc || "?"}${ev.ref ? `  ${ev.ref}` : ""}`
    case "scroll":
      return `  ${rel}  ${k}  dx=${ev.sx || 0} dy=${ev.sy || 0}`
    case "focus":
    case "blur":
      return `  ${rel}  ${k}  ${ev.ref || "?"}  ${ev.r || ""}  ${ev.n ? `"${ev.n}"` : ""}`
    case "copy":
    case "paste":
      return `  ${rel}  ${k}  ${ev.ref || "?"}`
    case "submit":
      return `  ${rel}  ${k}  ${ev.ref || "?"}  ${ev.n ? `"${ev.n}"` : ""}`
    case "mut": {
      const cause = ev.cause !== undefined ? `(cause: #${ev.cause})` : "(autonomous)"
      const counts = `+${ev.add || 0} -${ev.rem || 0} attr:${ev.attr || 0}${ev.txt ? ` txt:${ev.txt}` : ""}`
      return `  ${rel}  ${k}  ${counts}  ${cause}`
    }
    case "fetch":
    case "xhr": {
      const cause = ev.cause !== undefined ? `(cause: #${ev.cause})` : "(autonomous)"
      const u = ev.u ? shortUrl(ev.u) : "?"
      const sz = ev.bz ? `${(ev.bz / 1024).toFixed(1)}kB` : ""
      return `  ${rel}  ${k}  ${ev.m || "GET"} ${u} ${ev.st || 0}  ${sz}  ${cause}`
    }
    case "nav": {
      const cause = ev.cause !== undefined ? `(cause: #${ev.cause})` : ""
      const u = ev.u ? shortUrl(ev.u) : "?"
      return `  ${rel}  ${k}  ${ev.typ || "?"} \u2192 ${u}  ${cause}`
    }
    default:
      return `  ${rel}  ${k}  ${JSON.stringify(ev).slice(0, 200)}`
  }
}

export function renderSession(sid: string): string {
  const events = readMonEvents(sid)
  if (events.length === 0) return `(no events for session ${sid})`
  const start = events.find((e) => e.event === "mon_start")
  const stop = events.find((e) => e.event === "mon_stop")
  const base = start?.t || events[0].t || 0
  const lines: string[] = []
  const startedAt = start?.t ? new Date(start.t).toISOString().replace("T", " ").slice(0, 19) : "?"
  lines.push(`session ${sid}  started ${startedAt}  tab ${start?.tid || "?"}  ${start?.url || ""}`)
  if (start?.ins) lines.push(`  instruction: ${start.ins}`)
  if (stop) lines.push(`  ended after ${((stop.dur || 0) / 1000).toFixed(3)}s  ${stop.evt}evt ${stop.mut}mut ${stop.net}net`)
  else lines.push(`  status: active`)
  lines.push("")
  for (const ev of events) {
    if (ev.event === "mon_start" || ev.event === "mon_stop") continue
    lines.push(renderEvent(ev, base))
  }
  return lines.join("\n")
}

export function escapeArg(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export function buildPlan(sid: string): string {
  const events = readMonEvents(sid)
  if (events.length === 0) return `# (no events for session ${sid})`
  const start = events.find((e) => e.event === "mon_start")
  const lines: string[] = []
  lines.push(`# Replay plan for session ${sid}`)
  if (start?.ins) lines.push(`# Instruction: ${start.ins}`)
  lines.push(`# Generated at ${new Date().toISOString()}`)
  lines.push("")

  if (start?.url) {
    lines.push(`slop tab new "${escapeArg(start.url)}"`)
    lines.push(`slop wait-stable`)
  }

  type IndexedEvent = { ev: MonEvent; idx: number }
  const evList: IndexedEvent[] = events.map((ev, idx) => ({ ev, idx }))

  function nextMutBetween(fromIdx: number, untilIdx: number): boolean {
    for (let i = fromIdx + 1; i < untilIdx; i++) {
      if (evList[i].ev.event === "mut") return true
    }
    return false
  }

  function nextActionIdx(fromIdx: number): number {
    for (let i = fromIdx + 1; i < evList.length; i++) {
      const k = evList[i].ev.event
      if (k === "click" || k === "dblclick" || k === "rclick" || k === "input" || k === "change" || k === "key" || k === "submit") return i
    }
    return evList.length
  }

  for (let i = 0; i < evList.length; i++) {
    const { ev } = evList[i]
    const k = ev.event
    if (k === "mon_start" || k === "mon_stop" || k === "mon_pause" || k === "mon_resume") continue
    if (k === "scroll" || k === "focus" || k === "blur") continue
    if (ev.tr === false) {
      lines.push(`# skipped synthetic ${k} (slop-injected)`)
      continue
    }
    switch (k) {
      case "click":
      case "dblclick":
      case "rclick": {
        const role = ev.r || ev.tg || ""
        const name = ev.n || ""
        if (role && name) {
          const cmd = k === "click" ? "click" : k === "dblclick" ? "dblclick" : "rightclick"
          lines.push(`slop ${cmd} "${escapeArg(role)}:${escapeArg(name)}"`)
        } else if (ev.ref) {
          const cmd = k === "click" ? "click" : k === "dblclick" ? "dblclick" : "rightclick"
          lines.push(`# ref ${ev.ref} (no accessible name) — falling back to ref id, may be stale`)
          lines.push(`slop ${cmd} ${ev.ref}`)
        } else {
          lines.push(`# ${k} with no ref or name — skipped`)
        }
        break
      }
      case "input":
      case "change": {
        const role = ev.r || ev.tg || ""
        const name = ev.n || ""
        if (typeof ev.v === "string" && ev.v.startsWith("***") && ev.v.endsWith("***")) {
          lines.push(`# TODO: type into ${role}:${name} — original value was masked (length ${ev.v.length - 6})`)
          break
        }
        const value = (ev.v as string) || ""
        if (role && name) {
          lines.push(`slop type "${escapeArg(role)}:${escapeArg(name)}" "${escapeArg(value)}"`)
        } else if (ev.ref) {
          lines.push(`# ref ${ev.ref} (no accessible name)`)
          lines.push(`slop type ${ev.ref} "${escapeArg(value)}"`)
        }
        break
      }
      case "key":
        if (ev.kc) lines.push(`slop keys "${escapeArg(ev.kc)}"`)
        break
      case "submit":
        lines.push(`# form submit on ${ev.ref || "?"} (usually triggered by Enter or click — covered above)`)
        break
      case "mut":
        // Mutation events become wait-stable hints, handled below
        break
      case "fetch":
      case "xhr": {
        if (ev.cause !== undefined) {
          const u = ev.u ? shortUrl(ev.u) : ""
          lines.push(`#   correlated ${k} ${ev.m || "GET"} ${u} ${ev.st || 0}  cause:#${ev.cause}`)
          if (u) lines.push(`# slop net log --filter "${escapeArg(u)}" --limit 1`)
        } else {
          lines.push(`# autonomous ${k} ${ev.m || "GET"} ${ev.u || ""} (polling/timer)`)
        }
        break
      }
      case "nav": {
        if (ev.typ === "hard" || ev.typ === "reload") {
          if (ev.u) {
            lines.push(`slop navigate "${escapeArg(ev.u)}"`)
            lines.push(`slop wait-stable`)
          }
        } else {
          lines.push(`# nav (${ev.typ}) -> ${ev.u || ""}  (caused by previous click)`)
        }
        break
      }
    }

    // Insert wait-stable after this action if a mutation follows before the next action
    const nextIdx = nextActionIdx(i)
    if (nextMutBetween(i, nextIdx)) {
      lines.push(`slop wait-stable`)
    }
  }

  return lines.join("\n")
}

function withBodies(planText: string, sid: string): string {
  // For v1, --with-bodies emits the same plan but expands every commented `slop net log` line
  // into an actual `slop net log` invocation. The agent runs the plan and the net log entries
  // surface inline. Bodies themselves live in the live tab's net-buffer (cap 500); if rotated,
  // the agent will see (no entries) — same as the existing slop net log behavior.
  return planText.replace(/^# slop net log /gm, "slop net log ")
}

export async function parseMonitorCommand(filtered: string[], jsonMode = false): Promise<Action | null> {
  const sub = filtered[1]
  if (!sub || sub === "help") {
    console.log(MONITOR_HELP)
    return null
  }

  switch (sub) {
    case "start": {
      const inst = flagValue(filtered, "--instruction")
      const action: Action = { type: "monitor_start" }
      if (inst) action.instruction = inst
      return action
    }
    case "stop":
      return { type: "monitor_stop" }
    case "pause":
      return { type: "monitor_pause" }
    case "resume":
      return { type: "monitor_resume" }
    case "status":
      return { type: "monitor_status" }

    case "tail": {
      const sidFilter = flagValue(filtered, "--session")
      const raw = flagPresent(filtered, "--raw")
      if (!existsSync(EVENTS_PATH)) {
        console.log("(no events file yet — start a session first with: slop monitor start)")
        return null
      }
      const proc = Bun.spawn(["tail", "-f", "-n", "0", EVENTS_PATH], { stdout: "pipe", stderr: "inherit" })
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl = buf.indexOf("\n")
        while (nl !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          nl = buf.indexOf("\n")
          if (!line.trim()) continue
          try {
            const ev = JSON.parse(line) as MonEvent
            if (!ev.event || !MON_KINDS.has(ev.event)) continue
            if (sidFilter && ev.sid !== sidFilter) continue
            if (raw || jsonMode) {
              console.log(line)
            } else {
              const base = ev.t || 0
              console.log(renderEvent(ev, base))
            }
          } catch {}
        }
      }
      return null
    }

    case "list": {
      const sessions = listSessions()
      if (sessions.length === 0) {
        console.log("(no monitor sessions found in event log)")
        return null
      }
      if (jsonMode) {
        console.log(JSON.stringify(sessions, null, 2))
        return null
      }
      console.log(`${pad("session", 38)}${pad("status", 10)}${pad("started", 22)}${pad("tab", 12)}${pad("evt", 6)}${pad("mut", 6)}${pad("net", 6)}url`)
      for (const s of sessions) {
        const started = s.startedAt ? new Date(s.startedAt).toISOString().replace("T", " ").slice(0, 19) : "?"
        const url = s.url ? shortUrl(s.url) : ""
        console.log(`${pad(s.sid, 38)}${pad(s.status, 10)}${pad(started, 22)}${pad(String(s.tid || ""), 12)}${pad(String(s.evt), 6)}${pad(String(s.mut), 6)}${pad(String(s.net), 6)}${url}`)
      }
      return null
    }

    case "export": {
      const sid = filtered[2]
      if (!sid || sid.startsWith("--")) {
        console.error("error: slop monitor export requires a sessionId. Use 'slop monitor list' to find one.")
        process.exit(1)
      }
      const json = flagPresent(filtered, "--json")
      const plan = flagPresent(filtered, "--plan")
      const wb = flagPresent(filtered, "--with-bodies")
      if (json) {
        const events = readMonEvents(sid)
        for (const ev of events) console.log(JSON.stringify(ev))
        return null
      }
      if (plan) {
        let text = buildPlan(sid)
        if (wb) text = withBodies(text, sid)
        console.log(text)
        return null
      }
      console.log(renderSession(sid))
      return null
    }

    default:
      console.error(`error: unknown monitor subcommand '${sub}'. Try: start, stop, status, pause, resume, tail, list, export.`)
      process.exit(1)
  }
}

const MONITOR_HELP = `slop monitor — record user sessions for agent replay

Usage:
  slop monitor start [--instruction "<text>"]
  slop monitor stop
  slop monitor status
  slop monitor pause
  slop monitor resume
  slop monitor tail [--session <sid>] [--raw]
  slop monitor list
  slop monitor export <sessionId> [--json|--plan] [--with-bodies]

start    Begin recording on the active slop-group tab.
stop     End the active session and emit a summary.
status   Show active sessions and counts.
pause    Pause emission temporarily (does not unhook listeners).
resume   Resume emission.
tail     Live tail of recorded events. Pretty by default; --raw for JSONL.
list     List all sessions historically present in the event log.
export   Render a session as text, JSON (--json), or replay plan (--plan).
         --with-bodies turns commented 'slop net log' cues into live invocations.
`
