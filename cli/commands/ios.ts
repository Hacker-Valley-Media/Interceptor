/**
 * cli/commands/ios.ts — `interceptor ios <sub>`.
 *
 * Drive any installed app on an owned, unlocked, Developer-Mode iPhone via our
 * own on-device InterceptorRunner (XCUITest), brokered by the daemon-resident
 * IosManager and addressed by `--context ios:<udid>`. Needs the daemon but NOT
 * the Swift bridge — the device channel is daemon-side (xcrun devicectl/simctl +
 * xcodebuild launch; the runner then dials back over WebSocket), so
 * `interceptor ios` works in browser-only mode too.
 */

import { sendCommand, type DaemonResponse, type DaemonResult } from "../transport"
import { helpForCommand } from "../help"
import { runIosWebCommand } from "./ios-web"
import { runIosSvcCommand } from "./ios-svc"
import { runIosDevCommand } from "./ios-dev"
import { resolve } from "node:path"

/** Device-service introspection subcommands, delegated to ios-svc.ts. */
const IOS_SVC_SUBCOMMANDS = new Set(["diag", "logs", "fs", "crash", "profiles", "notify", "springboard"])

/** Instruments / telemetry / developer-service subcommands, delegated to ios-dev.ts. */
const IOS_DEV_SUBCOMMANDS = new Set(["proc", "ps", "top", "spawn", "kill", "location", "gpu", "shot", "backup", "screen", "axtree"])

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

/** Non-flag tokens from `start` on, skipping the operands of the listed value flags. */
function positionalsExcept(args: string[], start: number, valueFlags: string[]): string[] {
  const out: string[] = []
  for (let i = start; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith("--")) { if (valueFlags.includes(a)) i++; continue }
    out.push(a)
  }
  return out
}

/** `ios scroll [<ref> | --x N --y N] [--dir <d>]`: half a coordinate pair is an error, not a swipe from the center. */
/** `ios keys Enter|Return|Tab` presses that key; anything else is typed literally (XCUITest typeText). */
export function iosKeysText(text: string): string {
  const named: Record<string, string> = { enter: "\n", return: "\n", tab: "\t" }
  return named[text.toLowerCase()] ?? text
}

export function buildIosScrollAction(args: string[]): Action {
  const ref = args[2] && !args[2].startsWith("--") ? args[2] : undefined
  const x = numFlag(args, "--x"), y = numFlag(args, "--y")
  if ((args.includes("--x") || args.includes("--y")) && (x === undefined || y === undefined)) {
    console.error("error: ios scroll needs both --x <n> and --y <n>"); process.exit(1)
  }
  return { type: "ios_scroll", ref, x, y, dir: flagValue(args, "--dir") ?? "down" }
}

/** `ios click [<ref> | --x N --y N]`: a ref, or a screen point with fractions kept. */
export function buildIosClickAction(args: string[]): Action {
  const ref = args[2] && !args[2].startsWith("--") ? args[2] : undefined
  return { type: "ios_click", ref, x: numFlag(args, "--x"), y: numFlag(args, "--y") }
}

export const MAX_IOS_DRAG_DURATION_S = 55

/** `ios drag <from> <to> [--duration s]`: each end is a ref or "x,y"; the same point twice is a long press. */
export function buildIosDragAction(args: string[]): Action {
  const from = args[2], to = args[3]
  if (!from || !to || from.startsWith("--") || to.startsWith("--")) {
    console.error("error: ios drag requires <from> <to>: each a ref or an x,y coordinate"); process.exit(1)
  }
  // Seconds, fractional allowed: parseInt turned a 1.5 s long press into 1 s and 0.5 s into 0.
  const raw = flagValue(args, "--duration")
  const duration = raw === undefined ? undefined : Number(raw)
  if (duration !== undefined && !(Number.isFinite(duration) && duration >= 0)) {
    console.error("error: ios drag --duration takes seconds, for example 0.6 or 2"); process.exit(1)
  }
  // The CLI, the daemon, and the runner channel all stop waiting at 60 s. A longer hold could
  // still land after the caller was told it timed out, so refuse it before anything is sent.
  if (duration !== undefined && duration > MAX_IOS_DRAG_DURATION_S) {
    console.error(`error: ios drag --duration is at most ${MAX_IOS_DRAG_DURATION_S} seconds (the gesture deadline is 60 s)`); process.exit(1)
  }
  return { type: "ios_drag", from, to, duration }
}

