/**
 * cli/commands/cdp.ts — `interceptor macos cdp <sub>` and
 * `interceptor macos cdp app <sub>`.
 *
 * cdp  = Path A (direct CDP over --remote-debugging-port).
 * app  = Path 0 (inspector-bootstrap + resident MV2 extension; "app:<name>"
 *        contexts are then driven with the normal verbs via --context).
 *
 * These commands need the daemon but NOT the Swift bridge — process detection,
 * SIGUSR1, and relaunch are all daemon-side, so macos cdp/app work in
 * browser-only mode too (unlike `interceptor macos *`).
 */

import { sendCommand, type DaemonResponse, type DaemonResult } from "../transport"

type Action = { type: string; [key: string]: unknown }

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  const v = args[idx + 1]
  if (!v || v.startsWith("--")) return undefined
  return v
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function unwrap(resp: DaemonResponse): DaemonResult {
  return resp.result
}

async function send(action: Action, contextId?: string): Promise<DaemonResult> {
  try {
    return unwrap(await sendCommand(action, undefined, contextId))
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

function emit(result: DaemonResult, jsonMode: boolean): void {
  if (jsonMode) {
    const errPayload =
      result.data && typeof result.data === "object" && !Array.isArray(result.data)
        ? { error: result.error, ...(result.data as Record<string, unknown>) }
        : { error: result.error }
    console.log(JSON.stringify(result.success ? (result.data ?? null) : errPayload))
    return
  }
  if (!result.success) {
    console.error(`error: ${result.error || "unknown error"}`)
    return
  }
  const data = result.data
  if (data === undefined || data === null) {
    console.log("ok")
  } else if (typeof data === "string") {
    console.log(data)
  } else {
    console.log(JSON.stringify(data, null, 2))
  }
}

const CDP_HELP = `interceptor macos cdp <subcommand>   (Path A — direct CDP over --remote-debugging-port)
  connect <port> [--host H] [--app NAME] [--url HINT]   attach to a debug port
  targets [--context cdp:<id>]                          list debuggable targets
  attach <targetId> [--context cdp:<id>]                switch attached target
  detach [--context cdp:<id>]                           close the CDP connection
  status                                                list connected CDP contexts
  raw <Method> [jsonParams] [--context cdp:<id>]        send any CDP method
  discover                                              list running Electron apps
  launch <app> [--port N] --confirm                     relaunch app w/ debug flag (loses unsaved state)

Then drive it with the normal verbs:
  interceptor eval --context cdp:<id> --main "location.href"
  interceptor read --context cdp:<id>
  interceptor screenshot --context cdp:<id>`

const APP_HELP = `interceptor macos cdp app <subcommand>   (Path 0 — load the Interceptor extension into a running Electron app)
  attach <app> [--pid N] [--inspect-port N] [--ext-dir DIR] [--allow-sigusr1]
                                                               SIGUSR1 + loadExtension, register app:<name>
                                                               refuses SIGUSR1 when an existing CDP port is present
  detach <app|--context app:<id>>                             drop tracking (extension stays until app restart)
  status                                                      list Electron apps + attach state
  discover                                                    list running Electron apps + CDP/fuse status

Then drive it like any browser context:
  interceptor read --context app:<name>
  interceptor eval --context app:<name> --main "location.href"`

export async function runCdpCommand(
  filtered: string[],
  opts: { jsonMode?: boolean; useWs?: boolean; contextId?: string },
): Promise<void> {
  const familyIndex = filtered[0] === "macos" ? 1 : 0
  const nestedApp = filtered[0] === "macos" && filtered[1] === "cdp" && filtered[2] === "app"
  const family = nestedApp ? "app" : filtered[familyIndex] // "cdp" | "app"
  const sub = nestedApp ? filtered[3] : filtered[familyIndex + 1]
  const commandArgs = nestedApp ? filtered.slice(2) : filtered.slice(familyIndex)
  const jsonMode = opts.jsonMode === true
  const contextId = opts.contextId ?? flagValue(filtered, "--context")

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(family === "app" ? APP_HELP : CDP_HELP)
    return
  }

  if (family === "cdp") {
    await runCdp(sub, commandArgs, contextId, jsonMode)
    return
  }
  if (family === "app") {
    await runApp(sub, commandArgs, contextId, jsonMode)
    return
  }
  console.error(`error: unknown macOS runtime channel '${family}'`)
  process.exit(1)
}

async function runCdp(sub: string, args: string[], contextId: string | undefined, jsonMode: boolean): Promise<void> {
  switch (sub) {
    case "connect": {
      const port = parseInt(args[2] ?? "", 10)
      if (Number.isNaN(port)) { console.error("error: macos cdp connect requires a numeric port"); process.exit(1) }
      const result = await send({
        type: "cdp_connect",
        port,
        host: flagValue(args, "--host"),
        app: flagValue(args, "--app"),
        urlHint: flagValue(args, "--url"),
      })
      emit(result, jsonMode)
      if (!result.success) process.exit(1)
      return
    }
    case "targets": {
      emitExit(await send({ type: "cdp_targets", contextId }, contextId), jsonMode)
      return
    }
    case "attach": {
      const targetId = args[2]
      if (!targetId || targetId.startsWith("--")) { console.error("error: macos cdp attach requires a targetId"); process.exit(1) }
      emitExit(await send({ type: "cdp_attach", targetId, contextId }, contextId), jsonMode)
      return
    }
    case "detach": {
      emitExit(await send({ type: "cdp_detach", contextId }, contextId), jsonMode)
      return
    }
    case "status": {
      emitExit(await send({ type: "cdp_status" }), jsonMode)
      return
    }
    case "raw": {
      const method = args[2]
      if (!method || method.startsWith("--")) { console.error("error: macos cdp raw requires a method"); process.exit(1) }
      const params = args[3] && !args[3].startsWith("--") ? args[3] : undefined
      emitExit(await send({ type: "cdp_raw", method, params, contextId }, contextId), jsonMode)
      return
    }
    case "discover": {
      emitExit(await send({ type: "cdp_discover" }), jsonMode)
      return
    }
    case "launch": {
      const app = args[2]
      if (!app || app.startsWith("--")) { console.error("error: macos cdp launch requires an app name"); process.exit(1) }
      const port = flagValue(args, "--port")
      if (!hasFlag(args, "--confirm")) {
        console.error(`Relaunching "${app}" will QUIT it and lose any unsaved state.`)
        console.error(`Re-run with --confirm to proceed:`)
        console.error(`  interceptor macos cdp launch ${app}${port ? ` --port ${port}` : ""} --confirm`)
        process.exit(1)
      }
      emitExit(await send({ type: "cdp_launch", app, port: port ? parseInt(port, 10) : undefined }), jsonMode)
      return
    }
    default:
      console.log(CDP_HELP)
  }
}

async function runApp(sub: string, args: string[], contextId: string | undefined, jsonMode: boolean): Promise<void> {
  switch (sub) {
    case "attach": {
      const app = args[2] && !args[2].startsWith("--") ? args[2] : undefined
      const pidStr = flagValue(args, "--pid")
      const pid = pidStr ? parseInt(pidStr, 10) : undefined
      if (pidStr && !Number.isFinite(pid)) { console.error("error: --pid must be numeric"); process.exit(1) }
      const inspectStr = flagValue(args, "--inspect-port")
      const inspectPort = inspectStr ? parseInt(inspectStr, 10) : undefined
      if (inspectStr && !Number.isFinite(inspectPort)) { console.error("error: --inspect-port must be numeric"); process.exit(1) }
      if (!app && pid === undefined) { console.error("error: macos cdp app attach requires an app name or numeric --pid"); process.exit(1) }
      const result = await send({
        type: "app_attach",
        app,
        pid,
        inspectPort,
        extPath: flagValue(args, "--ext-dir"),
        allowSigusr1: hasFlag(args, "--allow-sigusr1"),
      })
      emit(result, jsonMode)
      // Path 0 unavailable → guide to the Path A fallback (no silent state loss).
      const data = (result.data ?? {}) as { fuseLikelyOff?: boolean; fallback?: string; remoteDebuggingPort?: number }
      if (!result.success && (data.fuseLikelyOff || data.fallback === "cdp")) {
        const name = app ?? "<app>"
        console.error("")
        console.error("Path 0 (extension) unavailable for this app. Fallback to direct CDP:")
        if (typeof data.remoteDebuggingPort === "number") {
          console.error(`  interceptor macos cdp connect ${data.remoteDebuggingPort} --app ${name}`)
        } else {
          console.error(`  interceptor macos cdp launch ${name} --port 9222 --confirm   # relaunch with the debug flag`)
          console.error(`  interceptor macos cdp connect 9222 --app ${name}            # then attach over CDP`)
        }
      }
      if (!result.success) process.exit(1)
      return
    }
    case "detach": {
      const app = args[2] && !args[2].startsWith("--") ? args[2] : undefined
      emitExit(await send({ type: "app_detach", app, contextId }, contextId), jsonMode)
      return
    }
    case "status": {
      emitExit(await send({ type: "app_status" }), jsonMode)
      return
    }
    case "discover": {
      emitExit(await send({ type: "app_discover" }), jsonMode)
      return
    }
    default:
      console.log(APP_HELP)
  }
}

function emitExit(result: DaemonResult, jsonMode: boolean): void {
  emit(result, jsonMode)
  if (!result.success) process.exit(1)
}
