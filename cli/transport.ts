/**
 * cli/transport.ts — sendCommand (Unix socket / TCP) and sendCommandWs (WebSocket)
 */

import { IPC_PORT, IS_WIN, SOCKET_PATH, WS_PORT, LOCK_PATH, MAX_UPLOAD_FRAME_BYTES } from "../shared/platform"
import { readDefaultContext } from "../shared/user-config"
import {readLockFile} from '../daemon/lifecycle'
import {isSecretBearing} from '../daemon/redact'
import { callDesktopProvider } from "../daemon/desktop-provider"
import { isDesktopActionType } from "../shared/desktop-contract"
import {desktopContainerActionError,desktopContainerDeadline} from "../shared/desktop-container-validation"
import {desktopCaptureDeadline} from "../shared/desktop-capture-validation"
import {desktopLanguageActionError} from "../shared/desktop-language-validation"
import {desktopVisionActionError} from "../shared/desktop-vision-validation"
import {desktopSensitiveActionError} from "../shared/desktop-sensitive-validation"
import {desktopUpdateActionError} from "../shared/desktop-update-validation"
import {DESKTOP_UPDATE_DEADLINE_MS} from "../shared/desktop-contract"
import {desktopLocationActionError} from "../shared/desktop-location-validation"
import {DESKTOP_LOCATION_DEADLINE_MS} from "../shared/desktop-contract"
import {DESKTOP_CONTRACT_ALIASES} from "../shared/desktop-contract.generated"
import {DESKTOP_MAPS_DEADLINE_MS} from "../shared/desktop-contract"
import {desktopShareActionError} from "../shared/desktop-share-validation"
import {DESKTOP_SHARE_DEADLINE_MS} from "../shared/desktop-contract"
import {desktopContactsActionError} from "../shared/desktop-contacts-validation"
import {desktopEventKitActionError} from "../shared/desktop-eventkit-validation"
import {desktopPhotosActionError} from "../shared/desktop-photos-validation"
import {desktopOverlayDeadline} from "../shared/desktop-overlay-validation"
import {desktopVmActionError} from "../shared/desktop-vm-validation"
import {DESKTOP_VM_DEADLINE_MS} from "../shared/desktop-contract"
import {DESKTOP_PHOTOS_DEADLINE_MS} from "../shared/desktop-contract"
import {DESKTOP_EVENTKIT_DEADLINE_MS} from "../shared/desktop-contract"
import {DESKTOP_CONTACTS_DEADLINE_MS} from "../shared/desktop-contract"
import {desktopMusicActionError} from "../shared/desktop-music-validation"
import {DESKTOP_MUSIC_DEADLINE_MS} from "../shared/desktop-contract"
import {DESKTOP_SENSITIVE_DEADLINE_MS} from "../shared/desktop-contract"
import {desktopScriptActionError} from "../shared/desktop-script-validation"
import {DESKTOP_SCRIPT_DEADLINE_MS} from "../shared/desktop-contract"
import {DESKTOP_PDF_DEADLINE_MS} from "../shared/desktop-contract"
import {desktopPdfActionError} from "../shared/desktop-pdf-validation"
import {DESKTOP_VISION_DEADLINE_MS} from "../shared/desktop-contract"
import {DESKTOP_LANGUAGE_DEADLINE_MS} from "../shared/desktop-contract"
import {CDP_ACTION_TYPES} from "../shared/cdp-app"
import {DESKTOP_LANGUAGE_OPERATIONS} from "../shared/desktop-contract.generated"
import { IOS_SVC_ACTION_TYPES } from "../shared/ios-service"
import { IOS_DEV_ACTION_TYPES } from "../shared/ios-dev"

export const INTERCEPTOR_TIMEOUT_MS = parseInt(process.env.INTERCEPTOR_TIMEOUT || "15000")

