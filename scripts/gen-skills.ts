#!/usr/bin/env bun
/**
 * Writes one operating system's copy of the agent skills.
 *
 *   bun scripts/gen-skills.ts <darwin|win32|linux> <out-dir> <skill>...
 *
 * The sources in .agents/skills hold the text for every OS. In a skill's Markdown files:
 *   text <!-- os:win32,linux -->           keeps that line only for the listed OSes;
 *   <!-- os:darwin --> … <!-- /os -->      on lines of their own keep a block the same way;
 *   #os:win32,linux key: value             in the frontmatter replaces the `key:` line there;
 *   <!-- generated:unsupported --> … <!-- /generated -->   (and `partial`) are filled per OS
 *                                          from shared/desktop-support.json.
 * The package builds call this (scripts/build.sh for Windows and Linux, scripts/release.sh for
 * the Mac), so every installer carries only its own OS's lines. The output is checked before it
 * is written: no marker may survive, and no OS may be told about another OS's surface.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { SUPPORT_ROWS, supportReason, type DesktopOs, type SupportRow } from "../shared/desktop-support"

export type Os = "darwin" | "win32" | "linux"
export const OSES: Os[] = ["darwin", "win32", "linux"]
const SKILLS = resolve(import.meta.dir, "..", ".agents", "skills")

/** Skills that exist for only some OSes. Every other skill ships everywhere. */
const SKILL_OSES: Record<string, Os[]> = {
  "interceptor-macos": ["darwin"],
  "interceptor-ios": ["darwin"],
  "interceptor-desktop": ["win32", "linux"],
}

/** Text no copy for that OS may contain once its lines are selected. */
const FORBIDDEN: Record<Os, RegExp[]> = {
  darwin: [/interceptor-desktop\b/],
  win32: [/interceptor[- ](macos|ios)\b/, /\bSafari\b/, /--trusted\b/, /--browser-login\b/, /Library\/Application Support/, /\bLinux\b/, /Hyprland|AT-SPI|Wayland/],
  linux: [/interceptor[- ](macos|ios)\b/, /\bSafari\b/, /--trusted\b/, /--browser-login\b/, /Library\/Application Support/, /\bWindows\b/, /UI Automation/],
}

const tagFor = (spec: string): Os[] => {
  const oses = spec.split(",").map(s => s.trim()) as Os[]
  for (const os of oses) if (!OSES.includes(os)) throw new Error(`unknown OS '${os}' in an os: tag`)
  return oses
}

const label = (row: SupportRow) => {
  const command = [row.family, row.sub, row.flag].filter(Boolean).join(" ")
  const except = row.except?.length ? ` (all but ${row.except.map(s => `\`${row.family} ${s}\``).join(", ")})` : ""
  return `\`${command}\`${except}`
}

/** One table row per reason, listing every command that shares it, in file order. */
export function supportTable(os: DesktopOs, status: "no" | "partial"): string {
  const groups = new Map<string, string[]>()
  for (const row of SUPPORT_ROWS.filter(r => r[os] === status)) {
    const why = supportReason(row, os)
    if (!why) throw new Error(`desktop-support row ${label(row)} has no reason for ${os}`)
    const commands = groups.get(why) ?? []
    if (!commands.includes(label(row))) commands.push(label(row))
    groups.set(why, commands)
  }
  if (!groups.size) return "None."
  const head = status === "no" ? "| Command | Why |" : "| Command | Limit |"
  return [head, "|---|---|", ...[...groups].map(([why, commands]) => `| ${commands.join(", ")} | ${why[0].toUpperCase()}${why.slice(1)} |`)].join("\n")
}

function generated(name: string, os: Os, file: string): string {
  if (os === "darwin") throw new Error(`${file}: generated sections are for Windows and Linux only`)
  if (name === "unsupported") return supportTable(os, "no")
  if (name === "partial") return supportTable(os, "partial")
  throw new Error(`${file}: unknown generated section '${name}'`)
}

