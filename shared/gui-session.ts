// A macOS account has a launchd GUI domain (gui/<uid>) only while it is logged
// in at the screen (including fast user switching). LaunchAgents, and so the
// bridge, exist only inside that domain. Over ssh, or as a service account,
// there is no domain: `launchctl print gui/<uid>` exits 125 "Domain does not
// support specified action" once anything has run as that uid since boot, and
// 112 "Bad request." when nothing has (observed on a shared Mac: an account
// with no process since boot gave the second form, then the first). The
// bare domain print is what is classified here; the service print
// (`gui/<uid>/com.interceptor.bridge`) exits 113 "Bad request." for a present
// domain without the service, which is the postinstall-bootstrap case.
// Reproduced on a shared Mac: one account over ssh while another held the
// console got the bootstrap hint, and `launchctl bootstrap gui/<uid>` cannot
// work there.
import { spawnSync } from "node:child_process"
import { userInfo } from "node:os"

export type GuiSession = "present" | "absent" | "unknown"

export type RunFn = (cmd: string, args: string[]) => { status: number | null; stderr?: string | null; stdout?: string | null }

const run: RunFn = (cmd, args) => spawnSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })

export function classifyGuiDomainProbe(status: number | null, stderr = ""): GuiSession {
  if (status === 0) return "present"
  if (status === 125 || status === 112 || status === 113 || /Domain does not support|Bad request/i.test(stderr)) return "absent"
  return "unknown"
}

export function probeGuiSession(uid: number, platform: NodeJS.Platform = process.platform, exec: RunFn = run): GuiSession {
  if (platform !== "darwin") return "unknown"
  try {
    const r = exec("launchctl", ["print", `gui/${uid}`])
    return classifyGuiDomainProbe(r.status, r.stderr ?? "")
  } catch {
    return "unknown"
  }
}

/** Who owns the screen right now (`stat -f %Su /dev/console`); null off macOS or on failure. */
export function consoleUser(platform: NodeJS.Platform = process.platform, exec: RunFn = run): string | null {
  if (platform !== "darwin") return null
  try {
    const r = exec("stat", ["-f", "%Su", "/dev/console"])
    const name = (r.stdout ?? "").trim()
    return r.status === 0 && name ? name : null
  } catch {
    return null
  }
}

export function currentUserName(): string | null {
  try { return userInfo().username || null } catch { return null }
}

export interface BridgeLaunchOpts {
  launchAgentLoaded?: boolean
  guiSession?: GuiSession
  consoleUser?: string | null
  user?: string | null
  uid?: number | null
}

/** [cause, remedy] for an account with no GUI session; callers add their own prefix and layout. */
export function missingGuiSessionLines(opts: BridgeLaunchOpts): [string, string] {
  const who = opts.user ?? "this account"
  const uid = opts.uid ?? "<uid>"
  const screen = opts.consoleUser && opts.consoleUser !== "root" && opts.consoleUser !== who
    ? `The screen belongs to ${opts.consoleUser}.`
    : "No one is logged in at the screen."
  return [
    `${who} (uid ${uid}) has no GUI login on this Mac, so launchd has no gui/${uid} session to run the bridge in. ${screen}`,
    `Run the CLI as the user logged in at the screen, or log ${who} in there: macOS starts the bridge LaunchAgent at login.`,
  ]
}