// Speech permission prompts are async and user-bounded; 15s is too short
// for first-time `listen start` / `vad start`. 60s covers the documented
// user-prompt UX while preserving the normal timeout for other verbs.
//
// Render/vision capture (screenshot, canvas read/ocr/diff, capture frame) can
// exceed 15s on a heavy chart/image page or when the browser is under load —
// which previously made an agent give up on reading a number trapped in a
// chart and fall back to a weaker secondary source. 45s lets the vision rung
// of the deep-research escalation chain actually complete.
const ACTION_TIMEOUT_OVERRIDES_MS: Record<string, number> = {
  // A manual update check waits up to 10s for Sparkle's delegate conclusion
  // before returning a truthful `checking` result. Leave transport headroom.
  macos_update: 20_000,
  macos_listen: 60_000,
  macos_vad: 60_000,
  // monitor start/stop can do non-trivial setup/teardown (AX
  // attach across many apps under --all-apps, frame/video/speech engines,
  // source snapshot). Even though the bridge now acks early, give the
  // RPC an elevated deadline as a safety margin so a momentarily busy main
  // run loop never trips the old 15s timeout that left a split-brain envelope.
  macos_monitor: 60_000,
  // issue #244: the registration box and gated releases wait on a person; sudo
  // may run an installer; the admin-prompt fill polls the dialog.
  macos_secret: 620_000,
  desktop_secret: 620_000,
  macos_sudo: 620_000,
  macos_authdialog: 60_000,
  ios_unlock: 60_000,
  // iOS XCUITest AX ops (element-tree snapshot, app activate/launch, typing) are
  // slow — the first snapshot initializes the on-device accessibility bridge and
  // waits for app quiescence. Give them an elevated deadline.
  ios_tree: 60_000,
  ios_find: 60_000,
  ios_app: 60_000,
  ios_type: 60_000,
  ios_screenshot: 60_000,
  // Runner gestures wait for the app to settle, and a long press holds for its
  // whole --duration: at the generic 15 s a 16 s hold that had landed came back
  // as "outcome unknown". Only these; the device-service lanes (top, proc, web)
  // fail by timing out, and a dead lane must keep reporting fast.
  ios_click: 60_000,
  ios_keys: 60_000,
  ios_press: 60_000,
  ios_scroll: 60_000,
  ios_drag: 60_000,
  // A gesture plays for up to 55 s before it returns; stream start/stop is one
  // runner round trip. `ios_frame` never touches the device and keeps the default.
  ios_gesture: 60_000,
  ios_stream: 60_000,
  ios_setup: 600_000,
  ios_refresh: 600_000,
  ios_enable: 120_000,
  ios_install: 240_000,
  // iOS web lane: cold target discovery can take up to ~15s and attach
  // ~10s per spec; give raw calls/eval room for slow expressions.
  ios_web_targets: 20_000,
  ios_web_attach: 20_000,
  ios_web_read: 20_000,
  ios_web_eval: 30_000,
  ios_web_call: 30_000,
  ios_web_screenshot: 60_000,
  // iOS device-service lane: diagnostics/filesystem/backup pulls can be
  // large; give them headroom over the 15s default.
  ios_diag: 30_000,
  ios_fs: 60_000,
  ios_crash: 60_000,
  ios_profiles: 20_000,
  ios_springboard: 30_000,
  // iOS Instruments/DTX + telemetry lanes: the first call opens the
  // RemoteXPC tunnel (~1-3s) + a DTX channel; screenshot/backup can be large.
  ios_proc: 30_000,
  ios_apps: 30_000,
  ios_spawn: 30_000,
  ios_kill: 30_000,
  ios_location: 30_000,
  ios_shot: 30_000,
  ios_backup: 30_000,
  ios_axtree: 30_000,
  binary_sink_save: 600_000,
  screenshot_background: 45_000,
  canvas_read: 45_000,
  canvas_ocr: 60_000,
  canvas_diff: 45_000,
  capture_frame: 45_000,
  // OCR: native capture + Tesseract. First call also lazy-loads the WASM core +
  // language data, so allow generous headroom.
  ocr: 60_000,
}

// Every screenshot gets a ceiling aligned with the daemon's REQUEST_TIMEOUT_MS
// (180s), not the flat 45s. The service worker bounds its own stages (the
// DOM-render path has a 30s budget; the pixel path has per-strip guards), so
// the CLI only needs to out-wait the SW's worst case without racing it:
//  - `--pixel`/`--pixel --full` scrolls + captures + stitches strip-by-strip
//    (~1.1s/strip, Chrome-rate-limited) with no single 30s cap.
//  - the DEFAULT (DOM-render) path can auto-fall-back to the pixel path when
//    the native renderer fails on a heavy page, so a plain `screenshot` can
//    also run DOM-render (≤30s) THEN a full pixel capture. A 45s ceiling would
//    race that combined path and surface the generic transport timeout it was
//    meant to prevent, so all screenshots share the long ceiling.
const SCREENSHOT_TIMEOUT_MS = 175_000

