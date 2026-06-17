/**
 * cli/commands/native.ts — implementation for `interceptor macos runtime <sub>`.
 *
 * Lifecycle (discover/enable/disable/status/signid) routes to the Swift bridge
 * (`macos_native_*`). Verbs (tree/eval/mutate/intercept/screenshot/watch/net/ping/
 * delegate) route by `--context runtime:<app>` to the in-process agent, which the
 * daemon reaches over the same WebSocket transport the browser extension uses.
 */

import { writeFileSync } from "fs"
import { sendCommand, type DaemonResponse, type DaemonResult } from "../transport"
import { isNativeContextId } from "../../shared/native-agent"
import { NATIVE_PLATFORM_TARGETS_ENABLED } from "../../shared/native-build-config"

type Action = { type: string; [key: string]: unknown }

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  const v = args[idx + 1]
  if (!v || v.startsWith("--")) return undefined
  return v
}
function hasFlag(args: string[], flag: string): boolean { return args.includes(flag) }

async function send(action: Action, contextId?: string): Promise<DaemonResult> {
  try {
    return (await sendCommand(action, undefined, contextId)).result
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
  if (!result.success) { console.error(`error: ${result.error || "unknown error"}`); return }
  const data = result.data
  if (data === undefined || data === null) console.log("ok")
  else if (typeof data === "string") console.log(data)
  else console.log(JSON.stringify(data, null, 2))
}
function emitExit(result: DaemonResult, jsonMode: boolean): void {
  emit(result, jsonMode)
  if (!result.success) process.exit(1)
}

/** First positional arg that isn't a flag or the command/subcommand. */
function positional(args: string[], from: number): string | undefined {
  for (let i = from; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith("--")) { if (flagValue(args, a) === args[i + 1]) i++; continue }
    return a
  }
  return undefined
}

/** All positional args from `from` (skips flags + their values + the context id). */
function positionalList(args: string[], from: number, contextId?: string): string[] {
  const out: string[] = []
  for (let i = from; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith("--")) { if (flagValue(args, a) === args[i + 1]) i++; continue }
    if (a === contextId) continue
    out.push(a)
  }
  return out
}

/** C symbols the `cintercept` (fishhook) tier supports — for `runtime hook` auto-routing. */
const C_SYMBOL_ALLOWLIST = new Set<string>(["open", "getaddrinfo", "SecItemCopyMatching"])

const PLATFORM_TARGET_HELP = NATIVE_PLATFORM_TARGETS_ENABLED
  ? "      --allow-platform                     research build only: enable platform target managed-copy support\n"
  : ""

export function nativeHelpText(): string {
  return `interceptor macos runtime <subcommand>

Lifecycle:
  discover [<app>]                         classify running apps + lightest runtime way-in
  enable <app> [--build]                   load the resident agent (own-build / weak-entitlement, no re-sign)
${PLATFORM_TARGET_HELP}  disable <app> [--keep]                   stop + remove the managed copy
  status                                   live agents (daemon) + managed copies (bridge)
  signid                                   show whether a BYO native signing identity is configured

  Hardened targets (re-sign + capability continuity + launch handling) are
  provided by an operator-installed extension's own verb, not the core.

Verbs (need --context runtime:<app>):
  tree | read                              the view + ObjC/Swift runtime graph (gives nN refs)
  layers --ref nN                          the CALayer tree under a view (finds custom-drawn CATextLayer text)
  eval --ref nN --selector title           invoke a selector on a ref
  mutate --ref nN --set-text "Hi"          change a standard control's text
  mutate --ref nN --set-layer-text "Hi"    rewrite CATextLayer text (custom-drawn apps)
  mutate --ref nN --set-alpha 0.3          translucency  | --set-hidden / --set-visible  | --set-bg "#ff0000"
  intercept --class NSButton --selector x  swizzle-redirect a 0-arg void selector
  screenshot [--ref nN] [--out f.png]      render the host's own window in-process
  watch --ref nN --key stringValue         stream KVO changes
  net                                      start network capture (connect/getaddrinfo + URLSession)
  net log [--clear] [--limit N]            the captured endpoints/requests
  ping                                     liveness + window count
  delegate <macos_action>                  run a bridge (TCC) action from inside the app

Hook Fabric:
  hook <Class> <selector>                  set a breakpoint on an ObjC method (captures args+return)
  hook <open|getaddrinfo|SecItemCopyMatching>   intercept a C function (fishhook tier, auto-routed)
  unhook <Class> <selector>                remove an ObjC method hook
  hooks                                    list installed hooks + hit counts
  hook log [--clear] [--limit N]           drain captured hook hits
  trace <Class> [--max N]                  hook every (safe) method of a class
  untrace <Class>                          remove a class trace
  cintercept <symbol> | cintercept list    install a C-symbol interceptor / list the allowlist
  dom-watch                                stream view lifecycle (-[NSView addSubview:/viewWillDraw])
  events [--follow] [--clear] [--limit N]  the unified event stream (hooks + dom + cintercept)
  domains                                  the runtime domain -> commands+events map

Examples:
  interceptor macos runtime mutate --context runtime:<app> --ref nN --set-text "Hi"
  interceptor macos runtime intercept --context runtime:<app> --class X --selector y`
}

