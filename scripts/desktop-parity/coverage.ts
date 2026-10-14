#!/usr/bin/env bun
// Coverage gate: every (family, subcommand) of the CLI inventory has a
// case, and every flag of that subcommand appears in one of its cases or in a recorded
// exclusion. Exits 1 and lists the gaps otherwise.
import inventory from "./inventory.json"
import { families, exclusions } from "./cases/index"
import type { Exclusion, Family } from "./types"

export type Row = { family: string; sub: string; flags: string[] }

export function coverageGaps(rows: Row[], fams: Family[], excl: Exclusion[]): string[] {
  const seen = new Map<string, Set<string>>()
  for (const f of fams) for (const c of f.cases) {
    const key = `${f.family}\u0000${c.sub}`
    const flags = seen.get(key) ?? new Set<string>()
    for (const a of typeof c.args === "function" ? [] : c.args) if (a.startsWith("--")) flags.add(a === "--" ? "--" : a.split("=")[0])
    for (const a of c.flags ?? []) flags.add(a)
    seen.set(key, flags)
  }
  const excluded = (r: Row, flag?: string) => excl.some(e => e.family === r.family && (!e.sub || e.sub === r.sub) && (flag ? !e.flag || e.flag === flag : !e.flag))
  const gaps: string[] = []
  for (const r of rows) {
    const flags = seen.get(`${r.family}\u0000${r.sub}`)
    if (!flags) { if (!excluded(r)) gaps.push(`${r.family} ${r.sub}: no case`); continue }
    for (const flag of r.flags.flatMap(f => f.startsWith("-- ") ? ["--"] : f.split("|")))
      if (!flags.has(flag) && !excluded(r, flag)) gaps.push(`${r.family} ${r.sub}: flag ${flag} not exercised`)
  }
  return gaps
}

if (import.meta.main) {
  const rows = (inventory as { rows: Row[] }).rows
  const gaps = coverageGaps(rows, families, exclusions)
  const cases = families.reduce((n, f) => n + f.cases.length, 0)
  console.log(`${rows.length} inventory rows, ${families.length} families, ${cases} cases, ${exclusions.length} exclusions, ${gaps.length} gaps`)
  for (const g of gaps) console.log(`  ${g}`)
  process.exit(gaps.length ? 1 : 0)
}
