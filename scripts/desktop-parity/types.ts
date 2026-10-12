// Shared types for the desktop parity runner . A family is built as a
// whole, then every subcommand and flag in it runs in one batch on the installed
// CLI. Cases are host-neutral; per-host expectations encode the scope table.

export type Host = "win32" | "linux" | "darwin"

/** ok: exit 0. refuse: exit != 0 with success:false (code/error checked when given). skip: not run on that host. */
export type Expect =
  /** orRefuse: the result depends on host state the test cannot control (e.g. what the person has in front); that exact refusal also passes. */
  | { ok: true; orRefuse?: { code: string; error: RegExp } }
  | { refuse: true; code?: string | string[]; error?: RegExp }
  | { skip: string }

export interface Res {
  exit: number
  /** Parsed stdout JSON (the CLI prints data on success and {success:false,...} on failure). */
  json: any
  stdout: string
  stderr: string
  ms: number
  timedOut: boolean
}

export interface Ctx {
  host: Host
  /** Absolute path of a scratch directory owned by this run. */
  dir: string
  /** Shared state between cases of one family (ids created, refs, paths). */
  vars: Record<string, any>
  /** Runs `interceptor --json desktop <args>` and returns the parsed result. */
  run(args: string[], timeoutMs?: number): Promise<Res>
  /** Fresh ref for a fixture element by accessible name (Windows find resets refs, so look up right before use). */
  ref(name: string, role?: string): Promise<string>
  /** Name of the fixture app/window on this host. */
  fixture: { app: string; title: string; pid?: number }
  /// Folder holding the owned fixture programs on this host.
  fixtures: string
  /// Starts an owned helper process; it is stopped when the run ends.
  spawn(cmd: string[]): { pid: number; kill(): void }
  sleep(ms: number): Promise<void>
}

export interface Case {
  /** Unique id: family.subcommand.what */
  id: string
  /** Inventory subcommand this case covers ("-" for families without one). */
  sub: string
  /** Arguments after `desktop`. A function is evaluated right before the case runs. */
  args: string[] | ((ctx: Ctx) => string[] | Promise<string[]>)
  /** Flags covered when args is a function (static args are scanned automatically). */
  flags?: string[]
  /** Default is { all: ok }. Host keys override `all`. */
  expect?: Partial<Record<Host | "all", Expect>>
  /** Semantic check; return a failure message, or nothing when the result is right. */
  check?: (r: Res, ctx: Ctx) => string | void | Promise<string | void>
  /** The verb may legitimately move focus (app activate, open --activate). */
  focus?: "allowed"
  /** Plays sound, opens UI, or touches personal data: never run on a Mac someone is using. */
  disruptive?: boolean
  /** A host precondition only the person can satisfy (a language pack, a consent): a reason skips the case. */
  needs?: (ctx: Ctx) => string | undefined
  timeoutMs?: number
}

export interface Family {
  family: string
  cases: Case[]
  setup?(ctx: Ctx): Promise<void>
  teardown?(ctx: Ctx): Promise<void>
}

/** Inventory rows that are deliberately not exercised, with the scope reason. */
export type Exclusion = { family: string; sub?: string; flag?: string; reason: string }

export const ok: Expect = { ok: true }
export const refuse = (code?: string | string[], error?: RegExp): Expect => ({ refuse: true, code, error })
export const skip = (reason: string): Expect => ({ skip: reason })
/** Out-of-scope on Windows and Linux: refuse there, still work on the Mac. */
export const macOnly = (code: string | string[] = ["unsupported_operation", "not_installed", "background_unavailable"]): Case["expect"] =>
  ({ all: refuse(code), darwin: ok })

export function expectationFor(c: Case, host: Host): Expect {
  return c.expect?.[host] ?? c.expect?.all ?? ok
}

/** Returns a failure message when the result does not meet the expectation. */
export function judge(e: Expect, r: Res): string | undefined {
  if ("skip" in e) return undefined
  if (r.timedOut) return `timed out after ${r.ms} ms`
  const failed = r.exit !== 0 || r.json?.success === false
  if ("ok" in e) {
    if (failed && e.orRefuse && r.json?.code === e.orRefuse.code && e.orRefuse.error.test(String(r.json?.error ?? ""))) return undefined
    return failed ? `expected success, got exit ${r.exit}: ${errorText(r)}` : undefined
  }
  if (!failed) return "expected a refusal, got success"
  const code = r.json?.code
  if (e.code && !([] as string[]).concat(e.code).includes(code)) return `expected code ${[].concat(e.code as any).join("|")}, got ${code ?? "none"}: ${errorText(r)}`
  if (e.error && !e.error.test(String(r.json?.error ?? r.stderr))) return `error text ${JSON.stringify(errorText(r))} does not match ${e.error}`
  return undefined
}

export function errorText(r: Res): string {
  return String(r.json?.error ?? r.stderr.split("\n").filter(l => l && !/^\[[0-9a-f]{8}\]/.test(l)).join(" ") ?? "").slice(0, 300)
}