export function nativeEnableAction(filtered: string[]): { result: DaemonResult } | { action: Action } {
  const app = positional(filtered, 2)
  if (!app) return { result: { success: false, error: "macos runtime enable requires an app" } }
  if (hasFlag(filtered, "--allow-platform") && !NATIVE_PLATFORM_TARGETS_ENABLED) {
    return {
      result: {
        success: false,
        error: "System platform target support is not included in this build.",
        data: {
          setup_required: {
            reason: "platform_target_support_compiled_out",
            detail: "Use owned-app audit targets or a research build that intentionally enables platform targets.",
          },
        },
      },
    }
  }
  return {
    action: {
      type: "macos_native_enable",
      app,
      // rung-1 (own build) / rung-3 (weak entitlement) only. The hardened-target
      // managed-copy audit flow (re-sign + capability continuity + launch
      // handling) is provided by an operator-installed extension, not
      // the capability-blind core.
      build: hasFlag(filtered, "--build"),
      allowPlatform: hasFlag(filtered, "--allow-platform"),
    },
  }
}

export function removedNativeMapResult(): DaemonResult {
  return {
    success: false,
    error: "`interceptor macos runtime map` was removed. Use `macos runtime tree`, `macos runtime layers`, or `macos runtime js` for generic app-runtime inspection; use the macOS maps/location domains for Maps workflows.",
    data: { removed: "macos runtime map", replacement: ["macos runtime tree", "macos runtime layers", "macos runtime js", "macos maps/location"] },
  }
}

