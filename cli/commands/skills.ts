/**
 * cli/commands/skills.ts — interceptor skills list|status|show|adopt
 *
 *
 * Links the skill packs shipped with the pkg into the skills directories of
 * the AI runtimes present on this machine. Symlinks (junctions on Windows —
 * they need neither Developer Mode nor elevation) keep adopted skills current
 * across package updates; a physical copy would silently go stale (observed
 * in the wild: a ~/.codex/skills/interceptor copy six weeks behind the pkg).
 *
 * Per-skill selection, whole-folder links: one symlink per skill directory.
 * A real directory at the destination is NEVER replaced without --force.
 */

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs"
import { join, dirname, resolve } from "node:path"
import { homedir, tmpdir } from "node:os"
import { isAbsoluteOwnedRoot } from "../../shared/install-maintenance"

const PKG_SKILLS_DIR_DARWIN = "/Library/Application Support/Interceptor/skills"
const SKILLS_REFRESH_MARKER_DARWIN = "/Library/Application Support/Interceptor/.skills-refresh"
const HINT_FLAG_FILE = join(tmpdir(), "interceptor-skills-hint.flag")
const HINT_WINDOW_MS = 24 * 60 * 60 * 1000

export type LinkState = "linked" | "stale-copy" | "foreign" | "missing"

export type SkillTarget = {
  id: string
  label: string
  dir: string      // skills dir links are created in
  parent: string   // runtime home whose existence means "this runtime is installed"
}

export type SkillInfo = { name: string; description: string; dir: string }

// ── pack discovery ────────────────────────────────────────────────────────────