export function pickTimeoutForAction(action: Action): number {
  const overlayDeadline=desktopOverlayDeadline(action)
  if(overlayDeadline)return Math.max(INTERCEPTOR_TIMEOUT_MS,overlayDeadline+5_000)
  if(action.type==='desktop_vm'&&!desktopVmActionError(action))return Math.max(INTERCEPTOR_TIMEOUT_MS,DESKTOP_VM_DEADLINE_MS+5_000)
  if(['desktop_contacts','macos_contacts'].includes(action.type)&&!desktopContactsActionError({...action,type:'desktop_contacts'}))return Math.max(INTERCEPTOR_TIMEOUT_MS,DESKTOP_CONTACTS_DEADLINE_MS+5_000)
  if(['desktop_calendar','macos_calendar','desktop_reminders','macos_reminders'].includes(action.type)&&!desktopEventKitActionError({...action,type:action.type.replace(/^macos_/,'desktop_')}))return Math.max(INTERCEPTOR_TIMEOUT_MS,DESKTOP_EVENTKIT_DEADLINE_MS+5_000)
  if(['desktop_photos','macos_photos'].includes(action.type)&&!desktopPhotosActionError({...action,type:'desktop_photos'}))return Math.max(INTERCEPTOR_TIMEOUT_MS,DESKTOP_PHOTOS_DEADLINE_MS+5_000)
  if(['desktop_location','macos_location'].includes(action.type)&&!desktopLocationActionError({...action,type:'desktop_location'}))return Math.max(INTERCEPTOR_TIMEOUT_MS,DESKTOP_LOCATION_DEADLINE_MS+5_000)
  if(['desktop_maps','macos_maps'].includes(action.type)&&DESKTOP_CONTRACT_ALIASES.DesktopMapsVerb.some(verb=>verb===action.sub))return Math.max(INTERCEPTOR_TIMEOUT_MS,DESKTOP_MAPS_DEADLINE_MS+5_000)
  if(['desktop_share','macos_share'].includes(action.type)&&!desktopShareActionError({...action,type:'desktop_share'}))return Math.max(INTERCEPTOR_TIMEOUT_MS,DESKTOP_SHARE_DEADLINE_MS+5_000)
  if(['desktop_music','macos_music'].includes(action.type)&&!desktopMusicActionError({...action,type:'desktop_music'}))return Math.max(INTERCEPTOR_TIMEOUT_MS,DESKTOP_MUSIC_DEADLINE_MS+5_000)
  if(['desktop_update','macos_update'].includes(action.type)&&!desktopUpdateActionError({...action,type:'desktop_update'}))return Math.max(INTERCEPTOR_TIMEOUT_MS,DESKTOP_UPDATE_DEADLINE_MS+5_000)
  if(['desktop_sensitive','macos_sensitive'].includes(action.type)&&!desktopSensitiveActionError({...action,type:'desktop_sensitive'}))return Math.max(INTERCEPTOR_TIMEOUT_MS,DESKTOP_SENSITIVE_DEADLINE_MS+5_000)
  if(['desktop_pdf','macos_pdf'].includes(action.type)&&!desktopPdfActionError({...action,type:'desktop_pdf'}))return Math.max(INTERCEPTOR_TIMEOUT_MS,DESKTOP_PDF_DEADLINE_MS+5_000)
  if(['desktop_script_run','desktop_intent_dispatch'].includes(action.type)&&!desktopScriptActionError(action))return Math.max(INTERCEPTOR_TIMEOUT_MS,DESKTOP_SCRIPT_DEADLINE_MS+5_000)
  // The macOS parser leaves absent flags as undefined keys (e.g. app); the contract check treats a present key as set.
  if(['desktop_vision','macos_vision'].includes(action.type)&&!desktopVisionActionError(Object.fromEntries(Object.entries({...action,type:'desktop_vision'}).filter(([,v])=>v!==undefined))))return Math.max(INTERCEPTOR_TIMEOUT_MS,DESKTOP_VISION_DEADLINE_MS+5_000)
  if(DESKTOP_LANGUAGE_OPERATIONS.some(type=>type===action.type)&&!desktopLanguageActionError(action))return Math.max(INTERCEPTOR_TIMEOUT_MS,DESKTOP_LANGUAGE_DEADLINE_MS+5_000)
  if(action.type==='desktop_container_run'&&!desktopContainerActionError(action))return Math.max(INTERCEPTOR_TIMEOUT_MS,desktopContainerDeadline(action))
  const nativeCaptureDeadline=desktopCaptureDeadline(action)
  if(nativeCaptureDeadline>0)return Math.max(INTERCEPTOR_TIMEOUT_MS,nativeCaptureDeadline+5_000)
  if(action.type==='desktop_type'&&typeof action.secret==='string')return 240_000
  if(action.type==='desktop_authdialog'&&typeof action.secret==='string')return 240_000
  if(action.type === "desktop_auth")return 180_000
  // camera start --prompt waits on the person answering the macOS camera prompt.
  if(action.type==='macos_camera'&&action.sub==='start'&&action.prompt===true)return Math.max(INTERCEPTOR_TIMEOUT_MS,125_000)
  if(action.type==='macos_camera'&&action.sub==='frame'&&typeof action.timeoutMs==='number')return Math.max(INTERCEPTOR_TIMEOUT_MS,action.timeoutMs+5_000)
  if (["macos_url_fetch","desktop_url_fetch"].includes(action.type)) {
    const deadline=typeof action.timeoutMs==="number"&&Number.isInteger(action.timeoutMs)&&action.timeoutMs>=100&&action.timeoutMs<=120000?action.timeoutMs:30000
    return Math.max(INTERCEPTOR_TIMEOUT_MS,deadline+5000)
  }
  if (action.type === "daemon_shutdown" && typeof action.timeoutMs === "number") {
    return Math.min(62_000, Math.max(2_000, action.timeoutMs + 2_000))
  }
  if (action.type === "screenshot") {
    return SCREENSHOT_TIMEOUT_MS
  }
  // The bridge runs Spotlight under its own deadline (--timeout-ms, default
  // 10 s) and answers with partial:true; the transport must outlive that
  // deadline so the honest partial result arrives instead of the generic
  // "waiting on a TCC prompt" timeout (2026-09-10 review, 199 results).
  if (action.type === "macos_fs_search") {
    const bridgeDeadline = typeof action.timeoutMs === "number" && action.timeoutMs > 0 ? action.timeoutMs : 10_000
    return Math.max(INTERCEPTOR_TIMEOUT_MS, bridgeDeadline + 5_000)
  }
  // `ios web eval/call --timeout <s>` arms the WIP request timeout; the CLI must
  // outlive it or a long expression dies at the 30 s default instead.
  if ((action.type === "ios_web_eval" || action.type === "ios_web_call") && typeof action.timeout === "number" && action.timeout > 0) {
    return Math.max(ACTION_TIMEOUT_OVERRIDES_MS[action.type] ?? INTERCEPTOR_TIMEOUT_MS, action.timeout + 5_000)
  }
  return ACTION_TIMEOUT_OVERRIDES_MS[action.type] ?? INTERCEPTOR_TIMEOUT_MS
}

