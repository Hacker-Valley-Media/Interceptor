import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MONITOR_SESSIONS_DIR } from "./platform"

export const MONITOR_EVENT_NAMES = new Set([
  // Lifecycle (shared)
  "mon_start", "mon_stop", "mon_pause", "mon_resume", "mon_attach", "mon_detach",
  // Input / interaction (shared)
  "click", "dblclick", "rclick", "input", "change", "submit",
  "key", "scroll", "focus", "blur", "copy", "paste",
  "mut", "fetch", "xhr", "sse",
  "ws_opening", "ws_open", "ws_send", "ws_message", "ws_error", "ws_close",
  "beacon", "beacon_error",
  "broadcast_open", "broadcast_send", "broadcast_message", "broadcast_error", "broadcast_close",
  "nav", "reload", "error",
  // macOS-only event kinds. AX-backed unless noted.
  "mouseup", "move", "mods",
  "selection", "selection_rows", "title_change", "window_focus",
  "window_create", "window_move", "window_resize", "window_min", "window_demin",
  "menu_open", "menu_close", "menu_select", "sheet", "layout_change",
  "ax_app_activated", "ax_app_deactivated", "ax_create", "ax_destroy", "ax_other",
  "frontmost", "app_launch", "app_terminate", "app_hide", "app_unhide", "app_deactivate",
  "space", "wake", "sleep", "session_active", "session_inactive",
  "mount", "unmount", "volume_rename",
  "clipboard", "file_change", "network_path", "notification",
  "log", "log_unavailable", "log_error",
  "frame", "frame_error", "frame_encode_error", "ocr_text", "speech_segment"
])

export type MonitorEvent = {
  timestamp?: string
  event?: string
  sid?: string
  taskId?: string
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
  // Surface discriminator. Browser-side sessions write "browser" (or omit,
  // treated as "browser" by the CLI). macOS sessions write "macos".
  surface?: "browser" | "macos" | "desktop"
  host?: "darwin" | "win32" | "linux"
  partial?: boolean
  coverage?: Array<{source:string;available:boolean;provider?:string;reason?:string;limits?:string[]}>
  sessionId: string
  taskId?: string
  taskModeAtAttach?: "human-observe" | "human-teach" | "agent-record" | "mixed"
  taskActorAtAttach?: "human" | "agent" | "system" | "verifier" | "guard"
  taskAttachedAt?: number
  taskDetachedAt?: number
  taskSourceSnapshotRoot?: string
  startedAt: number
  endedAt?: number
  status: "active" | "stopped"
  paused: boolean
  rootTabId?: number
  // macOS-only root identifiers (set by MonitorDomain on first attach).
  rootPid?: number
  rootBundleId?: string
  rootApp?: string
  appsObserved?: string[]
  instruction?: string
  url?: string
  activeAttachmentKey?: string
  counts?: { evt: number; mut: number; net: number; nav: number; ax?: number }
  stopReason?: string
  attachments: MonitorAttachmentMeta[]
  // TCC consent snapshot at session start (macOS only).
  tcc?: { accessibility: boolean; screenRecording?: boolean; microphone?: boolean }
  // Observation scope and include-set for macOS sessions.
  scope?: { mode: "frontmost" | "apps" | "all"; apps?: string[] }
  includes?: string[]
  excludes?: string[]
}

export type MonitorNetArtifact = {
  sid: string
  seq?: number
  tid?: number
  doc?: string
  cause?: number
  kind: "fetch" | "xhr" | "sse" | "ws" | "beacon" | "broadcast"
  url: string
  method?: string
  status?: number
  contentType?: string
  truncated?: boolean
  bodyBytes?: number
  bodyPreview: string
  direction?: string
  payloadKind?: string
  payloadEncoding?: string
  socketId?: string
  channelId?: string
  channelName?: string
  returnValue?: boolean
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
