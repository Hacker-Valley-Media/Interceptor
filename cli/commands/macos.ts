/**
 * cli/commands/macos.ts — interceptor macos <subcommand>
 *
 * Parses `interceptor macos` subcommands into macos_ prefixed action objects
 * that get routed to the native bridge via the daemon.
 */

import { existsSync } from "node:fs"
import { sendCommand, sendCommandWs, type DaemonResponse } from "../transport"
import {
  attachMonitorTaskSource,
  markMonitorTaskSourceAttachFailed,
  resolveOrCreateMonitorTask,
  validateMonitorTaskMode,
} from "../../shared/monitor-tasks"
import { runCdpCommand } from "./cdp"
import { runNativeCommand } from "./native"
import { extensionMacosPrefixes, extensionActionType } from "../../shared/extensions"

type Action = { type: string; [key: string]: unknown }
type Result = { success: boolean; error?: string; data?: unknown }

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
function bridgePreflightFailure(): string | null {
  if (process.platform !== "darwin") {
    return "'interceptor macos *' commands require macOS (the Swift bridge is mac-only)."
  }
  const home = process.env.HOME || ""
  // Two LaunchAgent locations depending on install channel: per-user (dev
  // path via scripts/install-bridge.sh) or system-wide (signed-pkg path via
  // Interceptor-Full-<v>.pkg). Either is sufficient.
  const launchAgentUser = `${home}/Library/LaunchAgents/com.interceptor.bridge.plist`
  const launchAgentSystem = "/Library/LaunchAgents/com.interceptor.bridge.plist"
  const bridgeSock = "/tmp/interceptor-bridge.sock"
  const bridgePid = "/tmp/interceptor-bridge.pid"
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
  opts: { jsonMode?: boolean; useWs?: boolean; globalTabId?: number; contextId?: string }
): Promise<void> {
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

  if (sub !== "trust") {
    const failure = bridgePreflightFailure()
    if (failure !== null) {
      console.error(`error: ${failure}`)
      process.exit(1)
    }
  }

  // Extension Fabric: synchronously discover the set of
  // manifest-declared `macos <prefix>` subcommands so an installed extension's
  // verbs fall through to the generic builder instead of the hard `default`.
  const extPrefixes = extensionMacosPrefixes()
  const action = parseMacosCommand(filtered, extPrefixes)
  if (!action) process.exit(1)

  let pendingMonitorTaskId: string | undefined
  if (action.type === "macos_monitor" && action.sub === "start" && typeof action.taskRef === "string") {
    try {
      const { task } = resolveOrCreateMonitorTask({
        taskRef: action.taskRef,
        mode: typeof action.taskMode === "string" ? action.taskMode : undefined,
        instruction: typeof action.instruction === "string" ? action.instruction : undefined,
        createdBy: "macos-monitor",
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

  const result = await send(action, opts.globalTabId, opts.useWs)

  if (!result.success) {
    if (pendingMonitorTaskId) {
      markMonitorTaskSourceAttachFailed(pendingMonitorTaskId, undefined, result.error || "macos monitor start failed")
    }
    console.error("error:", result.error || "unknown error")
    process.exit(1)
  }

  if (pendingMonitorTaskId) {
    const data = (result.data || {}) as Record<string, unknown>
    const sid = typeof data.sid === "string" ? data.sid : typeof data.sessionId === "string" ? data.sessionId : undefined
    if (sid) {
      try {
        attachMonitorTaskSource(pendingMonitorTaskId, sid, {
          surface: "macos",
          rootPid: typeof data.rootPid === "number" ? data.rootPid : undefined,
          rootBundleId: typeof data.rootBundleId === "string" ? data.rootBundleId : undefined,
          rootApp: typeof data.rootApp === "string" ? data.rootApp : undefined,
        })
        data.taskId = pendingMonitorTaskId
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

  if (opts.jsonMode) {
    console.log(JSON.stringify(result.data, null, 2))
  } else if (typeof result.data === "string") {
    console.log(result.data)
  } else if (result.data !== undefined && result.data !== null) {
    console.log(JSON.stringify(result.data, null, 2))
  } else {
    console.log("ok")
  }
}

export function parseMacosCommand(filtered: string[], extensionPrefixes?: Set<string>): Action | null {
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
    case "tree":
      return {
        type: "macos_tree",
        app: flagVal(filtered, "--app"),
        pid: flagInt(filtered, "--pid"),
        filter: flagVal(filtered, "--filter") || "interactive",
        depth: flagInt(filtered, "--depth") || 10,
      }

    case "find": {
      const query = filtered[2]
      if (!query) { console.error("error: interceptor macos find requires a query"); process.exit(1) }
      return {
        type: "macos_find",
        query,
        app: flagVal(filtered, "--app"),
        role: flagVal(filtered, "--role"),
      }
    }

    case "inspect": {
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
      const ref = filtered[2]
      if (!ref) { console.error("error: interceptor macos value requires a ref"); process.exit(1) }
      const newValue = filtered[3]
      return { type: "macos_value", ref, ...(newValue !== undefined && { value: newValue }) }
    }

    case "action": {
      const ref = filtered[2]
      if (!ref) { console.error("error: interceptor macos action requires a ref"); process.exit(1) }
      const actionName = filtered[3] || "press"
      return { type: "macos_action", ref, action: actionName }
    }

    case "focused":
      return { type: "macos_focused", app: flagVal(filtered, "--app") }

    case "windows":
      return { type: "macos_windows", app: flagVal(filtered, "--app") }

    // ── Text ──
    case "text": {
      const ref = filtered[2]
      if (!ref) { console.error("error: interceptor macos text requires a ref"); process.exit(1) }
      const mode = filtered.includes("--selection") ? "selection" : filtered.includes("--visible") ? "visible" : "full"
      return { type: "macos_text", ref, mode }
    }

    // ── Menu ──
    case "menu": {
      const items = collectPositionals(filtered, 2, new Set(["--app", "--pid"]))
      return {
        type: "macos_menu",
        ...(items.length > 0 && { items }),
        app: flagVal(filtered, "--app"),
        pid: flagInt(filtered, "--pid"),
      }
    }

    // ── Update (Sparkle) ──
    case "update": {
      const op = filtered[2] || "status"
      return {
        type: "macos_update",
        sub: op,
      }
    }

    // ── Trust ──
    case "trust": {
      // --no-prompt is defense-in-depth for read-only consumers: when set,
      // every prompt-triggering flag is forced false in the wire payload so
      // a future caller-side bug cannot accidentally modify TCC state.
      const noPrompt = filtered.includes("--no-prompt")
      return {
        type: "macos_trust",
        noPrompt,
        prompt: !noPrompt && (filtered.includes("--prompt") || filtered.includes("--walkthrough")),
        walkthrough: !noPrompt && filtered.includes("--walkthrough"),
        accessibilityPrompt: !noPrompt && filtered.includes("--accessibility-prompt"),
        screenPrompt: !noPrompt && filtered.includes("--screen-prompt"),
        microphonePrompt: !noPrompt && filtered.includes("--microphone-prompt"),
      }
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
      const subcommand = filtered[2] || "activate"
      const appName = flagVal(filtered, "--app") || filtered[3]
      return {
        type: "macos_app",
        subcommand,
        app: appName,
        pid: flagInt(filtered, "--pid"),
        bundleId: subcommand === "launch" ? (filtered[3] || flagVal(filtered, "--bundle")) : undefined,
      }
    }

    case "frontmost":
      return { type: "macos_frontmost" }

    // ── Input ──
    case "click": {
      const target = filtered[2]
      if (!target) { console.error("error: interceptor macos click requires a ref or coordinates"); process.exit(1) }
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
      const clickPid = flagInt(filtered, "--pid")
      if (clickApp) action.app = clickApp
      if (clickPid !== undefined) action.pid = clickPid
      return action
    }

    case "type": {
      const refOrText = filtered[2]
      if (!refOrText) { console.error("error: interceptor macos type requires text or ref + text"); process.exit(1) }
      const action: Action = /^e\d+$/.test(refOrText) && filtered[3]
        ? { type: "macos_type", ref: refOrText, text: filtered[3] }
        : { type: "macos_type", text: refOrText }
      const typeApp = flagVal(filtered, "--app")
      const typePid = flagInt(filtered, "--pid")
      if (typeApp) action.app = typeApp
      if (typePid !== undefined) action.pid = typePid
      return action
    }

    case "keys": {
      const combo = filtered[2]
      if (!combo) { console.error("error: interceptor macos keys requires a key combo"); process.exit(1) }
      const action: Action = { type: "macos_keys", keys: combo }
      const keysApp = flagVal(filtered, "--app")
      const keysPid = flagInt(filtered, "--pid")
      if (keysApp) action.app = keysApp
      if (keysPid !== undefined) action.pid = keysPid
      return action
    }

    case "scroll": {
      const direction = filtered[2] || "down"
      const amount = parseInt(filtered[3] || "300")
      const action: Action = {
        type: "macos_scroll",
        direction,
        amount: isNaN(amount) ? 300 : amount,
        ref: flagVal(filtered, "--ref"),
      }
      // --pid <pid> or --app <name> routes scroll to a specific process
      // via CGEvent.postToPid — works on occluded / minimized windows
      // without changing focus.
      const pid = flagInt(filtered, "--pid")
      const targetApp = flagVal(filtered, "--app")
      const times = flagInt(filtered, "--times")
      const intervalMs = flagInt(filtered, "--interval-ms")
      if (pid !== undefined) action.pid = pid
      if (targetApp) action.app = targetApp
      if (times !== undefined) action.times = times
      if (intervalMs !== undefined) action.intervalMs = intervalMs
      return action
    }

    case "resize": {
      const ref = filtered[2]
      if (!ref) { console.error("error: interceptor macos resize requires a ref"); process.exit(1) }
      const width = flagInt(filtered, "--width") || parseInt(filtered[3]) || undefined
      const height = flagInt(filtered, "--height") || parseInt(filtered[4]) || undefined
      // : parser parity with click/type/keys/scroll/drag — forward
      // --app and --pid so the bridge can use them for ref qualification.
      const action: Action = { type: "macos_resize", ref, width, height }
      const resizeApp = flagVal(filtered, "--app")
      const resizePid = flagInt(filtered, "--pid")
      if (resizeApp) action.app = resizeApp
      if (resizePid !== undefined) action.pid = resizePid
      return action
    }

    case "move": {
      const ref = filtered[2]
      if (!ref) { console.error("error: interceptor macos move requires a ref"); process.exit(1) }
      const x = flagInt(filtered, "--x") || parseInt(filtered[3]) || 0
      const y = flagInt(filtered, "--y") || parseInt(filtered[4]) || 0
      const action: Action = { type: "macos_move", ref, x, y }
      const moveApp = flagVal(filtered, "--app")
      const movePid = flagInt(filtered, "--pid")
      if (moveApp) action.app = moveApp
      if (movePid !== undefined) action.pid = movePid
      return action
    }

    case "drag": {
      const from = filtered[2]
      const to = filtered[3]
      if (!from || !to) { console.error("error: interceptor macos drag requires from and to refs or coords"); process.exit(1) }
      const fromIsCoords = from.includes(",")
      const toIsCoords = to.includes(",")
      const action: Action = fromIsCoords && toIsCoords
        ? { type: "macos_drag", fromCoords: from, toCoords: to }
        : { type: "macos_drag", from, to }
      const dragApp = flagVal(filtered, "--app")
      const dragPid = flagInt(filtered, "--pid")
      if (dragApp) action.app = dragApp
      if (dragPid !== undefined) action.pid = dragPid
      return action
    }

    // ── Screenshot / Capture ──
    case "screenshot": {
      // Capture-time optimizations: target_max_long_edge resize at capture,
      // WebP encoding, save-strips-dataUrl, --mode display for full-screen.
      const action: Action = {
        type: "macos_screenshot",
        app: flagVal(filtered, "--app"),
        display: flagInt(filtered, "--display"),
        window: flagInt(filtered, "--window"),
        save: filtered.includes("--save"),
        format: flagVal(filtered, "--format") || "jpeg",
        quality: flagInt(filtered, "--quality") || 80,
        element: flagVal(filtered, "--element"),
        cwd: process.cwd(),
      }
      const mode = flagVal(filtered, "--mode")
      if (mode) action.mode = mode
      // --full-screen is a friendlier alias for --mode display
      if (filtered.includes("--full-screen") || filtered.includes("--display-mode")) {
        action.mode = "display"
      }
      const targetMaxLongEdge = flagInt(filtered, "--target-max-long-edge")
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
      // `capture frame` blocks briefly waiting for the next sample buffer
      // when the stream is active but hasn't ticked yet. Default 1000ms;
      // override with --timeout-ms.
      const timeoutMs = flagInt(filtered, "--timeout-ms")
      if (timeoutMs !== undefined) action.timeoutMs = timeoutMs
      return action
    }

    // ── Speech ──
    case "listen": {
      const op = filtered[2] || "status"
      return {
        type: "macos_listen",
        sub: op,
        device: flagVal(filtered, "--device"),
      }
    }

    case "vad": {
      const op = filtered[2] || "status"
      return { type: "macos_vad", sub: op }
    }

    // ── Sound ──
    case "sounds": {
      const op = filtered[2] || "status"
      return {
        type: "macos_sounds",
        sub: op,
        filter: flagVal(filtered, "--filter"),
      }
    }

    // ── Vision ──
    case "vision": {
      const op = filtered[2] || "text"
      const action: Action = {
        type: "macos_vision",
        sub: op,
        app: flagVal(filtered, "--app"),
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
      const op = filtered[2] || "check"
      return {
        type: "macos_sensitive",
        sub: op,
        app: flagVal(filtered, "--app"),
      }
    }

    // ── Health ──
    case "health": {
      const op = filtered[2] || "status"
      return { type: "macos_health", sub: op }
    }

    // ── Files ──
    case "files": {
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
      const op = filtered[2] || "tail"
      const action: Action = { type: "macos_notifications", sub: op }
      // legacy DistributedNotificationCenter flags
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
      const nSeconds = flagInt(filtered, "--seconds"); if (nSeconds !== undefined) action.seconds = nSeconds
      const nBadge = flagInt(filtered, "--badge"); if (nBadge !== undefined) action.badge = nBadge
      const nCount = flagInt(filtered, "--count"); if (nCount !== undefined) action.count = nCount
      if (filtered.includes("--repeats")) action.repeats = true
      // sub-sub-verb on `categories` and `badge clear`
      if (op === "categories") action.verb = filtered[3]
      if (op === "badge" && filtered[3] === "clear") action.clear = true
      else if (op === "badge" && filtered[3]) action.count = parseInt(filtered[3])
      // identifier positional for cancel / dismiss
      if ((op === "cancel" || op === "dismiss") && filtered[3]) action.id = filtered[3]
      return action
    }

    // ── Clipboard ──
    case "clipboard": {
      const op = filtered[2] || "read"
      const text = op === "write" ? filtered[3] : undefined
      return {
        type: "macos_clipboard",
        sub: op,
        text,
        contentType: flagVal(filtered, "--type"),
        image: flagVal(filtered, "--image"),
        limit: flagInt(filtered, "--limit"),
      }
    }

    // ── Display ──
    case "display": {
      const op = filtered[2] || "list"
      const resolution = filtered[3]
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
      if (!channel || !op) {
        console.error("error: interceptor macos audio requires <channel> <op>. Channels: output | input | both. Ops: start | stop | level | devices.")
        process.exit(1)
      }
      return {
        type: "macos_audio",
        sub: channel,
        op,
        app: flagVal(filtered, "--app"),
        device: flagVal(filtered, "--device"),
        save: filtered.includes("--save"),
      }
    }

    // ── Stream ──
    case "stream": {
      const op = filtered[2] || "status"
      return {
        type: "macos_stream",
        op,
        sid: flagVal(filtered, "--sid") || filtered[3],
        app: flagVal(filtered, "--app"),
        display: flagInt(filtered, "--display"),
        virtual: flagVal(filtered, "--virtual"),
        format: flagVal(filtered, "--format"),
      }
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
      const frames = flagInt(filtered, "--frames")
      const visionText = filtered.includes("--vision-text")
      // Frame-encoding knobs. Default jpeg q=80 mirrors CaptureDomain
      // (interceptor-bridge/Sources/Domains/CaptureDomain.swift:84-86).
      const frameFormat = flagVal(filtered, "--frame-format")
      const frameQuality = flagInt(filtered, "--frame-quality")
      const frameMaxLongEdge = flagInt(filtered, "--frame-max-long-edge")
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

      const action: Action = {
        type: "macos_monitor",
        sub: op,
        sid: flagVal(filtered, "--sid") || (op === "export" ? filtered[3] : undefined),
        instruction: flagVal(filtered, "--instruction"),
        format: filtered.includes("--json") ? "json" : filtered.includes("--plan") ? "plan" : "timeline",
        raw: filtered.includes("--raw"),
        limit: flagInt(filtered, "--limit"),
      }
      const taskRef = flagVal(filtered, "--task")
      if (taskRef) {
        action.taskRef = taskRef
        if (!action.instruction) action.instruction = taskRef
        const taskMode = flagVal(filtered, "--mode")
        try {
          action.taskMode = validateMonitorTaskMode(taskMode)
        } catch (err) {
          console.error(`error: ${(err as Error).message}`)
          process.exit(1)
        }
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
      return action
    }

    // ── Compound Commands ──
    case "open": {
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
          if (range) {
            const [s, l] = range.split(",").map((v) => parseInt(v, 10))
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
            limit: flagInt(filtered, "--limit") || 50,
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
      if (!urlSub) {
        console.error("error: interceptor macos url requires a subcommand: get | post")
        process.exit(1)
      }
      const target = filtered[3]
      if (!target) { console.error(`error: interceptor macos url ${urlSub} requires a URL`); process.exit(1) }
      const headers: Record<string, string> = {}
      // Collect every --header "K: V" pair
      for (let i = 0; i < filtered.length - 1; i++) {
        if (filtered[i] === "--header" || filtered[i] === "-H") {
          const raw = filtered[i + 1]
          const m = /^([^:]+):\s*(.*)$/.exec(raw)
          if (m) headers[m[1].trim()] = m[2]
        }
      }
      const action: Action = {
        type: "macos_url_fetch",
        url: target,
        method: urlSub === "post" ? "POST" : (flagVal(filtered, "--method") || "GET").toUpperCase(),
        headers,
        timeoutMs: flagInt(filtered, "--timeout") || 30000,
      }
      const body = flagVal(filtered, "--body")
      if (body !== undefined) action.body = body
      const ct = flagVal(filtered, "--content-type")
      if (ct) (action.headers as Record<string, string>)["Content-Type"] = ct
      return action
    }

    // ── Log query (LogDomain) ──
    case "log": {
      const logSub = filtered[2]
      if (logSub !== "query") {
        console.error("error: interceptor macos log requires the 'query' subcommand")
        process.exit(1)
      }
      let predicate = flagVal(filtered, "--predicate")
      const subsystem = flagVal(filtered, "--subsystem")
      const category = flagVal(filtered, "--category")
      // Build a predicate from --subsystem / --category if no explicit one
      if (!predicate) {
        const parts: string[] = []
        if (subsystem) parts.push(`subsystem == "${subsystem}"`)
        if (category) parts.push(`category == "${category}"`)
        if (parts.length) predicate = parts.join(" AND ")
      }
      return {
        type: "macos_log_query",
        predicate,
        since: flagVal(filtered, "--since"),
        limit: flagInt(filtered, "--limit") || 100,
        includeInfo: filtered.includes("--include-info"),
        includeDebug: filtered.includes("--include-debug"),
      }
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
          return parseScriptRunAction(filtered, "macos_script_run")
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
          return parseScriptRunAction(filtered, "macos_intent_dispatch", { allowStructuredIntent: true })
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
          const srcVm = /^([^/:]+):(.+)$/.exec(src)
          const dstVm = /^([^/:]+):(.+)$/.exec(dst)
          base.name = (dstVm && dstVm[1]) || (srcVm && srcVm[1])
          if (!base.name) { console.error("error: interceptor macos vm cp requires one side as <vm>:<path>"); process.exit(1) }
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
      if (!overlaySub) {
        console.error("error: interceptor macos overlay requires a subcommand: start | stop | list | status | eval | ctl | verbs")
        process.exit(1)
      }
      switch (overlaySub) {
        case "start": {
          const action: Action = { type: "macos_overlay_start" }
          const id = flagVal(filtered, "--id")
          const level = flagVal(filtered, "--level")
          const particles = flagVal(filtered, "--particles")
          const scene = flagVal(filtered, "--scene")
          const sceneScript = flagVal(filtered, "--scene-script")
          const url = flagVal(filtered, "--url")
          const htmlB64 = flagVal(filtered, "--html-b64")
          // Spec 7: --html accepted as a friendlier alias to
          // --html-b64; the parser b64-encodes inline HTML so callers
          // don't have to wrap shell-escaped HTML themselves.
          const htmlInline = flagVal(filtered, "--html")
          const rect = flagVal(filtered, "--rect")
          const timeout = flagInt(filtered, "--timeout-seconds")
          // Spec 7: --duration / --duration-ms aliases for the
          // existing --timeout-seconds. The bridge auto-dismisses after
          // the timeout regardless of mode.
          const durationMs = flagInt(filtered, "--duration-ms")
          const durationLegacy = flagInt(filtered, "--duration")
          const density = flagInt(filtered, "--density")
          const lifetime = flagInt(filtered, "--lifetime")
          const anchor = flagVal(filtered, "--anchor")

          if (id) action.id = id
          if (level) action.level = level
          if (filtered.includes("--interactive")) action.interactive = true
          if (filtered.includes("--no-interactive")) action.interactive = false
          if (filtered.includes("--single-space")) action.single_space = true
          if (filtered.includes("--no-fullscreen-aux")) action.no_fullscreen_aux = true
          if (timeout !== undefined) action.timeout_seconds = timeout
          if (anchor) action.anchor = anchor

          if (particles) action.particles = particles
          if (density !== undefined) action.density = density
          if (lifetime !== undefined) action.lifetime = lifetime
          if (scene) action.scene = scene
          if (sceneScript) action.scene_script = sceneScript
          if (url) action.url = url
          if (htmlB64) action.html_b64 = htmlB64
          // Spec 7: forward inline --html as html_b64 (b64-encoded)
          // so the bridge has a single source HTML field. Buffer.from is
          // already imported into Bun's globals.
          let resolvedHtmlB64: string | undefined = htmlB64
          if (!resolvedHtmlB64 && htmlInline) {
            resolvedHtmlB64 = Buffer.from(htmlInline, "utf-8").toString("base64")
            action.html_b64 = resolvedHtmlB64
          }

          // Spec 7: unify --duration-ms / --duration / --timeout-seconds
          // into the bridge's single `timeout_seconds` action field
          // (OverlayDomain only reads timeout_seconds today, see
          // OverlayDomain.swift:114). --duration-ms wins, then --duration
          // (interpreted as ms for ergonomic parity with the particles-mode
          // flag the live tests already used), then --timeout-seconds as
          // the legacy form.
          if (durationMs !== undefined) {
            action.timeout_seconds = durationMs / 1000
          } else if (durationLegacy !== undefined) {
            action.timeout_seconds = durationLegacy / 1000
          } else if (timeout !== undefined) {
            action.timeout_seconds = timeout
          }

          if (rect) {
            const [x, y, w, h] = rect.split(",").map((v) => parseFloat(v))
            if (!isNaN(x) && !isNaN(y) && !isNaN(w) && !isNaN(h)) {
              action.rect = { x, y, width: w, height: h }
            }
          }

          if (!particles && !scene && !sceneScript && !url && !resolvedHtmlB64) {
            console.error("error: overlay start requires one of --particles, --scene, --scene-script, --url, --html, --html-b64")
            process.exit(1)
          }
          return action
        }
        case "stop": {
          const id = filtered[3]
          const action: Action = { type: "macos_overlay_stop" }
          if (id) action.id = id
          return action
        }
        case "list":
          return { type: "macos_overlay_list" }
        case "status": {
          const id = filtered[3]
          const action: Action = { type: "macos_overlay_status" }
          if (id) action.id = id
          return action
        }
        case "eval": {
          const id = filtered[3]
          const js = filtered[4]
          if (!id || !js) { console.error("error: overlay eval requires <id> <javascript>"); process.exit(1) }
          return { type: "macos_overlay_eval", id, javascript: js }
        }
        case "ctl": {
          const id = filtered[3]
          const verb = filtered[4]
          if (!id || !verb) { console.error("error: overlay ctl requires <id> <verb> [args]"); process.exit(1) }
          const action: Action = { type: "macos_overlay_ctl", id, verb }
          // Remaining --foo bar pairs become args
          const args: Record<string, unknown> = {}
          for (let i = 5; i < filtered.length - 1; i++) {
            if (filtered[i].startsWith("--")) {
              const key = filtered[i].slice(2)
              const val = filtered[i + 1]
              const numeric = parseFloat(val)
              args[key] = !isNaN(numeric) && /^-?[\d.]+$/.test(val) ? numeric : val
            }
          }
          if (Object.keys(args).length) action.args = args
          return action
        }
        case "verbs": {
          const id = filtered[3]
          const action: Action = { type: "macos_overlay_verbs" }
          if (id) action.id = id
          return action
        }
        default:
          console.error(`error: unknown 'overlay' subcommand '${overlaySub}'. Use: start | stop | list | status | eval | ctl | verbs`)
          process.exit(1)
      }
    }

    // ── Personal data + distribution + document surfaces ──
    // Each branch maps `interceptor macos <domain> <verb> [...]` to a
    // `macos_<domain>` action with `sub` carrying the verb (invariant).

    case "pdf": {
      const verb = filtered[2]
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
          action.value = flagVal(filtered, "--value")
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
        const page = flagInt(filtered, "--page"); if (page !== undefined) action.page = page
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
      return action
    }

    case "detect": {
      const verb = filtered[2]
      if (!verb) { console.error("error: detect requires a verb (types|run|file|stdin)"); process.exit(1) }
      const action: Action = { type: "macos_detect", sub: verb }
      if (verb === "run") action.input = filtered[3]
      else if (verb === "file") action.path = filtered[3]
      else if (verb === "stdin") {
        // Bridge handler reads action["input"]; CLI must wrap stdin into it.
        const buf = require("node:fs").readFileSync(0, "utf8")
        action.input = buf
      }
      const types = flagVal(filtered, "--types"); if (types) action.types = types
      return action
    }

    case "translate": {
      const verb = filtered[2]
      if (!verb) { console.error("error: translate requires a verb (status|languages|availability|prepare|text|batch|file|stop)"); process.exit(1) }
      const action: Action = { type: "macos_translate", sub: verb }
      const from = flagVal(filtered, "--from"); if (from) action.from = from
      const to = flagVal(filtered, "--to"); if (to) action.to = to
      const sample = flagVal(filtered, "--sample"); if (sample) action.sample = sample
      const json = flagVal(filtered, "--json"); if (json) action.json = json
      if (verb === "text") action.input = filtered[3]
      else if (verb === "file") action.path = filtered[3]
      return action
    }

    case "thumbnail": {
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

    case "auth": {
      const verb = filtered[2]
      if (!verb) { console.error("error: auth requires a verb (status|confirm|invalidate|domain-state)"); process.exit(1) }
      const action: Action = { type: "macos_auth", sub: verb }
      if (verb === "confirm") action.reason = filtered[3]
      const policy = flagVal(filtered, "--policy"); if (policy) action.policy = policy
      const fb = flagVal(filtered, "--fallback-title"); if (fb) action.fallback_title = fb
      const cancel = flagVal(filtered, "--cancel-title"); if (cancel) action.cancel_title = cancel
      const reuse = flagInt(filtered, "--reuse"); if (reuse !== undefined) action.reuse_seconds = reuse
      return action
    }

    case "calendar": {
      const verb = filtered[2]
      if (!verb) { console.error("error: calendar requires a verb (status|request|list|default|sources|create-calendar|delete-calendar|events|event|event-by-external|create|update|delete|move|refresh-sources|reset|tail)"); process.exit(1) }
      const action: Action = { type: "macos_calendar", sub: verb }
      // common flags. NB: --type would collide with the action envelope's
      // `type` field (which dispatches the action), so we remap it to
      // `cal_type` and read it as such on the bridge side.
      for (const flag of ["--level","--title","--color","--start","--end","--calendar","--calendars","--all-day","--location","--notes","--url","--span","--to","--recurrence-frequency","--recurrence-interval","--recurrence-end"]) {
        const val = flagVal(filtered, flag)
        if (val !== undefined) action[flag.replace(/^--/, "").replace(/-/g, "_")] = val
      }
      const calType = flagVal(filtered, "--type")
      if (calType !== undefined) action.cal_type = calType
      if (filtered.includes("--all-day")) action.all_day = true
      // alarms (multiple), attendees (multiple)
      action.alarms = filtered.reduce<string[]>((acc, v, i) => filtered[i - 1] === "--alarm" ? acc.concat(v) : acc, [])
      action.attendees = filtered.reduce<string[]>((acc, v, i) => filtered[i - 1] === "--attendee" ? acc.concat(v) : acc, [])
      // positional id args (after verb)
      const positional = filtered[3]
      if (verb === "delete-calendar" || verb === "event" || verb === "event-by-external" || verb === "update" || verb === "delete" || verb === "move") {
        if (positional) action.id = positional
      }
      return action
    }

    case "reminders": {
      const verb = filtered[2]
      if (!verb) { console.error("error: reminders requires a verb (status|request|lists|default|all|incomplete|completed|create|update|complete|uncomplete|delete)"); process.exit(1) }
      const action: Action = { type: "macos_reminders", sub: verb }
      for (const flag of ["--list","--due-start","--due-end","--since","--until","--title","--due","--start","--priority","--notes","--url"]) {
        const val = flagVal(filtered, flag)
        if (val !== undefined) action[flag.replace(/^--/, "").replace(/-/g, "_")] = val
      }
      const positional = filtered[3]
      if (["update","complete","uncomplete","delete"].includes(verb) && positional) action.id = positional
      return action
    }

    case "contacts": {
      const verb = filtered[2]
      if (!verb) { console.error("error: contacts requires a verb (status|request|containers|default-container|groups|group|group-create|group-update|group-delete|group-add-member|group-remove-member|list|contact|me|find|create|update|delete|vcard|import-vcard|current-token|changes)"); process.exit(1) }
      const action: Action = { type: "macos_contacts", sub: verb }
      // String flags only. --limit and --offset are integers — see below.
      // Without the int conversion the Swift handler's `as? Int` cast fails
      // on strings, silently treating limit=undefined and serializing every
      // contact (verified — caused 15s timeouts on the list verb).
      for (const flag of ["--keys","--container","--group","--name","--email","--phone","--given","--family","--organization","--postal","--birthday","--note","--since","--contact"]) {
        const val = flagVal(filtered, flag)
        if (val !== undefined) action[flag.replace(/^--/, "").replace(/-/g, "_")] = val
      }
      const cLimit = flagInt(filtered, "--limit"); if (cLimit !== undefined) action.limit = cLimit
      const cOffset = flagInt(filtered, "--offset"); if (cOffset !== undefined) action.offset = cOffset
      const positional = filtered[3]
      if (positional && !positional.startsWith("--")) action.id = positional
      // Free-text query for find
      if (verb === "find" && filtered[3] && !filtered[3].startsWith("--")) action.query = filtered[3]
      if (verb === "import-vcard") action.path = filtered[3]
      if (verb === "vcard") action.id = filtered[3]
      return action
    }

    case "appintent": {
      const verb = filtered[2] || "list"
      const action: Action = { type: "macos_appintent", sub: verb }
      if (verb === "donate") action.intent_id = filtered[3]
      return action
    }

    case "photos": {
      const verb = filtered[2]
      if (!verb) { console.error("error: photos requires a verb (status|request|albums|album|album-create|album-delete|album-rename|assets|asset|export|export-video|export-live|thumbnail|favorite|hide|delete|add-to-album|remove-from-album|import|import-video|current-token|changes)"); process.exit(1) }
      const action: Action = { type: "macos_photos", sub: verb }
      // --type collides with the action envelope's `type` dispatch field;
      // remap to album_type. --limit/--offset must be int-typed because
      // PhotosDomain casts them with `as? Int` (verified — string casts
      // silently drop the value, causing accidental full-library fetches).
      for (const flag of ["--level","--name","--media","--subtype","--since","--until","--where","--out","--size","--asset","--file","--album","--token"]) {
        const val = flagVal(filtered, flag)
        if (val !== undefined) action[flag.replace(/^--/, "").replace(/-/g, "_")] = val
      }
      const pType = flagVal(filtered, "--type")
      if (pType !== undefined) action.album_type = pType
      const pLimit = flagInt(filtered, "--limit"); if (pLimit !== undefined) action.limit = pLimit
      const pOffset = flagInt(filtered, "--offset"); if (pOffset !== undefined) action.offset = pOffset
      if (filtered.includes("--favorite")) action.favorite = true
      if (filtered.includes("--hidden")) action.hidden = true
      if (filtered.includes("--burst")) action.burst = true
      if (filtered.includes("--save")) action.save = true
      if (filtered.includes("--on")) action.on = true
      if (filtered.includes("--off")) action.on = false
      const positional = filtered[3]
      if (positional && !positional.startsWith("--")) action.id = positional
      return action
    }

    case "maps": {
      const verb = filtered[2]
      if (!verb) { console.error("error: maps requires a verb (search|complete|directions|eta|mapitem-open|reverse)"); process.exit(1) }
      const action: Action = { type: "macos_maps", sub: verb }
      if (verb === "search" || verb === "complete") action.query = filtered[3]
      if (verb === "reverse") action.coords = filtered[3]
      if (verb === "mapitem-open") action.id = filtered[3]
      for (const flag of ["--region","--types","--poi-categories","--address-include","--address-exclude","--limit","--from","--to","--transport"]) {
        const val = flagVal(filtered, flag)
        if (val !== undefined) action[flag.replace(/^--/, "").replace(/-/g, "_")] = val
      }
      if (filtered.includes("--requests-alternates")) action.requests_alternates = true
      return action
    }

    case "location": {
      const verb = filtered[2]
      if (!verb) { console.error("error: location requires a verb (status|request|request-temporary-accuracy|current|monitor|significant|visits|heading|geocode|reverse|distance|postal-geocode)"); process.exit(1) }
      const action: Action = { type: "macos_location", sub: verb }
      // Sub-sub verbs (start/stop/tail) for monitor / significant / visits / heading
      if (["monitor","significant","visits","heading"].includes(verb)) {
        const sub2 = filtered[3]
        if (!sub2) { console.error(`error: location ${verb} requires start|stop${verb === "monitor" ? "|tail" : ""}`); process.exit(1) }
        action.sub = `${verb}_${sub2}`
      }
      if (verb === "geocode") action.address = filtered[3]
      if (verb === "reverse") action.coords = filtered[3]
      if (verb === "postal-geocode") action.postal = filtered[3]
      for (const flag of ["--level","--purpose","--accuracy","--region","--locale","--from","--to"]) {
        const val = flagVal(filtered, flag)
        if (val !== undefined) action[flag.replace(/^--/, "").replace(/-/g, "_")] = val
      }
      return action
    }

    case "music": {
      const verb = filtered[2]
      // Catalog verbs (search/search-suggest/charts/recommendations and the
      // song/album/artist/playlist by-catalog-id fetchers) require an Apple
      // Developer MusicKit team key, which interceptor-bridge does not ship
      // with. Apple's MusicCatalog* APIs return "Failed to request developer
      // token" without it. Removed from the verb surface; only library,
      // subscription state, and playback control remain.
      if (!verb) { console.error("error: music requires a verb (status|request|subscription|library|library-search|play|pause|resume|stop|next|previous|seek|queue|repeat|shuffle|now-playing)"); process.exit(1) }
      const action: Action = { type: "macos_music", sub: verb }
      if (["library-search"].includes(verb)) action.term = filtered[3]
      if (verb === "repeat" || verb === "shuffle") action.mode = filtered[3]
      for (const flag of ["--types","--limit","--offset","--filter","--sort","--song","--playlist","--time","--kind"]) {
        const val = flagVal(filtered, flag)
        if (val !== undefined) action[flag.replace(/^--/, "").replace(/-/g, "_")] = val
      }
      if (filtered.includes("--top")) action.top = true
      if (filtered.includes("--ascending")) action.ascending = true
      if (filtered.includes("--include-tracks")) action.include_tracks = true
      if (filtered.includes("--include-system")) action.include_system = true
      return action
    }

    case "share": {
      const verb = filtered[2]
      if (!verb) { console.error("error: share requires a verb (services|airdrop|email|message|reading-list|desktop-picture|named|text|url)"); process.exit(1) }
      const action: Action = { type: "macos_share", sub: verb }
      if (verb === "named") {
        // Positional form: `share named <service> [items]`. Skip when the
        // first positional is actually a flag (`--service ...`); that case
        // is handled by the flagVal pass below.
        if (filtered[3] && !filtered[3].startsWith("--")) {
          action.service = filtered[3]
          if (filtered[4] && !filtered[4].startsWith("--")) action.items = filtered[4].split(",")
        }
      } else if (verb === "text" || verb === "url") {
        action.value = filtered[3]
      } else if (verb !== "services") {
        const items = filtered[3]
        if (items && !items.startsWith("--")) action.items = items.split(",")
      }
      const recipient = flagVal(filtered, "--recipient"); if (recipient) action.recipient = recipient
      const recipients = flagVal(filtered, "--to") || flagVal(filtered, "--recipients"); if (recipients) action.recipients = recipients.split(",")
      const subject = flagVal(filtered, "--subject"); if (subject) action.subject = subject
      const body = flagVal(filtered, "--body"); if (body) action.body = body
      const service = flagVal(filtered, "--service"); if (service) action.service = service
      const forItem = flagVal(filtered, "--for"); if (forItem) action.for_item = forItem
      // Canned verbs (airdrop / email / message / reading-list / desktop-picture)
      // can also accept content via --text or --url. Bridge resolveItems()
      // unifies items / text / url / body into a single payload.
      const text = flagVal(filtered, "--text"); if (text) action.text = text
      const url = flagVal(filtered, "--url"); if (url) action.url = url
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
  options: { allowStructuredIntent?: boolean } = {}
): Action {
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

function flagInt(args: string[], flag: string): number | undefined {
  const val = flagVal(args, flag)
  if (val === undefined) return undefined
  const n = parseInt(val)
  return isNaN(n) ? undefined : n
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