// True for the browser-extension lane — the actions whose generic timeout
// hint says "Ensure Chrome/Brave is open". Bridge/iOS/upload lanes carry
// their own tailored hints and never need the context probe.
export function isGenericBrowserAction(actionType: string): boolean {
  return actionType !== "daemon_shutdown"
    && actionType !== "desktop_secret"
    && !actionType.startsWith("macos_")
    && !actionType.startsWith("ios_")
    && !IOS_SVC_ACTION_TYPES.has(actionType)
    && !IOS_DEV_ACTION_TYPES.has(actionType)
    && actionType !== "file_upload"
    && actionType !== "file_upload_chunk"
}

// When the daemon reports a live browser context at the moment a request times
// out, "Ensure Chrome/Brave is open" is provably the wrong hint (issue #161) —
// the usual culprit is an oversized/slow response, not a dead extension.
export function timeoutMessageConnected(actionType: string, ms: number): string {
  const seconds = Math.round(ms / 1000)
  const base = `timeout: no response for '${actionType}' after ${seconds}s. ` +
    `A browser context is connected, so the extension is reachable — this is usually an oversized or slow response, not a dead extension.`
  if (actionType === "net_log") {
    return `${base} Retry with a smaller --limit, use --since <ts> to fetch incrementally, or --filter to narrow.`
  }
  // No blind "Retry": the daemon may still complete the request after the CLI
  // gave up, so replaying a click, type, or upload can fire it twice. The
  // outcome is unknown, not failed.
  return `${base} The outcome is unknown, not failed: run 'interceptor read' to see whether the action landed before retrying it. If it persists, the tab may be busy or the response too large (narrow with --text-only or --tree-format compact).`
}

