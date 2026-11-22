/**
 * cli/commands/verify.ts — interceptor verify
 *
 * Checks a result against what is really there: the page, a saved file, or a
 * native app. Each check is passed, failed, or unverifiable (the surface could
 * not be read at all), so an agent never has to treat "could not look" as
 * "it worked". Read-only. Exit 0 all passed, 1 any failed, 2 none failed but
 * at least one could not be checked.
 */
import { readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { sendCommand } from "../transport"
import { staleExtensionHint } from "./diagnose"
import { VERSION } from "../version"

export type VerifyStatus = "passed" | "failed" | "unverifiable"
export type VerifyResult = { check: string; status: VerifyStatus; observed: string }

type PageCheck = { kind: "text" | "gone" | "url" | "selector"; value: string; count?: number }
export type VerifyPlan = {
  file?: { path: string; contains?: string; minBytes?: number; modifiedWithin?: number }
  page: PageCheck[]
  app?: { name: string; axText?: string; windowTitle?: string }
  timeout: number
}

const VALUE_FLAGS = ["--file", "--contains", "--min-bytes", "--modified-within", "--text", "--gone", "--url", "--selector", "--count", "--app", "--ax-text", "--window-title", "--timeout"]

function val(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  if (i === -1) return undefined
  const v = argv[i + 1]
  if (v === undefined || (v.startsWith("--") && VALUE_FLAGS.includes(v))) throw new Error(`verify ${flag} requires a value`)
  return v
}

function num(argv: string[], flag: string): number | undefined {
  const v = val(argv, flag)
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new Error(`verify ${flag} requires a non-negative number`)
  return n
}

export function parseVerifyArgs(argv: string[]): VerifyPlan {
  const plan: VerifyPlan = { page: [], timeout: num(argv, "--timeout") ?? 0 }
  const file = val(argv, "--file")
  const fileMods = ["--contains", "--min-bytes", "--modified-within"].filter(f => argv.includes(f))
  if (!file && fileMods.length) throw new Error(`verify ${fileMods[0]} goes with --file <path>`)
  if (file) plan.file = { path: resolve(file), contains: val(argv, "--contains"), minBytes: num(argv, "--min-bytes"), modifiedWithin: num(argv, "--modified-within") }
  for (const kind of ["text", "gone", "url", "selector"] as const) {
    const v = val(argv, `--${kind}`)
    if (v !== undefined) plan.page.push({ kind, value: v, ...(kind === "selector" && argv.includes("--count") ? { count: num(argv, "--count") } : {}) })
  }
  if (argv.includes("--count") && !plan.page.some(p => p.kind === "selector")) throw new Error("verify --count goes with --selector <css>")
  const app = val(argv, "--app")
  const axText = val(argv, "--ax-text"), windowTitle = val(argv, "--window-title")
  if ((axText || windowTitle) && !app) throw new Error("verify --ax-text and --window-title go with --app <name>")
  if (app) {
    if (!axText && !windowTitle) throw new Error("verify --app needs --ax-text \"<text>\" or --window-title \"<text>\"")
    plan.app = { name: app, axText, windowTitle }
  }
  if (!plan.file && !plan.page.length && !plan.app) {
    throw new Error("verify needs at least one check: --text, --gone, --url, --selector, --file <path>, or --app <name> --ax-text/--window-title. Run 'interceptor help verify'.")
  }
  return plan
}

export function checkFile(f: NonNullable<VerifyPlan["file"]>, now = Date.now()): VerifyResult[] {
  const out: VerifyResult[] = []
  let size = 0, mtime = 0
  try {
    const st = statSync(f.path)
    if (!st.isFile()) return [{ check: `file ${f.path}`, status: "failed", observed: "exists but is not a regular file" }]
    size = st.size; mtime = st.mtimeMs
    out.push({ check: `file ${f.path}`, status: "passed", observed: `${size} bytes` })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return [{ check: `file ${f.path}`, status: "failed", observed: "no such file" }]
    return [{ check: `file ${f.path}`, status: "unverifiable", observed: `cannot read it (${code ?? (err as Error).message})` }]
  }
  if (f.minBytes !== undefined) out.push({ check: `size >= ${f.minBytes} bytes`, status: size >= f.minBytes ? "passed" : "failed", observed: `${size} bytes` })
  if (f.modifiedWithin !== undefined) {
    const age = Math.round((now - mtime) / 1000)
    out.push({ check: `modified within ${f.modifiedWithin} s`, status: age <= f.modifiedWithin ? "passed" : "failed", observed: `modified ${age} s ago` })
  }
  if (f.contains !== undefined) {
    try {
      const text = readFileSync(f.path, "utf8")
      out.push({ check: `contains "${f.contains}"`, status: text.includes(f.contains) ? "passed" : "failed", observed: text.includes(f.contains) ? "found" : "not found" })
    } catch (err) {
      out.push({ check: `contains "${f.contains}"`, status: "unverifiable", observed: `cannot read it (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})` })
    }
  }
  return out
}

export type Send = (action: Record<string, unknown> & { type: string }) => Promise<{ success: boolean; error?: string; data?: unknown }>

const PAGE_LABEL: Record<PageCheck["kind"], (c: PageCheck) => string> = {
  text: c => `page text contains "${c.value}"`,
  gone: c => `page text does not contain "${c.value}"`,
  url: c => `URL contains "${c.value}"`,
  selector: c => c.count !== undefined ? `${c.count}+ elements match ${c.value}` : `an element matches ${c.value}`,
}

/** A condition that was looked at and not met is failed; one that could not be looked at is unverifiable. */
export function pageVerdict(c: PageCheck, r: { success: boolean; error?: string; data?: unknown }): VerifyResult {
  const check = PAGE_LABEL[c.kind](c)
  const observed = (r.data as { observed?: string } | undefined)?.observed
  if (r.success) return { check, status: "passed", observed: observed ?? "met" }
  if (r.data && typeof r.data === "object" && (r.data as { met?: unknown }).met === false) return { check, status: "failed", observed: observed ?? r.error ?? "not met" }
  return { check, status: "unverifiable", observed: r.error ?? "no answer from the browser" }
}

/**
 * The observed text for a page check the connected extension cannot run: it
 * predates the action verify sends. The fix depends on the copy (a store copy
 * changes only when the store publishes), so runVerify adds the same
 * copy-specific line every other verb prints.
 */
export const STALE_EXTENSION_OBSERVED = `the connected browser extension is older than this CLI (${VERSION}) and cannot run this check`

export async function checkPage(plan: VerifyPlan, send: Send): Promise<VerifyResult[]> {
  const out: VerifyResult[] = []
  for (const c of plan.page) {
    const action: Record<string, unknown> & { type: string } = { type: "wait_condition", kind: c.kind, timeout: plan.timeout }
    if (c.kind === "selector") { action.selector = c.value; if (c.count !== undefined) action.count = c.count }
    else action.text = c.value
    let r: { success: boolean; error?: string; data?: unknown }
    try { r = await send(action) } catch (err) { r = { success: false, error: (err as Error).message } }
    if (!r.success && /unknown action type/i.test(r.error ?? "")) r = { success: false, error: STALE_EXTENSION_OBSERVED }
    out.push(pageVerdict(c, r))
  }
  return out
}

export async function checkApp(a: NonNullable<VerifyPlan["app"]>, send: Send): Promise<VerifyResult[]> {
  const out: VerifyResult[] = []
  const unreadable = (check: string, r: { error?: string }) => ({ check, status: "unverifiable" as const, observed: r.error ?? "no answer from the macOS bridge" })
  if (a.axText !== undefined) {
    const check = `${a.name} shows "${a.axText}"`
    let r: { success: boolean; error?: string; data?: unknown }
    try { r = await send({ type: "macos_find", query: a.axText, app: a.name }) } catch (err) { r = { success: false, error: (err as Error).message } }
    if (!r.success) out.push(unreadable(check, r))
    else {
      const hits = Array.isArray(r.data) ? r.data as Array<{ ref?: string; role?: string; name?: string }> : []
      out.push(hits.length
        ? { check, status: "passed", observed: hits.slice(0, 3).map(h => `[${h.ref}] ${h.role} "${h.name ?? ""}"`).join(", ") }
        : { check, status: "failed", observed: "no element with that text" })
    }
  }
  if (a.windowTitle !== undefined) {
    const check = `${a.name} has a window titled "${a.windowTitle}"`
    let r: { success: boolean; error?: string; data?: unknown }
    try { r = await send({ type: "macos_windows", app: a.name }) } catch (err) { r = { success: false, error: (err as Error).message } }
    if (!r.success) out.push(unreadable(check, r))
    else {
      const titles = (Array.isArray(r.data) ? r.data as Array<{ title?: string }> : []).map(w => w.title ?? "")
      const hit = titles.find(t => t.toLowerCase().includes(a.windowTitle!.toLowerCase()))
      out.push(hit !== undefined
        ? { check, status: "passed", observed: `window "${hit}"` }
        : { check, status: "failed", observed: titles.length ? `windows: ${titles.map(t => `"${t}"`).join(", ")}` : "no windows" })
    }
  }
  return out
}

export function overall(results: VerifyResult[]): VerifyStatus {
  if (results.some(r => r.status === "failed")) return "failed"
  if (results.some(r => r.status === "unverifiable")) return "unverifiable"
  return "passed"
}

export function formatVerify(results: VerifyResult[]): string {
  const lines = results.map(r => `${r.status}: ${r.check} (${r.observed})`)
  lines.push(`verify: ${overall(results)} (${results.filter(r => r.status === "passed").length}/${results.length} passed)`)
  return lines.join("\n")
}

export const VERIFY_EXIT: Record<VerifyStatus, number> = { passed: 0, failed: 1, unverifiable: 2 }

/** The stale-extension hint when any page check hit an extension older than this CLI. */
export async function staleHintFor(results: VerifyResult[], hint: () => Promise<string>): Promise<string | undefined> {
  return results.some(r => r.observed === STALE_EXTENSION_OBSERVED) ? await hint() : undefined
}

/** A daemon that could not start makes every page and app check unverifiable; file checks still run. */
export function sendOrUnreadable(failure: string | undefined, send: Send): Send {
  if (!failure) return send
  const why = `the daemon is not running: ${failure.replace(/^error:\s*/, "").split("\n")[0]}`
  return async () => ({ success: false, error: why })
}

export async function runVerify(filtered: string[], opts: { jsonMode: boolean; tabId?: number; contextId?: string; anyTab?: boolean; startDaemon: () => Promise<string | undefined>; staleHint?: () => Promise<string> }): Promise<number> {
  const plan = parseVerifyArgs(filtered.slice(1))
  const results: VerifyResult[] = []
  if (plan.file) results.push(...checkFile(plan.file))
  if (plan.page.length || plan.app) {
    const failure = await opts.startDaemon().catch((err: Error) => err.message)
    const send = sendOrUnreadable(failure, async (action) =>
      (await sendCommand(opts.anyTab ? { ...action, anyTab: true } : action, opts.tabId, opts.contextId)).result)
    if (plan.page.length) results.push(...await checkPage(plan, send))
    if (plan.app) results.push(...await checkApp(plan.app, send))
  }
  const status = overall(results)
  const hint = await staleHintFor(results, opts.staleHint ?? (() => staleExtensionHint(VERSION, opts.contextId)))
  if (opts.jsonMode) {
    console.log(JSON.stringify({ success: status === "passed", data: { status, checks: results }, ...(hint ? { hint: hint.replace(/^hint:\s*/, "") } : {}) }, null, 2))
  } else {
    console.log(formatVerify(results))
    if (hint) console.error(hint)
  }
  return VERIFY_EXIT[status]
}
