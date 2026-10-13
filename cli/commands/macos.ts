import {desktopOverlayActionError} from '../../shared/desktop-overlay-validation'
import {desktopAuthDialogActionError} from '../../shared/desktop-authdialog-validation'
/**
 * cli/commands/macos.ts — interceptor macos <subcommand>
 *
 * Parses `interceptor macos` subcommands into macos_ prefixed action objects
 * that get routed to the native bridge via the daemon.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import {desktopVmCopySelection} from "../../shared/desktop-vm-validation"
import { bridgePidPathForDetection, bridgeSocketPathForDetection } from "../../shared/bridge-paths"
import { jsonFailure, sendCommand, sendCommandWs, type DaemonResponse } from "../transport"
import {
  attachMonitorTaskSource,
  listMonitorTasks,
  markMonitorTaskSourceAttachFailed,
  resolveOrCreateMonitorTask,
  validateMonitorTaskMode,
  findLatestSessionSidForTask,
  readMonitorTaskMeta,
  resolveMonitorTaskId,
  stopMonitorTask,
  synthesizeMonitorTaskTranscript,
  generateMonitorTaskCaptureQuality,
  renderMonitorTaskStatus,
  renderMonitorTaskQualitySummary,
} from "../../shared/monitor-tasks"
import { runCdpCommand } from "./cdp"
import { runNativeCommand } from "./native"
import {desktopEventKitActionError,DESKTOP_CALENDAR_FIELDS,DESKTOP_REMINDERS_FIELDS} from "../../shared/desktop-eventkit-validation"
import {desktopPhotosActionError,DESKTOP_PHOTOS_FIELDS} from "../../shared/desktop-photos-validation"
import {desktopVmActionError,DESKTOP_VM_FIELDS} from "../../shared/desktop-vm-validation"
import {desktopTrustActionError} from "../../shared/desktop-trust-validation"
import {desktopStreamActionError} from "../../shared/desktop-stream-validation"
import {desktopSensitiveActionError} from "../../shared/desktop-sensitive-validation"
import {desktopMapsActionError} from "../../shared/desktop-maps-validation"
import {desktopShareActionError} from "../../shared/desktop-share-validation"
import {desktopContactsActionError} from "../../shared/desktop-contacts-validation"
import {desktopMusicActionError} from "../../shared/desktop-music-validation"
import {desktopLocationActionError} from "../../shared/desktop-location-validation"
import {desktopSoundActionError} from "../../shared/desktop-sound-validation"
import { extensionMacosPrefixes, extensionActionType } from "../../shared/extensions"
import { readSecretValue,readStdinValue } from "../prompt"
import { desktopAction,DESKTOP_LANGUAGE_MAX_TEXT_BYTES } from "../../shared/desktop-contract"
import {desktopHttpActionError} from "../../shared/desktop-http-validation"
import {desktopLogActionError} from "../../shared/desktop-log-validation"
import {desktopThumbnailActionError} from "../../shared/desktop-thumbnail-validation"
import {desktopSecretActionError} from "../../shared/desktop-secret-validation"
import {desktopAuthActionError} from "../../shared/desktop-auth-validation"
import {desktopContainerActionError,desktopContainerDeadline} from "../../shared/desktop-container-validation"
import {desktopFilesActionError} from "../../shared/desktop-files-validation"
import {desktopNotificationsActionError} from "../../shared/desktop-notifications-validation"
import {desktopMonitorActionError,desktopMonitorArchiveError} from "../../shared/desktop-monitor-validation"
import {desktopLanguageActionError} from "../../shared/desktop-language-validation"
import {desktopVisionActionError} from "../../shared/desktop-vision-validation"
import {desktopScriptActionError} from "../../shared/desktop-script-validation"
import {desktopPdfActionError,DESKTOP_PDF_FIELDS} from "../../shared/desktop-pdf-validation"
import {desktopVadActionError} from "../../shared/desktop-vad-validation"
import {desktopSpeechActionError} from "../../shared/desktop-speech-validation"
import {desktopAudioActionError} from "../../shared/desktop-audio-validation"
import {parseTargets,parseDuration} from "../../daemon/secrets"
import { DESKTOP_ACCESSIBILITY_OPERATIONS, DESKTOP_CLIPBOARD_OPERATIONS, DESKTOP_CAPTURE_OPERATIONS, DESKTOP_DISPLAY_OPERATIONS, DESKTOP_COMPOUND_OPERATIONS, DESKTOP_LOG_OPERATIONS, DESKTOP_THUMBNAIL_OPERATIONS } from "../../shared/desktop-contract.generated"
import { desktopProviderBinary } from "../../shared/desktop-provider"
import {readSessionMeta} from "../../shared/monitor-artifacts"
import { callDesktopProvider } from "../../daemon/desktop-provider"

type Action = { type: string; [key: string]: unknown }
type Result = { success: boolean; error?: string; code?: string; data?: unknown }

function unwrap(resp: DaemonResponse): Result {
  return resp.result
}

async function send(
  action: Action,
  tabId?: number,
  useWs = false
): Promise<Result> {
  try {
    const resp = useWs
      ? await sendCommandWs(action, tabId)
      : await sendCommand(action, tabId)
    return unwrap(resp)
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// Bridge preflight: detect browser-only installs and short-circuit before the
// daemon roundtrip times out at 15s with a misleading "Ensure Chrome/Brave"
// message. Returns a reason string if the bridge is unreachable, else null.
export function bridgePreflightFailure(): string | null {
  if (process.platform !== "darwin") {
    return "'interceptor macos *' commands require macOS (the Swift bridge is mac-only)."
  }
  const home = process.env.HOME || ""
  // Two LaunchAgent locations depending on install channel: per-user (dev
  // path via scripts/install-bridge.sh) or system-wide (signed-pkg path via
  // Interceptor-Full-<v>.pkg). Either is sufficient.
  const launchAgentUser = `${home}/Library/LaunchAgents/com.interceptor.bridge.plist`
  const launchAgentSystem = "/Library/LaunchAgents/com.interceptor.bridge.plist"
  const bridgeSock = bridgeSocketPathForDetection()
  const bridgePid = bridgePidPathForDetection()
  const launchAgentInstalled = existsSync(launchAgentUser) || existsSync(launchAgentSystem)
  const bridgeReachable = existsSync(bridgeSock) || existsSync(bridgePid)
  if (!launchAgentInstalled && !bridgeReachable) {
    return [
      "'interceptor macos *' requires full computer-use mode.",
      "You're currently running in browser-only mode (no bridge installed).",
      "",
      "To enable:",
      "  interceptor upgrade --full",
    ].join("\n")
  }
  return null
}

export async function runMacosCommand(
  filtered: string[],
  opts: { jsonMode?: boolean; useWs?: boolean; globalTabId?: number; contextId?: string; desktop?: boolean }
): Promise<void> {
  const detectionStdin = opts.desktop && filtered[1] === 'detect' && filtered[2] === 'stdin'
  let stdinText: string | undefined
  if(detectionStdin){
    if(process.stdin.isTTY){console.error('error: desktop detect stdin requires piped UTF-8 input');process.exitCode=1;return}
    // Validate syntax before consuming input; the parser receives the text after the read.
    const values=compoundPositionals(filtered,new Set(['--types']))
    if(values.length!==1)throw new Error('detect stdin accepts no text argument')
    // The text is data for the parser, never argv: input such as `---` front matter is not a flag.
    stdinText=await readStdinValue({maxBytes:DESKTOP_LANGUAGE_MAX_TEXT_BYTES,trimNewline:false})
  }
  // Skip preflight only for "trust" — that subcommand is the user-driven
  // first-run permission walkthrough and may legitimately be the very first
  // call before anything else is wired up. The bridge will surface its own
  // not-ready errors there.
  const sub = filtered[1]
  if (sub === "cdp") {
    await runCdpCommand(filtered, { jsonMode: opts.jsonMode, contextId: opts.contextId })
    return
  }
  if (sub === "runtime") {
    await runNativeCommand(["runtime", ...filtered.slice(2)], { jsonMode: opts.jsonMode, contextId: opts.contextId })
    return
  }

  if (sub !== "trust" && !(opts.desktop && sub === "secret")) {
    const failure = opts.desktop && process.platform !== "darwin"
      ? (desktopProviderBinary() ? null : "native desktop provider is not installed; install the full package for this host")
      : bridgePreflightFailure()
    if (failure !== null) {
      if (opts.desktop && opts.jsonMode) {
        console.log(JSON.stringify({ success: false, code: "not_installed", error: failure }))
        process.exitCode = 1; return
      }
      console.error(`error: ${failure}`)
      process.exit(1)
    }
  }

  // Extension Fabric: synchronously discover the set of
  // manifest-declared `macos <prefix>` subcommands so an installed extension's
  // verbs fall through to the generic builder instead of the hard `default`.
  const extPrefixes = extensionMacosPrefixes()
  let action: Action | null
  try { action = parseMacosCommand(filtered, extPrefixes, opts.desktop === true, stdinText) } catch (error) {
    if (!opts.desktop) throw error
    const failure = {success: false, code: "invalid_request", error: error instanceof Error ? error.message : "invalid desktop command"}
    if (opts.jsonMode) console.log(JSON.stringify(failure))
    else console.error(`error: ${failure.error}`)
    process.exitCode = 1; return
  }
  if (!action) process.exit(1)

  if (action.type === "macos_monitor" && action.sub !== "start" && typeof action.taskRef === "string") {
    try {
      const taskId = resolveMonitorTaskId(action.taskRef)
      const task = readMonitorTaskMeta(taskId)
      const surface = opts.desktop && process.platform !== "darwin" ? "desktop" : "macos"
      const sources = task?.sourceSessions.filter(source => source.surface === surface &&
        (source.host === undefined || source.host === process.platform) && source.status !== "detached") ?? []
      if (action.sid !== undefined) {
        if (!sources.some(source => source.sid === action.sid)) throw new Error("monitor --sid is not a source of the requested task on this host")
      } else {
        if (sources.length !== 1) throw new Error("monitor task requires --sid when it has zero or multiple matching native sources")
        action.sid = sources[0].sid
      }
    } catch (error) {
      const failure = {success:false,code:"invalid_request",error:(error as Error).message}
      if (opts.jsonMode) console.log(JSON.stringify(failure))
      else console.error(`error: ${failure.error}`)
      process.exitCode = 1; return
    }
  }

  let pendingMonitorTaskId: string | undefined
  if (action.type === "macos_monitor" && action.sub === "start" && typeof action.taskRef === "string") {
    try {
      const { task } = resolveOrCreateMonitorTask({
        taskRef: action.taskRef,
        mode: typeof action.taskMode === "string" ? action.taskMode : undefined,
        instruction: typeof action.instruction === "string" ? action.instruction : undefined,
        createdBy: opts.desktop && process.platform !== "darwin" ? "desktop-monitor" : "macos-monitor",
        retentionPolicyId: typeof action.retentionPolicyId === "string" ? action.retentionPolicyId : undefined,
        guardPolicyId: typeof action.guardPolicyId === "string" ? action.guardPolicyId : undefined,
        verifierPolicyId: typeof action.verifierPolicyId === "string" ? action.verifierPolicyId : undefined,
      })
      pendingMonitorTaskId = task.taskId
      action.taskId = task.taskId
    } catch (err) {
      console.error(`error: ${(err as Error).message}`)
      process.exit(1)
    }
  }

  // issue #244: the vault value comes from a hidden prompt or stdin, never argv;
  // reveal prints to a human at a terminal only.
  if (action.type === "macos_secret" && action.sub === "set") {
    action.value = await readSecretValue(`Value for secret "${action.name}"`, { stdin: action.stdin === true })
    delete action.stdin
  }
  if (action.type === "macos_secret" && action.sub === "reveal") {
    if (opts.jsonMode) { console.error("error: secret reveal is refused under --json (it prints to a terminal only)"); process.exit(1) }
    if (process.env.INTERCEPTOR_MCP === "1") { console.error("error: secret reveal is refused over MCP"); process.exit(1) }
    if (!process.stdout.isTTY) { console.error("error: secret reveal prints to a terminal only (stdout is not a TTY)"); process.exit(1) }
  }

  const nativeFilesystem = action.type.startsWith("macos_fs_")
  // The generated declarations decide which neutral actions have native shape
  // validation. Named-secret delivery retains the existing daemon vault path.
  const nativeAccessibility = action.secret === undefined && DESKTOP_ACCESSIBILITY_OPERATIONS.some(
    type => type === action.type.replace(/^macos_/, "desktop_")
  )
  const nativeClipboard = DESKTOP_CLIPBOARD_OPERATIONS.some(type => type === action.type.replace(/^macos_/, "desktop_"))
  const nativeCapture = DESKTOP_CAPTURE_OPERATIONS.some(type => type === action.type.replace(/^macos_/, "desktop_"))
  const nativeDisplay = DESKTOP_DISPLAY_OPERATIONS.some(type => type === action.type.replace(/^macos_/, "desktop_"))
  const nativeCompound = DESKTOP_COMPOUND_OPERATIONS.some(type => type === action.type.replace(/^macos_/, "desktop_"))
  const nativeLog = DESKTOP_LOG_OPERATIONS.some(type => type === action.type.replace(/^macos_/, "desktop_"))
  const nativeThumbnail = DESKTOP_THUMBNAIL_OPERATIONS.some(type => type === action.type.replace(/^macos_/, "desktop_"))
  const nativeAuth = action.type === "macos_auth"
  const nativeContainer = action.type === "macos_container_run"
  const nativeFiles = action.type === "macos_files"
  const nativeNotifications = action.type === "desktop_notifications"
  const nativeMonitor = action.type === "macos_monitor"
  let nativeSecretFailure: Result | undefined
  if(opts.desktop&&process.platform!=='darwin'&&action.type==='macos_type'&&typeof action.secret==='string'){
    if(opts.useWs)nativeSecretFailure={success:false,code:'permission_denied',error:'native named-secret delivery requires direct local graphical-session access'}
    else{
      const probe:Record<string,unknown>={type:'desktop_inspect',ref:action.ref,secretBindingName:action.secret}
      for(const key of ['app','pid','window'])if(action[key]!==undefined)probe[key]=action[key]
      const binding=await callDesktopProvider(probe)
      const lease=(binding.data as {secretLease?:unknown}|undefined)?.secretLease
      if(!binding.success)nativeSecretFailure=binding
      else if(typeof lease!=='string'||!/^[a-f0-9]{64}$/.test(lease))nativeSecretFailure={success:false,code:'permission_denied',error:'native graphical-session credential grant is unavailable'}
      else action.secretLease=lease
    }
  }
  const nativeLocal = opts.desktop && (nativeContainer || process.platform === "darwin" &&
    (nativeFilesystem || nativeAccessibility || nativeClipboard || nativeCapture || nativeDisplay || nativeCompound || nativeLog || nativeThumbnail || nativeAuth || nativeFiles || nativeNotifications || nativeMonitor))
  const result: Result = nativeSecretFailure ?? (nativeLocal
    ? opts.useWs
      ? { success: false, code: "permission_denied", error: `neutral ${nativeFilesystem ? "filesystem" : nativeFiles ? "files" : nativeClipboard ? "clipboard" : nativeCapture ? "capture" : nativeDisplay ? "display" : nativeCompound ? "compound" : nativeLog ? "log" : nativeThumbnail ? "thumbnail" : ["macos_resize", "macos_move"].includes(action.type) ? "window geometry" : "accessibility"} control requires the local native bridge; WebSocket proxying is unavailable` }
      : await callDesktopProvider(action,nativeAuth?180_000:nativeContainer?desktopContainerDeadline(action):15_000)
    : await send(opts.desktop && (process.platform !== "darwin" || action.type === "macos_secret") ? desktopAction(action) : action, opts.globalTabId, opts.useWs))

  if (!result.success) {
    if (pendingMonitorTaskId) {
      markMonitorTaskSourceAttachFailed(pendingMonitorTaskId, undefined, result.error || "macos monitor start failed")
    }
    // --json failures print one JSON line on every surface (`macos menu --json` used to print nothing on stdout).
    if (opts.jsonMode) {
      console.log(JSON.stringify(jsonFailure(result))); process.exitCode = 1; return
    }
    console.error("error:", result.error || "unknown error")
    // Bridge errors may carry an actionable `remediation` command (e.g. the
    // Accessibility trust gate, monitor's TCC preflight). Surface it.
    const remediation = (result as Record<string, unknown>).remediation
    if (typeof remediation === "string") console.error("fix:", remediation)
    process.exit(1)
  }

  if (pendingMonitorTaskId) {
    const data = (result.data || {}) as Record<string, unknown>
    // prefer the sid in the response, but if a slow/garbled RPC
    // dropped it, recover the sid from the freshly-written session meta so the
    // source still attaches (no more split-brain envelope with empty sources).
    const sid = typeof data.sid === "string" ? data.sid
      : typeof data.sessionId === "string" ? data.sessionId
      : findLatestSessionSidForTask(pendingMonitorTaskId)
    if (sid) {
      try {
        attachMonitorTaskSource(pendingMonitorTaskId, sid, {
          surface: opts.desktop && process.platform !== "darwin" ? "desktop" : "macos",
          rootPid: typeof data.rootPid === "number" ? data.rootPid : undefined,
          rootBundleId: typeof data.rootBundleId === "string" ? data.rootBundleId : undefined,
          rootApp: typeof data.rootApp === "string" ? data.rootApp : undefined,
        })
        // post-attach verification — confirm the source actually landed.
        const verify = readMonitorTaskMeta(pendingMonitorTaskId)
        const attached = verify?.sourceSessions.some((s) => s.sid === sid && s.status !== "detached")
        if (!attached) {
          markMonitorTaskSourceAttachFailed(pendingMonitorTaskId, sid, "source attach did not register in task meta")
          console.error(`error: macOS monitor session ${sid} did not register as a source of task ${pendingMonitorTaskId}`)
          process.exit(1)
        }
        data.taskId = pendingMonitorTaskId
        data.sid = sid
        result.data = data
      } catch (err) {
        markMonitorTaskSourceAttachFailed(pendingMonitorTaskId, sid, (err as Error).message)
        console.error(`error: macOS monitor session ${sid} started but task attachment failed: ${(err as Error).message}`)
        process.exit(1)
      }
    } else {
      markMonitorTaskSourceAttachFailed(pendingMonitorTaskId, undefined, "macos monitor response did not include sid")
    }
  }

  // `interceptor macos monitor stop --task <t>` must finalize
  // the envelope locally (the bridge only stops the session). Mirror the browser
  // path: snapshot sources, transcribe offline audio, regenerate the
  // timeline/transcript/segments, re-grade, and print status + quality.
  if (action.type === "macos_monitor" && action.sub === "stop" && typeof action.taskRef === "string") {
    try {
      const taskId = resolveMonitorTaskId(action.taskRef)
      const task = readMonitorTaskMeta(taskId)
      const unfinished = task?.sourceSessions.filter(source => source.sid !== action.sid && source.status !== "detached" &&
        source.status !== "source_stopped" && readSessionMeta(source.sid)?.status !== "stopped") ?? []
      if (unfinished.length) {
        if (opts.jsonMode) console.log(JSON.stringify({...(result.data as Record<string,unknown>),taskId,taskStatus:task?.status,remainingSources:unfinished.map(source=>source.sid)}))
        else console.log(`Stopped source ${action.sid}. Task ${taskId} remains ${task?.status}; ${unfinished.length} other sources have no confirmed stop.`)
        return
      }
      stopMonitorTask(taskId, {}) // snapshots + transcribes offline audio
      synthesizeMonitorTaskTranscript(taskId) // timeline + transcript + segments + grade
      generateMonitorTaskCaptureQuality(taskId)
      if (opts.jsonMode) {
        console.log(JSON.stringify(readMonitorTaskMeta(taskId), null, 2))
      } else {
        console.log(`${renderMonitorTaskStatus(taskId)}\n${renderMonitorTaskQualitySummary(taskId)}`)
      }
      return
    } catch (err) {
      console.error(`error: ${(err as Error).message}`)
      process.exit(1)
    }
  }

  // A sid-addressed stop bypasses the task epilogue above (snapshot +
  // synthesis + grading), which is why a later `task quality` used to grade an
  // empty transcript with no pointer to the missing step (#218). Name the
  // owning task and the path forward.
  if (action.type === "macos_monitor" && action.sub === "stop" && typeof action.taskRef !== "string") {
    const sid = typeof action.sid === "string" ? action.sid
      : typeof (result.data as Record<string, unknown> | undefined)?.sid === "string"
        ? (result.data as Record<string, unknown>).sid as string
        : undefined
    if (sid) {
      try {
        const owner = listMonitorTasks().find((task) => task.sourceSessions?.some((s) => s.sid === sid))
        if (owner) {
          console.error(
            `note: session ${sid} belongs to task ${owner.taskId} — ` +
            `'interceptor macos monitor stop --task ${owner.taskId}' auto-snapshots and grades; ` +
            `to finish now run 'interceptor monitor task snapshot ${owner.taskId}' then 'interceptor monitor task quality ${owner.taskId}'.`,
          )
        }
      } catch {}
    }
  }

  if (action.type === "macos_secret" && action.sub === "reveal") {
    const value = (result.data as { value?: unknown } | undefined)?.value
    if (typeof value !== "string") { console.error("error: no value returned"); process.exit(1) }
    console.log(value)
    return
  }

  if (action.type === "macos_monitor" && action.raw === true && Array.isArray(result.data)) {
    console.log(result.data.map(event => JSON.stringify(event)).join("\n"))
  } else if (opts.jsonMode) {
    console.log(JSON.stringify(result.data, null, 2))
  } else if (action.type === "macos_apps" && Array.isArray(result.data)) {
    console.log(formatAppRows(result.data))
  } else if (typeof result.data === "string") {
    console.log(result.data)
  } else if (result.data !== undefined && result.data !== null) {
    console.log(JSON.stringify(result.data, null, 2))
  } else {
    console.log("ok")
  }
}

/** Plain-text `apps`: one `[pid] name * (hidden) — bundle id` line per app; the fields after the name only when the host reports them. */
export function formatAppRows(rows: { pid?: unknown; name?: unknown; bundleId?: unknown; active?: unknown; hidden?: unknown }[]): string {
  return rows.map(row => `[${row.pid}] ${row.name}${row.active === true ? " *" : ""}${row.hidden === true ? " (hidden)" : ""}${typeof row.bundleId === "string" ? ` — ${row.bundleId}` : ""}`).join("\n")
}