// Minimal one-shot `{type:"contexts"}` probe with its own short deadline. The
// daemon answers from its connection table without touching the extension, so
// this cleanly separates "daemon up with a browser attached" from "nothing
// listening". Never rejects — resolves null on any failure.
export function probeContextCount(timeoutMs = 1500): Promise<number | null> {
  return probeContexts(timeoutMs).then(ids => ids ? ids.length : null)
}

/** The connected context ids, or null when no daemon answers (never spawns one). */
export function probeContexts(timeoutMs = 1500): Promise<string[] | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: string[] | null): void => { if (!done) { done = true; resolve(v) } }
    const timer = setTimeout(() => finish(null), timeoutMs)
    let buffer = Buffer.alloc(0)
    const handlers: Bun.SocketHandler<undefined> = {
      open(socket: Bun.Socket<undefined>) {
        const payload = JSON.stringify({ id: crypto.randomUUID(), action: { type: "contexts" } })
        const encoded = Buffer.from(payload, "utf-8")
        const header = Buffer.alloc(4)
        header.writeUInt32LE(encoded.byteLength, 0)
        try { socket.write(Buffer.concat([header, encoded])) } catch { finish(null) }
      },
      data(socket: Bun.Socket<undefined>, raw: Buffer<ArrayBufferLike>) {
        buffer = Buffer.concat([buffer, Buffer.from(raw)])
        if (buffer.length >= 4) {
          const msgLen = buffer.readUInt32LE(0)
          if (msgLen > 0 && msgLen <= MAX_UPLOAD_FRAME_BYTES && buffer.length >= 4 + msgLen) {
            clearTimeout(timer)
            try {
              const resp = JSON.parse(buffer.subarray(4, 4 + msgLen).toString("utf-8")) as DaemonResponse
              const ids = resp.result?.success && Array.isArray(resp.result.data) ? resp.result.data as unknown[] : null
              finish(ids ? ids.map(String) : null)
            } catch { finish(null) }
            try { socket.end() } catch {}
          }
        }
      },
      close() { clearTimeout(timer); finish(null) },
      connectError() { clearTimeout(timer); finish(null) },
      error() { clearTimeout(timer); finish(null) },
    }
    const connect = IS_WIN
      ? Bun.connect({ hostname: "127.0.0.1", port: IPC_PORT, socket: handlers })
      : Bun.connect({ unix: SOCKET_PATH, socket: handlers })
    void connect.catch(() => finish(null))
  })
}

// Branch the timeout hint on `macos_*` so bridge commands don't get a
// Chrome/Brave-extension troubleshooting hint.
/** The trace line is hidden by default, so a timeout names its request id for the daemon log. */
export function withRequestId(message: string, shortId: string): string {
  return `${message} (request ${shortId}; the daemon log has it)`
}

