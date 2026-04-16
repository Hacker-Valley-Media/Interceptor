import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MONITOR_SESSIONS_DIR } from "./platform"

export const MONITOR_EVENT_NAMES = new Set([
  "mon_start", "mon_stop", "mon_pause", "mon_resume", "mon_attach", "mon_detach",
  "click", "dblclick", "rclick", "input", "change", "submit",
  "key", "scroll", "focus", "blur", "copy", "paste",
  "mut", "fetch", "xhr", "sse", "nav", "reload", "error"
])

export type MonitorEvent = {
  timestamp?: string
  event?: string
  sid?: string
  s?: number
  t?: number
  tid?: number
  doc?: string
  lif?: string
  url?: string
  ins?: string
  u?: string
  reason?: string
  openerTid?: number
  fid?: number
  evt?: number
  mut?: number
  net?: number
  nav?: number
  dur?: number
  [key: string]: unknown
}

export type MonitorAttachmentMeta = {
  key: string
  tabId: number
  documentId?: string
  frameId?: number
  url?: string
  openerTabId?: number
  attachedAt: number
  detachedAt?: number
  lifecycle?: string
  reason?: string
}

export type MonitorSessionMeta = {
  artifactVersion: number
  sessionId: string
  startedAt: number
  endedAt?: number
  status: "active" | "stopped"
  paused: boolean
  rootTabId?: number
  instruction?: string
  url?: string
  activeAttachmentKey?: string
  counts?: { evt: number; mut: number; net: number; nav: number }
  stopReason?: string
  attachments: MonitorAttachmentMeta[]
}

export type MonitorNetArtifact = {
  sid: string
  seq?: number
  tid?: number
  doc?: string
  cause?: number
  kind: "fetch" | "xhr" | "sse"
  url: string
  method?: string
  status?: number
  contentType?: string
  truncated?: boolean
  bodyBytes?: number
  bodyPreview: string
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function ensureMonitorSessionsDir(): void {
  if (!existsSync(MONITOR_SESSIONS_DIR)) mkdirSync(MONITOR_SESSIONS_DIR, { recursive: true })
}

export function getSessionDir(sessionId: string): string {
  return join(MONITOR_SESSIONS_DIR, sessionId)
}

export function getSessionEventsPath(sessionId: string): string {
  return join(getSessionDir(sessionId), "events.jsonl")
}

export function getSessionMetaPath(sessionId: string): string {
  return join(getSessionDir(sessionId), "session.json")
}

export function getSessionNetPath(sessionId: string): string {
  return join(getSessionDir(sessionId), "net.jsonl")
}

export function hasSessionArtifacts(sessionId: string): boolean {
  return existsSync(getSessionEventsPath(sessionId)) || existsSync(getSessionMetaPath(sessionId))
}

export function ensureSessionDir(sessionId: string): void {
  ensureMonitorSessionsDir()
  const dir = getSessionDir(sessionId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function appendSessionEvent(sessionId: string, event: MonitorEvent): void {
  ensureSessionDir(sessionId)
  appendFileSync(getSessionEventsPath(sessionId), JSON.stringify(event) + "\n")
}

export function readSessionEvents(sessionId: string): MonitorEvent[] {
  const path = getSessionEventsPath(sessionId)
  if (!existsSync(path)) return []
  const content = readFileSync(path, "utf-8")
  if (!content.trim()) return []
  const out: MonitorEvent[] = []
  for (const line of content.split("\n")) {
    if (!line.trim()) continue
    const parsed = safeParse<MonitorEvent>(line)
    if (parsed) out.push(parsed)
  }
  return out
}

export function readSessionMeta(sessionId: string): MonitorSessionMeta | null {
  const path = getSessionMetaPath(sessionId)
  if (!existsSync(path)) return null
  return safeParse<MonitorSessionMeta>(readFileSync(path, "utf-8"))
}

export function writeSessionMeta(meta: MonitorSessionMeta): void {
  ensureSessionDir(meta.sessionId)
  writeFileSync(getSessionMetaPath(meta.sessionId), JSON.stringify(meta, null, 2) + "\n")
}

export function updateSessionMeta(
  sessionId: string,
  updater: (current: MonitorSessionMeta | null) => MonitorSessionMeta
): MonitorSessionMeta {
  const next = updater(readSessionMeta(sessionId))
  writeSessionMeta(next)
  return next
}

export function appendSessionNetArtifact(sessionId: string, artifact: MonitorNetArtifact): void {
  ensureSessionDir(sessionId)
  appendFileSync(getSessionNetPath(sessionId), JSON.stringify(artifact) + "\n")
}

export function readSessionNetArtifacts(sessionId: string): MonitorNetArtifact[] {
  const path = getSessionNetPath(sessionId)
  if (!existsSync(path)) return []
  const content = readFileSync(path, "utf-8")
  if (!content.trim()) return []
  const out: MonitorNetArtifact[] = []
  for (const line of content.split("\n")) {
    if (!line.trim()) continue
    const parsed = safeParse<MonitorNetArtifact>(line)
    if (parsed) out.push(parsed)
  }
  return out
}

export function listPersistedSessionIds(): string[] {
  ensureMonitorSessionsDir()
  return readdirSync(MONITOR_SESSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return statSync(getSessionDir(name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
}