export function parseMacosCommand(filtered: string[], extensionPrefixes?: Set<string>, desktop = false, stdinText?: string): Action | null {
  const sub = filtered[1]
  if (!sub) {
    console.error("error: interceptor macos requires a subcommand. Examples:")
    console.error("  interceptor macos tree")
    console.error("  interceptor macos apps")
    console.error("  interceptor macos click e5")
    console.error("  interceptor macos trust")
    process.exit(1)
  }

  switch (sub) {
    // ── Accessibility ──
    case "tree": {
      const action: Action = {
        type: "macos_tree",
        app: flagVal(filtered, "--app"),
        pid: flagInt(filtered, "--pid", desktop),
        filter: flagVal(filtered, "--filter") || "interactive",
        depth: desktop ? flagInt(filtered, "--depth", true) ?? 10 : flagInt(filtered, "--depth") || 10,
        // help advertises `--max-chars`; forward it (was dropped).
        maxChars: desktop ? flagInt(filtered, "--max-chars", true) ?? 50000 : flagInt(filtered, "--max-chars") || 50000,
        // traversal bounds (bridge clamps to the safety hard caps; omit ⇒ defaults).
        maxNodes: flagInt(filtered, "--max-nodes", desktop),
        maxMs: flagInt(filtered, "--max-ms", desktop),
      }
      withWindow(action, filtered, desktop)
      // A tree read never moves focus, so --background-only has nothing to restrict and
      // the tree contract has no such field; accept the flag without sending it.
      delete action.backgroundOnly
      return action
    }

    case "find": {
      const query = filtered[2]
      if (!query) { if (desktop) throw new Error("find requires a query"); console.error("error: interceptor macos find requires a query"); process.exit(1) }
      return {
        type: "macos_find",
        query,
        app: flagVal(filtered, "--app"),
        pid: flagInt(filtered, "--pid", desktop),
        role: flagVal(filtered, "--role"),
        maxNodes: flagInt(filtered, "--max-nodes", desktop),
        maxMs: flagInt(filtered, "--max-ms", desktop),
      }
    }

    case "inspect": {
      if (desktop) {
        const values = compoundPositionals(filtered, new Set(["--app", "--pid"]))
        if (values.length > 1) throw new Error("inspect accepts at most one ref")
        if (values.length) return { type: "macos_inspect", ref: values[0], app: flagVal(filtered, "--app"), pid: flagInt(filtered, "--pid", true) }
        return { type: "macos_inspect_app", app: flagVal(filtered, "--app"), pid: flagInt(filtered, "--pid", true) }
      }
      const ref = filtered[2]
      if (ref && !ref.startsWith("--")) return { type: "macos_inspect", ref }
      return {
        type: "macos_compound",
        sub: "inspect",
        app: flagVal(filtered, "--app"),
        pid: flagInt(filtered, "--pid"),
      }
    }

    case "value": {
      if (desktop) {
        const boundary = filtered.indexOf("--", 2)
        const options = boundary < 0 ? filtered : filtered.slice(0, boundary)
        const values = compoundPositionals(options, new Set(["--app", "--pid", "--window"]))
        if (boundary >= 0) values.push(...filtered.slice(boundary + 1))
        if (!values[0] || values.length > 2) throw new Error("value requires a ref and at most one value")
        const action: Action = {
          type: "macos_value", ref: values[0],
          ...(values[1] !== undefined && { value: values[1] }),
          app: flagVal(options, "--app"), pid: flagInt(options, "--pid", true),
        }
        withWindow(action, options, true)
        return action
      }
      const ref = filtered[2]
      if (!ref) { if (desktop) throw new Error("value requires a ref"); console.error("error: interceptor macos value requires a ref"); process.exit(1) }
      const newValue = filtered[3]
      return { type: "macos_value", ref, ...(newValue !== undefined && { value: newValue }) }
    }

    case "action": {
      if (desktop) {
        const boundary = filtered.indexOf("--", 2)
        const options = boundary < 0 ? filtered : filtered.slice(0, boundary)
        if (options.filter(value => value === "--background-only").length > 1) throw new Error("action accepts one --background-only flag")
        const backgroundIndex = options.indexOf("--background-only", 2)
        if (backgroundIndex > 2 && ["--app", "--pid", "--window"].includes(options[backgroundIndex - 1])) throw new Error(`${options[backgroundIndex - 1]} requires a value`)
        const values = compoundPositionals(options.filter(value => value !== "--background-only"), new Set(["--app", "--pid", "--window"]))
        if (boundary >= 0) values.push(...filtered.slice(boundary + 1))
        if (!values[0] || values.length > 2) throw new Error("action requires a ref and at most one action name")
        const action: Action = {
          type: "macos_action", ref: values[0], action: values[1] ?? "press",
          app: flagVal(options, "--app"), pid: flagInt(options, "--pid", true),
        }
        withWindow(action, options, true)
        return action
      }
      const ref = filtered[2]
      if (!ref) { if (desktop) throw new Error("action requires a ref"); console.error("error: interceptor macos action requires a ref"); process.exit(1) }
      const actionName = filtered[3] || "press"
      return { type: "macos_action", ref, action: actionName }
    }

    case "focused":
      return { type: "macos_focused", app: flagVal(filtered, "--app"), pid: flagInt(filtered, "--pid", desktop) }

    case "windows":
      return { type: "macos_windows", app: flagVal(filtered, "--app"), pid: flagInt(filtered, "--pid", desktop) }

    // ── Text ──
    case "text": {
      const ref = filtered[2]
      if (!ref) { if (desktop) throw new Error("text requires a ref"); console.error("error: interceptor macos text requires a ref"); process.exit(1) }
      const mode = filtered.includes("--selection") ? "selection" : filtered.includes("--visible") ? "visible" : "full"
      if (desktop) {
        const modes = filtered.filter(value => value === "--selection" || value === "--visible")
        if (modes.length > 1) throw new Error("text accepts one selection or visible mode flag")
        const values = compoundPositionals(filtered.filter(value => value !== "--selection" && value !== "--visible"), new Set(["--app", "--pid", "--window"]))
        if (values.length !== 1) throw new Error("text requires exactly one reference")
        const app = flagVal(filtered, "--app")
        const action: Action = { type: "macos_text", ref: values[0], mode, app, pid: flagInt(filtered, "--pid", true) }
        withWindow(action, filtered, true)
        return action
      }
      return { type: "macos_text", ref, mode }
    }

    // ── Menu ──
    case "menu": {
      const items = collectPositionals(filtered, 2, new Set(["--app", "--pid", "--window"]))
      const action: Action = {
        type: "macos_menu",
        ...(items.length > 0 && { items }),
        app: flagVal(filtered, "--app"),
        pid: flagInt(filtered, "--pid", desktop),
      }
      if (desktop) withWindow(action, filtered, true)
      return action
    }

    // ── Update (Sparkle) ──
    case "update": {
      const op = filtered[2] || "status"
      // Windows and Linux Full install releases themselves; macOS installs through Sparkle's prompt.
      if(op==="install"&&process.platform==="darwin")throw new Error('macOS installs updates through Sparkle: run interceptor update, then accept its prompt')
      if(filtered.length>3||!["check","status","install"].includes(op))throw new Error('update accepts only check, status or install, without fields')
      return {
        type: "macos_update",
        sub: op,
      }
    }

    // ── Trust ──
    case "trust": {
      if(desktop){
        const flags=new Set(['--no-prompt','--prompt','--walkthrough','--accessibility-prompt','--screen-prompt','--microphone-prompt','--speech-prompt'])
        const args=filtered.slice(2)
        if(args.some((value,index)=>!flags.has(value)&&(index!==0||value!=='speech')))throw new Error('trust accepts only speech and its named permission flags')
        for(const flag of flags)if(args.filter(value=>value===flag).length>1)throw new Error(`repeated flag: ${flag}`)
      }
      // --no-prompt is defense-in-depth for read-only consumers: when set,
      // every prompt-triggering flag is forced false in the wire payload so
      // a future caller-side bug cannot accidentally modify TCC state.
      const noPrompt = filtered.includes("--no-prompt")
      // `interceptor macos trust speech [--prompt]` is sugar for
      // `interceptor macos trust --speech-prompt`; both surface the distinct
      // Speech-Recognition TCC dialog.
      const speechSub = filtered[2] === "speech"
      const action:Action = {
        type: "macos_trust",
        noPrompt,
        prompt: !noPrompt && (filtered.includes("--prompt") || filtered.includes("--walkthrough")) && !speechSub,
        walkthrough: !noPrompt && filtered.includes("--walkthrough"),
        accessibilityPrompt: !noPrompt && filtered.includes("--accessibility-prompt"),
        screenPrompt: !noPrompt && filtered.includes("--screen-prompt"),
        microphonePrompt: !noPrompt && filtered.includes("--microphone-prompt"),
        speechPrompt: !noPrompt && (filtered.includes("--speech-prompt") || (speechSub && (filtered.includes("--prompt") || filtered.length <= 3))),
      }
      if(desktop){const error=desktopTrustActionError(desktopAction(action));if(error)throw new Error(error)}
      return action
    }

    // ── TCC / PPPC profile management ──
    case "tcc": {
      const op = filtered[2] || "status"
      const target = flagVal(filtered, "--target") || "host"

      if (op === "status") {
        return {
          type: "macos_tcc_status",
          sub: "status",
          target,
        }
      }

      if (op === "profile") {
        const profileOp = filtered[3]
        if (profileOp !== "generate") {
          console.error("error: interceptor macos tcc profile requires subcommand: generate")
          process.exit(1)
        }
        const services = collectMulti(filtered, "--service").flatMap((s) => s.split(",").filter(Boolean))
        const action: Action = {
          type: "macos_tcc_profile_generate",
          sub: "profile_generate",
          target,
        }
        if (services.length > 0) action.services = services
        if (flagVal(filtered, "--out")) action.out = flagVal(filtered, "--out")
        if (flagVal(filtered, "--bundle-id")) action.bundleId = flagVal(filtered, "--bundle-id")
        if (flagVal(filtered, "--app-path")) action.appPath = flagVal(filtered, "--app-path")
        if (flagVal(filtered, "--identifier-type")) action.identifierType = flagVal(filtered, "--identifier-type")
        if (flagVal(filtered, "--code-requirement")) action.codeRequirement = flagVal(filtered, "--code-requirement")
        if (filtered.includes("--full-disk")) action.fullDisk = true
        if (filtered.includes("--include-user-only")) action.includeUserOnly = true
        return action
      }

      console.error("error: interceptor macos tcc requires subcommand: status | profile generate")
      process.exit(1)
    }

    // ── Apps ──
    case "apps":
      return { type: "macos_apps" }

    case "app": {
      // `app --pid N` has no subcommand: a leading flag means the default, activate.
      const hasSub = filtered[2] !== undefined && !filtered[2].startsWith("--")
      const subcommand = hasSub ? filtered[2] : "activate"
      const positional = !hasSub || (desktop && filtered[3]?.startsWith("--")) ? undefined : filtered[3]
      const appName = desktop && subcommand === "launch" ? undefined : flagVal(filtered, "--app") || positional
      return {
        type: "macos_app",
        subcommand,
        app: appName,
        pid: flagInt(filtered, "--pid", desktop),
        bundleId: subcommand === "launch" ? (positional || flagVal(filtered, "--bundle")) : undefined,
      }
    }

    case "frontmost":
      return { type: "macos_frontmost" }

    // ── Input ──
    case "click": {
      const target = filtered[2]
      if (!target) { if (desktop) throw new Error("click requires a ref or coordinates"); console.error("error: interceptor macos click requires a ref or coordinates"); process.exit(1) }
      const isCoords = target.includes(",")
      const action: Action = {
        type: "macos_click",
        ...(isCoords ? { coords: target } : { ref: target }),
        double: filtered.includes("--double"),
        right: filtered.includes("--right"),
      }
      // Optional --app / --pid flow through to the bridge so synthesized
      // CGEvents post via CGEvent.postToPid instead of the system HID
      // tap, keeping the click background-only.
      const clickApp = flagVal(filtered, "--app")
      const clickPid = flagInt(filtered, "--pid", desktop)
      if (clickApp) action.app = clickApp
      if (clickPid !== undefined) action.pid = clickPid
      withWindow(action, filtered, desktop)
      return action
    }

    case "type": {
      const keycodesUS = filtered.includes("--keycodes-us")
      if (desktop && keycodesUS) throw new Error("--keycodes-us is available on macos type; desktop type uses the host's native text path")
      if (keycodesUS && filtered.filter(value => value === "--keycodes-us").length !== 1) throw new Error("invalid or repeated flag: --keycodes-us")
      const physicalValues = keycodesUS ? compoundPositionals(filtered.filter(value => value !== "--keycodes-us"), new Set(["--secret", "--app", "--pid", "--window"])) : undefined
      const typeApp = flagVal(filtered, "--app")
      const typePid = flagInt(filtered, "--pid", desktop)
      // issue #244: `--secret <name>` delivers a vault value by name. The daemon
      // resolves it after logging; the CLI never sees the value.
      if (filtered.includes("--secret")) {
        const secretName = flagVal(filtered, "--secret")
        if (!secretName || secretName.startsWith("--")) { console.error("error: --secret requires a secret name"); process.exit(1) }
        const positionals = physicalValues ?? (desktop ? compoundPositionals(filtered,new Set(["--secret","--app","--pid","--window"])) : collectPositionals(filtered, 2, new Set(["--secret", "--app", "--pid", "--window"])))
        const ref = positionals[0] && /^e\d+$/.test(positionals[0]) ? positionals[0] : undefined
        const literal = ref ? positionals.slice(1) : positionals
        if (literal.length) { console.error("error: --secret and literal text are mutually exclusive"); process.exit(1) }
        if(desktop&&!ref)throw new Error('desktop named-secret typing requires an exact accessibility reference')
        const action: Action = { type: "macos_type", secret: secretName }
        if (keycodesUS) action.keycodesUS = true
        if (ref) action.ref = ref
        if (typeApp) action.app = typeApp
        if (typePid !== undefined) action.pid = typePid
        withWindow(action, filtered, desktop)
        return action
      }
      if (physicalValues && (physicalValues.length > 2 || (physicalValues.length === 2 && !/^e\d+$/.test(physicalValues[0])))) throw new Error("physical type accepts text or ref plus text")
      const typeValues = physicalValues ?? filtered.slice(2)
      const refOrText = typeValues[0]
      if (!refOrText) { if (desktop) throw new Error("type requires text or ref + text"); console.error("error: interceptor macos type requires text or ref + text"); process.exit(1) }
      const action: Action = /^e\d+$/.test(refOrText) && (desktop ? typeValues[1] !== undefined : !!typeValues[1])
        ? { type: "macos_type", ref: refOrText, text: typeValues[1] }
        : { type: "macos_type", text: refOrText }
      if (keycodesUS) action.keycodesUS = true
      if (typeApp) action.app = typeApp
      if (typePid !== undefined) action.pid = typePid
      withWindow(action, filtered, desktop)
      return action
    }

    case "keys": {
      const combo = filtered[2]
      if (!combo) { if (desktop) throw new Error("keys requires a key combo"); console.error("error: interceptor macos keys requires a key combo"); process.exit(1) }
      const action: Action = { type: "macos_keys", keys: combo }
      const keysApp = flagVal(filtered, "--app")
      const keysPid = flagInt(filtered, "--pid", desktop)
      if (keysApp) action.app = keysApp
      if (keysPid !== undefined) action.pid = keysPid
      withWindow(action, filtered, desktop)
      return action
    }

    case "scroll": {
      // Direction and amount are optional positionals; `scroll --ref e1 --pid 7` uses the defaults.
      const hasDirection = filtered[2] !== undefined && !filtered[2].startsWith("--")
      const direction = hasDirection ? filtered[2] : "down"
      const amountToken = hasDirection && filtered[3] !== undefined && !filtered[3].startsWith("--") ? filtered[3] : "300"
      const amount = desktop ? flagInt(["--amount", amountToken], "--amount", true)! : parseInt(amountToken)
      const action: Action = {
        type: "macos_scroll",
        direction,
        amount: isNaN(amount) ? 300 : amount,
        ref: flagVal(filtered, "--ref"),
      }
      // --pid <pid> or --app <name> routes scroll to a specific process
      // via CGEvent.postToPid — works on occluded / minimized windows
      // without changing focus.
      const pid = flagInt(filtered, "--pid", desktop)
      const targetApp = flagVal(filtered, "--app")
      const times = flagInt(filtered, "--times", desktop)
      const intervalMs = flagInt(filtered, "--interval-ms", desktop)
      if (pid !== undefined) action.pid = pid
      if (targetApp) action.app = targetApp
      if (times !== undefined) action.times = times
      if (intervalMs !== undefined) action.intervalMs = intervalMs
      withWindow(action, filtered, desktop)
      return action
    }

    case "resize": {
      const ref = filtered[2]
      if (!ref) { console.error("error: interceptor macos resize requires a ref"); process.exit(1) }
      const values = desktop ? collectPositionals(filtered, 3, new Set(["--width", "--height", "--app", "--pid"])) : []
      const width = desktop
        ? flagInt(filtered, "--width", true) ?? flagInt(values[0] === undefined ? [] : ["--width", values[0]], "--width", true)
        : flagInt(filtered, "--width") || parseInt(filtered[3]) || undefined
      const height = desktop
        ? flagInt(filtered, "--height", true) ?? flagInt(values[1] === undefined ? [] : ["--height", values[1]], "--height", true)
        : flagInt(filtered, "--height") || parseInt(filtered[4]) || undefined
      if (desktop && values.length > 2) throw new Error("resize accepts only width and height positionals")
      // : parser parity with click/type/keys/scroll/drag — forward
      // --app and --pid so the bridge can use them for ref qualification.
      const action: Action = { type: "macos_resize", ref, width, height }
      const resizeApp = flagVal(filtered, "--app")
      const resizePid = flagInt(filtered, "--pid", desktop)
      if (desktop && filtered.includes("--app") && (!resizeApp || resizeApp.startsWith("--"))) throw new Error("--app requires a target application")
      if (resizeApp) action.app = resizeApp
      if (resizePid !== undefined) action.pid = resizePid
      return action
    }

    case "move": {
      const ref = filtered[2]
      if (!ref) { console.error("error: interceptor macos move requires a ref"); process.exit(1) }
      const values = desktop ? collectPositionals(filtered, 3, new Set(["--x", "--y", "--app", "--pid"])) : []
      const x = desktop
        ? flagInt(filtered, "--x", true) ?? flagInt(values[0] === undefined ? [] : ["--x", values[0]], "--x", true) ?? 0
        : flagInt(filtered, "--x") || parseInt(filtered[3]) || 0
      const y = desktop
        ? flagInt(filtered, "--y", true) ?? flagInt(values[1] === undefined ? [] : ["--y", values[1]], "--y", true) ?? 0
        : flagInt(filtered, "--y") || parseInt(filtered[4]) || 0
      if (desktop && values.length > 2) throw new Error("move accepts only x and y positionals")
      const action: Action = { type: "macos_move", ref, x, y }
      const moveApp = flagVal(filtered, "--app")
      const movePid = flagInt(filtered, "--pid", desktop)
      if (desktop && filtered.includes("--app") && (!moveApp || moveApp.startsWith("--"))) throw new Error("--app requires a target application")
      if (moveApp) action.app = moveApp
      if (movePid !== undefined) action.pid = movePid
      return action
    }

    case "drag": {
      const from = filtered[2]
      const to = filtered[3]
      if (!from || !to) { if (desktop) throw new Error("drag requires from and to refs or coords"); console.error("error: interceptor macos drag requires from and to refs or coords"); process.exit(1) }
      const fromIsCoords = from.includes(",")
      const toIsCoords = to.includes(",")
      const action: Action = fromIsCoords && toIsCoords
        ? { type: "macos_drag", fromCoords: from, toCoords: to }
        : { type: "macos_drag", from, to }
      const dragApp = flagVal(filtered, "--app")
      const dragPid = flagInt(filtered, "--pid", desktop)
      if (dragApp) action.app = dragApp
      if (dragPid !== undefined) action.pid = dragPid
      withWindow(action, filtered, desktop)
      return action
    }

    // ── Screenshot / Capture ──
    case "screenshot": {
      // Capture-time optimizations: target_max_long_edge resize at capture,
      // WebP encoding, save-strips-dataUrl, --mode display for full-screen.
      const action: Action = {
        type: "macos_screenshot",
        app: flagVal(filtered, "--app"),
        display: flagInt(filtered, "--display", desktop),
        window: flagInt(filtered, "--window", desktop),
        save: filtered.includes("--save"),
        format: flagVal(filtered, "--format") || "jpeg",
        quality: desktop ? (flagInt(filtered, "--quality", true) ?? 80) : flagInt(filtered, "--quality") || 80,
        element: flagVal(filtered, "--element"),
        cwd: process.cwd(),
      }
      if (desktop) for (const flag of ["--app", "--format", "--element", "--mode"]) {
        if (filtered.includes(flag) && (!flagVal(filtered, flag) || flagVal(filtered, flag)!.startsWith("--"))) throw new Error(`${flag} requires a value`)
      }
      const mode = flagVal(filtered, "--mode")
      if (mode) action.mode = mode
      // --full-screen is a friendlier alias for --mode display
      if (filtered.includes("--full-screen") || filtered.includes("--display-mode")) {
        action.mode = "display"
      }
      const targetMaxLongEdge = flagInt(filtered, "--target-max-long-edge", desktop)
      if (targetMaxLongEdge !== undefined) {
        action.target_max_long_edge = targetMaxLongEdge
      } else if (flagVal(filtered, "--target-max-long-edge") === "0") {
        // Explicit "no resize" — keep full pixel resolution (legacy behavior).
        action.target_max_long_edge = 0
      }
      return action
    }

    case "capture": {
      const op = filtered[2] || "frame"
      const action: Action = {
        type: "macos_capture",
        sub: op,
        app: flagVal(filtered, "--app"),
      }
      if (desktop && filtered.includes("--app") && (!flagVal(filtered, "--app") || flagVal(filtered, "--app")!.startsWith("--"))) throw new Error("--app requires a target application")
      // `capture frame` blocks briefly waiting for the next sample buffer
      // when the stream is active but hasn't ticked yet. Default 3000ms;
      // override with --timeout-ms.
      const timeoutMs = flagInt(filtered, "--timeout-ms", desktop)
      if (timeoutMs !== undefined) action.timeoutMs = timeoutMs
      return action
    }

    // ── Speech ──
    case "listen": {
      const values=compoundPositionals(filtered,new Set(['--device']))
      const op=values[0]??'status'
      if(!['start','stop','status','transcript','tail','vocab'].includes(op))throw new Error('listen requires start, stop, status, transcript, tail or vocab')
      const action:Action={type:'macos_listen',sub:op,device:flagVal(filtered,'--device')}
      if(op==='vocab'){
        action.op=values[1]??'list';action.word=values[2]
        if(values.length>3)throw new Error('listen vocab requires one operation and optional word')
      }else if(values.length>1)throw new Error('listen requires one selector and named flags')
      const error=desktopSpeechActionError(desktopAction(action));if(error)throw new Error(error)
      return action
    }

    case "vad": {
      const op=filtered[2]??"status"
      if(!['start','stop','status'].includes(op))throw new Error('vad requires start, stop or status')
      const action:Action={type:'macos_vad',sub:op}
      let seen=false
      for(let i=3;i<filtered.length;i++){
        if(filtered[i]!=='--threshold'||seen||filtered[i+1]===undefined)throw new Error('vad accepts one --threshold value on start')
        seen=true;action.threshold=Number(filtered[++i]);if(!filtered[i].trim())throw new Error('vad threshold value is missing')
      }
      const error=desktopVadActionError(desktopAction(action));if(error)throw new Error(error)
      return action
    }

    // ── Sound ──
    case "sounds": {
      const values=compoundPositionals(filtered,new Set(['--filter']))
      if(values.length>1)throw new Error('sounds requires one selector and named filter')
      const action:Action={type:desktop?'desktop_sounds':'macos_sounds',sub:values[0]??'status'}
      const filter=flagVal(filtered,'--filter');if(filter!==undefined)action.filter=filter
      const error=desktopSoundActionError({...action,type:'desktop_sounds'});if(error)throw new Error(error)
      return action
    }

    // ── Vision ──
    case "vision": {
      if(desktop){
        const values=compoundPositionals(filtered,new Set(['--app','--image','--debug-dump']))
        if(values.length>1)throw new Error('vision requires one selector and named source flags')
        const image=flagVal(filtered,'--image'),dump=flagVal(filtered,'--debug-dump')
        const action:Action={type:'macos_vision',sub:values[0]??'text',app:flagVal(filtered,'--app'),imagePath:image?resolve(image):undefined,debugDumpPath:dump?resolve(dump):undefined}
        const error=desktopVisionActionError(desktopAction(action));if(error)throw new Error(error)
        return action
      }
      const op = filtered[2] || "text"
      const app = flagVal(filtered, "--app")
      const image = flagVal(filtered, "--image")
      // A dropped --image would recognize whatever window is frontmost and report success.
      if (filtered.includes("--image") && (!image || image.startsWith("--"))) {
        console.error("error: interceptor macos vision --image requires a path to an image file"); process.exit(1)
      }
      if (image && app) {
        console.error("error: interceptor macos vision takes --image <path> or --app <name>, not both"); process.exit(1)
      }
      const action: Action = {
        type: "macos_vision",
        sub: op,
        app,
        // The bridge's working directory is "/", so a relative path means the caller's.
        imagePath: image ? resolve(image) : undefined,
      }
      // diagnostic: dump the captured image to disk so the operator
      // can see what Vision actually fed VNRecognizeTextRequest. Off by
      // default; opt in with --debug-dump <path>.
      const debugDump = flagVal(filtered, "--debug-dump")
      if (debugDump) action.debugDumpPath = debugDump
      return action
    }

    // ── NLP ──
    case "nlp": {
      if(desktop){
        const values=compoundPositionals(filtered,new Set<string>()),sub=values[0]
        const action:Action={type:'macos_nlp',sub}
        if(sub==='similar'){if(values.length!==3)throw new Error('similar requires two words');action.word1=values[1];action.word2=values[2]}
        else{if(values.length!==2)throw new Error('NLP requires one text argument');action.text=values[1]}
        const error=desktopLanguageActionError(desktopAction(action));if(error)throw new Error(error)
        return action
      }
      const op = filtered[2]
      if (!op) { console.error("error: interceptor macos nlp requires a subcommand (entities, language, sentiment, tokens, similar, embed)"); process.exit(1) }
      const text = filtered[3]
      return {
        type: `macos_nlp`,
        sub: op,
        text,
        word1: op === "similar" ? filtered[3] : undefined,
        word2: op === "similar" ? filtered[4] : undefined,
      }
    }

    // ── Intelligence ──
    case "ai": {
      if(desktop){
        const values=compoundPositionals(filtered,new Set<string>()),sub=values[0]??'status',action:Action={type:'macos_ai',sub}
        if(sub==='prompt'){if(values.length!==2)throw new Error('prompt requires one text argument');action.prompt=values[1]}
        else if(sub==='session'){
          action.op=values[1]
          if(action.op==='send'){if(values.length!==3)throw new Error('session send requires one message');action.message=values[2]}
          else if(values.length!==2)throw new Error('session requires one operation')
        }else if(values.length>1)throw new Error('AI status accepts no arguments')
        const error=desktopLanguageActionError(desktopAction(action));if(error)throw new Error(error)
        return action
      }
      const op = filtered[2] || "status"
      // Spec 1 follow-up: `ai session <op>` previously sent
      // filtered[3] as `prompt`, but the bridge's IntelligenceDomain.handleSession
      // reads action["op"], so the inner op (start/send/history/end) was
      // dropped and every session call fell through to "session status"
      // notImplemented. Route filtered[3] to the right field per outer op:
      //   - sub="prompt"  → filtered[3] is the prompt text
      //   - sub="session" → filtered[3] is the session sub-op; filtered[4] is the message for session send
      //   - everything else → leave both unset
      const action: Action = { type: "macos_ai", sub: op }
      if (op === "session") {
        if (filtered[3]) action.op = filtered[3]
        if (filtered[4]) action.message = filtered[4]
      } else {
        if (filtered[3]) action.prompt = filtered[3]
      }
      return action
    }

    // ── Sensitive ──
    case "sensitive": {
      const values=compoundPositionals(filtered,new Set(['--app','--image']))
      const sub=values[0]??'check'
      if(values.length>(sub==='monitor'?2:1))throw new Error('sensitive accepts check or monitor start/stop/status')
      const image=flagVal(filtered,'--image')
      const action:Action={type:desktop?'desktop_sensitive':'macos_sensitive',sub,app:flagVal(filtered,'--app'),imagePath:image?resolve(image):undefined}
      if(sub==='monitor')action.op=values[1]??'status'
      const error=desktopSensitiveActionError(desktopAction(action));if(error)throw new Error(error)
      return action
    }

    // ── Health ──
    case "health": {
      if (desktop) {
        const values = compoundPositionals(filtered, new Set<string>())
        if (values.length > 1 || values[0] !== undefined && values[0] !== "status") throw new Error("desktop health accepts only status")
        return { type: "macos_health", sub: "status" }
      }
      const op = filtered[2] || "status"
      return { type: "macos_health", sub: op }
    }

    // ── Files ──
    case "files": {
      if(desktop){
        const values=compoundPositionals(filtered,new Set(['--limit','--pid']))
        const sub=values[0]??'recent',action:Action={type:'macos_files',sub}
        if(['watch','unwatch'].includes(sub)){
          if(values.length!==2)throw new Error('files watch/unwatch require one path')
          action.path=values[1]
        }else if(values.length>1)throw new Error('files recent/open accept only named inventory selectors')
        for(const [flag,key] of [['--limit','limit'],['--pid','pid']])if(filtered.includes(flag))action[key]=flagInt(filtered,flag,true)
        const error=desktopFilesActionError(desktopAction(action));if(error)throw new Error(error)
        return action
      }
      const op = filtered[2] || "recent"
      const path = filtered[3]
      return {
        type: "macos_files",
        sub: op,
        path,
        filter: flagVal(filtered, "--filter"),
        app: flagVal(filtered, "--app"),
        limit: flagInt(filtered, "--limit"),
      }
    }

    // ── Notifications ──
    case "notifications": {
      if (desktop) {
        const strings = ['namespace','name','app','title','subtitle','body','sound','category','thread','user-info','interruption','attachment','date','components','id','options','identifier','actions','intent-identifiers','summary-format','hidden-placeholder']
        const numbers = ['limit','seconds','badge','count']
        if (filtered.filter(s => s === '--repeats').length > 1) throw new Error('invalid or repeated flag: --repeats')
        const args = filtered.filter(s => s !== '--repeats')
        const values = compoundPositionals(args, new Set([...strings,...numbers].map(s => '--' + s)))
        const op = values[0] ?? 'tail'
        const action: Action = {type:'desktop_notifications',sub:op}
        for (const key of strings) { const val=flagVal(args,'--'+key); if(val!==undefined) action[key.replaceAll('-','_')]=val }
        // flagVal reads an empty value as absent, which turned --options "" into the default set.
        if(args.includes('--options')&&!String(action.options??'').trim()) throw new Error('notifications --options needs at least one option (alert, sound, badge, ...); nothing was requested')
        for (const key of numbers) if(args.includes('--'+key)) action[key]=flagInt(args,'--'+key,true)
        if(filtered.includes('--repeats')) action.repeats=true
        if(op==='categories') action.verb=values[1]??'list'
        else if(op==='badge'&&values[1]==='clear') action.clear=true
        else if(op==='badge'&&values[1]!==undefined) {
          if(action.count!==undefined) throw new Error('badge count has conflicting positional and flag values')
          action.count=flagInt(['--count',values[1]],'--count',true)
        } else if(['cancel','dismiss'].includes(op)&&values[1]!==undefined) {
          if(action.id!==undefined) throw new Error('notification identifier has conflicting positional and flag values')
          action.id=values[1]
        } else if(values.length>1) throw new Error('notification operation accepts only named options')
        if(values.length>2) throw new Error('notification operation has extra positional values')
        const error=desktopNotificationsActionError(action);if(error)throw new Error(error)
        return action
      }
      const op = filtered[2] || "tail"
      const action: Action = { type: "macos_notifications", sub: op }
      // legacy DistributedNotificationCenter flags
      const name = flagVal(filtered, "--name"); if (name !== undefined) action.name = name
      const app = flagVal(filtered, "--app"); if (app) action.app = app
      const limit = flagInt(filtered, "--limit"); if (limit !== undefined) action.limit = limit
      // UNUserNotificationCenter flags. Numeric flags must be
      // int-typed because the bridge handler casts with `as? Int` and a
      // string value silently drops to nil (NotificationsDomain.swift:297
      // — `--seconds <N> required` fires even when --seconds 5 is passed).
      for (const flag of ["--title","--subtitle","--body","--sound","--category","--thread","--user-info","--interruption","--attachment","--date","--components","--id","--options","--identifier","--actions","--intent-identifiers","--summary-format","--hidden-placeholder"]) {
        const val = flagVal(filtered, flag)
        if (val !== undefined) action[flag.replace(/^--/, "").replace(/-/g, "_")] = val
      }
      // flagVal reads an empty value as absent, which turned --options "" into the default set.
      if (filtered.includes("--options") && !String(action.options ?? "").trim()) throw new Error("notifications --options needs at least one option (alert, sound, badge, ...); nothing was requested")
      const nSeconds = flagInt(filtered, "--seconds"); if (nSeconds !== undefined) action.seconds = nSeconds
      const nBadge = flagInt(filtered, "--badge"); if (nBadge !== undefined) action.badge = nBadge
      const nCount = flagInt(filtered, "--count"); if (nCount !== undefined) action.count = nCount
      if (filtered.includes("--repeats")) action.repeats = true
      // sub-sub-verb on `categories` and `badge clear`
      const positional = filtered[3]?.startsWith("--") ? undefined : filtered[3]
      if (op === "categories") action.verb = positional ?? "list"
      if (op === "badge" && positional === "clear") action.clear = true
      else if (op === "badge" && positional) action.count = parseInt(positional)
      // identifier positional for cancel / dismiss
      if ((op === "cancel" || op === "dismiss") && positional) action.id = positional
      return action
    }

    // ── Clipboard ──
    case "clipboard": {
      const op = filtered[2] || "read"
      const text = op === "write" ? filtered[3] : undefined
      // Clipboard writes are text-only on every host; never write a flag name as the text.
      if (op === "write" && (text === undefined || text.startsWith("--"))) throw new Error("clipboard write requires the text to write; image writes are not supported")
      const limit = flagInt(filtered, "--limit", desktop)
      if (desktop && limit !== undefined && (limit < 0 || limit > 500)) throw new Error("clipboard --limit must be in 0..500")
      return {
        type: "macos_clipboard",
        sub: op,
        text,
        contentType: flagVal(filtered, "--type"),
        image: flagVal(filtered, "--image"),
        limit,
      }
    }

    // ── Display ──
    case "display": {
      const op = filtered[2] || "list"
      if (desktop && ["list", "info"].includes(op)) {
        if (op === "list") {
          if (filtered.length > 3) throw new Error("display list accepts no target or options")
          return {type: "macos_display_list"}
        }
        const value = flagVal(filtered, "--id") ?? filtered[3]
        if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new Error("display info requires a positive native display ID")
        const expected = filtered.includes("--id") ? 5 : 4
        if (filtered.length !== expected || (filtered.includes("--id") && filtered[3] !== "--id")) throw new Error("display info accepts one native ID or --id ID")
        return {type: "macos_display_info", id: Number(value)}
      }
      const resolution = filtered[3]
      if (op === "move-window") {
        // move-window <windowId> <displayId>: the bridge needs both native ids.
        const windowId = Number(flagVal(filtered, "--window") ?? filtered[3]), displayId = Number(flagVal(filtered, "--display") ?? filtered[4])
        if (!Number.isSafeInteger(windowId) || windowId <= 0 || !Number.isSafeInteger(displayId) || displayId <= 0) throw new Error("display move-window requires a native window id and a display id")
        return { type: "macos_display", sub: op, windowId, displayId }
      }
      return {
        type: "macos_display",
        sub: op,
        resolution,
        id: flagVal(filtered, "--id") || filtered[3],
        hidpi: filtered.includes("--hidpi"),
        hz: flagInt(filtered, "--hz"),
      }
    }

    // ── Audio ──
    case "audio": {
      // Spec 5 / Spec 5: bare `interceptor macos audio`
      // previously defaulted to channel="output" + op="start" — silently
      // starting capture as a side effect of asking for help. Require both
      // explicitly so the no-arg invocation prints usage instead.
      const channel = filtered[2]
      const op = filtered[3]
      if (!channel || !op) throw new Error("audio requires <input|output|both> <start|stop|level|devices>")
      const seen=new Set<string>()
      for(let i=4;i<filtered.length;i++){
        const flag=filtered[i]
        if(!['--app','--device','--save'].includes(flag)||seen.has(flag))throw new Error('audio accepts unique --app, --device and --save options')
        seen.add(flag)
        if(flag!=='--save'&&(!filtered[++i]||filtered[i].startsWith('--')))throw new Error(`${flag} requires a value`)
      }
      const action:Action = {
        type: "macos_audio",
        sub: channel,
        op,
        app: flagVal(filtered, "--app"),
        device: flagVal(filtered, "--device"),
        save: filtered.includes("--save"),
      }
      const error=desktopAudioActionError(desktopAction(action));if(error)throw new Error(error)
      return action
    }

    // ── Stream ──
    case "stream": {
        const flags=new Set(['--sid','--app','--window','--display','--virtual','--format','--input-type','--ref','--x','--y','--text','--combo','--direction','--amount','--record-audio'])
        const values=compoundPositionals(filtered,flags,new Set(['--media']))
        const action:Action={type:desktop?'desktop_stream':'macos_stream',op:values[0]??'status'}
        if(action.op==='record')action.recordOp=values[1]??'status'
        else if(action.op==='inject')action.inputType=values[1]??flagVal(filtered,'--input-type')??'click'
        const position=action.op==='record'||action.op==='inject'?values[2]:values[1]
        if(position!==undefined){if(filtered.includes('--sid'))throw new Error('stream session identity has conflicting positional and named values');action.sid=position}
        if(values.length>(action.op==='record'||action.op==='inject'?3:2))throw new Error('stream operation has extra positional values')
        for(const key of ['sid','app','virtual','format','ref','text','combo','direction']){const value=flagVal(filtered,'--'+key);if(value!==undefined)action[key]=value}
        for(const key of ['window','display','amount'])if(filtered.includes('--'+key))action[key]=flagInt(filtered,'--'+key,true)
        for(const key of ['x','y'])if(filtered.includes('--'+key)){const value=flagVal(filtered,'--'+key);if(value===undefined||!value.trim()||!Number.isFinite(Number(value)))throw new Error('stream coordinates require finite numbers');action[key]=Number(value)}
        if(filtered.includes('--input-type')){const kind=flagVal(filtered,'--input-type');if(values[1]!==undefined&&action.op==='inject'&&values[1]!==kind)throw new Error('stream input type has conflicting values');action.inputType=kind}
        if(filtered.includes('--media'))action.media=true
        const audio=flagVal(filtered,'--record-audio');if(audio!==undefined)action.recordAudio=audio
        const canonical:Action={...action,type:'desktop_stream'}
        if(!desktop&&canonical.display===0)canonical.display=1 // Legacy macOS uses a zero-based display ordinal.
        const error=desktopStreamActionError(canonical);if(error)throw new Error(error)
        return action
    }

    // ── Monitor ──
    // Full surface for `interceptor macos monitor *`. The bridge
    // (interceptor-bridge/Sources/Domains/MonitorDomain.swift) reads the
    // forwarded fields off action[]: sub, sid, instruction, app/apps/allApps,
    // include[]/exclude[], frames, visionText, watchPath/watchPaths,
    // logPredicate, format, raw, limit. Field names here are stable wire-
    // format keys consumed by the Swift handler.
    case "monitor": {
      const op = filtered[2] || "status"
      if(desktop){
        const values=new Set(['--sid','--app','--apps','--include','--exclude','--frames','--frame-format','--frame-quality','--frame-max-long-edge','--watch-path','--watch-paths','--log-predicate','--speech-mode','--video-max-mb','--frame-budget','--frame-disk-cap','--frame-pixel-scale','--scroll-coalesce-ms','--ax-coalesce-ms','--exclude-app','--instruction','--limit','--task','--mode','--retention-policy','--guard-policy','--verifier-policy'])
        const switches=new Set(['--all-apps','--vision-text','--tap','--include-system-apps','--json','--plan','--raw']),repeatable=new Set(['--apps','--include','--exclude','--watch-paths','--exclude-app']),seen=new Set<string>(),positions:string[]=[]
        for(let i=3;i<filtered.length;i++){
          const key=filtered[i]
          if(!key.startsWith('--')){positions.push(key);continue}
          if(!values.has(key)&&!switches.has(key)&&key!=='--video'||seen.has(key)&&!repeatable.has(key))throw new Error(`invalid or repeated monitor flag: ${key}`)
          seen.add(key)
          if(values.has(key)){if(!filtered[++i]||filtered[i].startsWith('--'))throw new Error(`${key} requires a value`)}
          else if(key==='--video'&&filtered[i+1]&&!filtered[i+1].startsWith('--')){if(!/^\d+$/.test(filtered[++i]))throw new Error('--video requires an integer fps')}
        }
        if(positions.length>(op==='export'&&!seen.has('--sid')?1:0))throw new Error('monitor accepts a positional session identifier only for export')
        if([...['--json','--plan','--raw']].filter(key=>seen.has(key)).length>1)throw new Error('monitor export requires one output format')
        if(op==='tail'&&seen.has('--plan'))throw new Error('monitor tail has no --plan; use monitor export <sid> --plan')
        if(seen.has('--raw')&&!['tail','export'].includes(op))throw new Error('--raw applies to monitor tail and export')
        if(['--mode','--retention-policy','--guard-policy','--verifier-policy'].some(key=>seen.has(key))&&!seen.has('--task'))throw new Error('monitor task policy/mode options require --task')
      }
      const sid = flagVal(filtered, "--sid")
      if (filtered.includes("--sid") && (!sid || sid.startsWith("--") || filtered.filter(value => value === "--sid").length !== 1)) {
        throw new Error("monitor requires one nonempty --sid value")
      }
      // Scope flags.
      const appFlag = flagVal(filtered, "--app")
      const appsRaw = collectMulti(filtered, "--apps")
      const apps = appsRaw.length > 0
        ? appsRaw.flatMap((s) => s.split(",")).map((s) => s.trim()).filter((s) => s.length > 0)
        : undefined
      const allApps = filtered.includes("--all-apps")
      // Include / exclude sets (comma-separated or repeated).
      const includesRaw = collectMulti(filtered, "--include")
      const include = includesRaw.length > 0
        ? includesRaw.flatMap((s) => s.split(",")).map((s) => s.trim()).filter((s) => s.length > 0)
        : undefined
      const excludesRaw = collectMulti(filtered, "--exclude")
      const exclude = excludesRaw.length > 0
        ? excludesRaw.flatMap((s) => s.split(",")).map((s) => s.trim()).filter((s) => s.length > 0)
        : undefined
      // Co-recording knobs.
      const frames = flagInt(filtered, "--frames", desktop)
      const visionText = filtered.includes("--vision-text")
      // Frame-encoding knobs. Default jpeg q=80 mirrors CaptureDomain
      // (interceptor-bridge/Sources/Domains/CaptureDomain.swift:84-86).
      const frameFormat = flagVal(filtered, "--frame-format")
      const frameQuality = flagInt(filtered, "--frame-quality", desktop)
      const frameMaxLongEdge = flagInt(filtered, "--frame-max-long-edge", desktop)
      // CGEventTap fallback opt-in.
      const tap = filtered.includes("--tap")
      // File-watch paths.
      const watchPath = flagVal(filtered, "--watch-path")
      const watchPathsRaw = collectMulti(filtered, "--watch-paths")
      const watchPaths = watchPathsRaw.length > 0
        ? watchPathsRaw.flatMap((s) => s.split(",")).map((s) => s.trim()).filter((s) => s.length > 0)
        : undefined
      // Log-predicate override.
      const logPredicate = flagVal(filtered, "--log-predicate")

      // new capture knobs.
      const speechMode = flagVal(filtered, "--speech-mode")
      // --video takes an optional fps (defaults to 4 when bare).
      const videoIdx = filtered.indexOf("--video")
      let video: number | undefined
      if (videoIdx !== -1) {
        const next = filtered[videoIdx + 1]
        video = next && /^\d+$/.test(next) ? parseInt(next) : 4
      }
      const videoMaxMb = flagInt(filtered, "--video-max-mb", desktop)
      const frameBudget = flagInt(filtered, "--frame-budget", desktop)
      const frameDiskCapMb = flagInt(filtered, "--frame-disk-cap", desktop)
      const framePixelScale = flagInt(filtered, "--frame-pixel-scale", desktop)
      const scrollCoalesceMs = flagInt(filtered, "--scroll-coalesce-ms", desktop)
      const axCoalesceMs = flagInt(filtered, "--ax-coalesce-ms", desktop)
      const includeSystemApps = filtered.includes("--include-system-apps")
      const excludeAppsRaw = collectMulti(filtered, "--exclude-app")
      const excludeApps = excludeAppsRaw.length > 0
        ? excludeAppsRaw.flatMap((s) => s.split(",")).map((s) => s.trim()).filter((s) => s.length > 0)
        : undefined

      const action: Action = {
        type: "macos_monitor",
        sub: op,
        sid: sid ?? (op === "export" ? filtered[3] : undefined),
        instruction: flagVal(filtered, "--instruction"),
        format: filtered.includes("--json") || filtered.includes("--raw") ? "json" : filtered.includes("--plan") ? "plan" : "timeline",
        raw: filtered.includes("--raw"),
        limit: flagInt(filtered, "--limit", true),
      }
      const taskRef = flagVal(filtered, "--task")
      if (taskRef) {
        action.taskRef = taskRef
        if (op === "start" && !action.instruction) action.instruction = taskRef
        if (op === "start") action.taskMode = validateMonitorTaskMode(flagVal(filtered, "--mode"))
        const retentionPolicyId = flagVal(filtered, "--retention-policy")
        const guardPolicyId = flagVal(filtered, "--guard-policy")
        const verifierPolicyId = flagVal(filtered, "--verifier-policy")
        if (retentionPolicyId) action.retentionPolicyId = retentionPolicyId
        if (guardPolicyId) action.guardPolicyId = guardPolicyId
        if (verifierPolicyId) action.verifierPolicyId = verifierPolicyId
      }
      if (appFlag) action.app = appFlag
      if (apps) action.apps = apps
      if (allApps) action.allApps = true
      if (include) action.include = include
      if (exclude) action.exclude = exclude
      if (typeof frames === "number") action.frames = frames
      if (visionText) action.visionText = true
      if (frameFormat) action.frameFormat = frameFormat
      if (typeof frameQuality === "number") action.frameQuality = frameQuality
      if (typeof frameMaxLongEdge === "number") action.frameMaxLongEdge = frameMaxLongEdge
      if (tap) action.tap = true
      if (watchPath) action.watchPath = watchPath
      if (watchPaths) action.watchPaths = watchPaths
      if (logPredicate) action.logPredicate = logPredicate
      // capture knobs (MB flags converted to bytes for the bridge).
      if (speechMode) action.speechMode = speechMode
      if (typeof video === "number") action.video = video
      if (typeof videoMaxMb === "number") action.videoMaxBytes = videoMaxMb * 1024 * 1024
      if (typeof frameBudget === "number") action.frameBudget = frameBudget
      if (typeof frameDiskCapMb === "number") action.frameDiskCap = frameDiskCapMb * 1024 * 1024
      if (typeof framePixelScale === "number") action.framePixelScale = framePixelScale
      if (typeof scrollCoalesceMs === "number") action.scrollCoalesceMs = scrollCoalesceMs
      if (typeof axCoalesceMs === "number") action.axCoalesceMs = axCoalesceMs
      if (includeSystemApps) action.includeSystemApps = true
      if (excludeApps) action.excludeApps = excludeApps
      const canonical = Object.fromEntries(Object.entries(desktopAction(action)).filter(([,value])=>value!==undefined))
      const error = desktop ? desktopMonitorActionError(canonical) : desktopMonitorArchiveError(canonical)
      if (error) throw new Error(error)
      return action
    }

    // ── Compound Commands ──
    case "open": {
      if (desktop) {
        if (filtered.filter(value => value === "--activate").length > 1) throw new Error("repeated --activate flag")
        const values = compoundPositionals(filtered.filter(value => value !== "--activate"), new Set(["--app", "--pid", "--filter", "--depth"]))
        const app = flagVal(filtered, "--app")
        if (values.length > 1 || (values.length && app !== undefined)) throw new Error("open accepts one app name or --app, with optional --pid")
        return { type: "macos_open", app: app ?? values[0], pid: flagInt(filtered, "--pid", true), activate: filtered.includes("--activate"), filter: flagVal(filtered, "--filter") ?? "interactive", depth: flagInt(filtered, "--depth", true) ?? 10 }
      }
      const appName = filtered[2] || flagVal(filtered, "--app")
      // Background-first by default; --activate is the
      // explicit opt-in for "bring this app to the foreground."
      const activate = filtered.includes("--activate")
      return {
        type: "macos_compound",
        sub: "open",
        app: appName,
        pid: flagInt(filtered, "--pid"),
        filter: flagVal(filtered, "--filter") || "interactive",
        depth: flagInt(filtered, "--depth") || 10,
        activate,
      }
    }

    case "read": {
      if (desktop) {
        if (compoundPositionals(filtered, new Set(["--app", "--pid", "--filter", "--depth"])).length) throw new Error("read accepts only target and tree flags")
        return { type: "macos_read", app: flagVal(filtered, "--app"), pid: flagInt(filtered, "--pid", true), filter: flagVal(filtered, "--filter") ?? "interactive", depth: flagInt(filtered, "--depth", true) ?? 10 }
      }
      return {
        type: "macos_compound",
        sub: "read",
        app: flagVal(filtered, "--app"),
        pid: flagInt(filtered, "--pid"),
        filter: flagVal(filtered, "--filter") || "interactive",
        depth: flagInt(filtered, "--depth") || 10,
      }
    }

    case "act": {
      if (desktop) {
        const values = compoundPositionals(filtered, new Set(["--app", "--pid"]))
        if (values.length < 1 || values.length > 2) throw new Error("act requires a ref and optional text")
        return { type: "macos_act", ref: values[0], text: values[1], app: flagVal(filtered, "--app"), pid: flagInt(filtered, "--pid", true) }
      }
      const target = filtered[2]
      if (!target) { console.error("error: interceptor macos act requires a ref"); process.exit(1) }
      const text = filtered[3]
      return {
        type: "macos_compound",
        sub: "act",
        ref: target,
        text,
        app: flagVal(filtered, "--app"),
        pid: flagInt(filtered, "--pid"),
      }
    }

    // ── Filesystem (FsDomain) ──
    case "fs": {
      const fsSub = filtered[2]
      if (!fsSub) {
        console.error("error: interceptor macos fs requires a subcommand: read | write | search")
        process.exit(1)
      }
      switch (fsSub) {
        case "read": {
          const path = filtered[3]
          if (!path) { console.error("error: interceptor macos fs read requires a path"); process.exit(1) }
          const action: Action = {
            type: "macos_fs_read",
            path,
            encoding: flagVal(filtered, "--encoding") || "utf8",
          }
          const range = flagVal(filtered, "--byte-range")
          if (desktop && filtered.includes("--byte-range") && range === undefined) throw new Error("--byte-range requires START,LENGTH")
          if (range) {
            const values = range.split(",")
            if (desktop && (values.length !== 2 || !values.every(v => /^-?\d+$/.test(v.trim()) && Number.isSafeInteger(Number(v))))) {
              throw new Error("--byte-range requires two safe integers")
            }
            const [s, l] = values.map((v) => desktop ? Number(v) : parseInt(v, 10))
            if (!isNaN(s) && !isNaN(l)) action.byteRange = { start: s, length: l }
          }
          return action
        }
        case "write": {
          const path = filtered[3]
          if (!path) { console.error("error: interceptor macos fs write requires a path"); process.exit(1) }
          const action: Action = { type: "macos_fs_write", path }
          const content = flagVal(filtered, "--content")
          const base64 = flagVal(filtered, "--base64")
          // Both would silently keep only one of them.
          if (content !== undefined && base64 !== undefined) throw new Error("fs write takes --content or --base64, not both; nothing was written")
          if (content !== undefined) action.content = content
          if (base64 !== undefined) { action.content = base64; action.encoding = "base64" }
          if (filtered.includes("--append")) action.append = true
          return action
        }
        case "search": {
          const query = filtered[3]
          if (!query) { console.error("error: interceptor macos fs search requires a query"); process.exit(1) }
          const action: Action = {
            type: "macos_fs_search",
            query,
            scope: flagVal(filtered, "--scope"),
            limit: desktop ? flagInt(filtered, "--limit", true) ?? 50 : flagInt(filtered, "--limit") || 50,
            // Spotlight deadline (default 10 s in the bridge). The result carries
            // partial:true when the deadline cut a pass; the CLI transport
            // timeout for this verb is derived from it (cli/transport.ts).
            timeoutMs: flagInt(filtered, "--timeout-ms", desktop),
          }
          // --paths /a,/b,/c — multi-root search (only valid with --scope path).
          // Repeating --paths is also accepted; entries are concatenated.
          const pathsRaw = collectMulti(filtered, "--paths")
          if (pathsRaw.length > 0) {
            action.paths = pathsRaw.flatMap((s) => s.split(",")).map((s) => s.trim()).filter((s) => s.length > 0)
          }
          // --kinds public.folder,file — additive kind filter.
          const kindsRaw = collectMulti(filtered, "--kinds")
          if (kindsRaw.length > 0) {
            action.kinds = kindsRaw.flatMap((s) => s.split(",")).map((s) => s.trim()).filter((s) => s.length > 0)
          }
          // --cwd /path — root for "cwd"/"workspace" scopes. If absent and the
          // user passed scope=cwd/workspace, default to the CLI's working dir
          // so the bridge sees something meaningful instead of falling back to home.
          const cwdFlag = flagVal(filtered, "--cwd")
          if (cwdFlag !== undefined) {
            action.cwd = cwdFlag
          } else if (action.scope === "cwd" || action.scope === "workspace") {
            action.cwd = process.cwd()
          }
          return action
        }
        default:
          console.error(`error: unknown 'fs' subcommand '${fsSub}'. Use: read | write | search`)
          process.exit(1)
      }
    }

    // ── URL fetch (NetDomain) ──
    case "url": {
      const urlSub = filtered[2]
      if(desktop&&!['get','post'].includes(urlSub))throw new Error('url requires get or post')
      if (!urlSub) {
        console.error("error: interceptor macos url requires a subcommand: get | post")
        process.exit(1)
      }
      const target = filtered[3]
      if(desktop&&(!target||target.startsWith('--')))throw new Error('url requires an absolute HTTP(S) URL')
      if (!target) { console.error(`error: interceptor macos url ${urlSub} requires a URL`); process.exit(1) }
      const headers: Record<string, string> = {}
      // Collect every --header "K: V" pair
      for (let i = 0; i < filtered.length - 1; i++) {
        if (filtered[i] === "--header" || filtered[i] === "-H") {
          const raw = filtered[i + 1]
          const m = /^([^:]+):\s*(.*)$/.exec(raw)
          if (m) {
            if(desktop&&Object.keys(headers).some(key=>key.toLowerCase()===m[1].trim().toLowerCase()))throw new Error('HTTP header names must be unique without regard to case')
            headers[m[1].trim()] = m[2]
          } else if(desktop)throw new Error('HTTP --header requires a name: value pair')
        }
      }
      const action: Action = {
        type: "macos_url_fetch",
        url: target,
        method: urlSub === "post" ? "POST" : (flagVal(filtered, "--method") || "GET").toUpperCase(),
        headers,
        timeoutMs: desktop?(flagInt(filtered,"--timeout",true)??30000):(flagInt(filtered,"--timeout")||30000),
      }
      const body = flagVal(filtered, "--body")
      if (body !== undefined) action.body = body
      const ct = flagVal(filtered, "--content-type")
      if (ct) (action.headers as Record<string, string>)["Content-Type"] = ct
      if(desktop){const error=desktopHttpActionError(desktopAction(action));if(error)throw new Error(error)}
      return action
    }

    // ── Log query (LogDomain) ──
    case "log": {
      const logSub = filtered[2]
      if (logSub !== "query") {
        if(desktop)throw new Error("log requires the 'query' subcommand")
        console.error("error: interceptor macos log requires the 'query' subcommand")
        process.exit(1)
      }
      if(desktop){
        for(const flag of ['--include-info','--include-debug'])if(filtered.filter(value=>value===flag).length>1)throw new Error(`repeated flag: ${flag}`)
        const values=compoundPositionals(filtered.filter(value=>!['--include-info','--include-debug'].includes(value)),new Set(['--predicate','--subsystem','--category','--since','--limit']))
        if(values.length!==1||values[0]!=='query')throw new Error('log query accepts only named options')
        if(filtered.includes('--predicate')&&(filtered.includes('--subsystem')||filtered.includes('--category')))throw new Error('log predicate cannot be combined with subsystem/category shortcuts')
      }
      let predicate = flagVal(filtered, "--predicate")
      const subsystem = flagVal(filtered, "--subsystem")
      const category = flagVal(filtered, "--category")
      // Build a predicate from --subsystem / --category if no explicit one
      if (!predicate) {
        const parts: string[] = []
        if (subsystem) parts.push(`subsystem == ${desktop?JSON.stringify(subsystem):`"${subsystem}"`}`)
        if (category) parts.push(`category == ${desktop?JSON.stringify(category):`"${category}"`}`)
        if (parts.length) predicate = parts.join(" AND ")
      }
      const action:Action={
        type: "macos_log_query",
        predicate,
        since: flagVal(filtered, "--since"),
        limit: desktop?(flagInt(filtered,"--limit",true)??100):(flagInt(filtered, "--limit") || 100),
        includeInfo: filtered.includes("--include-info"),
        includeDebug: filtered.includes("--include-debug"),
      }
      if(desktop){
        for(const key of ['predicate','since'])if(action[key]===undefined)delete action[key]
        const error=desktopLogActionError(desktopAction(action));if(error)throw new Error(error)
      }
      return action
    }

    // ── Apple Events / OSA scripts ──
    case "script": {
      const scriptSub = filtered[2]
      if (!scriptSub) {
        console.error("error: interceptor macos script requires a subcommand: run")
        process.exit(1)
      }
      switch (scriptSub) {
        case "run":
          return parseScriptRunAction(filtered, desktop?"desktop_script_run":"macos_script_run",{desktop})
        default:
          console.error(`error: unknown macos script subcommand '${scriptSub}'. Expected: run`)
          process.exit(1)
      }
    }

    // ── legacy structured Apple Events verb dispatch ──
    case "intent": {
      const intentSub = filtered[2]
      if (!intentSub) {
        console.error("error: interceptor macos intent requires a subcommand: dispatch | warmup")
        process.exit(1)
      }
      switch (intentSub) {
        case "dispatch": {
          return parseScriptRunAction(filtered, desktop?"desktop_intent_dispatch":"macos_intent_dispatch", { allowStructuredIntent: true,desktop })
        }
        case "warmup": {
          const bundleIds = filtered.slice(3).filter((s) => !s.startsWith("--"))
          if (bundleIds.length === 0) {
            console.error("error: interceptor macos intent warmup requires one or more bundle ids")
            process.exit(1)
          }
          return { type: "macos_intent_warmup", bundleIds }
        }
        default:
          console.error(`error: unknown 'intent' subcommand '${intentSub}'. Use: dispatch | warmup`)
          process.exit(1)
      }
    }

    // ── VM management (VmDomain) — ──
    case "vm": {
      if(desktop){
        const sub=(filtered[2]==='tcc'&&filtered[3]==='profile'&&filtered[4]==='generate'?'tcc_profile_generate':filtered[2]??'').replaceAll('-','_'),fields=DESKTOP_VM_FIELDS[sub]
        if(!fields)throw new Error('desktop vm requires a known subcommand')
        const action:Action={type:'desktop_vm',sub},positionals:string[]=[],seen=new Set<string>()
        const aliases:Record<string,string>={'state-dir':'stateDir',memory:'memorySize',disk:'diskSize','image-format':'imageFormat','source-path':'sourcePath','install-agent':'installAgent','wait-for-agent':'waitForAgent','wait-for-vsock':'waitForVsock','keep-disk':'keepDisk','from-latest':'fromLatest','disk-only':'diskOnly','paused-state':'pausedStateOnly','max-depth':'max_depth','max-bytes':'maxBytes',op:'snapshotOp','host-address':'hostAddress','host-port':'hostPort','guest-port':'guestPort','no-prompt':'noPrompt','accessibility-prompt':'accessibilityPrompt','screen-prompt':'screenPrompt','reset-denied':'resetDenied','bundle-id':'bundleId','app-path':'appPath','identifier-type':'identifierType','code-requirement':'codeRequirement','full-disk':'fullDisk','include-user-only':'includeUserOnly',service:'services'}
        const booleans=new Set(['rosetta','installAgent','waitForAgent','waitForVsock','headless','detach','force','keepDisk','fromLatest','diskOnly','pausedStateOnly','tty','noPrompt','prompt','walkthrough','accessibilityPrompt','screenPrompt','resetDenied','fullDisk','includeUserOnly'])
        const numbers=new Set(['cpu','memorySize','diskSize','timeout','max_depth','maxBytes','limit','hostPort','guestPort','x','y'])
        for(let i=filtered[2]==='tcc'?5:3;i<filtered.length;i++){
          const raw=filtered[i];if(raw==='--json')continue
          if(raw==='--'){if(sub!=='exec'||positionals.length!==1)throw new Error('VM exact argv requires exec <name> -- <argv>');action.command=filtered.slice(i+1);break}
          if(!raw.startsWith('--')){positionals.push(raw);continue}
          const key=aliases[raw.slice(2)]??raw.slice(2)
          if(key!=='stateDir'&&!(sub==='adopt'&&key==='name')&&!fields.includes(key)&&!(sub==='create'&&key==='share')&&!(sub==='share'&&key==='rw'))throw new Error('unknown VM option '+raw)
          if(seen.has(key)&&!['env','share','services'].includes(key))throw new Error('duplicate VM option '+raw);seen.add(key)
          if(booleans.has(key)){action[key]=true;continue}
          if(key==='rw'){action.readOnly=false;continue}
          const value=filtered[++i];if(value===undefined)throw new Error(raw+' requires a value')
          if(numbers.has(key)){if(!/^[0-9]+(?:\.[0-9]+)?$/.test(value))throw new Error(raw+' requires a number');action[key]=Number(value)}
          else if(key==='env'){const at=value.indexOf('=');if(at<1)throw new Error('--env requires KEY=value');const env=(action.env??={}) as Record<string,string>,name=value.slice(0,at);if(Object.hasOwn(env,name))throw new Error('duplicate VM environment key');Object.defineProperty(env,name,{value:value.slice(at+1),enumerable:true,writable:true})}
          else if(key==='share'){const m=/^(.+?):([^:]+?)(?::(ro|rw))?$/.exec(value);if(!m)throw new Error('--share requires host:tag[:ro|rw]');const shares=(action.shares??=[]) as unknown[];shares.push({hostPath:m[1],tag:m[2],readOnly:m[3]!=='rw'})}
          else if(key==='services'){const services=(action.services??=[]) as string[];services.push(...value.split(','))}
          else action[key]=value
        }
        const positionalFields=sub==='clone'||sub==='cp'?['src','dst']:sub==='adopt'?['sourcePath']:sub==='pull'?['image']:sub==='list'?[]:sub==='snapshot'&&action.snapshotOp==='list'?['name']:sub==='snapshot'||sub==='restore'?['name','tag']:sub==='mount'?['name','tag','path']:sub==='share'?['name','hostPath','tag']:sub==='type'?['name','text']:sub==='keys'?['name','keys']:sub==='click'&&positionals.length===2?['name','point']:['name']
        if(sub==='exec'&&action.command===undefined&&positionals.length>1){action.command=positionals.slice(1);positionals.splice(1)}
        if(sub==='port_forward'&&positionals.length===2){const parts=positionals.pop()!.split(':');if(parts.length<2||parts.length>3)throw new Error('VM forward requires [127.0.0.1:]hostPort:guestPort');action.hostPort=Number(parts.at(-2));action.guestPort=Number(parts.at(-1));if(parts.length===3)action.hostAddress=parts[0]}
        if(positionals.length!==positionalFields.length)throw new Error('wrong VM positional arguments')
        for(let i=0;i<positionalFields.length;i++){const key=positionalFields[i];if(key==='point'){const p=positionals[i].split(',');if(p.length!==2||p.some(x=>!x.length))throw new Error('VM click requires x,y');if(action.x!==undefined||action.y!==undefined)throw new Error('duplicate VM coordinates');action.x=Number(p[0]);action.y=Number(p[1])}else{if(action[key]!==undefined)throw new Error('duplicate VM '+key);action[key]=positionals[i]}}
        const error=desktopVmActionError(action);if(error)throw new Error(error);return action
      }
      const vmSub = filtered[2]
      if (!vmSub) {
        console.error("error: interceptor macos vm requires a subcommand: create | adopt | clone | install | pull | list | get | inspect | start | stop | pause | resume | delete | reset | snapshot | restore | exec | cp | share | mount | port-forward | screenshot | type | click | keys | read-ax | console | logs | trust | tcc")
        process.exit(1)
      }
      const stateDir = flagVal(filtered, "--state-dir")
      const base: Action = { type: `macos_vm_${vmSub.replace(/-/g, "_")}`, sub: vmSub }
      if (stateDir) base.stateDir = stateDir

      const intArg = (flag: string): number | undefined => flagInt(filtered, flag) ?? undefined
      const strArg = (flag: string): string | undefined => flagVal(filtered, flag) ?? undefined
      const boolArg = (flag: string): boolean => filtered.includes(flag)

      switch (vmSub) {
        case "create": {
          const name = filtered[3]
          if (!name) { console.error("error: interceptor macos vm create requires a name"); process.exit(1) }
          base.name = name
          const kind = strArg("--kind") || "linux"
          base.kind = kind
          if (intArg("--cpu") !== undefined) base.cpu = intArg("--cpu")
          if (intArg("--memory") !== undefined) base.memorySize = intArg("--memory")
          if (intArg("--disk") !== undefined) base.diskSize = intArg("--disk")
          if (strArg("--image")) base.image = strArg("--image")
          if (strArg("--network")) base.network = strArg("--network")
          if (boolArg("--rosetta")) base.rosetta = true
          // --share src:tag[:ro|:rw], repeatable
          const shares: Array<{ hostPath: string; tag: string; readOnly: boolean }> = []
          for (let i = 0; i < filtered.length - 1; i++) {
            if (filtered[i] === "--share") {
              const parts = filtered[i + 1].split(":")
              if (parts.length >= 2) {
                shares.push({ hostPath: parts[0], tag: parts[1], readOnly: parts[2] !== "rw" })
              }
            }
          }
          if (shares.length > 0) base.shares = shares
          return base
        }
        case "adopt": {
          const sourcePath = filtered[3]
          if (!sourcePath) { console.error("error: interceptor macos vm adopt requires <path>"); process.exit(1) }
          base.sourcePath = sourcePath
          const name = strArg("--name")
          if (!name) { console.error("error: interceptor macos vm adopt requires --name <name>"); process.exit(1) }
          base.name = name
          base.kind = strArg("--kind") || "macos"
          base.provider = strArg("--provider") || "auto"
          base.mode = strArg("--mode") || "clone"
          if (boolArg("--install-agent")) base.installAgent = true
          if (boolArg("--wait-for-agent")) base.waitForAgent = true
          return base
        }
        case "clone": {
          const src = filtered[3]
          const dst = filtered[4]
          if (!src || !dst) { console.error("error: interceptor macos vm clone requires <src> <dst>"); process.exit(1) }
          base.src = src; base.dst = dst
          return base
        }
        case "install": {
          const name = filtered[3]
          if (!name) { console.error("error: interceptor macos vm install requires a name"); process.exit(1) }
          base.name = name
          if (strArg("--ipsw")) base.ipsw = strArg("--ipsw")
          if (boolArg("--from-latest")) base.fromLatest = true
          return base
        }
        case "pull": {
          const image = filtered[3]
          if (!image) { console.error("error: interceptor macos vm pull requires an image OCI ref"); process.exit(1) }
          base.image = image
          return base
        }
        case "list": {
          return base
        }
        case "get":
        case "inspect": {
          const name = filtered[3]
          if (!name) { console.error(`error: interceptor macos vm ${vmSub} requires a name`); process.exit(1) }
          base.name = name
          return base
        }
        case "start": {
          const name = filtered[3]
          if (!name) { console.error("error: interceptor macos vm start requires a name"); process.exit(1) }
          base.name = name
          if (boolArg("--headless")) base.headless = true
          if (boolArg("--wait-for-agent") || boolArg("--wait-for-vsock")) {
            base.waitForAgent = true
            base.waitForVsock = true
          }
          if (boolArg("--detach")) base.detach = true
          return base
        }
        case "stop": {
          const name = filtered[3]
          if (!name) { console.error("error: interceptor macos vm stop requires a name"); process.exit(1) }
          base.name = name
          if (boolArg("--force")) base.force = true
          if (intArg("--timeout") !== undefined) base.timeout = intArg("--timeout")
          return base
        }
        case "pause":
        case "resume":
        case "reset": {
          const name = filtered[3]
          if (!name) { console.error(`error: interceptor macos vm ${vmSub} requires a name`); process.exit(1) }
          base.name = name
          return base
        }
        case "delete": {
          const name = filtered[3]
          if (!name) { console.error("error: interceptor macos vm delete requires a name"); process.exit(1) }
          base.name = name
          if (boolArg("--force")) base.force = true
          if (boolArg("--keep-disk")) base.keepDisk = true
          return base
        }
        case "trust": {
          const name = filtered[3]
          if (!name) { console.error("error: interceptor macos vm trust requires a name"); process.exit(1) }
          base.name = name
          const noPrompt = boolArg("--no-prompt")
          base.noPrompt = noPrompt
          base.prompt = !noPrompt && (boolArg("--prompt") || boolArg("--walkthrough"))
          base.walkthrough = !noPrompt && boolArg("--walkthrough")
          base.accessibilityPrompt = !noPrompt && boolArg("--accessibility-prompt")
          base.screenPrompt = !noPrompt && boolArg("--screen-prompt")
          base.resetDenied = !noPrompt && boolArg("--reset-denied")
          if (intArg("--timeout") !== undefined) base.timeout = intArg("--timeout")
          return base
        }
        case "tcc": {
          const tccOp = filtered[3]
          if (tccOp !== "profile") {
            console.error("error: interceptor macos vm tcc requires subcommand: profile generate <name>")
            process.exit(1)
          }
          const profileOp = filtered[4]
          if (profileOp !== "generate") {
            console.error("error: interceptor macos vm tcc profile requires subcommand: generate <name>")
            process.exit(1)
          }
          const name = filtered[5]
          if (!name) { console.error("error: interceptor macos vm tcc profile generate requires a VM name"); process.exit(1) }
          base.type = "macos_vm_tcc_profile_generate"
          base.sub = "tcc_profile_generate"
          base.name = name
          const services = collectMulti(filtered, "--service").flatMap((s) => s.split(",").filter(Boolean))
          if (services.length > 0) base.services = services
          if (strArg("--out")) base.out = strArg("--out")
          if (strArg("--bundle-id")) base.bundleId = strArg("--bundle-id")
          if (strArg("--app-path")) base.appPath = strArg("--app-path")
          if (strArg("--identifier-type")) base.identifierType = strArg("--identifier-type")
          if (strArg("--code-requirement")) base.codeRequirement = strArg("--code-requirement")
          if (boolArg("--full-disk")) base.fullDisk = true
          if (boolArg("--include-user-only")) base.includeUserOnly = true
          return base
        }
        case "exec": {
          const name = filtered[3]
          if (!name) { console.error("error: interceptor macos vm exec requires <name> <cmd> [args...]"); process.exit(1) }
          base.name = name
          // Everything after the name and -- separator is the command argv
          const sepIdx = filtered.indexOf("--", 4)
          const argv = sepIdx >= 0 ? filtered.slice(sepIdx + 1) : filtered.slice(4).filter(a => !a.startsWith("--"))
          if (argv.length === 0) { console.error("error: interceptor macos vm exec requires a command"); process.exit(1) }
          base.command = argv
          if (strArg("--user")) base.user = strArg("--user")
          if (strArg("--workdir")) base.workdir = strArg("--workdir")
          if (boolArg("--tty")) base.tty = true
          if (intArg("--timeout") !== undefined) base.timeout = intArg("--timeout")
          // --env KEY=VAL repeatable
          const env: Record<string, string> = {}
          for (let i = 0; i < filtered.length - 1; i++) {
            if (filtered[i] === "--env") {
              const m = /^([^=]+)=(.*)$/.exec(filtered[i + 1])
              if (m) env[m[1]] = m[2]
            }
          }
          if (Object.keys(env).length > 0) base.env = env
          return base
        }
        case "snapshot": {
          const name = filtered[3]
          const tag = filtered[4]
          if (!name || !tag) { console.error("error: interceptor macos vm snapshot requires <name> <tag>"); process.exit(1) }
          base.name = name; base.tag = tag
          base.snapshotOp = strArg("--op") || "create"
          if (boolArg("--disk-only")) base.diskOnly = true
          if (boolArg("--paused-state")) base.pausedStateOnly = true
          return base
        }
        case "restore": {
          const name = filtered[3]
          const tag = filtered[4]
          if (!name || !tag) { console.error("error: interceptor macos vm restore requires <name> <tag>"); process.exit(1) }
          base.name = name; base.tag = tag
          if (boolArg("--disk-only")) base.diskOnly = true
          if (boolArg("--paused-state")) base.pausedStateOnly = true
          if (boolArg("--headless")) base.headless = true
          return base
        }
        case "cp": {
          const src = filtered[3]
          const dst = filtered[4]
          if (!src || !dst) { console.error("error: interceptor macos vm cp requires <src> <dst>"); process.exit(1) }
          base.src = src
          base.dst = dst
          base.name = desktopVmCopySelection(src,dst)?.name
          if (!base.name) { console.error("error: interceptor macos vm cp requires exactly one side as <vm>:<guest-path>"); process.exit(1) }
          if (intArg("--timeout") !== undefined) base.timeout = intArg("--timeout")
          return base
        }
        case "mount": {
          const name = filtered[3]
          const tag = filtered[4]
          const path = filtered[5]
          if (!name || !tag || !path) { console.error("error: interceptor macos vm mount requires <name> <tag> <guest-path>"); process.exit(1) }
          base.name = name
          base.tag = tag
          base.path = path
          if (intArg("--timeout") !== undefined) base.timeout = intArg("--timeout")
          return base
        }
        case "screenshot": {
          const name = filtered[3]
          if (!name) { console.error("error: interceptor macos vm screenshot requires <name>"); process.exit(1) }
          base.name = name
          if (strArg("--out")) base.out = strArg("--out")
          if (intArg("--timeout") !== undefined) base.timeout = intArg("--timeout")
          return base
        }
        case "type": {
          const name = filtered[3]
          const text = filtered[4]
          if (!name || text === undefined) { console.error("error: interceptor macos vm type requires <name> <text>"); process.exit(1) }
          base.name = name
          base.text = text
          if (intArg("--timeout") !== undefined) base.timeout = intArg("--timeout")
          return base
        }
        case "click": {
          const name = filtered[3]
          if (!name) { console.error("error: interceptor macos vm click requires <name> <x,y> or --x --y"); process.exit(1) }
          base.name = name
          const xy = filtered[4] && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(filtered[4]) ? filtered[4].split(",") : undefined
          const xRaw = strArg("--x") ?? xy?.[0]
          const yRaw = strArg("--y") ?? xy?.[1]
          const x = xRaw !== undefined ? Number(xRaw) : NaN
          const y = yRaw !== undefined ? Number(yRaw) : NaN
          if (!Number.isFinite(x) || !Number.isFinite(y)) { console.error("error: interceptor macos vm click requires numeric x/y"); process.exit(1) }
          base.x = x
          base.y = y
          if (strArg("--button")) base.button = strArg("--button")
          if (intArg("--timeout") !== undefined) base.timeout = intArg("--timeout")
          return base
        }
        case "keys": {
          const name = filtered[3]
          const keys = filtered[4]
          if (!name || !keys) { console.error("error: interceptor macos vm keys requires <name> <keys>"); process.exit(1) }
          base.name = name
          base.keys = keys
          if (intArg("--timeout") !== undefined) base.timeout = intArg("--timeout")
          return base
        }
        case "read-ax": {
          const name = filtered[3]
          if (!name) { console.error("error: interceptor macos vm read-ax requires <name>"); process.exit(1) }
          base.name = name
          if (intArg("--max-depth") !== undefined) base.max_depth = intArg("--max-depth")
          if (strArg("--app")) base.app = strArg("--app")
          if (intArg("--timeout") !== undefined) base.timeout = intArg("--timeout")
          return base
        }
        case "logs": {
          const name = filtered[3]
          if (!name) { console.error("error: interceptor macos vm logs requires <name>"); process.exit(1) }
          base.name = name
          if (intArg("--limit") !== undefined) base.limit = intArg("--limit")
          if (intArg("--timeout") !== undefined) base.timeout = intArg("--timeout")
          return base
        }
        case "share": {
          const name = filtered[3]
          const hostPath = filtered[4]
          const tag = filtered[5]
          if (!name || !hostPath || !tag) { console.error("error: interceptor macos vm share requires <name> <host-path> <tag>"); process.exit(1) }
          base.name = name
          base.hostPath = hostPath
          base.tag = tag
          base.readOnly = !boolArg("--rw")
          return base
        }
        case "port-forward":
        case "console": {
          const name = filtered[3]
          if (name) base.name = name
          const rule = filtered[4]
          if (vmSub === "port-forward" && rule) {
            const parts = rule.split(":")
            if (parts.length === 2) {
              base.hostPort = Number(parts[0])
              base.guestPort = Number(parts[1])
            } else if (parts.length === 3) {
              base.hostAddress = parts[0]
              base.hostPort = Number(parts[1])
              base.guestPort = Number(parts[2])
            }
          }
          if (vmSub === "console") {
            if (strArg("--write")) base.write = strArg("--write")
            if (intArg("--max-bytes") !== undefined) base.maxBytes = intArg("--max-bytes")
            if (intArg("--timeout") !== undefined) base.timeout = intArg("--timeout")
          }
          return base
        }
        default:
          console.error(`error: interceptor macos vm: unknown subcommand '${vmSub}'`)
          process.exit(1)
      }
    }

    // ── container_run (ContainerDomain) ──
    case "container": {
      if(desktop){
        if(filtered[2]!=='run'||!filtered[3])throw new Error('container run requires an image')
        const end=filtered.indexOf('--',4),options=filtered.slice(4,end<0?filtered.length:end)
        const action:Action={type:'macos_container_run',image:filtered[3],command:end<0?[]:filtered.slice(end+1),env:{},mounts:[]}
        const seen=new Set<string>()
        for(let i=0;i<options.length;i++){
          const key=options[i];if(key==='--json')continue
          if(!['--cmd','--env','--mount','--volume','-v','--network','--timeout','--max-output-bytes'].includes(key))throw new Error(`unknown container option ${key}`)
          const value=options[++i];if(value===undefined)throw new Error(`${key} requires a value`)
          if(!['--env','--mount','--volume','-v'].includes(key)&&seen.has(key))throw new Error(`duplicate container option ${key}`)
          seen.add(key)
          if(key==='--cmd'){if(end>=0)throw new Error('--cmd cannot be combined with exact argv');action.command=value.split(' ').filter(Boolean)}
          else if(key==='--env'){
            const at=value.indexOf('=');if(at<1)throw new Error('--env requires KEY=value')
            const env=action.env as Record<string,string>,name=value.slice(0,at);if(Object.hasOwn(env,name))throw new Error('duplicate container env key');Object.defineProperty(env,name,{value:value.slice(at+1),enumerable:true,writable:true})
          }else if(key==='--mount'){(action.mounts as unknown[]).push(JSON.parse(value))}
          else if(key==='--volume'||key==='-v'){
            const match=/^(.+):(\/[^:]*)(?::(ro|rw))?$/.exec(value)
            if(!match||!match[2].startsWith('/'))throw new Error('--volume requires host:/guest[:ro|rw]; use --mount JSON for ambiguous paths')
            ;(action.mounts as unknown[]).push({hostPath:match[1],mountPath:match[2],mode:match[3]??'ro'})
          }else if(key==='--network')action.network=value
          else{if(!/^\d+$/.test(value))throw new Error(`${key} requires an integer`);action[key==='--timeout'?'timeoutMs':'maxOutputBytes']=Number(value)}
        }
        const error=desktopContainerActionError(desktopAction(action));if(error)throw new Error(error)
        return action
      }
      const containerSub = filtered[2]
      if (containerSub !== "run") {
        console.error("error: interceptor macos container requires the 'run' subcommand")
        process.exit(1)
      }
      const image = filtered[3]
      if (!image) {
        console.error("error: interceptor macos container run requires an image (e.g. docker.io/library/alpine:3)")
        process.exit(1)
      }
      const cmd = flagVal(filtered, "--cmd")
      const command: string[] = cmd ? cmd.split(" ").filter(Boolean) : []
      const env: Record<string, string> = {}
      const mounts: Array<Record<string, unknown>> = []
      for (let i = 0; i < filtered.length - 1; i++) {
        if (filtered[i] === "--env") {
          const raw = filtered[i + 1]
          const m = /^([^=]+)=(.*)$/.exec(raw)
          if (m) env[m[1]] = m[2]
        }
        if (filtered[i] === "--volume" || filtered[i] === "-v") {
          const raw = filtered[i + 1]
          // host:container[:mode]
          const parts = raw.split(":")
          if (parts.length >= 2) {
            mounts.push({
              hostPath: parts[0],
              mountPath: parts[1],
              mode: parts[2] || "ro",
            })
          }
        }
      }
      return {
        type: "macos_container_run",
        image,
        command,
        network: flagVal(filtered, "--network") || "off",
        env,
        mounts,
        timeoutMs: flagInt(filtered, "--timeout") || 60000,
      }
    }

    // ── Overlays (OverlayDomain) ──
    case "overlay": {
      const overlaySub = filtered[2]
      if (!["start", "stop", "list", "status", "eval", "ctl", "verbs"].includes(overlaySub)) throw new Error("overlay requires start | stop | list | status | eval | ctl | verbs")
      const startFields: Record<string, string> = {
        "--id": "id", "--level": "level", "--particles": "particles", "--scene": "scene",
        "--scene-script": "scene_script", "--scene-script-file": "scene_script_file",
        "--url": "url", "--html-b64": "html_b64", "--html": "html",
        "--rect": "rect", "--anchor": "anchor", "--width": "width", "--height": "height",
        "--display-id": "display_id", "--emojis": "emojis", "--direction": "direction",
        "--density": "density", "--lifetime": "lifetime", "--velocity": "velocity", "--size-scale": "size_scale",
        "--timeout-seconds": "timeout_seconds", "--duration-ms": "duration_ms", "--duration": "duration"
      }
      const controlFields: Record<string, string[]> = {
        "set-density": ["value"], "set-direction": ["value"], "set-emojis": ["value"],
        "set-lifetime": ["value"], "set-velocity": ["value"], "set-scale": ["value"],
        burst: ["count"], pause: [], resume: [], reset: [], say: ["text"],
        round: ["n", "text"], punch: ["who", "emoji"], "breathe-fire": ["who", "emoji"],
        throw: ["who", "emoji"], taunt: ["who"], roar: ["who", "text"], bow: ["who"],
        jump: ["who", "height"], knockout: ["who"], tint: ["who", "color", "amount"],
        "append-ops": ["ops", "relative"], "append-script": ["json"], "clear-entities": [],
        spawn: ["entity"], despawn: ["id"], "face-track-start": ["fps"], "face-track-stop": []
      }
      const booleans: Record<string, string> = overlaySub === "start" ? {
        "--interactive": "interactive", "--no-interactive": "noInteractive", "--single-space": "single_space",
        "--no-fullscreen-aux": "no_fullscreen_aux", "--visible": "visible"
      } : {}
      const flags = overlaySub === "start" ? new Set(Object.keys(startFields))
        : overlaySub === "ctl" ? new Set(["--args", ...Object.values(controlFields).flat().map(key => "--" + key)])
        : overlaySub === "eval" ? new Set(["--timeout-seconds"]) : new Set<string>()
      const raw: Record<string, string> = {}
      const selectedBooleans = new Set<string>()
      const positionals: string[] = []
      for (let i = 3; i < filtered.length; i++) {
        const flag = filtered[i]
        if (!flag.startsWith("--")) { positionals.push(flag); continue }
        if (Object.hasOwn(booleans, flag)) {
          if (selectedBooleans.has(flag)) throw new Error("repeated overlay flag: " + flag)
          selectedBooleans.add(flag); continue
        }
        if (!flags.has(flag) || Object.hasOwn(raw, flag)) throw new Error("invalid or repeated overlay flag: " + flag)
        const value = filtered[++i]
        if (value === undefined || value.startsWith("--")) throw new Error(flag + " requires a value")
        raw[flag] = value
      }
      const action: Action = {type: "macos_overlay_" + overlaySub}
      switch (overlaySub) {
        case "start": {
          if (positionals.length) throw new Error("overlay start accepts named flags only")
          if (selectedBooleans.has("--interactive") && selectedBooleans.has("--no-interactive")) throw new Error("overlay interactive flags are exclusive")
          for (const flag of selectedBooleans) action[flag === "--no-interactive" ? "interactive" : booleans[flag]] = flag !== "--no-interactive"
          const numbers: Record<string, [number, number]> = {
            density: [0, 128], lifetime: [0.05, 60], velocity: [0, 4096], size_scale: [0.05, 8],
            width: [1, 16384], height: [1, 16384], display_id: [1, desktop ? Number.MAX_SAFE_INTEGER : 0xffffffff],
            timeout_seconds: [0.001, 86400], duration_ms: [1, 86400000], duration: [1, 86400000]
          }
          for (const [flag, value] of Object.entries(raw)) {
            const key = startFields[flag]
            if (numbers[key]) {
              const [low, high] = numbers[key], n = Number(value)
              if (value.trim() !== value || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(n) || n < low || n > high || (key === "display_id" && !Number.isInteger(n))) throw new Error("invalid bounded overlay " + flag)
              if (key === "duration_ms" || key === "duration") action.timeout_seconds = n / 1000
              else action[key] = n
            } else action[key] = value
          }
          if (["--timeout-seconds", "--duration-ms", "--duration"].filter(flag => Object.hasOwn(raw, flag)).length > 1) throw new Error("overlay duration flags are exclusive")
          const sources = ["--particles", "--scene", "--scene-script", "--scene-script-file", "--url", "--html", "--html-b64"].filter(flag => Object.hasOwn(raw, flag))
          if (sources.length !== 1) throw new Error("overlay start requires exactly one content source")
          if (action.html !== undefined) { action.html_b64 = Buffer.from(action.html as string, "utf8").toString("base64"); delete action.html }
          if (action.rect !== undefined) {
            const values = (action.rect as string).split(",")
            const nums = values.map(Number)
            if (values.length !== 4 || values.some(v => !v.trim()) || nums.some(n => !Number.isFinite(n)) || nums[2] < 1 || nums[3] < 1 || nums[2] > 16384 || nums[3] > 16384 || Math.abs(nums[0]) > 131072 || Math.abs(nums[1]) > 131072) throw new Error("--rect requires bounded x,y,width,height")
            action.rect = {x: nums[0], y: nums[1], width: nums[2], height: nums[3]}
            if (action.anchor !== undefined || action.width !== undefined || action.height !== undefined) throw new Error("overlay rect and anchor sizing are exclusive")
          }
          if (action.level !== undefined && !["statusBar", "mainMenu", "floating", "screenSaver"].includes(action.level as string)) throw new Error("unknown overlay level")
          if (action.scene !== undefined && action.scene !== "titans") throw new Error("unknown scene preset")
          if (action.particles !== undefined && !["roses", "hearts", "petals", "stars", "snow", "confetti", "titans", "fire", "beams", "custom"].includes(action.particles as string)) throw new Error("unknown particle preset")
          if (action.anchor !== undefined && !["tl", "tr", "bl", "br", "top", "bottom", "right", "left", "center"].includes(action.anchor as string)) throw new Error("unknown overlay anchor")
          if (action.anchor === undefined && action.rect === undefined && (action.width !== undefined || action.height !== undefined)) throw new Error("overlay width and height require an anchor")
          if (action.direction !== undefined && !["up", "down", "left", "right"].includes(action.direction as string)) throw new Error("unknown particle direction")
          if (!action.particles && ["emojis", "direction", "density", "lifetime", "velocity", "size_scale"].some(key => action[key] !== undefined)) throw new Error("particle parameters require particles mode")
          break
        }
        case "stop":
        case "status":
        case "verbs":
          if (positionals.length > 1) throw new Error("overlay selector takes at most one ID")
          if (positionals.length) action.id = positionals[0]
          break
        case "list":
          if (positionals.length) throw new Error("overlay list takes no arguments")
          break
        case "eval":
          if (positionals.length !== 2) throw new Error("overlay eval requires <id> <javascript>")
          action.id = positionals[0]; action.js = positionals[1]
          if (!action.js || Buffer.byteLength(action.js as string) > 32768) throw new Error("overlay JavaScript exceeds 32KiB")
          if (raw["--timeout-seconds"] !== undefined) {
            const n = Number(raw["--timeout-seconds"])
            if (!raw["--timeout-seconds"].trim() || !Number.isFinite(n) || n < 0.001 || n > 30) throw new Error("invalid overlay evaluation timeout")
            action.timeout_seconds = n
          }
          break
        case "ctl": {
          if (positionals.length !== 2) throw new Error("overlay ctl requires <id> <verb> [named args]")
          action.id = positionals[0]; action.verb = positionals[1]
          const fields = controlFields[positionals[1]]
          if (!fields) throw new Error("unknown overlay controller verb")
          const args: Record<string, unknown> = {}
          if (raw["--args"] !== undefined) {
            if (Object.keys(raw).length !== 1 || Buffer.byteLength(raw["--args"]) > 131072) throw new Error("--args requires one bounded JSON object")
            const json = JSON.parse(raw["--args"])
            if (!json || typeof json !== "object" || Array.isArray(json) || Object.keys(json).some(key => !fields.includes(key))) throw new Error("invalid overlay controller argument object")
            action.args = json
          } else {
            for (const [flag, value] of Object.entries(raw)) {
              const key = flag.slice(2)
              if (!fields.includes(key)) throw new Error("field does not belong to overlay controller verb")
              if (["ops", "json", "entity"].includes(key)) {
                if (Buffer.byteLength(value) > 131072) throw new Error("overlay control JSON exceeds 128KiB")
                args[key] = JSON.parse(value)
              } else if (key === "relative") {
                if (!["true", "false"].includes(value)) throw new Error("--relative requires true or false")
                args[key] = value === "true"
              } else if (["n", "height", "amount", "count", "fps"].includes(key) || (key === "value" && !["set-direction", "set-emojis"].includes(positionals[1]))) {
                const n = Number(value)
                if (!value.trim() || !Number.isFinite(n)) throw new Error("overlay control requires a finite number")
                args[key] = n
              } else args[key] = value
            }
            action.args = args
          }
          break
        }
      }
      if (action.id !== undefined && ((action.id as string).trim() !== action.id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(action.id as string))) throw new Error("overlay requires a safe bounded ID")
      if (Buffer.byteLength(JSON.stringify(action)) > 262144) throw new Error("overlay request exceeds 256KiB")
      const overlayError=desktopOverlayActionError(desktopAction(action));if(overlayError)throw new Error(overlayError)
      return action
    }

    // ── Personal data + distribution + document surfaces ──
    // Each branch maps `interceptor macos <domain> <verb> [...]` to a
    // `macos_<domain>` action with `sub` carrying the verb (invariant).

    case "pdf": {
      const verb = filtered[2]
      if(desktop){
        const selector=verb==='forms'&&filtered[3]==='set'?'forms_set':verb
        if(!Object.hasOwn(DESKTOP_PDF_FIELDS,selector??''))throw new Error('PDF requires a known operation')
        const names=DESKTOP_PDF_FIELDS[selector]
        const booleanFields=new Set(['attributed','case_sensitive'])
        const flag=(field:string)=>field==='annotation_type'?'--type':field==='case_sensitive'?'--case-sensitive':'--'+field
        compoundPositionals(filtered,new Set(names.filter(field=>!booleanFields.has(field)&&!['query','paths'].includes(field)).map(flag)),new Set(names.filter(field=>booleanFields.has(field)).map(flag)))
      }
      if (!verb) { console.error("error: pdf requires a verb (info|text|outline|annotations|forms|images|find|attributes|permissions|annotate|strip|merge|split)"); process.exit(1) }
      const action: Action = { type: "macos_pdf", sub: verb }
      if (verb === "merge") {
        const out = flagVal(filtered, "--out")
        const paths = collectPositionals(filtered, 3, new Set(["--out"]))
        if (!out || paths.length === 0) { console.error("error: pdf merge <path...> --out <out>"); process.exit(1) }
        action.paths = paths
        action.out = out
      } else if (verb === "forms") {
        const sub2 = filtered[3]
        if (sub2 === "set") {
          action.sub = "forms_set"
          const path = filtered[4]
          if (!path) { console.error("error: pdf forms set <path> --field <name> --value <string> [--out <out>]"); process.exit(1) }
          action.path = path
          action.field = flagVal(filtered, "--field")
          action.value = desktop && filtered.includes('--value') ? filtered[filtered.indexOf('--value')+1] : flagVal(filtered, "--value")
          action.out = flagVal(filtered, "--out")
        } else {
          const path = filtered[3]
          if (!path) { console.error("error: pdf forms <path>"); process.exit(1) }
          action.path = path
        }
      } else {
        const path = filtered[3]
        if (!path) { console.error(`error: pdf ${verb} requires <path>`); process.exit(1) }
        action.path = path
        const page = flagInt(filtered, "--page", desktop); if (page !== undefined) action.page = page
        const range = flagVal(filtered, "--range"); if (range) action.range = range
        if (filtered.includes("--attributed")) action.attributed = true
        if (filtered.includes("--case-sensitive")) action.case_sensitive = true
        const type = flagVal(filtered, "--type"); if (type) action.annotation_type = type
        if (verb === "find") action.query = filtered[4]
        if (verb === "annotate") {
          action.rect = flagVal(filtered, "--rect")
          action.contents = flagVal(filtered, "--contents")
          action.out = flagVal(filtered, "--out")
        }
        if (verb === "strip") action.out = flagVal(filtered, "--out")
        if (verb === "split") {
          action.pages = flagVal(filtered, "--pages")
          action.out = flagVal(filtered, "--out")
        }
      }
      if(desktop){
        const values=compoundPositionals(filtered,new Set(['--out','--field','--value','--page','--range','--type','--rect','--contents','--pages']),new Set(['--attributed','--case-sensitive']))
        const expected=verb==='merge'?undefined:verb==='forms'&&filtered[3]==='set'?3:verb==='find'?3:2
        if(expected!==undefined&&values.length!==expected)throw new Error('PDF command has missing or extra positional fields')
        const canonical=desktopAction(action),error=desktopPdfActionError(canonical);if(error)throw new Error(error)
        return canonical as Action
      }
      return action
    }

    case "detect": {
      const values=desktop?compoundPositionals(filtered,new Set(['--types'])):undefined
      const verb = filtered[2]
      if (!verb) { console.error("error: detect requires a verb (types|run|file|stdin)"); process.exit(1) }
      const action: Action = { type: "macos_detect", sub: verb }
      const operand = filtered.slice(3).find((value, i, rest) => !value.startsWith("--") && (i === 0 || rest[i - 1] !== "--types"))
      if (verb === "run") action.input = operand
      else if (verb === "file") action.path = operand
      else if (verb === "stdin") {
        // Bridge handler reads action["input"]; CLI must wrap stdin into it.
        action.input = stdinText ?? require("node:fs").readFileSync(0, "utf8")
      }
      const types = flagVal(filtered, "--types"); if (types) action.types = types
      if(desktop){
        if(values!.length!==(verb==='run'||verb==='file'?2:1))throw new Error('detect requires exactly the selected operation and input')
        const error=desktopLanguageActionError(desktopAction(action));if(error)throw new Error(error)
      }
      return action
    }

    case "translate": {
      if(desktop)compoundPositionals(filtered,new Set(['--from','--to','--sample','--json']))
      const verb = filtered[2]
      if (!verb) { console.error("error: translate requires a verb (status|languages|availability|prepare|text|batch|file|stop)"); process.exit(1) }
      const action: Action = { type: "macos_translate", sub: verb }
      const from = flagVal(filtered, "--from"); if (from) action.from = from
      const to = flagVal(filtered, "--to"); if (to) action.to = to
      const sample = flagVal(filtered, "--sample"); if (sample) action.sample = sample
      const json = flagVal(filtered, "--json"); if (json) action.json = json
      if (verb === "text") action.input = filtered[3]
      else if (verb === "file") action.path = filtered[3]
      if(desktop){
        const values=compoundPositionals(filtered,new Set(['--from','--to','--sample','--json']))
        if(values.length!==(['text','file'].includes(verb)?2:1))throw new Error('translation command has missing or extra positional fields')
        const error=desktopLanguageActionError(desktopAction(action));if(error)throw new Error(error)
      }
      return action
    }

    case "thumbnail": {
      if (desktop) {
        if (filtered.filter(value => value === '--save').length > 1) throw new Error('repeated flag: --save')
        const values = compoundPositionals(filtered.filter(value => value !== '--save'), new Set(['--size','--scale','--types','--format','--out']))
        const batch = values[0] === 'batch'
        if (!batch && values.length !== 1) throw new Error('thumbnail requires one path')
        const action: Action = {type:'macos_thumbnail', sub:batch?'batch':'generate'}
        if (batch) action.paths = values.slice(1); else action.path = values[0]
        for (const [flag,key] of [['--size','size'],['--types','types'],['--format','format'],['--out','out']]) {
          const value=flagVal(filtered,flag); if(value!==undefined) action[key]=value
        }
        const scale=flagInt(filtered,'--scale',true); if(scale!==undefined) action.scale=scale
        if(filtered.includes('--save'))action.save=true
        const error=desktopThumbnailActionError(desktopAction(action));if(error)throw new Error(error)
        return action
      }
      const verb = filtered[2] === "batch" ? "batch" : "generate"
      const action: Action = { type: "macos_thumbnail", sub: verb }
      if (verb === "batch") {
        const paths = collectPositionals(filtered, 3, new Set(["--size","--scale","--types","--format","--out"]))
        action.paths = paths
      } else {
        const path = filtered[2]
        if (!path) { console.error("error: thumbnail <path> [--size N] [--scale N] [--types ...] [--save] [--out <path>] [--format png|jpeg|heic]"); process.exit(1) }
        action.path = path
      }
      const size = flagVal(filtered, "--size"); if (size) action.size = size
      const scale = flagInt(filtered, "--scale"); if (scale !== undefined) action.scale = scale
      const types = flagVal(filtered, "--types"); if (types) action.types = types
      const format = flagVal(filtered, "--format"); if (format) action.format = format
      if (filtered.includes("--save")) action.save = true
      const out = flagVal(filtered, "--out"); if (out) action.out = out
      return action
    }

    // issue #244: the secret vault. Values never appear on argv: `register`
    // opens the bridge's native box, `set` reads stdin or a hidden prompt.
    case "secret": {
      if (desktop) {
        const verb = filtered[2]
        const storing = verb === "set" || verb === "register"
        const flags = new Set(storing ? ["--gate", "--reuse"] : verb === "unlock" ? ["--for"] : [])
        const options = filtered.slice(0, 2), targets: string[] = []
        let stdin = false
        for (let i = 2; i < filtered.length; i++) {
          const token = filtered[i]
          if (token === "--target" || token === "--stdin") {
            if (flags.has(filtered[i - 1])) throw new Error(`${filtered[i - 1]} requires a value`)
            if (token === "--target") {
              if (!storing || filtered[i + 1] === undefined || filtered[i + 1].startsWith("--") || filtered[i + 1].split(",").some(value=>!value.trim())) throw new Error("--target requires a storage target")
              targets.push(filtered[++i])
            } else {
              if (verb !== "set" || stdin) throw new Error("--stdin is accepted once for secret set")
              stdin = true
            }
          } else options.push(token)
        }
        const values = compoundPositionals(options, flags)
        const requiresName = ["register", "set", "rm", "unlock", "reveal"].includes(verb)
        if (values.length > 2 || (requiresName && values.length !== 2) || (["status", "list"].includes(verb) && values.length !== 1)) throw new Error("secret requires its verb and permitted name; values must not appear on argv")
        const action: Action = {type:"macos_secret",sub:verb}
        if (values[1] !== undefined) action.name = values[1]
        if (stdin) action.stdin = true
        const gate = flagVal(options,"--gate");if(gate!==undefined)action.gate=gate
        const reuse = flagInt(options,"--reuse",true);if(reuse!==undefined)action.reuseSeconds=reuse
        if (targets.length) action.targets = parseTargets(targets)
        if (verb === "unlock") { const duration=flagVal(options,"--for");if(duration!==undefined)action.forSeconds=parseDuration(duration) }
        const error=desktopSecretActionError(desktopAction(action),'cli');if(error)throw new Error(error)
        return action
      }
      const verb = filtered[2]
      const verbs = ["register", "set", "list", "rm", "status", "unlock", "lock", "reveal"]
      if (!verb || !verbs.includes(verb)) {
        console.error(`error: secret requires a verb (${verbs.join("|")})`)
        console.error("  interceptor macos secret register <name> [--gate none|touchid|biometry] [--target sudo|macos:<bundleId>|browser:<host>|ios|any]... [--reuse <seconds>]")
        console.error("  interceptor macos secret set <name> --stdin [same flags]      (value from stdin; TTY prompt without --stdin)")
        console.error("  interceptor macos secret list | status | rm <name> | unlock <name> --for 30m | lock [<name>] | reveal <name>")
        process.exit(1)
      }
      const action: Action = { type: "macos_secret", sub: verb }
      const name = filtered[3] && !filtered[3].startsWith("--") ? filtered[3] : undefined
      if (["register", "set", "rm", "unlock", "reveal"].includes(verb) && !name) {
        console.error(`error: secret ${verb} requires a <name>`); process.exit(1)
      }
      if (name) action.name = name
      if ((verb === "register" || verb === "set") && filtered[4] && !filtered[4].startsWith("--")) {
        console.error("error: never pass the secret value on argv (it lands in shell history and ps). Use 'secret register <name>' for the box, or 'secret set <name> --stdin'.")
        process.exit(1)
      }
      if (verb === "register" || verb === "set") {
        const gate = flagVal(filtered, "--gate")
        if (gate) action.gate = gate
        const targets = collectMulti(filtered, "--target").flatMap((t) => t.split(",")).map((t) => t.trim()).filter(Boolean)
        if (targets.length) action.targets = targets
        const reuse = flagInt(filtered, "--reuse")
        if (reuse !== undefined) action.reuseSeconds = reuse
        if (verb === "set" && filtered.includes("--stdin")) action.stdin = true
      }
      if (verb === "unlock") {
        const dur = flagVal(filtered, "--for")
        if (!dur) { console.error("error: secret unlock requires --for <duration> (e.g. 30m, 2h)"); process.exit(1) }
        action.for = dur
      }
      return action
    }

    // issue #244: `interceptor macos sudo --secret <name> [--keep] -- <command...>`
    // The daemon pipes the vault value to `sudo -S` stdin.
    case "sudo": {
      const sep = filtered.indexOf("--")
      const head = sep === -1 ? filtered : filtered.slice(0, sep)
      const cmd = sep === -1 ? [] : filtered.slice(sep + 1)
      const secretName = flagVal(head, "--secret")
      if (!secretName || secretName.startsWith("--")) { console.error("error: interceptor macos sudo requires --secret <name> -- <command...>"); process.exit(1) }
      if (cmd.length === 0) { console.error("error: interceptor macos sudo requires a command after --"); process.exit(1) }
      const action: Action = { type: "macos_sudo", secret: secretName, cmd }
      if (head.includes("--keep")) action.keep = true
      return action
    }

    // issue #244: fill the macOS administrator prompt (SecurityAgent) from the vault.
    case "authdialog": {
      const verb = filtered[2]
      if (!verb || !["fill", "status"].includes(verb)) {
        console.error("error: authdialog requires a verb (fill --secret <name> [--submit] | status)"); process.exit(1)
      }
      const action: Action = { type: "macos_authdialog", sub: verb }
      const portable=desktop&&process.platform!=='darwin'
      const flags=new Set(verb==='fill'?['--secret']:[])
      if(portable)for(const flag of ['--app','--pid','--window','--ref',...(verb==='fill'?['--secret-lease']:[])])flags.add(flag)
      const submits=filtered.filter(flag=>flag==='--submit').length
      if(submits>1||submits>0&&verb!=='fill')throw new Error('authentication submit requires one fill flag')
      const values=compoundPositionals(filtered.filter(flag=>flag!=='--submit'),flags)
      if(values.length!==1)throw new Error('authentication dialog requires its verb and supported exact flags')
      if (verb === "fill") {
        const secretName = flagVal(filtered, "--secret")
        if (!secretName || secretName.startsWith("--")) { console.error("error: authdialog fill requires --secret <name>"); process.exit(1) }
        action.secret = secretName
        if (filtered.includes("--submit")) action.submit = true
      }
      if(portable){
        for(const [flag,key]of [['--app','app'],['--ref','ref'],['--secret-lease','secretLease']] as const){const value=flagVal(filtered,flag);if(value!==undefined)action[key]=value}
        for(const [flag,key]of [['--pid','pid'],['--window','window']] as const){const value=flagInt(filtered,flag,true);if(value!==undefined)action[key]=value}
        const error=desktopAuthDialogActionError(desktopAction(action));if(error)throw new Error(error)
      }
      return action
    }

    case "auth": {
      const verb = filtered[2]
      const values=desktop?compoundPositionals(filtered,new Set(['--policy','--fallback-title','--cancel-title','--reuse'])):undefined
      if(desktop&&(!verb||values?.length!==(verb==='confirm'?2:1)))throw new Error('auth requires its verb and, for confirm, one reason')
      if (!verb) { console.error("error: auth requires a verb (status|confirm|invalidate|domain-state)"); process.exit(1) }
      const action: Action = { type: "macos_auth", sub: verb }
      if (verb === "confirm") action.reason = desktop?values?.[1]:filtered[3]
      const policy = flagVal(filtered, "--policy"); if (policy) action.policy = policy
      const fb = flagVal(filtered, "--fallback-title"); if (fb) action.fallback_title = fb
      const cancel = flagVal(filtered, "--cancel-title"); if (cancel) action.cancel_title = cancel
      const reuse = flagInt(filtered, "--reuse",desktop); if (reuse !== undefined) action.reuse_seconds = reuse
      if(desktop){const error=desktopAuthActionError(desktopAction(action));if(error)throw new Error(error)}
      return action
    }

    case "calendar":
    case "reminders": {
      const family=filtered[1],verb=filtered[2],fields=(family==='calendar'?DESKTOP_CALENDAR_FIELDS:DESKTOP_REMINDERS_FIELDS)[verb]
      if(!fields)throw new Error(family+' requires an exact selector')
      const action:Action={type:'macos_'+family,sub:verb}
      let index=3
      if(filtered[index]&&!filtered[index].startsWith('--'))action.id=filtered[index++]
      for(;index<filtered.length;index++){
        const flag=filtered[index],key=flag==='--type'?'cal_type':flag==='--alarm'?'alarms':flag==='--attendee'?'attendees':flag.slice(2).replaceAll('-','_')
        if(!flag.startsWith('--')||!fields.includes(key)||action[key]!==undefined&&!['alarms','attendees'].includes(key))throw new Error('unknown or duplicate '+family+' field '+flag)
        if(key==='all_day'){action.all_day=true;continue}
        const value=filtered[++index]
        if(value===undefined||value.startsWith('--'))throw new Error('missing '+family+' value '+flag)
        if(['alarms','attendees'].includes(key))action[key]=[...(action[key] as string[]??[]),value]
        else if(['limit','offset','recurrence_interval'].includes(key)){if(!/^\d+$/.test(value))throw new Error('integer required for '+flag);action[key]=Number(value)}
        else action[key]=value
      }
      const error=desktopEventKitActionError({...action,type:'desktop_'+family});if(error)throw new Error(error)
      return action
    }

    case "contacts": {
      const verb=filtered[2],action:Action={type:'macos_contacts',sub:verb}
      if(!verb)throw new Error('contacts requires an exact selector')
      const values=['keys','container','group','name','email','phone','given','family','organization','postal','birthday','note','since','contact','limit','offset']
      let index=3
      if(filtered[index]&&!filtered[index].startsWith('--')){
        const key=verb==='find'?'query':verb==='import-vcard'?'path':'id'
        action[key]=filtered[index++]
      }
      for(;index<filtered.length;index++){
        const flag=filtered[index],key=flag.slice(2),value=filtered[++index]
        if(!flag.startsWith('--')||!values.includes(key)||action[key]!==undefined||value===undefined||value.startsWith('--'))throw new Error('unknown, duplicate or missing contacts field '+flag)
        if(['limit','offset'].includes(key)){if(!/^\d+$/.test(value))throw new Error('contacts integer required for '+flag);action[key]=Number(value)}else action[key]=value
      }
      const error=desktopContactsActionError({...action,type:'desktop_contacts'});if(error)throw new Error(error)
      return action
    }

    case "appintent": {
      const verb = filtered[2] || "list"
      const action: Action = { type: "macos_appintent", sub: verb }
      if (verb === "donate") action.intent_id = filtered[3]
      return action
    }

    case "photos": {
      const sub=filtered[2],action:Action={type:"macos_photos",sub}
      const fields=DESKTOP_PHOTOS_FIELDS[sub];if(!fields)throw new Error("unknown Photos selector")
      let index=3
      if(fields.includes("id")){const id=filtered[index++];if(!id||id.startsWith("--"))throw new Error("Photos "+sub+" requires its identity");action.id=id}
      const seen=new Set(Object.keys(action)),booleans=new Set(["favorite","hidden","burst","save","on"])
      for(;index<filtered.length;index++){
        const flag=filtered[index],key=flag==="--type"?"album_type":flag==="--off"?"on":flag.slice(2).replaceAll("-","_")
        if(!flag.startsWith("--")||!fields.includes(key)||seen.has(key))throw new Error("invalid or repeated Photos field: "+flag)
        seen.add(key)
        if(booleans.has(key)){action[key]=flag!=="--off";continue}
        const value=filtered[++index];if(value===undefined||value.startsWith("--"))throw new Error("missing Photos field: "+flag)
        if(["limit","offset","size"].includes(key)){if(!/^\d+$/.test(value))throw new Error("invalid Photos integer: "+key);action[key]=Number(value)}else action[key]=value
      }
      const error=desktopPhotosActionError({...action,type:"desktop_photos"});if(error)throw new Error(error)
      return action
    }

    case "maps": {
      const sub=filtered[2],action:Action={type:"macos_maps",sub}
      const positional:Record<string,string>={search:"query",complete:"query",reverse:"coords","mapitem-open":"id"}
      const common=["--region","--types","--poi-categories","--address-include","--address-exclude","--limit"]
      const flags:Record<string,string[]>={search:common,complete:common,directions:["--from","--to","--transport","--requests-alternates"],eta:["--from","--to","--transport","--requests-alternates"]}
      let index=3
      if(positional[sub]){const value=filtered[index++];if(!value||value.startsWith("--"))throw new Error("maps "+sub+" requires its source");action[positional[sub]]=value}
      const seen=new Set<string>()
      for(;index<filtered.length;index++){
        const flag=filtered[index];if(!flags[sub]?.includes(flag)||seen.has(flag))throw new Error("invalid or repeated maps field: "+flag);seen.add(flag)
        const key=flag.slice(2).replaceAll("-","_")
        if(flag==="--requests-alternates"){action[key]=true;continue}
        const value=filtered[++index];if(value===undefined||value.startsWith("--"))throw new Error("missing maps field: "+flag)
        if(key==="limit"){if(!/^\d+$/.test(value))throw new Error("invalid integer maps limit");action[key]=Number(value)}else action[key]=value
      }
      const error=desktopMapsActionError({...action,type:"desktop_maps"});if(error)throw new Error(error)
      return action
    }

    case "location": {
      const verb=filtered[2]
      const grouped=["monitor","significant","visits","heading"].includes(verb)
      const sub=grouped?verb+"_"+filtered[3]:verb
      const flags:Record<string,string[]>={request:["--level"],"request-temporary-accuracy":["--purpose"],monitor_start:["--accuracy"],geocode:["--locale","--region"],reverse:["--locale"],distance:["--from","--to"],"postal-geocode":["--locale"]}
      const positional:Record<string,string>={geocode:"address",reverse:"coords","postal-geocode":"postal"}
      const action:Action={type:"macos_location",sub}
      let index=grouped?4:3
      if(positional[sub]){if(!filtered[index]||filtered[index].startsWith("--"))throw new Error("location "+verb+" requires its source");action[positional[sub]]=filtered[index++]}
      const seen=new Set<string>()
      for(;index<filtered.length;index+=2){const flag=filtered[index],value=filtered[index+1];if(!flags[sub]?.includes(flag)||seen.has(flag)||value===undefined||value.startsWith("--"))throw new Error("invalid, missing or repeated location field: "+flag);seen.add(flag);action[flag.slice(2)]=value}
      const error=desktopLocationActionError({...action,type:"desktop_location"});if(error)throw new Error(error)
      return action
    }

    case "music": {
      const sub=filtered[2],action:Action={type:"macos_music",sub}
      let index=3
      const positional:Record<string,string>={"library-search":"term",search:"term","search-suggest":"term",repeat:"mode",shuffle:"mode",song:"id",album:"id",artist:"id",playlist:"id"}
      if(positional[sub]){
        const value=filtered[index++];if(!value||value.startsWith("--"))throw new Error("music "+sub+" requires its value")
        action[positional[sub]]=value
      }
      const flags:Record<string,string[]>={library:["--kind","--type","--limit","--offset","--filter","--sort","--ascending","--include-tracks"],"library-search":["--types","--limit","--top","--include-tracks"],search:["--types","--limit","--offset","--top"],charts:["--limit"],play:["--song","--album","--playlist"],seek:["--time"],"now-playing":["--include-system"]}
      const booleanFields=new Set(["--ascending","--include-tracks","--top","--include-system"]),seen=new Set<string>()
      for(;index<filtered.length;index++){
        const flag=filtered[index],canonicalFlag=flag==="--type"?"--kind":flag;if(!flags[sub]?.includes(flag)||seen.has(canonicalFlag))throw new Error("invalid or repeated music field: "+flag);seen.add(canonicalFlag)
        const key=canonicalFlag.slice(2).replaceAll("-","_")
        if(booleanFields.has(flag)){action[key]=true;continue}
        const value=filtered[++index];if(value===undefined||value.startsWith("--"))throw new Error("missing music field: "+flag)
        if(key==="limit"||key==="offset"||key==="time"){
          if(key!=="time"?!/^\d+$/.test(value):!/^\d+(?:\.\d+)?$/.test(value))throw new Error("invalid numeric music "+key)
          action[key]=Number(value)
        }else action[key]=value
      }
      const error=desktopMusicActionError({...action,type:"desktop_music"});if(error)throw new Error(error)
      return action
    }

    case "share": {
      const sub=filtered[2],action:Action={type:"macos_share",sub}
      let index=3
      if(sub==="named"&&filtered[index]&&!filtered[index].startsWith("--"))action.service=filtered[index++]
      if(["text","url"].includes(sub)){const value=filtered[index++];if(value===undefined||value.startsWith("--"))throw new Error("share requires its value");action.value=value}
      else if(sub!=="services"&&filtered[index]&&!filtered[index].startsWith("--"))action.items=filtered[index++].split(",")
      const fields:Record<string,string>={"--recipient":"recipient","--to":"recipients","--recipients":"recipients","--subject":"subject","--body":"body","--service":"service","--for":"for_item","--text":"text","--url":"url","--items":"items"}
      const seen=new Set(Object.keys(action))
      for(;index<filtered.length;index+=2){
        const flag=filtered[index],key=fields[flag],value=filtered[index+1]
        if(!key||seen.has(key)||value===undefined||value.startsWith("--"))throw new Error("invalid, missing or repeated share field: "+flag)
        seen.add(key);action[key]=["items","recipients"].includes(key)?value.split(","):value
      }
      const error=desktopShareActionError({...action,type:"desktop_share"});if(error)throw new Error(error)
      return action
    }

    default: {
      // Extension Fabric: an installed extension may declare this
      // prefix as a `macos <prefix> <cmd>` verb → route to its bridge domain as
      // `macos_<prefix>_<cmd>` (mirrors vm's hyphen-normalized type encoding).
      if (extensionPrefixes && sub && extensionPrefixes.has(sub)) {
        return buildExtensionVerbAction(filtered, sub)
      }
      console.error(`error: unknown macos subcommand '${sub}'. Run 'interceptor help' for usage.`)
      process.exit(1)
    }
  }
}