export function timeoutMessage(actionType: string, ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (actionType === "daemon_shutdown") {
    return `timeout: the daemon did not acknowledge shutdown within ${seconds}s.`
  }
  if (actionType === "desktop_secret") {
    return `timeout: no response for '${actionType}' after ${seconds}s. The native credential service or authentication may still be pending. The outcome is unknown; inspect secret metadata before retrying a storage or removal operation.`
  }
  if (actionType.startsWith("macos_")) {
    return `timeout: no response for '${actionType}' after ${seconds}s. The macOS bridge may be waiting on a TCC permission prompt (Microphone / Speech Recognition for listen/vad, Screen Recording for screenshot/capture/vision, Camera for camera start --prompt). Check System Settings → Privacy & Security.`
  }
  if (IOS_SVC_ACTION_TYPES.has(actionType)) {
    return `timeout: no response for '${actionType}' after ${seconds}s. The classic-Lockdown service didn't reply in time — a large fs/crash pull can exceed this; confirm the device is unlocked and 'interceptor ios status' shows it connected.`
  }
  if (IOS_DEV_ACTION_TYPES.has(actionType)) {
    return `timeout: no response for '${actionType}' after ${seconds}s. The Instruments/telemetry lane opens a RemoteXPC tunnel + DTX channel — confirm the device is unlocked and paired; a busy developer service can be retried.`
  }
  if (actionType.startsWith("ios_web_")) {
    return `timeout: no response for '${actionType}' after ${seconds}s. The web-inspector session did not reply. A session ends when its page navigates, and on iOS 27 Safari some page targets never answer Runtime.evaluate; run 'interceptor ios web status', then re-attach from 'interceptor ios web targets'.`
  }
  if (actionType.startsWith("ios_")) {
    return `timeout: no response for '${actionType}' after ${seconds}s. The InterceptorRunner may be busy with a slow XCUITest snapshot, or a runner built before 1.0.15 is waiting up to 60 s for a busy app to idle (run 'interceptor ios refresh'); confirm the device is unlocked and 'interceptor ios status' shows it connected.`
  }
  if (actionType === "file_upload" || actionType === "file_upload_chunk") {
    return `timeout: no response for '${actionType}' after ${seconds}s. The daemon may have rejected an oversized upload frame (check 'interceptor status' and the daemon log for "oversized socket frame"), or the tab/content script isn't reachable — large files are chunked automatically, so this usually means the target tab changed. Retry after 'interceptor state'.`
  }
  return `timeout: no response for '${actionType}' after ${seconds}s. Ensure Chrome/Brave is open with the Interceptor extension loaded.`
}

export type Action = { type: string; [key: string]: unknown }
export type DaemonResult = { success: boolean; error?: string; code?: string; data?: unknown; tabId?: number }

/** The --json line for a failure: always success:false and a code, so scripts can branch without parsing the message. */
export function jsonFailure(result: DaemonResult): Record<string, unknown> {
  const { data, ...rest } = result as DaemonResult & Record<string, unknown>
  const fields = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {}
  return { ...rest, ...fields, success: false, code: result.code ?? fields.code ?? "provider_failed" }
}
export type DaemonResponse = {
  id: string
  result: DaemonResult
}

// the per-invocation group scope (--group / $INTERCEPTOR_GROUP), set once
// by cli/index.ts and injected into every outgoing action here — the single choke
// point every command path (simple, compound, override, tail loops) funnels
// through. The group rides INSIDE the action payload because the daemon relays
// `{id, action, tabId}` verbatim to the extension.
let globalGroup: string | undefined
let globalGroupColor: string | undefined
let globalGroupSoft = false
let globalFrame: number | undefined

export class ActionValidationError extends Error {}

export function setGlobalFrame(frameId?: number): void { globalFrame = frameId }

export function setGlobalGroup(group?: string, groupColor?: string, soft = false): void {
  globalGroup = group
  globalGroupColor = groupColor
  globalGroupSoft = soft
}

/** Exported for tests (wire-shape assertion); production callers use sendCommand. */
export function withGroup(action: Action): Action {
  // Browser routing metadata never changes native domain fields. Contacts
  // uses group for actual membership filtering, and native schemas reject
  // unrelated browser scope and frame fields.
  if (/^(?:macos|desktop|ios)_/.test(action.type)) return action
  if (globalFrame !== undefined) {
    if (action.frameId !== undefined && action.frameId !== globalFrame) {
      throw new ActionValidationError("element frame conflicts with --frame; use the frame from the fresh element ref")
    }
    action = { ...action, frameId: globalFrame }
  }
  if (!globalGroup || action.group !== undefined) return action
  const scoped: Action = { ...action, group: globalGroup }
  // Automatic session scope is a preference, not an isolation boundary.
  if (globalGroupSoft) scoped.groupSoft = true
  if (globalGroupColor && scoped.groupColor === undefined) scoped.groupColor = globalGroupColor
  return scoped
}