/** One finger of `ios gesture`: `x,y[@ms][>x,y@ms...]`. A single sample lifts at `--hold`. */
export type GestureSample = { x: number; y: number; t: number }

export function parseGestureFinger(spec: string, holdMs: number): GestureSample[] | { error: string } {
  const samples: GestureSample[] = []
  for (const part of spec.split(">")) {
    const m = part.trim().match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:@(\d+(?:\.\d+)?))?$/)
    if (!m) return { error: `'${part.trim()}' is not x,y or x,y@ms` }
    if (m[3] === undefined && samples.length) return { error: `'${part.trim()}' needs a time offset (x,y@ms) after the first sample` }
    samples.push({ x: Number(m[1]), y: Number(m[2]), t: m[3] === undefined ? 0 : Number(m[3]) })
  }
  if (samples.length === 1) samples.push({ ...samples[0], t: samples[0].t + holdMs })
  return samples
}

/** `ios gesture <finger> [<finger> ...] [--hold ms]`: every positional is one finger. */
export function buildIosGestureAction(args: string[]): Action {
  const holdRaw = flagValue(args, "--hold")
  const holdMs = holdRaw === undefined ? 100 : Number(holdRaw)
  if (!(Number.isFinite(holdMs) && holdMs >= 0)) { console.error("error: ios gesture --hold takes milliseconds, for example 600"); process.exit(1) }
  const specs = positionalsExcept(args, 2, ["--hold", "--on", "--context"])
  if (!specs.length) {
    console.error('error: ios gesture requires at least one finger, e.g. ios gesture "380,700@0>380,700@600" "120,650@100>120,650@300"'); process.exit(1)
  }
  if (specs.length > 10) { console.error("error: ios gesture takes at most 10 fingers"); process.exit(1) }
  const fingers: GestureSample[][] = []
  for (const spec of specs) {
    const finger = parseGestureFinger(spec, holdMs)
    if ("error" in finger) { console.error(`error: ios gesture: ${finger.error}`); process.exit(1) }
    fingers.push(finger)
  }
  return { type: "ios_gesture", fingers }
}

/** `ios stream start|stop|status [--fps N] [--scale S] [--quality Q] [--out <path>]`. */
export function buildIosStreamAction(args: string[], cwd = process.cwd()): Action {
  const op = args[2] && !args[2].startsWith("--") ? args[2] : undefined
  if (!op || !["start", "stop", "status"].includes(op)) { console.error("error: ios stream requires start|stop|status"); process.exit(1) }
  const action: Action = { type: "ios_stream", op }
  if (op !== "start") return action
  const ranges: Array<[string, number, number]> = [["--fps", 1, 30], ["--scale", 0.1, 1], ["--quality", 0.05, 1]]
  for (const [flag, lo, hi] of ranges) {
    if (!hasFlag(args, flag)) continue
    const n = Number(flagValue(args, flag))
    if (!(Number.isFinite(n) && n >= lo && n <= hi)) { console.error(`error: ios stream ${flag} must be ${lo} to ${hi}`); process.exit(1) }
    action[flag.slice(2)] = n
  }
  if (hasFlag(args, "--out")) {
    const out = flagValue(args, "--out")
    if (!out) { console.error("error: ios stream --out requires a path"); process.exit(1) }
    action.out = resolve(cwd, out)
  }
  return action
}