/**
 * Build a generic extension verb action: `macos <prefix> <cmd> [args] [--flags]`
 * → `{ type: macos_<prefix>_<cmd>, sub: <cmd>, args, flags }`. The extension's
 * bridge handler receives the verb (via the Router's `command`) plus this action;
 * the core stays capability-blind (it knows the routing shape, not the behavior).
 */
function buildExtensionVerbAction(filtered: string[], prefix: string): Action | null {
  const verb = filtered[2]
  if (!verb || verb.startsWith("--")) {
    console.error(`error: interceptor macos ${prefix} requires a subcommand (e.g. interceptor macos ${prefix} <cmd>)`)
    process.exit(1)
  }
  const rest = filtered.slice(3)
  const args: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++ }
      else flags[key] = true
    } else {
      args.push(a)
    }
  }
  return { type: extensionActionType(prefix, verb), sub: verb, args, flags }
}

function parseScriptRunAction(
  filtered: string[],
  type: string,
  options: { allowStructuredIntent?: boolean; desktop?:boolean } = {}
): Action {
  if(options.desktop){
    // The portable surface is the same on every host; AppleScript stays on `interceptor macos script`.
    if(filtered.some(flag=>['--script','--jxa','--javascript','--bundle','--intent','--target','--params'].includes(flag)))throw new Error('AppleScript, JXA and Apple Events are macOS-only: use `interceptor macos script`, or --jsc for portable JavaScript')
    const args=[...filtered]
    let unsafe=false
    for(let i=3;i<args.length;i++){
      if(args[i]==='--jsc-unsafe-native'){if(unsafe)throw new Error('repeated --jsc-unsafe-native');unsafe=true;args.splice(i--,1)}
      else if(args[i]==='--jsc-host'&&(args[i+1]===undefined||args[i+1].startsWith('--')))args.splice(i+1,0,'all')
    }
    const positionals=compoundPositionals(args,new Set(['--jsc','--jsc-host','--args']))
    if(positionals.length!==1||positionals[0]!==filtered[2])throw new Error('script accepts one operation and named flags')
    const action:Action={type,jsc:flagVal(args,'--jsc')}
    const host=flagVal(args,'--jsc-host');if(host!==undefined||unsafe)action.jscHost=host??'all'
    const argv=flagVal(args,'--args');if(argv!==undefined){try{action.args=JSON.parse(argv)}catch{throw new Error('--args requires a JSON array of exact strings')}}
    const error=desktopScriptActionError(action);if(error)throw new Error(error);return action
  }
  const action: Action = { type }
  const script = flagVal(filtered, "--script")
  const jxa = flagVal(filtered, "--jxa")
  const javascriptAlias = flagVal(filtered, "--javascript")
  const jsc = flagVal(filtered, "--jsc")
  const jscHost = optionalFlagVal(filtered, "--jsc-host", "all")
  const jscUnsafeNative = filtered.includes("--jsc-unsafe-native")
  const bundleId = flagVal(filtered, "--bundle")
  const intent = flagVal(filtered, "--intent")
  const target = flagVal(filtered, "--target")
  const params = flagVal(filtered, "--params")
  const argsRaw = flagVal(filtered, "--args")
  const jxaSource = jxa ?? javascriptAlias
  const scriptInputs = [
    script !== undefined ? "--script" : undefined,
    jxaSource !== undefined ? "--jxa" : undefined,
    jsc !== undefined ? "--jsc" : undefined,
  ].filter(Boolean)

  if (jxa !== undefined && javascriptAlias !== undefined) {
    console.error("error: use only one of --jxa or deprecated --javascript")
    process.exit(1)
  }
  if (scriptInputs.length > 1) {
    console.error(`error: choose exactly one script source flag (${scriptInputs.join(", ")})`)
    process.exit(1)
  }

  if (script !== undefined) action.script = script
  if (jxaSource !== undefined) action.jxa = jxaSource
  if (jsc !== undefined) action.jsc = jsc
  if (jscHost !== undefined || jscUnsafeNative) action.jscHost = jscHost ?? "all"
  if (bundleId !== undefined) action.bundleId = bundleId
  if (intent !== undefined) action.intent = intent
  if (target !== undefined) action.target = target
  if (params !== undefined) {
    try { action.parameters = JSON.parse(params) }
    catch { console.error("error: --params must be JSON"); process.exit(1) }
  }
  if (argsRaw !== undefined) {
    try { action.args = JSON.parse(argsRaw) }
    catch {
      // Allow space-separated raw form
      action.args = argsRaw.split(" ").filter(Boolean)
    }
  }

  if (options.allowStructuredIntent) {
    if (!script && !jxaSource && !jsc && !bundleId) {
      console.error("error: macos intent dispatch requires one of --script, --jxa, --jsc, or --bundle")
      process.exit(1)
    }
  } else if (!script && !jxaSource && !jsc) {
    console.error("error: macos script run requires one of --script, --jxa, or --jsc")
    process.exit(1)
  }
  if ((jscHost !== undefined || jscUnsafeNative) && jsc === undefined) {
    console.error("error: --jsc-host/--jsc-unsafe-native require --jsc")
    process.exit(1)
  }

  return action
}