// The default context the person saved with
// `contexts default <name>`, read once per process. The daemon uses it only
// when this call names no context and several contexts are connected.
let savedDefaultContext: string | undefined | null = null
export function defaultContextField(contextId?: string): { defaultContextId?: string } {
  if (contextId !== undefined) return {}
  if (savedDefaultContext === null) savedDefaultContext = readDefaultContext()
  return savedDefaultContext ? { defaultContextId: savedDefaultContext } : {}
}

/**
 * Request-trace lines (`[<id>] → <action>`) are for a person at a terminal.
 * Agent harnesses merge stderr into what the model reads, and the lines were
 * 8.6% of it. The daemon log keeps every id either way.
 * A Bun-compiled binary reports isTTY as undefined when piped: test truthiness.
 */
export function traceEnabled(stream: { isTTY?: boolean } = process.stderr, env: Record<string, string | undefined> = process.env): boolean {
  return !!stream.isTTY || env.INTERCEPTOR_DEBUG === "1"
}

function trace(line: string): void {
  if (traceEnabled()) process.stderr.write(line)
}

export function sendCommand(rawAction: Action, tabId?: number, contextId?: string): Promise<DaemonResponse> {
  const action = withGroup(rawAction)
  if (process.platform !== "darwin" && isDesktopActionType(action.type) && !CDP_ACTION_TYPES.has(action.type) && !isSecretBearing(action)) {
    const id = crypto.randomUUID()
    // A native socket authenticates this CLI's OS identity. A daemon proxy
    // would substitute its own login and lose the caller's session boundary.
    if (!/^(?:desktop|macos)_/.test(action.type)) return Promise.resolve({ id, result: {
      success: false, code: "unsupported_operation", error: "this native surface is not implemented by the host provider" } } as DaemonResponse)
    trace(`[${id.slice(0, 8)}] → ${action.type}\n`)
    return callDesktopProvider(action, pickTimeoutForAction(action)).then(result => ({ id, result } as DaemonResponse))
  }
  // The vault is daemon-owned on every host. Its native store and metadata
  // policy already live there; secret values must not enter an AX provider.
  const needsCredentialAuthentication = isSecretBearing(action)
  const vaultToken = needsCredentialAuthentication ? readLockFile(LOCK_PATH)?.shutdownToken : undefined
  if (needsCredentialAuthentication && !vaultToken) return Promise.resolve({ id: crypto.randomUUID(), result: { success: false, code: "not_installed", error: "daemon credential authentication is unavailable; start or repair the installed daemon before using credentials" } } as DaemonResponse)
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const shortId = id.slice(0, 8)
    trace(`[${shortId}] → ${action.type}\n`)
    let buffer = Buffer.alloc(0)
    let resolved = false
    let socketRef: Bun.Socket<undefined> | null = null

    // Outbound frame + backpressure handling. Bun's socket.write() does a
    // PARTIAL write when the payload exceeds the socket's send buffer and
    // returns the number of bytes actually written — the remainder is NOT
    // auto-queued. A single naive write() therefore truncates any large frame
    // (e.g. a 512 KiB upload chunk), and the daemon then blocks forever waiting
    // for bytes that never arrive. Queue the remainder and flush it on `drain`,
    // mirroring the daemon's own socketWriteFramed.
    let pendingWrite: Buffer | null = null
    const flushWrite = (socket: Bun.Socket<undefined>) => {
      if (!pendingWrite) return
      let wrote = 0
      try { wrote = socket.write(pendingWrite) } catch { return }
      if (wrote >= pendingWrite.byteLength) pendingWrite = null
      else if (wrote > 0) pendingWrite = pendingWrite.subarray(wrote)
      // wrote <= 0: socket buffer full — keep pendingWrite, retry on drain.
    }

    const timeoutMs = pickTimeoutForAction(action)
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        if (socketRef) try { socketRef.end() } catch {}
        // Browser-lane timeouts: check whether the daemon still holds a live
        // context before blaming the extension (issue #161). Other lanes keep
        // their tailored hints without the probe round-trip.
        if (isGenericBrowserAction(action.type)) {
          void probeContextCount().then((count) => {
            reject(new Error(withRequestId(count && count > 0
              ? timeoutMessageConnected(action.type, timeoutMs)
              : timeoutMessage(action.type, timeoutMs), shortId)))
          })
        } else {
          reject(new Error(withRequestId(timeoutMessage(action.type, timeoutMs), shortId)))
        }
      }
    }, timeoutMs)

    const socketHandlers: Bun.SocketHandler<undefined> = {
      open(socket: Bun.Socket<undefined>) {
        socketRef = socket
        const payload = JSON.stringify({ id, action, ...(vaultToken !== undefined && { vaultToken }), ...(tabId !== undefined && { tabId }), ...(contextId !== undefined && { contextId }), ...defaultContextField(contextId) })
        const encoded = Buffer.from(payload, "utf-8")
        const header = Buffer.alloc(4)
        header.writeUInt32LE(encoded.byteLength, 0)
        pendingWrite = Buffer.concat([header, encoded])
        flushWrite(socket)
      },
      drain(socket: Bun.Socket<undefined>) {
        flushWrite(socket)
      },
      data(socket: Bun.Socket<undefined>, raw: Buffer<ArrayBufferLike>) {
        buffer = Buffer.concat([buffer, Buffer.from(raw)])
        if (buffer.length >= 4) {
          const msgLen = buffer.readUInt32LE(0)
          if (msgLen > 0 && msgLen <= MAX_UPLOAD_FRAME_BYTES && buffer.length >= 4 + msgLen) {
            const json = buffer.subarray(4, 4 + msgLen).toString("utf-8")
            clearTimeout(timer)
            try {
              resolved = true
              resolve(JSON.parse(json) as DaemonResponse)
            } catch {
              resolved = true
              reject(new Error("invalid response from daemon"))
            }
            socket.end()
          }
        }
      },
      close(_socket: Bun.Socket<undefined>) {
        clearTimeout(timer)
        if (!resolved) {
          reject(new Error("connection closed before response"))
        }
      },
      connectError(_socket: Bun.Socket<undefined>, _err: Error) {
        clearTimeout(timer)
        reject(new Error("daemon not running. Open Chrome with the Interceptor extension loaded."))
      },
      error(_socket: Bun.Socket<undefined>, err: Error) {
        clearTimeout(timer)
        reject(err)
      }
    }

    const connectPromise = IS_WIN
      ? Bun.connect({ hostname: "127.0.0.1", port: IPC_PORT, socket: socketHandlers })
      : Bun.connect({ unix: SOCKET_PATH, socket: socketHandlers })

    void connectPromise.catch(() => {})
  })
}

