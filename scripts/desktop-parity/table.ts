#!/usr/bin/env bun
// Combined parity table from batch run directories :
//   bun scripts/desktop-parity/table.ts <run dir>... > parity-table.md
// Per family it lists pass/fail/skip on each host, every case that moved focus or the cursor,
// and capability rows that contradict their batch (effective:false but an ok case passed, or
// effective:true with cases and none of its ok cases passed).
import { readFileSync } from "node:fs"
import { join, basename } from "node:path"

type Result = { family: string; id: string; sub: string; outcome: string; expect?: { ok?: boolean }; failure?: string }
type Run = { dir: string; host: string; cli: string; stamp: string; totals: Record<string, number>; families: Record<string, Record<string, number>>; results: Result[]; caps: { operation: string; effective: boolean; reason?: string }[] }
// Bookkeeping verbs answer from local state while the operation's engine is out, so they say nothing about the row.
const BOOKKEEPING = /^(status|list|stop|tail|log|types|tokens|vocab|transcript|session (history|end)|monitor (status|stop))$/
const ALIASES: Record<string, string[]> = { display: ["display_list", "display_info"], script: ["script_run"], intent: ["intent_dispatch"], container: ["container_run"] }
const HOSTS: Record<string, string> = { win32: "Windows", linux: "Linux", darwin: "macOS" }

const runs: Run[] = process.argv.slice(2).map(dir => {
  const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"))
  const results = readFileSync(join(dir, "results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
  let caps: Run["caps"] = []
  try { caps = JSON.parse(readFileSync(join(dir, "capabilities.json"), "utf8")).capabilities ?? [] } catch {}
  return { dir, host: summary.host, cli: summary.cli, stamp: summary.stamp, totals: summary.totals, families: summary.families, results, caps }
})
if (!runs.length) { console.error("usage: table.ts <run dir>..."); process.exit(1) }

const out: string[] = []
const families = [...new Set(runs.flatMap(r => Object.keys(r.families)))]
out.push("| Family | " + runs.map(r => HOSTS[r.host] ?? r.host).join(" | ") + " |", "|---|" + runs.map(() => "---|").join(""))
for (const f of families) out.push(`| ${f} | ` + runs.map(r => { const c = r.families[f]; return c ? `${c.pass}/${c.fail}/${c.skip}` : "not run" }).join(" | ") + " |")
out.push("| **total** | " + runs.map(r => `**${r.totals.pass}/${r.totals.fail}/${r.totals.skip}**`).join(" | ") + " |")

const findings: string[] = []
for (const r of runs) {
  const host = HOSTS[r.host] ?? r.host
  const moved = r.results.filter(x => /frontmost changed|cursor moved/.test(x.failure ?? ""))
  findings.push(`- **${host}:** ${moved.length} case(s) moved focus or the cursor${moved.length ? ": " + moved.map(x => x.id).join(", ") : ""}.`)
  const contradictions: string[] = []
  for (const f of Object.keys(r.families)) {
    const ops = r.caps.filter(c => (ALIASES[f] ?? [f]).includes(c.operation))
    if (!ops.length) continue
    const okCases = r.results.filter(x => x.family === f && x.expect?.ok)
    const okPassed = okCases.filter(x => x.outcome === "pass")
    const working = okPassed.filter(x => !BOOKKEEPING.test(x.sub))
    if (ops.every(c => !c.effective) && working.length) contradictions.push(`${f}: capability says unavailable, but ${working.map(x => x.id).join(", ")} succeeded`)
    if (ops.some(c => c.effective) && okCases.length && !okPassed.length) contradictions.push(`${f}: capability says available, no ok case passed`)
  }
  findings.push(`- **${host} capability rows:** ${contradictions.length ? contradictions.join("; ") : "none contradict their batch"}.`)
}

console.log(`---
author: agent
generated_by: "scripts/desktop-parity/table.ts"
created: ${new Date().toISOString().slice(0, 10)}
updated: ${new Date().toISOString().slice(0, 10)}
status: final
reviewed: false
source: "${runs.map(r => basename(r.dir)).join("; ")}"
---

# Desktop parity table

Each cell is pass/fail/skip for the family's cases on that host. A case fails if it moved the frontmost window or the cursor (outside the focus verbs).

${runs.map(r => `- **${HOSTS[r.host] ?? r.host}:** \`${basename(r.dir)}\`, CLI \`${r.cli}\``).join("\n")}

${out.join("\n")}

## Checks

${findings.join("\n")}
`)