/** Installed skill-pack directory: pkg locations first, dev checkout fallback. */
export function resolvePackDir(): string | null {
  if (process.platform === "darwin" && existsSync(PKG_SKILLS_DIR_DARWIN)) {
    return PKG_SKILLS_DIR_DARWIN
  }
  // Windows: Inno lays skills down next to the CLI at {app}\skills
  const besideBinary = join(dirname(process.execPath), "skills")
  if (existsSync(join(besideBinary, "interceptor-browser"))) return besideBinary
  // Dev checkout: walk up from the binary / cwd looking for .agents/skills
  const starts = [dirname(process.execPath), process.cwd()]
  for (const start of starts) {
    let cur = start
    for (let hop = 0; hop < 6; hop++) {
      const candidate = resolve(cur, ".agents/skills")
      if (existsSync(join(candidate, "interceptor-browser"))) return candidate
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  }
  return null
}

function skillDescription(dir: string): string {
  try {
    const raw = readFileSync(join(dir, "SKILL.md"), "utf-8")
    const m = /^description:\s*(.+)$/m.exec(raw)
    if (m) return m[1].trim().replace(/^["']|["']$/g, "")
  } catch {}
  return ""
}

export function discoverSkills(packDir: string): SkillInfo[] {
  try {
    return readdirSync(packDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && existsSync(join(packDir, e.name, "SKILL.md")))
      .map(e => ({
        name: e.name,
        description: skillDescription(join(packDir, e.name)),
        dir: join(packDir, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

// ── runtime targets ───────────────────────────────────────────────────────────

/**
 * Candidate runtimes. Codex's home is $CODEX_HOME (default ~/.codex) — its
 * documented USER-scope skills dir is ~/.agents/skills, but curated installs
 * land in $CODEX_HOME/skills and both are scanned; we link into the Codex
 * home so `codex` means Codex regardless of the shared-.agents convention.
 */
export function allTargets(home = homedir(), env: Record<string, string | undefined> = process.env): SkillTarget[] {
  const codexHome = env.CODEX_HOME || join(home, ".codex")
  return [
    { id: "claude", label: "Claude Code", parent: join(home, ".claude"), dir: join(home, ".claude", "skills") },
    { id: "codex", label: "Codex", parent: codexHome, dir: join(codexHome, "skills") },
    { id: "agents", label: "~/.agents consumers", parent: join(home, ".agents"), dir: join(home, ".agents", "skills") },
    { id: "openclaw", label: "OpenClaw", parent: join(home, ".openclaw"), dir: join(home, ".openclaw", "skills") },
    { id: "opencode", label: "OpenCode", parent: join(home, ".config", "opencode"), dir: join(home, ".config", "opencode", "skills") },
  ]
}

export function detectedTargets(home = homedir(), env: Record<string, string | undefined> = process.env): SkillTarget[] {
  return allTargets(home, env).filter(t => existsSync(t.parent))
}

// ── classification ────────────────────────────────────────────────────────────

export function classifyLink(targetDir: string, skillName: string, srcDir: string): LinkState {
  const dst = join(targetDir, skillName)
  let st
  try { st = lstatSync(dst) } catch { return "missing" }
  if (st.isSymbolicLink()) {
    try {
      if (realpathSync(dst) === realpathSync(srcDir)) return "linked"
    } catch { return "foreign" } // dangling link
    return "foreign"
  }
  if (st.isDirectory()) return "stale-copy"
  return "foreign"
}

// ── adopt ─────────────────────────────────────────────────────────────────────

export type AdoptResult = {
  target: string
  skill: string
  action: "linked" | "already-linked" | "skipped" | "replaced-copy" | "error"
  detail?: string
}

export type UnadoptResult = {
  target: string
  skill: string
  action: "removed" | "missing" | "foreign" | "not-link" | "error"
  detail?: string
}

function comparablePath(path: string, platform = process.platform): string {
  let normalized = resolve(path)
  if (platform === "win32") {
    normalized = normalized.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/i, "")
    normalized = normalized.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase()
  } else {
    normalized = normalized.replace(/\/+$/, "") || "/"
  }
  return normalized
}

export function unadoptSkill(target: SkillTarget, skillName: string, ownedRoot: string): UnadoptResult {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(skillName)) {
    return { target: target.id, skill: skillName, action: "error", detail: "invalid skill name" }
  }
  if (!isAbsoluteOwnedRoot(ownedRoot)) {
    return { target: target.id, skill: skillName, action: "error", detail: "--owned-root must be absolute" }
  }

  const destination = join(target.dir, skillName)
  let stat
  try {
    stat = lstatSync(destination)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { target: target.id, skill: skillName, action: "missing" }
    return { target: target.id, skill: skillName, action: "error", detail: (error as Error).message }
  }
  if (!stat.isSymbolicLink()) {
    return { target: target.id, skill: skillName, action: "not-link", detail: "destination is a real file or directory" }
  }

  try {
    const recorded = readlinkSync(destination)
    const recordedAbsolute = resolve(dirname(destination), recorded)
    const expected = resolve(ownedRoot, skillName)
    if (comparablePath(recordedAbsolute) !== comparablePath(expected)) {
      return { target: target.id, skill: skillName, action: "foreign", detail: "link target is outside the owned skill root" }
    }
    unlinkSync(destination)
    return { target: target.id, skill: skillName, action: "removed" }
  } catch (error) {
    return { target: target.id, skill: skillName, action: "error", detail: (error as Error).message }
  }
}

export function adoptSkill(target: SkillTarget, skill: SkillInfo, force: boolean): AdoptResult {
  const dst = join(target.dir, skill.name)
  const state = classifyLink(target.dir, skill.name, skill.dir)
  try {
    mkdirSync(target.dir, { recursive: true })
    if (state === "linked") return { target: target.id, skill: skill.name, action: "already-linked" }
    if (state === "foreign") {
      // ln -sfn semantics: replacing a symlink (even one pointing elsewhere)
      // destroys no data — the target directory is untouched.
      unlinkSync(dst)
    } else if (state === "stale-copy") {
      if (!force) {
        return {
          target: target.id, skill: skill.name, action: "skipped",
          detail: `${dst} is a real directory (stale copy?) — re-run with --force to replace it with a link`,
        }
      }
      rmSync(dst, { recursive: true })
    }
    symlinkSync(skill.dir, dst, process.platform === "win32" ? "junction" : undefined)
    // verify the link resolves before reporting success
    if (!existsSync(dst)) {
      return { target: target.id, skill: skill.name, action: "error", detail: `link created at ${dst} but does not resolve` }
    }
    return { target: target.id, skill: skill.name, action: state === "stale-copy" ? "replaced-copy" : "linked" }
  } catch (err) {
    return { target: target.id, skill: skill.name, action: "error", detail: (err as Error).message }
  }
}

// ── status summary (shared with `interceptor status` and the manifest) ────────

export type SkillsStatusSummary = {
  packDir: string | null
  skills: string[]
  targets: Array<{ id: string; dir: string; linked: number; total: number; states: Record<string, LinkState> }>
}

export function skillsStatusSummary(): SkillsStatusSummary {
  const packDir = resolvePackDir()
  if (!packDir) return { packDir: null, skills: [], targets: [] }
  const skills = discoverSkills(packDir)
  const targets = detectedTargets().map(t => {
    const states: Record<string, LinkState> = {}
    let linked = 0
    for (const s of skills) {
      const st = classifyLink(t.dir, s.name, s.dir)
      states[s.name] = st
      if (st === "linked") linked++
    }
    return { id: t.id, dir: t.dir, linked, total: skills.length, states }
  })
  return { packDir, skills: skills.map(s => s.name), targets }
}

// ── update-time hint ────────────

/**
 * One rate-limited stderr line when installed skills are not (or no longer)
 * linked into a detected runtime. Information, not coercion: changes nothing
 * about the command's behavior or stdout. Opt out with --no-skills-hint or
 * INTERCEPTOR_NO_SKILLS_HINT=1.
 */
export function maybeEmitSkillsHint(argv: string[], env: Record<string, string | undefined> = process.env): void {
  if (argv.includes("--no-skills-hint") || env.INTERCEPTOR_NO_SKILLS_HINT) return
  try {
    if (existsSync(HINT_FLAG_FILE)) {
      const age = Date.now() - statSync(HINT_FLAG_FILE).mtimeMs
      if (age < HINT_WINDOW_MS) return
    }
    const summary = skillsStatusSummary()
    if (!summary.packDir || summary.targets.length === 0) return
    const gaps: string[] = []
    for (const t of summary.targets) {
      const unlinked = Object.entries(t.states).filter(([, st]) => st !== "linked")
      if (unlinked.length > 0) {
        gaps.push(`${t.id}: ${unlinked.length} of ${t.total} not linked`)
      }
    }
    if (gaps.length === 0) return
    writeFileSync(HINT_FLAG_FILE, String(Date.now()))
    process.stderr.write(
      `hint: Interceptor skill packs are not fully linked into your AI runtimes (${gaps.join("; ")}). ` +
      `Run 'interceptor skills adopt'. (--no-skills-hint to silence)\n`,
    )
  } catch {
    // never let the hint break a real command
  }
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

function parseInto(filtered: string[]): string[] | null {
  const idx = filtered.indexOf("--into")
  if (idx === -1) return null
  const val = filtered[idx + 1]
  if (!val || val.startsWith("--")) {
    console.error("error: --into requires a comma-separated target list (claude,codex,agents,openclaw,opencode)")
    process.exit(1)
  }
  return val.split(",").map(s => s.trim()).filter(Boolean)
}

export function runSkillsCommand(filtered: string[], jsonMode: boolean): null {
  const sub = filtered[1] && !filtered[1].startsWith("--") ? filtered[1] : "list"
  const packDir = resolvePackDir()

  if (!packDir) {
    const msg = "no installed skill packs found (looked in the pkg location and for a dev checkout)"
    if (jsonMode) console.log(JSON.stringify({ success: false, error: msg }))
    else console.error(`error: ${msg}`)
    process.exit(1)
  }

  const skills = discoverSkills(packDir)

  if (sub === "list") {
    const summary = skillsStatusSummary()
    if (jsonMode) {
      console.log(JSON.stringify({ packDir, skills: discoverSkills(packDir), targets: summary.targets }, null, 2))
      return null
    }
    console.log(`skill packs at ${packDir}:\n`)
    for (const s of skills) {
      console.log(`  ${s.name}`)
      if (s.description) console.log(`      ${s.description.slice(0, 120)}${s.description.length > 120 ? "…" : ""}`)
    }
    console.log("")
    if (summary.targets.length === 0) {
      console.log("no AI runtimes detected (~/.claude, ~/.codex, ~/.agents, ~/.openclaw, ~/.config/opencode)")
    } else {
      for (const t of summary.targets) console.log(`  ${t.id}: ${t.linked}/${t.total} linked (${t.dir})`)
      console.log("\nRun 'interceptor skills adopt' to link, 'interceptor skills status' for detail, 'interceptor skills show <name>' for one skill.")
    }
    return null
  }

  if (sub === "status") {
    const summary = skillsStatusSummary()
    if (jsonMode) {
      console.log(JSON.stringify(summary, null, 2))
      return null
    }
    if (summary.targets.length === 0) {
      console.log("no AI runtimes detected")
      return null
    }
    for (const t of summary.targets) {
      console.log(`${t.id} (${t.dir}): ${t.linked}/${t.total} linked`)
      for (const [name, st] of Object.entries(t.states)) {
        console.log(`  ${st === "linked" ? "✓" : st === "missing" ? "·" : "!"} ${name}: ${st}`)
      }
    }
    return null
  }

  if (sub === "show") {
    const name = filtered[2]
    const skill = skills.find(s => s.name === name)
    if (!skill) {
      console.error(`error: unknown skill '${name || ""}'. Installed: ${skills.map(s => s.name).join(", ")}`)
      process.exit(1)
    }
    const summary = skillsStatusSummary()
    if (jsonMode) {
      console.log(JSON.stringify({
        ...skill,
        adoption: summary.targets.map(t => ({ target: t.id, state: t.states[skill.name] })),
      }, null, 2))
      return null
    }
    console.log(`${skill.name} — ${skill.description}`)
    console.log(`pack: ${skill.dir}`)
    for (const t of summary.targets) console.log(`  ${t.id}: ${t.states[skill.name]}`)
    if (skill.name === "interceptor-browser" || skill.name === "interceptor") {
      console.log("\nPicking the right text verb (what each actually returns):")
      console.log("  read --text-only / text     visible rendered text (innerText); 8K cap, --full → 200K")
      console.log("  read --markdown             text WITH structure — headings/bold/lists/tables preserved")
      console.log("  text e<ref>                 one element's textContent (includes display:none text)")
      console.log("  html e<ref>                 raw outerHTML markup")
      console.log("  read --tree-only / tree     a11y tree of interactive elements + refs for act")
      console.log("  find \"<term>\"               current-page rendered text + accessible elements (snippets + refs)")
      console.log("  find \"<term>\" --text-only   current-page rendered-text snippets only")
      console.log("  find \"<term>\" --elements-only  accessible controls only")
      console.log("  websearch \"<query>\"          configured default provider in a managed background tab")
      console.log("  table/links/forms/query     structured JSON extraction")
      console.log("\nFull machine-readable semantics: interceptor manifest")
    }
    return null
  }

  if (sub === "adopt") {
    const force = filtered.includes("--force")
    const all = filtered.includes("--all")
    const intoIds = parseInto(filtered)
    const detected = detectedTargets()
    const targets = intoIds
      ? allTargets().filter(t => intoIds.includes(t.id))
      : detected
    if (intoIds) {
      const known = new Set(allTargets().map(t => t.id))
      const bad = intoIds.filter(id => !known.has(id))
      if (bad.length) {
        console.error(`error: unknown target(s) ${bad.join(", ")} (valid: claude, codex, agents, openclaw, opencode)`)
        process.exit(1)
      }
    }
    if (targets.length === 0) {
      console.error("error: no AI runtimes detected and no --into given. Try: interceptor skills adopt --into claude")
      process.exit(1)
    }
    // positional skill names: argv is normalized, so positionals run from
    // index 2 until the first flag token
    const nameArgs: string[] = []
    for (let i = 2; i < filtered.length; i++) {
      if (filtered[i].startsWith("--")) break
      nameArgs.push(filtered[i])
    }
    const unknown = nameArgs.filter(n => !skills.some(s => s.name === n))
    if (unknown.length > 0) {
      console.error(`error: unknown skill(s) ${unknown.join(", ")}. Installed: ${skills.map(s => s.name).join(", ")}`)
      process.exit(1)
    }
    const requested = all || nameArgs.length === 0
      ? skills
      : skills.filter(s => nameArgs.includes(s.name))

    const results: AdoptResult[] = []
    for (const t of targets) {
      for (const s of requested) {
        results.push(adoptSkill(t, s, force))
      }
    }
    if (jsonMode) {
      console.log(JSON.stringify({ success: results.every(r => r.action !== "error"), results }, null, 2))
    } else {
      for (const r of results) {
        const mark = r.action === "error" ? "✗" : r.action === "skipped" ? "!" : "✓"
        console.log(`${mark} ${r.target}/${r.skill}: ${r.action}${r.detail ? ` — ${r.detail}` : ""}`)
      }
      const skipped = results.filter(r => r.action === "skipped").length
      if (skipped) console.log(`\n${skipped} destination(s) were real directories — re-run with --force to replace them with links.`)
    }
    if (results.some(r => r.action === "error")) process.exit(1)
    return null
  }

  if (sub === "unadopt") {
    if (filtered.includes("--force")) {
      console.error("error: skills unadopt never accepts --force")
      process.exit(1)
    }
    const rootIndex = filtered.indexOf("--owned-root")
    const ownedRoot = rootIndex >= 0 ? filtered[rootIndex + 1] : ""
    if (!ownedRoot || ownedRoot.startsWith("--") || !isAbsoluteOwnedRoot(ownedRoot)) {
      console.error("error: skills unadopt requires --owned-root <absolute-path>")
      process.exit(1)
    }
    const all = filtered.includes("--all")
    const intoIds = parseInto(filtered)
    const targets = intoIds
      ? allTargets().filter(target => intoIds.includes(target.id))
      : detectedTargets()
    if (intoIds) {
      const known = new Set(allTargets().map(target => target.id))
      const bad = intoIds.filter(id => !known.has(id))
      if (bad.length > 0) {
        console.error(`error: unknown target(s) ${bad.join(", ")} (valid: claude, codex, agents, openclaw, opencode)`)
        process.exit(1)
      }
    }
    const nameArgs: string[] = []
    for (let index = 2; index < filtered.length; index++) {
      if (filtered[index].startsWith("--")) break
      nameArgs.push(filtered[index])
    }
    const knownNames = new Set(skills.map(skill => skill.name))
    const unknown = nameArgs.filter(name => !knownNames.has(name))
    if (unknown.length > 0) {
      console.error(`error: unknown skill(s) ${unknown.join(", ")}. Installed: ${skills.map(skill => skill.name).join(", ")}`)
      process.exit(1)
    }
    const requestedNames = all || nameArgs.length === 0 ? skills.map(skill => skill.name) : nameArgs
    const results: UnadoptResult[] = []
    for (const target of targets) {
      for (const skillName of requestedNames) results.push(unadoptSkill(target, skillName, ownedRoot))
    }
    const success = results.every(result => result.action !== "error")
    if (jsonMode) {
      console.log(JSON.stringify({ success, results }, null, 2))
    } else {
      for (const result of results) {
        const mark = result.action === "error" ? "✗" : result.action === "removed" ? "✓" : "·"
        console.log(`${mark} ${result.target}/${result.skill}: ${result.action}${result.detail ? ` — ${result.detail}` : ""}`)
      }
    }
    if (!success) process.exit(1)
    return null
  }

  console.error(`error: unknown skills subcommand '${sub}'. Usage: interceptor skills [list|status|show <name>|adopt ...|unadopt [names…] [--into t1,t2] [--all] --owned-root <path>]`)
  process.exit(1)
}