export async function runNativeCommand(
  filtered: string[],
  opts: { jsonMode?: boolean; contextId?: string },
): Promise<void> {
  const jsonMode = opts.jsonMode === true
  const contextId = opts.contextId ?? flagValue(filtered, "--context")

  const sub = filtered[1]
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") { console.log(nativeHelpText()); return }

  switch (sub) {
    case "discover": {
      const app = positional(filtered, 2)
      emitExit(await send({ type: "macos_native_discover", ...(app ? { app } : {}) }), jsonMode)
      return
    }
    case "enable": {
      const parsed = nativeEnableAction(filtered)
      if ("result" in parsed) emitExit(parsed.result, jsonMode)
      else emitExit(await send(parsed.action), jsonMode)
      return
    }
    case "disable": {
      const app = positional(filtered, 2)
      if (!app) { console.error("error: macos runtime disable requires an app"); process.exit(1) }
      emitExit(await send({ type: "macos_native_disable", app, keep: hasFlag(filtered, "--keep") }), jsonMode)
      return
    }
    case "signid": {
      emitExit(await send({ type: "macos_native_signid" }), jsonMode)
      return
    }
    case "status": {
      const agents = await send({ type: "native_status" })
      const copies = await send({ type: "macos_native_status" })
      const merged = {
        agents: agents.success ? agents.data : { error: agents.error },
        managed: copies.success ? copies.data : { error: copies.error },
      }
      emit({ success: true, data: merged }, jsonMode)
      return
    }
    // ── verbs (route to the agent by --context runtime:<app>) ──
    case "ping":
      return void emitExit(await sendVerb({ type: "native_ping" }, contextId), jsonMode)
    case "ax":
      return void emitExit(await sendVerb({ type: "native_ax", pid: numFlag(filtered, "--pid"), text: flagValue(filtered, "--type") }, contextId), jsonMode)
    case "draw": {
      if (hasFlag(filtered, "--clear")) return void emitExit(await sendVerb({ type: "native_draw", op: "clear" }, contextId), jsonMode)
      const nf = (f: string) => { const v = flagValue(filtered, f); return v === undefined ? undefined : Number(v) }
      return void emitExit(await sendVerb({ type: "native_draw",
        ref: flagValue(filtered, "--ref"), shape: flagValue(filtered, "--shape"),
        text: flagValue(filtered, "--text"), font: flagValue(filtered, "--font"),
        x: nf("--x"), y: nf("--y"), w: nf("--w"), h: nf("--h"),
        color: flagValue(filtered, "--color"), color2: flagValue(filtered, "--color2"),
        glow: flagValue(filtered, "--glow"), glowRadius: nf("--glow-radius"),
        radius: nf("--radius"), opacity: nf("--opacity"),
        border: nf("--border"), borderColor: flagValue(filtered, "--border-color"),
        fontSize: nf("--font-size"), animate: flagValue(filtered, "--animate"),
        spin: nf("--spin"), id: flagValue(filtered, "--id") }, contextId), jsonMode)
    }
    case "tcc":
      return void emitExit(await sendVerb({ type: "native_tcc", activate: flagValue(filtered, "--activate") }, contextId), jsonMode)
    case "file":
      return void emitExit(await sendVerb({ type: "native_file", path: positional(filtered, 2) ?? flagValue(filtered, "--path"), bytes: numFlag(filtered, "--bytes") }, contextId), jsonMode)
    case "tree":
    case "read":
      return void emitExit(await sendVerb({ type: "native_tree", depth: numFlag(filtered, "--depth"), all: hasFlag(filtered, "--all") }, contextId), jsonMode)
    case "map":
      return void emitExit(removedNativeMapResult(), jsonMode)
    case "layers":
      return void emitExit(await sendVerb({ type: "native_layers", ref: flagValue(filtered, "--ref"), depth: numFlag(filtered, "--depth") }, contextId), jsonMode)
    case "eval":
      return void emitExit(await sendVerb({ type: "native_eval", ref: flagValue(filtered, "--ref"), selector: flagValue(filtered, "--selector"), arg: flagValue(filtered, "--arg") }, contextId), jsonMode)
    case "js": {
      // inline JavaScript against the live ObjC/Cocoa runtime (the native `eval --main`).
      // code = everything after `js` that isn't a flag, OR --code "<js>".
      const code = flagValue(filtered, "--code") ?? filtered.slice(2).filter(a => !a.startsWith("--") && a !== contextId).join(" ")
      if (!code) { console.error('error: macos runtime js needs inline JS — e.g. macos runtime js \'ObjC.className(ObjC.cls("NSApplication"))\''); process.exit(1) }
      return void emitExit(await sendVerb({ type: "native_js", code }, contextId), jsonMode)
    }
    // ── Runtime Hook Fabric — Debugger/DOM/Network domains ──
    case "hook": {
      // `runtime hook <Class> <selector>` (ObjC) OR `runtime hook <c_symbol>` (auto C-tier).
      // `runtime hook log` drains captured hits.
      if (filtered[2] === "log") {
        return void emitExit(await sendVerb({ type: "native_hook_log", clear: hasFlag(filtered, "--clear"), limit: numFlag(filtered, "--limit") }, contextId), jsonMode)
      }
      const pos = positionalList(filtered, 2, contextId)
      const cls = pos[0]
      const sel = pos[1]
      if (cls && sel) {
        // ObjC method hook (Tier 1) — Class + selector
        return void emitExit(await sendVerb({ type: "native_hook", class: cls, selector: sel, domain: flagValue(filtered, "--domain") }, contextId), jsonMode)
      }
      if (cls && C_SYMBOL_ALLOWLIST.has(cls)) {
        // C-symbol auto-routed to the cintercept tier (C9 tier auto-selection)
        return void emitExit(await sendVerb({ type: "native_cintercept", symbol: cls }, contextId), jsonMode)
      }
      console.error('error: macos runtime hook <Class> <selector>   (ObjC)   |   macos runtime hook <open|getaddrinfo|SecItemCopyMatching>   (C)')
      process.exit(1); return
    }
    case "unhook":
      return void emitExit(await sendVerb({ type: "native_unhook", class: positional(filtered, 2), selector: positional(filtered, 3) }, contextId), jsonMode)
    case "hooks":
      return void emitExit(await sendVerb({ type: "native_hooks" }, contextId), jsonMode)
    case "trace":
      return void emitExit(await sendVerb({ type: "native_trace", class: positional(filtered, 2), max: numFlag(filtered, "--max") }, contextId), jsonMode)
    case "untrace":
      return void emitExit(await sendVerb({ type: "native_untrace", class: positional(filtered, 2) }, contextId), jsonMode)
    case "cintercept":
      if (filtered[2] === "list" || hasFlag(filtered, "--list")) return void emitExit(await sendVerb({ type: "native_cintercept", list: true }, contextId), jsonMode)
      return void emitExit(await sendVerb({ type: "native_cintercept", symbol: positional(filtered, 2) }, contextId), jsonMode)
    case "dom-watch":
      return void emitExit(await sendVerb({ type: "native_dom_watch" }, contextId), jsonMode)
    case "events": {
      if (hasFlag(filtered, "--follow")) {
        // poll-drain the agent buffer and stream new events until Ctrl-C
        const intervalMs = numFlag(filtered, "--interval") ?? 500
        process.stderr.write("streaming runtime events (Ctrl-C to stop)…\n")
        for (;;) {
          const r = await sendVerb({ type: "native_events", clear: true, limit: 500 }, contextId)
          if (!r.success) { console.error(`error: ${r.error || "stream ended"}`); process.exit(1) }
          const evs = ((r.data as { events?: Array<Record<string, unknown>> } | undefined)?.events) ?? []
          for (const e of evs) {
            if (jsonMode) { console.log(JSON.stringify(e)); continue }
            const sig = e.fn ? `${e.fn} ${e.arg ?? ""}` : `-[${e.class} ${e.selector}]`
            const extra = e.args !== undefined ? ` args=${JSON.stringify(e.args)}` : (e.ret !== undefined ? ` ret=${JSON.stringify(e.ret)}` : "")
            console.log(`${e.domain}/${e.event}  ${sig}${extra}`)
          }
          await new Promise((res) => setTimeout(res, intervalMs))
        }
      }
      return void emitExit(await sendVerb({ type: "native_events", clear: hasFlag(filtered, "--clear"), limit: numFlag(filtered, "--limit") }, contextId), jsonMode)
    }
    case "domains":
      return void emitExit(await sendVerb({ type: "native_domains" }, contextId), jsonMode)
    case "mutate":
      return void emitExit(await runMutate(filtered, contextId), jsonMode)
    case "intercept":
      return void emitExit(await runIntercept(filtered, contextId), jsonMode)
    case "watch":
      return void emitExit(await sendVerb({ type: "native_watch", ref: flagValue(filtered, "--ref"), key: flagValue(filtered, "--key") }, contextId), jsonMode)
    case "net": {
      if (filtered[2] === "log") {
        return void emitExit(await sendVerb({ type: "native_net_log", clear: hasFlag(filtered, "--clear"), limit: numFlag(filtered, "--limit") }, contextId), jsonMode)
      }
      if (filtered[2] === "bodies") {
        return void emitExit(await sendVerb({ type: "native_net_bodies", host: flagValue(filtered, "--host"), clear: hasFlag(filtered, "--clear"), limit: numFlag(filtered, "--limit") }, contextId), jsonMode)
      }
      return void emitExit(await sendVerb({ type: "native_net" }, contextId), jsonMode)
    }
    case "screenshot":
      return void runScreenshot(filtered, contextId, jsonMode)
    case "delegate": {
      const macosType = positional(filtered, 2)
      if (!macosType) { console.error("error: macos runtime delegate requires a macos_* action type"); process.exit(1) }
      return void emitExit(await sendVerb({ type: "native_delegate", action: { type: macosType } }, contextId), jsonMode)
    }
    default:
      console.log(nativeHelpText())
  }
}