/** A numeric flag with fractions kept: Vision boxes give fractional points, and parseInt turned 10.7 into 10. */
function numFlag(args: string[], flag: string): number | undefined {
  const v = flagValue(args, flag)
  if (v === undefined || v.trim() === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

async function send(action: Action, contextId?: string): Promise<DaemonResult> {
  try {
    const resp: DaemonResponse = await sendCommand(action, undefined, contextId)
    return resp.result
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
  if (data === undefined || data === null) console.log("ok")
  else if (typeof data === "string") console.log(data)
  else console.log(JSON.stringify(data, null, 2))
}

function emitExit(result: DaemonResult, jsonMode: boolean): void {
  emit(result, jsonMode)
  if (!result.success) process.exit(1)
}

// Progressive disclosure: before any phone has the agent, only the setup verbs
// are shown. Once a device is ready, the full automation surface appears.
const SETUP_HELP = `interceptor ios — automate your iPhone

Get started (requires Xcode signed in with your Apple ID) —   setup [<device>] [--team <id>] [--project <xcodeproj>]
                            build/sign + install + launch on your phone. Idempotent.
                            One-time Apple-mandated steps it will prompt for:
                              • plug in over USB, tap "Trust This Computer" (+ passcode)
                              • enable Developer Mode (Settings > Privacy & Security), reboot
                              • trust the certificate (Settings > General > VPN & Device Management)
  refresh [<device>]        force a re-sign now (also runs on a timer before expiry)

Unsupported compatibility command:
  login                     fails before password input; use ios setup
  logout                    remove legacy stored Apple-ID data

Signed-runner path:
  install [<device>]        reinstall a runner previously signed by ios setup
  devices                   list iPhones that have the agent
  name <device> <alias>     give a phone a friendly name (e.g. "work")

Once installed, run 'interceptor ios' again to see the automation commands.`

const FULL_HELP = `interceptor ios — automate your iPhone

Setup:
  setup [<device>] [--team <id>]             Xcode self-service build/sign + install + launch
  refresh [<device>] [--team <id>]           re-sign now (also automatic before expiry)
  login                                      unavailable; fails before password input and points to setup
  logout                                     remove legacy stored Apple-ID data
  install [<device>]                         reinstall a runner previously signed by setup
  devices                                    phones with the agent (+ names)
  name <device> <alias>                      rename a phone (use it with --on <alias>)

Drive a phone (add --on <name>, or it uses your only phone):
  tree    [--filter interactive|all|full]    on-screen elements (ref-tagged)
  find    --label "Send" [--role button]     find elements
  inspect <ref>                              element details
  click   <ref> | --x N --y N                tap
  type    <ref> "text" | --secret <name>     focus + type (a vault secret by name never shows the value)
  keys    "text"|Enter|Tab | --secret <name>  type into the focused field; Enter/Return/Tab press that key
  unlock  --secret <name> | --probe          lock screen: wake, swipe up, type the passcode (runner must be resident)
  scroll  [<ref> | --x N --y N] [--dir up|down|left|right]
                                             swipe from a ref, a point, or (bare) the screen center; --dir defaults to down
  drag    <from> <to> [--duration s]         each end is a ref or x,y (120,330); the same point twice is a long press
  press   home|lock|volume-up|volume-down    hardware button
  screenshot                                 capture the screen (one JPEG, VLM-budget resized)
  stream  start|stop|status [--fps N] [--scale S] [--quality Q] [--out <path>]
                                             the runner pushes JPEG frames continuously (default 10 fps, half size, quality 0.3);
                                             --out is rewritten atomically with every frame, so a loop just reads that file
  frame   [--out <path>]                     save the newest streamed frame (no device round trip)
  gesture <finger> [<finger>...] [--hold ms] multi-touch: each finger is x,y[@ms][>x,y@ms...]; a lone x,y presses at 0 and
                                             lifts at --hold (default 100). "380,700@0>380,700@600" "120,650@100>120,650@300"
                                             holds a pedal 600 ms while an arrow is tapped from 100 to 300 ms. Hold over 500 ms
                                             or UIKit reads a tap. Same screen points as click and drag.
  apps                                       installed apps
  app     launch|activate|terminate <id>     app lifecycle
  eval    "<js>" | --file <f.js>              run a JS program in the on-device brain (Interceptor.tree/tap/type/sleep/log/foreground)

Connection model (how the runner reaches the phone):
  • The phone runs an on-device XCUITest runner (InterceptorRunner) that DIALS IN
    to the daemon over WiFi.
  • 'devices' shows "connected: false" when the runner isn't dialed in. That is
    "installed, will auto-connect on the next drive verb", NOT "broken" or "offline".
    ('ios unlock' is the exception: it needs the runner already connected.)
  • You do NOT need to connect manually. Just run a verb — e.g.
    'interceptor ios tree --on <name>' — and the daemon launches the runner and
    the phone dials in. 'connected' flips to true for the life of that session.
  • 'ios unlock --secret ios-passcode' types the passcode into the lock screen while the
    runner is still resident (Auto-Lock off keeps it that way). After a reboot the runner
    cannot start on a locked phone: unlock once by hand, then drive as usual.
  • Keep the phone UNLOCKED and AWAKE while driving. Auto-lock / sleep tears the
    runner down (you'll see connected:false again and the next verb re-launches).
  • If a verb hangs or times out: confirm the phone is unlocked and reachable —
    'interceptor ios status' shows the live context plus the dial-back address the
    runner is handed (dialBack / dialBackVia); 'xcrun devicectl list devices'
    shows whether macOS sees it as "available". iOS silently blocks a backgrounded
    runner's LAN connection until Settings › Privacy & Security › Local Network
    grants InterceptorRunner-Runner, so the daemon prefers a VPN address (Tailscale)
    when the Mac has one — put the phone on the same VPN, or grant that switch once.

Troubleshooting — when things aren't working, try these IN ORDER:
  1. "device not found" / "not visible to usbmuxd" — the phone dropped off the
     Mac's device bus. Most common right after a device REBOOT: the whole tunnel
     rides usbmuxd, and its WiFi route is cleared on reboot even though
     'xcrun devicectl list devices' still shows the phone "available".
       → Plug the iPhone in by USB for ~10s (then you may unplug — WiFi resumes).
         This re-seeds usbmuxd instantly. Or restart it:
         'sudo launchctl kickstart -k system/com.apple.usbmuxd'.
  2. "Before First Unlock" — after a reboot, developer services stay locked until
     you enter the PASSCODE once (Face ID alone won't leave this state). Unlock
     with the passcode, then retry.
  2b. Runner verbs time out with 'timeout requesting channel …XCTestManager_IDEInterface'
     but Instruments (proc/top/shot) works — the FIRST XCUITest launch after a
     reboot pops an on-device dialog: "Enter iPhone Passcode for XCTest — Enable
     UI Automation". iOS gates the runner until the passcode is entered ON THE
     PHONE. This sheet has no software input path: the runner is the process it
     blocks, 'ios unlock'/'keys --secret' need that runner, AccessibilityAudit and
     Accessibility Inspector can read it but every action on it is unsupported,
     Switch Control cannot target a digit, and iPhone Mirroring does not forward
     keystrokes to it. Agents: STOP and ask for a tap on the phone (or a paired
     hardware keyboard). Then restart the daemon (so it drops the stale
     testmanagerd session) and retry a verb.
  3. Verbs time out / Instruments (proc, top, shot) return nothing — the Developer
     Disk Image unmounts every boot. Re-mount it:
       'xcrun devicectl device info details --device <udid>'   (brings back
       testmanagerd/Instruments), then retry.
  4. Runner drops mid-sequence ('ios runner disconnected') — iOS can suspend the
     runner's socket when it backgrounds to drive another app. Keep the phone
     UNLOCKED with Auto-Lock = Never (Settings › Display & Brightness › Auto-Lock).
     The next verb re-launches it automatically.
  5. Still stuck — capture detail with 'DEBUG_IOS=1 DBG=1' in the daemon env, and
     check 'interceptor ios status' (tunnel/connection) + 'interceptor ios devices'.

Phones connect automatically — no enable, no cable required once paired over WiFi.
Drives UI only: nothing can fake Face ID or Apple Pay. Passcode sheets are typed from the vault
('ios type <ref> --secret ios-passcode' after tapping "Enter Passcode"), and 'ios unlock --secret'
unlocks the lock screen while the runner is resident.`

export async function runIosCommand(
  filtered: string[],
  opts: { jsonMode?: boolean; contextId?: string },
): Promise<void> {
  // filtered = ["ios", <sub>, ...args]
  const sub = filtered[1]
  const args = filtered
  const jsonMode = opts.jsonMode === true
  // `--on <name>` is the friendly device selector; `--context` still works.
  const contextId = opts.contextId ?? flagValue(filtered, "--on") ?? flagValue(filtered, "--context")

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    // Progressive disclosure: show the full surface only once a phone has the agent.
    const dev = await send({ type: "ios_devices" })
    const list = (dev.success && dev.data && typeof dev.data === "object") ? (dev.data as { devices?: unknown[] }).devices : undefined
    console.log(Array.isArray(list) && list.length > 0 ? FULL_HELP : SETUP_HELP)
    return
  }

  // `interceptor ios <sub> --help` / `-h`: the top-level CLI routes every
  // `ios … --help` here expecting help, so answer it BEFORE any lane is
  // delegated or any daemon request is sent. Without this, `ios setup --help`
  // performed a full build/sign/install. `web` keeps its own help page.
  if (sub !== "web" && args.slice(2).some((a) => a === "--help" || a === "-h")) {
    console.log(helpForCommand("ios", sub) ?? FULL_HELP)
    return
  }

  // ios web … — the WebKit-inspection lane. Delegated wholesale.
  if (sub === "web") { await runIosWebCommand(filtered, { jsonMode, contextId }); return }

  // ios diag|logs|fs|crash|profiles|notify|springboard — device-service
  // introspection lane. Runner-free classic Lockdown.
  if (sub && IOS_SVC_SUBCOMMANDS.has(sub)) { await runIosSvcCommand(filtered, { jsonMode, contextId }); return }

  // ios proc|top|spawn|kill|location|gpu|shot|backup|screen|axtree —
  // Instruments/DTX + telemetry + developer-service lanes. Runner-free.
  if (sub && IOS_DEV_SUBCOMMANDS.has(sub)) { await runIosDevCommand(filtered, { jsonMode, contextId }); return }

  // device ref for setup commands = first non-flag positional after the subcommand
  const deviceRef = args[2] && !args[2].startsWith("--") ? args[2] : undefined

  switch (sub) {
    case "install":
      emitExit(await send({ type: "ios_install", device: deviceRef }), jsonMode)
      return

    case "devices":
      emitExit(await send({ type: "ios_devices" }), jsonMode)
      return

    case "name": {
      const alias = args[3] && !args[3].startsWith("--") ? args[3] : undefined
      if (!deviceRef || !alias) { console.error("usage: interceptor ios name <device> <alias>"); process.exit(1) }
      emitExit(await send({ type: "ios_name", device: deviceRef, alias }), jsonMode)
      return
    }

    // Retained for older clients, but fail before touching terminal or stdin.
    case "login": {
      console.error("error: ios login is unavailable because no-Xcode Apple-ID signing is not implemented. Use: interceptor ios setup [device]")
      process.exit(1)
    }

    case "setup":
      emitExit(await send({
        type: "ios_setup",
        device: deviceRef,
        team: flagValue(args, "--team") ?? flagValue(args, "--team-id"),
        project: flagValue(args, "--project"),
      }), jsonMode)
      return

    case "refresh":
      emitExit(await send({
        type: "ios_refresh",
        device: deviceRef,
        team: flagValue(args, "--team") ?? flagValue(args, "--team-id"),
        project: flagValue(args, "--project"),
      }), jsonMode)
      return

    case "logout":
      emitExit(await send({ type: "ios_logout" }), jsonMode)
      return

    case "tunnel":
      // Legacy diagnostic. The no-Xcode launch path now brings up the userspace
      // CoreDeviceProxy tunnel inside ios enable/setup.
      emitExit(await send({ type: "ios_tunnel", device: deviceRef, service: flagValue(args, "--service"), rc: flagValue(args, "--rc") }), jsonMode)
      return

    case "discover":
      emitExit(await send({ type: "ios_discover" }), jsonMode)
      return

    case "enable": {
      // Mostly unnecessary now (verbs auto-connect). Kept for the --wda-url path.
      const udid = (args[2] && !args[2].startsWith("--") ? args[2] : flagValue(args, "--udid")) ?? contextId
      emitExit(await send({
        type: "ios_enable",
        udid,
        device: contextId,
        wdaUrl: flagValue(args, "--wda-url"),
        bundleId: flagValue(args, "--bundle") ?? flagValue(args, "--bundle-id"),
      }), jsonMode)
      return
    }

    case "disable": {
      const udid = args[2] && !args[2].startsWith("--") ? args[2] : undefined
      emitExit(await send({ type: "ios_disable", udid, contextId }, contextId), jsonMode)
      return
    }

    case "status":
      emitExit(await send({ type: "ios_status" }), jsonMode)
      return

    case "fgdebug":
      emitExit(await send({ type: "ios_fgdebug" }, contextId), jsonMode)
      return

    case "eval": {
      // Lane D — the on-device JSCore brain. The script runs inside the runner's
      // JSContext with an `Interceptor` global (tree/tap/type/sleep/log/foreground),
      // so a whole observe→decide→act loop executes on the phone in one round-trip.
      const file = flagValue(args, "--file")
      const script = file ? await Bun.file(file).text() : (args[2] && !args[2].startsWith("--") ? args[2] : undefined)
      if (!script) { console.error('error: ios eval requires a script, e.g. ios eval "Interceptor.tap(200,400); Interceptor.log(Interceptor.foreground())"  (or --file loop.js)'); process.exit(1) }
      emitExit(await send({ type: "ios_eval", script }, contextId), jsonMode)
      return
    }

    case "tree":
      emitExit(await send({
        type: "ios_tree",
        all: hasFlag(args, "--all"),
        filter: flagValue(args, "--filter"),
      }, contextId), jsonMode)
      return

    case "find":
      emitExit(await send({
        type: "ios_find",
        label: flagValue(args, "--label"),
        query: flagValue(args, "--query") ?? (args[2] && !args[2].startsWith("--") ? args[2] : undefined),
        role: flagValue(args, "--role"),
      }, contextId), jsonMode)
      return

    case "inspect": {
      const ref = args[2]
      if (!ref || ref.startsWith("--")) { console.error("error: ios inspect requires a ref"); process.exit(1) }
      emitExit(await send({ type: "ios_inspect", ref }, contextId), jsonMode)
      return
    }

    case "click": {
      emitExit(await send(buildIosClickAction(args), contextId), jsonMode)
      return
    }

    case "type": {
      const ref = args[2] && !args[2].startsWith("--") ? args[2] : undefined
      // issue #244: `--secret <name>` types a vault value by name (daemon-resolved).
      const secretName = flagValue(args, "--secret")
      if (hasFlag(args, "--secret")) {
        if (!secretName) { console.error("error: --secret requires a secret name"); process.exit(1) }
        // Every positional after the verb other than the ref is literal text, wherever it sits.
        const literals = positionalsExcept(args, 2, ["--secret", "--bundle", "--on", "--context"]).filter((p) => p !== ref)
        if (literals.length) { console.error("error: --secret and literal text are mutually exclusive"); process.exit(1) }
        emitExit(await send({ type: "ios_type", ref, secret: secretName, bundleId: flagValue(args, "--bundle") }, contextId), jsonMode)
        return
      }
      // text is the last non-flag arg (or the only one when no ref is given)
      const text = ref ? (args[3] && !args[3].startsWith("--") ? args[3] : undefined) : (args[2] && !args[2].startsWith("--") ? args[2] : undefined)
      if (text === undefined) { console.error('error: ios type requires text, e.g. ios type e5 "hello"'); process.exit(1) }
      emitExit(await send({ type: "ios_type", ref: ref && args[3] !== undefined ? ref : undefined, text, bundleId: flagValue(args, "--bundle") }, contextId), jsonMode)
      return
    }

    case "keys": {
      const secretName = flagValue(args, "--secret")
      if (hasFlag(args, "--secret")) {
        if (!secretName) { console.error("error: --secret requires a secret name"); process.exit(1) }
        if (positionalsExcept(args, 2, ["--secret", "--bundle", "--on", "--context"]).length) { console.error("error: --secret and literal text are mutually exclusive"); process.exit(1) }
        emitExit(await send({ type: "ios_keys", secret: secretName, bundleId: flagValue(args, "--bundle") }, contextId), jsonMode)
        return
      }
      const text = args[2]
      if (!text || text.startsWith("--")) { console.error("error: ios keys requires text"); process.exit(1) }
      emitExit(await send({ type: "ios_keys", text: iosKeysText(text), bundleId: flagValue(args, "--bundle") }, contextId), jsonMode)
      return
    }

    // issue #244: unlock the lock screen with the passcode from the vault. The
    // resident runner wakes the phone, swipes up, and types into SpringBoard's
    // passcode field. `--probe` stops before typing and reports what it found.
    case "unlock": {
      const secretName = flagValue(args, "--secret")
      const probe = hasFlag(args, "--probe")
      if (!probe && (!secretName || hasFlag(args, "--secret") === false)) {
        console.error("error: ios unlock requires --secret <name> (or --probe to check the lock screen without typing)"); process.exit(1)
      }
      const action: Action = { type: "ios_unlock", probe }
      if (secretName) action.secret = secretName
      emitExit(await send(action, contextId), jsonMode)
      return
    }

    case "scroll": {
      emitExit(await send(buildIosScrollAction(args), contextId), jsonMode)
      return
    }

    case "drag": {
      emitExit(await send(buildIosDragAction(args), contextId), jsonMode)
      return
    }

    case "press": {
      const button = args[2]
      if (!button || button.startsWith("--")) { console.error("error: ios press requires home|lock|volume-up|volume-down"); process.exit(1) }
      emitExit(await send({ type: "ios_press", button }, contextId), jsonMode)
      return
    }

    case "gesture": {
      emitExit(await send(buildIosGestureAction(args), contextId), jsonMode)
      return
    }

    case "stream": {
      emitExit(await send(buildIosStreamAction(args), contextId), jsonMode)
      return
    }

    case "frame": {
      // Written by the daemon (it holds the bytes); the path is resolved here so a
      // relative --out means the caller's directory, not the daemon's.
      const out = resolve(process.cwd(), flagValue(args, "--out") ?? `interceptor-ios-frame-${Date.now()}.jpg`)
      if (hasFlag(args, "--out") && !flagValue(args, "--out")) { console.error("error: ios frame --out requires a path"); process.exit(1) }
      const result = await send({ type: "ios_frame", out }, contextId)
      if (result.success && result.data && typeof result.data === "object" && !jsonMode) {
        const d = result.data as { path?: string; seq?: number; ageMs?: number; width?: number; height?: number; running?: boolean }
        console.log(`saved: ${d.path} (frame ${d.seq}, ${d.ageMs} ms old, ${d.width}x${d.height}${d.running ? "" : ", stream stopped"})`)
        return
      }
      emitExit(result, jsonMode)
      return
    }

    case "screenshot": {
      const edge = numFlag(args, "--target-max-long-edge")   // pixels: sips wants a whole number
      const result = await send({ type: "ios_screenshot", targetMaxLongEdge: edge === undefined ? undefined : Math.trunc(edge) }, contextId)
      if (result.success && result.data && typeof result.data === "object") {
        const d = result.data as { dataUrl?: string; format?: string }
        if (d.dataUrl) {
          const base64 = d.dataUrl.split(",")[1] ?? ""
          const ext = d.format === "png" ? "png" : "jpg"
          const filename = `interceptor-ios-screenshot-${Date.now()}.${ext}`
          await Bun.write(filename, Buffer.from(base64, "base64"))
          const filePath = `${process.cwd()}/${filename}`
          if (jsonMode) console.log(JSON.stringify({ filePath, format: d.format }))
          else console.log(`saved: ${filePath}`)
          return
        }
      }
      emitExit(result, jsonMode)
      return
    }

    case "apps":
      emitExit(await send({ type: "ios_apps" }, contextId), jsonMode)
      return

    case "app": {
      const op = args[2]
      const bundleId = args[3]
      if (!op || !bundleId || op.startsWith("--") || bundleId.startsWith("--")) {
        console.error("error: ios app requires launch|activate|terminate <bundleId>"); process.exit(1)
      }
      emitExit(await send({ type: "ios_app", op, bundleId }, contextId), jsonMode)
      return
    }

    default:
      console.log(FULL_HELP)
  }
}