// ── Flag helpers ──

function compoundPositionals(args: string[], flags: Set<string>, booleans: Set<string> = new Set()): string[] {
  const seen = new Set<string>()
  for (let i = 2; i < args.length; i++) {
    const flag = args[i]
    if (!flag.startsWith("--")) continue
    if (!flags.has(flag) && !booleans.has(flag)) throw new Error(`${args[1] ?? "this command"} does not take ${flag}`)
    if (seen.has(flag)) throw new Error(`repeated flag: ${flag}`)
    seen.add(flag)
    if (booleans.has(flag)) continue
    if (args[++i] === undefined || args[i].startsWith("--")) throw new Error(`${flag} requires a value`)
  }
  return collectPositionals(args.filter(value => !booleans.has(value)), 2, flags)
}

function flagVal(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1 || !args[idx + 1]) return undefined
  return args[idx + 1]
}

function optionalFlagVal(args: string[], flag: string, defaultValue: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  const next = args[idx + 1]
  if (!next || next.startsWith("--")) return defaultValue
  return next
}

function flagInt(args: string[], flag: string, strict = false): number | undefined {
  const val = flagVal(args, flag)
  if (strict && args.includes(flag) && (val === undefined || !/^-?\d+$/.test(val.trim()) || !Number.isSafeInteger(Number(val)))) {
    throw new Error(`${flag} requires a safe integer`)
  }
  if (val === undefined) return undefined
  const n = strict ? Number(val) : parseInt(val)
  return isNaN(n) ? undefined : n
}

