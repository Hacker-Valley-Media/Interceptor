/**
 * cli/commands/run.ts — interceptor run [<file>|-]
 *
 * One command per line, run in order in one call, stopping at the first
 * failure. Each step is this same binary as a child process, so it gets the
 * exact parsing, group scoping and safety gates of a single call; the gain is
 * one agent turn instead of one per step (tokens follow command count because
 * the harness resends the conversation each turn). `expect <verify flags>`
 * lines run `verify`, so a script can check its own result.
 */
import { readFileSync } from "node:fs"
import { selfPrefix } from "../mcp/adapter"

export type Step = { line: number; text: string; argv: string[] }
export type StepResult = { line: number; command: string; code: number; ms: number; stdout: string; stderr: string }

/** Shell-style words: whitespace splits, '...' is literal, "..." allows \" and \\, \ escapes outside quotes. */
export function splitLine(line: string): string[] {
  const out: string[] = []
  let cur = "", inWord = false, quote: "'" | "\"" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote === "'") { if (ch === "'") quote = null; else cur += ch; continue }
    if (quote === "\"") {
      if (ch === "\"") quote = null
      else if (ch === "\\" && (line[i + 1] === "\"" || line[i + 1] === "\\")) cur += line[++i]
      else cur += ch
      continue
    }
    if (ch === "'" || ch === "\"") { quote = ch; inWord = true; continue }
    if (ch === "\\" && i + 1 < line.length) { cur += line[++i]; inWord = true; continue }
    if (/\s/.test(ch)) { if (inWord) { out.push(cur); cur = ""; inWord = false } continue }
    cur += ch; inWord = true
  }
  if (quote) throw new Error(`unterminated ${quote} quote`)
  if (inWord) out.push(cur)
  return out
}

export function parseScript(text: string): Step[] {
  const steps: Step[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim()
    if (!t || t.startsWith("#")) return
    let argv: string[]
    try { argv = splitLine(t) } catch (err) { throw new Error(`line ${i + 1}: ${(err as Error).message}`) }
    if (argv[0] === "interceptor") argv = argv.slice(1)
    if (!argv.length) return
    if (commandWord(argv) === "run") throw new Error(`line ${i + 1}: run cannot run another run`)
    if (argv[0] === "expect") argv = ["verify", ...argv.slice(1)]
    steps.push({ line: i + 1, text: t, argv })
  })
  return steps
}

const GLOBAL_VALUE = new Set(["--context", "--group", "--tab", "--frame", "--group-color"])
const GLOBAL_BOOL = new Set(["--any-tab", "--shared-group", "--json", "--ws", "--no-ws"])

/** The step's command after any leading global flags (`--group x run f` is a run). */
function commandWord(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], name = a.split("=", 1)[0]
    if (GLOBAL_VALUE.has(name)) { if (!a.includes("=")) i++; continue }
    if (!GLOBAL_BOOL.has(a)) return a
  }
  return undefined
}

/** The run's own global flags, forwarded to every step. */
export function globalFlags(args: string[]): string[] {
  const out: string[] = []
  const end = args.indexOf("--")
  const limit = end === -1 ? args.length : end
  for (let i = 0; i < limit; i++) {
    const a = args[i], name = a.split("=", 1)[0]
    if (GLOBAL_VALUE.has(name)) { if (a.includes("=")) out.push(a); else if (i + 1 < limit) out.push(a, args[++i]) }
    else if (GLOBAL_BOOL.has(a)) out.push(a)
  }
  return out
}

export const STEP_OUTPUT_CHARS = 1500

function cap(text: string, full: boolean): string {
  if (full || text.length <= STEP_OUTPUT_CHARS) return text
  return `${text.slice(0, STEP_OUTPUT_CHARS)}\n… (step output cut at ${STEP_OUTPUT_CHARS} of ${text.length} chars; --full shows it all)`
}

export function formatStep(r: StepResult, index: number, total: number, full: boolean, last: boolean): string {
  const head = `[${index + 1}/${total}] ${r.command}  (${r.code === 0 ? "ok" : `failed, exit ${r.code}`}, ${r.ms} ms)`
  const body = cap(r.stdout.trimEnd(), full || last)
  const notes = r.stderr.trimEnd()
  return [head, body, notes].filter(Boolean).join("\n")
}

async function runStep(prefix: string[], step: Step): Promise<StepResult> {
  const start = Date.now()
  const proc = Bun.spawn([...selfPrefix(), ...prefix, ...step.argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, [IN_RUN_ENV]: "1" } })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { line: step.line, command: step.text, code, ms: Date.now() - start, stdout, stderr }
}

// Set on every step, so a step that reaches `run` by any spelling is refused
// instead of starting a chain of runs.
const IN_RUN_ENV = "INTERCEPTOR_IN_RUN"

export async function runScript(filtered: string[], rawArgs: string[], opts: { jsonMode: boolean }): Promise<number> {
  if (process.env[IN_RUN_ENV] === "1") throw new Error("run cannot run another run")
  const src = filtered[1]
  const keepGoing = filtered.includes("--keep-going")
  const full = filtered.includes("--full")
  let text: string
  if (src && src !== "-" && !src.startsWith("--")) text = readFileSync(src, "utf8")
  else if (src === "-" || !process.stdin.isTTY) text = await Bun.stdin.text()
  else throw new Error("run needs a script: interceptor run <file>, or pipe one in with interceptor run -")
  const steps = parseScript(text)
  if (!steps.length) throw new Error("run: the script has no commands")
  const prefix = globalFlags(rawArgs)
  const results: StepResult[] = []
  const started = Date.now()
  let failed: StepResult | undefined
  for (let i = 0; i < steps.length; i++) {
    const r = await runStep(prefix, steps[i])
    results.push(r)
    if (!opts.jsonMode) console.log(formatStep(r, i, steps.length, full, i === steps.length - 1 || (r.code !== 0 && !keepGoing)) + "\n")
    if (r.code !== 0) {
      failed ??= r
      if (!keepGoing) break
    }
  }
  const ok = results.filter(r => r.code === 0).length
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  if (opts.jsonMode) {
    console.log(JSON.stringify({ success: !failed, data: { completed: ok, total: steps.length, steps: results } }, null, 2))
  } else if (failed) {
    const lines = `${failed.stdout}\n${failed.stderr}`.split("\n").map(l => l.trim()).filter(Boolean)
    const why = lines.find(l => /^(error|failed|unverifiable):/.test(l)) ?? lines[0] ?? ""
    console.log(`run: ${ok}/${steps.length} steps ok; ${keepGoing ? "first failure" : "stopped"} at line ${failed.line} (${failed.command}): ${why} (${secs} s)`)
  } else {
    console.log(`run: ${ok}/${steps.length} steps ok (${secs} s)`)
  }
  return failed ? (failed.code || 1) : 0
}