function numFlag(args: string[], flag: string): number | undefined {
  const v = flagValue(args, flag)
  if (v === undefined) return undefined
  const n = parseInt(v, 10)
  return Number.isNaN(n) ? undefined : n
}

function requireNativeContext(contextId?: string): string | null {
  if (!isNativeContextId(contextId)) {
    console.error("error: this verb needs --context runtime:<app> (run `interceptor macos runtime enable <app>` first)")
    return null
  }
  return contextId
}

async function sendVerb(action: Action, contextId?: string): Promise<DaemonResult> {
  const ctx = requireNativeContext(contextId)
  if (!ctx) process.exit(1)
  return send(action, ctx)
}

async function runMutate(args: string[], contextId?: string): Promise<DaemonResult> {
  const ref = flagValue(args, "--ref")
  if (!ref) return { success: false, error: "macos runtime mutate requires --ref nN" }
  const action: Action = { type: "native_mutate", ref }
  const text = flagValue(args, "--set-text"); if (text !== undefined) action.set_text = text
  const layerText = flagValue(args, "--set-layer-text"); if (layerText !== undefined) action.set_layer_text = layerText
  const alpha = flagValue(args, "--set-alpha"); if (alpha !== undefined) action.set_alpha = parseFloat(alpha)
  const bg = flagValue(args, "--set-bg"); if (bg !== undefined) action.set_bg = bg
  if (args.includes("--set-hidden")) action.set_hidden = true
  if (args.includes("--set-visible")) action.set_hidden = false
  const has = ["set_text", "set_layer_text", "set_alpha", "set_bg", "set_hidden"].some(k => k in action)
  if (!has) return { success: false, error: "macos runtime mutate needs one of --set-text / --set-layer-text / --set-alpha <0-1> / --set-hidden / --set-visible / --set-bg <#RRGGBB>" }
  return sendVerb(action, contextId)
}

async function runIntercept(args: string[], contextId?: string): Promise<DaemonResult> {
  const cls = flagValue(args, "--class")
  const selector = flagValue(args, "--selector")
  if (!cls || !selector) return { success: false, error: "macos runtime intercept requires --class <ObjCClass> --selector <selector>" }
  return sendVerb({ type: "native_intercept", class: cls, selector }, contextId)
}

async function runScreenshot(args: string[], contextId: string | undefined, jsonMode: boolean): Promise<void> {
  const result = await sendVerb({ type: "native_screenshot", ref: flagValue(args, "--ref") }, contextId)
  if (!result.success) { emitExit(result, jsonMode); return }
  const data = result.data as { base64?: string; width?: number; height?: number } | undefined
  const out = flagValue(args, "--out")
  if (out && data?.base64) {
    writeFileSync(out, Buffer.from(data.base64, "base64"))
    emit({ success: true, data: { saved: out, width: data.width, height: data.height } }, jsonMode)
    return
  }
  // Don't dump base64 to the terminal; show metadata.
  emit({ success: true, data: { width: data?.width, height: data?.height, bytes: data?.base64 ? Buffer.byteLength(data.base64, "base64") : 0, hint: "pass --out <file.png> to save" } }, jsonMode)
}