/** Selects one OS's lines from a source Markdown file. */
export function renderText(source: string, os: Os, file = "<text>"): string {
  // A Windows checkout has CRLF line endings; markers and the frontmatter fence are matched per LF line.
  const lines = source.replace(/\r\n/g, "\n").split("\n")
  const out: string[] = []
  let start = 0
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1)
    if (end < 0) throw new Error(`${file}: unterminated frontmatter`)
    const body = lines.slice(1, end)
    const overrides = new Map<string, string>()
    for (const line of body) {
      const m = /^#os:([a-z0-9,]+) (.*)$/.exec(line)
      if (!m) continue
      const key = /^(\s*[\w-]+):/.exec(m[2])?.[1]
      if (!key) throw new Error(`${file}: frontmatter override without a key: ${line}`)
      if (tagFor(m[1]).includes(os)) overrides.set(key, m[2])
    }
    const used = new Set<string>()
    out.push("---")
    for (const line of body) {
      if (line.startsWith("#os:")) continue
      const key = /^(\s*[\w-]+):/.exec(line)?.[1]
      if (key && overrides.has(key)) { out.push(overrides.get(key)!); used.add(key) } else out.push(line)
    }
    for (const key of overrides.keys()) if (!used.has(key)) throw new Error(`${file}: frontmatter override for missing key '${key.trim()}'`)
    out.push("---")
    start = end + 1
  }
  let block: Os[] | undefined
  let section: string | undefined
  for (const line of lines.slice(start)) {
    const blockStart = /^<!-- os:([a-z0-9,]+) -->$/.exec(line.trim())
    if (blockStart) { if (block) throw new Error(`${file}: nested os blocks`); block = tagFor(blockStart[1]); continue }
    if (line.trim() === "<!-- /os -->") { if (!block) throw new Error(`${file}: /os without a block`); block = undefined; continue }
    const gen = /^<!-- generated:([a-z-]+) -->$/.exec(line.trim())
    if (gen) {
      if (section) throw new Error(`${file}: nested generated sections`)
      section = gen[1]
      if (!block || block.includes(os)) out.push(generated(section, os, file))
      continue
    }
    if (line.trim() === "<!-- /generated -->") { if (!section) throw new Error(`${file}: /generated without a section`); section = undefined; continue }
    if (section) continue
    if (block && !block.includes(os)) continue
    const tagged = /^(.*?)\s*<!-- os:([a-z0-9,]+) -->\s*$/.exec(line)
    if (tagged) { if (tagFor(tagged[2]).includes(os)) out.push(tagged[1]); continue }
    out.push(line)
  }
  if (block) throw new Error(`${file}: unterminated os block`)
  if (section) throw new Error(`${file}: unterminated generated section`)
  const text = out.join("\n")
  if (/<!--\s*\/?(os|generated)\b|^#os:/m.test(text)) throw new Error(`${file}: an os or generated marker survived for ${os}`)
  // Provenance keys describe where a file came from, not what this OS can do.
  const hits = text.split("\n").flatMap((l, i) => /^\s*(author|generated_by|created|updated|status|reviewed|source):/.test(l) ? []
    : FORBIDDEN[os].filter(re => re.test(l)).map(re => `  line ${i + 1} ${re}: ${l.trim().slice(0, 110)}`))
  if (hits.length) throw new Error(`${file}: the ${os} copy names another OS's surface\n${hits.join("\n")}`)
  return text
}

const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  if (name.startsWith("._") || name === ".DS_Store") return []
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : [path]
})

/** Every file of one skill for one OS, keyed by path inside the skill. */
export function renderSkill(skill: string, os: Os): Map<string, string | Buffer> {
  const allowed = SKILL_OSES[skill] ?? OSES
  if (!allowed.includes(os)) throw new Error(`${skill} does not ship on ${os}`)
  const dir = join(SKILLS, skill)
  const files = new Map<string, string | Buffer>()
  for (const path of walk(dir)) {
    const rel = relative(dir, path)
    files.set(rel, path.endsWith(".md") ? renderText(readFileSync(path, "utf8"), os, `${skill}/${rel}`) : readFileSync(path))
  }
  if (!files.has("SKILL.md")) throw new Error(`${skill} has no SKILL.md`)
  return files
}

export function writeSkills(os: Os, outDir: string, skills: string[]): void {
  // Render everything before writing anything, so a failure leaves no half-written pack.
  const rendered = skills.map(skill => [skill, renderSkill(skill, os)] as const)
  for (const [skill, files] of rendered) {
    const target = join(outDir, skill)
    rmSync(target, { recursive: true, force: true })
    for (const [rel, content] of files) {
      mkdirSync(dirname(join(target, rel)), { recursive: true })
      writeFileSync(join(target, rel), content)
    }
  }
}

if (import.meta.main) {
  const [os, outDir, ...skills] = process.argv.slice(2)
  if (!OSES.includes(os as Os) || !outDir || !skills.length) {
    console.error("usage: bun scripts/gen-skills.ts <darwin|win32|linux> <out-dir> <skill>...")
    process.exit(1)
  }
  writeSkills(os as Os, outDir, skills)
  console.log(`skills for ${os}: ${skills.join(", ")} -> ${outDir}`)
}