// `--window <id>`: the window id (from `macos windows`) an input verb should
// reach, for when another window of the same app covers the point.
function withWindow(action: Action, args: string[], neutral = false): void {
  if (neutral) {
    if (args.includes("--background-only")) action.backgroundOnly = true
    if (["macos_type", "macos_click"].includes(action.type)) {
      const title = flagVal(args, "--window-title")
      if (args.includes("--window-title")) {
        if (!title || title.startsWith("--")) throw new Error("--window-title requires an exact title")
        action.windowTitle = title
      }
      const bounds = flagVal(args, "--window-bounds")
      if (args.includes("--window-bounds")) {
        const values = bounds?.split(",").map(Number)
        if (!values || values.length !== 4 || values.some(n => !Number.isFinite(n)) || values[2] <= 0 || values[3] <= 0) throw new Error("--window-bounds requires left,top,width,height")
        action.windowBounds = {left:values[0],top:values[1],width:values[2],height:values[3]}
      }
    }
  }
  if (!args.includes("--window")) return
  const raw = flagVal(args, "--window")
  // Strict digits: a dropped or half-parsed id would send the input to the
  // frontmost window instead.
  if (raw === undefined || !/^[1-9]\d{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw)) || (!neutral && Number(raw) > 0xffffffff)) {
    if (neutral) throw new Error("--window requires a positive safe-integer native window id")
    console.error(`error: --window takes a numeric window id (the windowId field of 'interceptor macos windows'), got '${raw ?? ""}'`)
    process.exit(1)
  }
  action.window = Number(raw)
}

// Collect every value that follows a repeated --flag occurrence.
// `--paths /a --paths /b` and `--paths /a,/b` are both valid call sites; the
// caller is expected to split commas after this returns the raw values.
function collectMulti(args: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) {
      out.push(args[i + 1])
      i += 1
    }
  }
  return out
}

function collectPositionals(args: string[], startIndex: number, flagsWithValues = new Set<string>()): string[] {
  const values: string[] = []
  for (let i = startIndex; i < args.length; i++) {
    const arg = args[i]
    if (flagsWithValues.has(arg)) {
      i += 1
      continue
    }
    if (arg.startsWith("--")) continue
    values.push(arg)
  }
  return values
}