export function sendCommandWs(rawAction: Action, tabId?: number, contextId?: string): Promise<DaemonResponse> {
  const action = withGroup(rawAction)
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const shortId = id.slice(0, 8)
    trace(`[${shortId}] →ws ${action.type}\n`)

    const timeoutMs = pickTimeoutForAction(action)
    const timer = setTimeout(() => {
      // Same context-awareness as the socket path: a live context at timeout
      // means the extension is reachable and payload size is the likely cause.
      if (isGenericBrowserAction(action.type)) {
        void probeContextCount().then((count) => {
          reject(new Error(withRequestId(count && count > 0
            ? timeoutMessageConnected(action.type, timeoutMs)
            : `timeout: no response for '${action.type}' after ${timeoutMs / 1000}s via WebSocket.`, shortId)))
        })
      } else {
        reject(new Error(withRequestId(`timeout: no response for '${action.type}' after ${timeoutMs / 1000}s via WebSocket.`, shortId)))
      }
    }, timeoutMs)

    const ws = new WebSocket(`ws://localhost:${WS_PORT}`)
    ws.onopen = () => {
      ws.send(JSON.stringify({ id, action, ...(tabId !== undefined && { tabId }), ...(contextId !== undefined && { contextId }), ...defaultContextField(contextId) }))
    }
    ws.onmessage = (event) => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(typeof event.data === "string" ? event.data : "") as DaemonResponse)
      } catch {
        reject(new Error("invalid response from daemon via WebSocket"))
      }
      ws.close()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error("WebSocket connection failed to daemon"))
    }
    ws.onclose = () => {
      clearTimeout(timer)
    }
  })
}
