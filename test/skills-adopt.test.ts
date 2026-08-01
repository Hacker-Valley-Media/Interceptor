import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync, realpathSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { classifyLink, adoptSkill, discoverSkills, allTargets, type SkillTarget, type SkillInfo } from "../cli/commands/skills"

let root: string
let packDir: string
let targetDir: string

function makeSkill(name: string): SkillInfo {
  const dir = join(packDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill ${name}\n---\nbody`)
  return { name, description: `test skill ${name}`, dir }
}

function target(): SkillTarget {
  return { id: "claude", label: "Claude Code", parent: join(root, ".claude"), dir: targetDir }
}

/**
 * Directory link matching what adoptSkill creates. Bare symlinkSync needs
 * Developer Mode or elevation on Windows and otherwise throws EPERM; junctions
 * need neither, which is why the implementation uses them there.
 */
function link(src: string, dst: string): void {
  symlinkSync(src, dst, process.platform === "win32" ? "junction" : undefined)
}

/**
 * Probed, not inferred from process.platform: macOS APFS is case-insensitive by
 * default but can be formatted case-sensitive, and Linux can mount either way.
 */
function caseInsensitiveFs(): boolean {
  const probe = join(root, "CaseProbe")
  mkdirSync(probe, { recursive: true })
  try {
    lstatSync(join(root, "caseprobe"))
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "interceptor-skills-test-"))
  packDir = join(root, "pack")
  targetDir = join(root, ".claude", "skills")
  mkdirSync(packDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("discoverSkills", () => {
  test("finds directories with SKILL.md and reads descriptions", () => {
    makeSkill("interceptor-browser")
    makeSkill("interceptor")
    mkdirSync(join(packDir, "not-a-skill"))
    const skills = discoverSkills(packDir)
    expect(skills.map(s => s.name)).toEqual(["interceptor", "interceptor-browser"])
    expect(skills[0].description).toBe("test skill interceptor")
  })
})

describe("classifyLink", () => {
  test("missing when destination does not exist", () => {
    const s = makeSkill("a")
    expect(classifyLink(targetDir, "a", s.dir)).toBe("missing")
  })

  test("linked when symlink resolves to the pack skill", () => {
    const s = makeSkill("a")
    mkdirSync(targetDir, { recursive: true })
    link(s.dir, join(targetDir, "a"))
    expect(classifyLink(targetDir, "a", s.dir)).toBe("linked")
  })

  test("foreign when symlink points elsewhere", () => {
    const s = makeSkill("a")
    const other = makeSkill("b")
    mkdirSync(targetDir, { recursive: true })
    link(other.dir, join(targetDir, "a"))
    expect(classifyLink(targetDir, "a", s.dir)).toBe("foreign")
  })

  test("stale-copy when destination is a real directory", () => {
    const s = makeSkill("a")
    mkdirSync(join(targetDir, "a"), { recursive: true })
    writeFileSync(join(targetDir, "a", "SKILL.md"), "old copy")
    expect(classifyLink(targetDir, "a", s.dir)).toBe("stale-copy")
  })

  test("name-collision when the on-disk entry differs only by case", () => {
    const s = makeSkill("interceptor")
    // Someone else's skill, capital I. On Windows / default APFS the lstat for
    // ".../interceptor" resolves this directory; readdir reports the true name.
    mkdirSync(join(targetDir, "Interceptor"), { recursive: true })
    writeFileSync(join(targetDir, "Interceptor", "SKILL.md"), "hand-authored, unstaged")
    const state = classifyLink(targetDir, "interceptor", s.dir)
    if (caseInsensitiveFs()) {
      expect(state).toBe("name-collision")
    } else {
      // Case-sensitive FS: the two names never collide, so nothing is at ours.
      expect(state).toBe("missing")
    }
  })

  test("exact-case match still classifies normally when a case variant exists too", () => {
    const s = makeSkill("a")
    mkdirSync(targetDir, { recursive: true })
    link(s.dir, join(targetDir, "a"))
    // Only meaningful where both can coexist; skip where the FS folds them.
    if (!caseInsensitiveFs()) {
      mkdirSync(join(targetDir, "A"), { recursive: true })
    }
    expect(classifyLink(targetDir, "a", s.dir)).toBe("linked")
  })
})

describe("adoptSkill", () => {
  test("creates a working symlink and reports linked", () => {
    const s = makeSkill("a")
    const r = adoptSkill(target(), s, false)
    expect(r.action).toBe("linked")
    expect(lstatSync(join(targetDir, "a")).isSymbolicLink()).toBe(true)
    expect(realpathSync(join(targetDir, "a"))).toBe(realpathSync(s.dir))
  })

  test("is idempotent (already-linked)", () => {
    const s = makeSkill("a")
    adoptSkill(target(), s, false)
    expect(adoptSkill(target(), s, false).action).toBe("already-linked")
  })

  test("replaces a foreign symlink (ln -sfn semantics, no data destroyed)", () => {
    const s = makeSkill("a")
    const other = makeSkill("b")
    mkdirSync(targetDir, { recursive: true })
    link(other.dir, join(targetDir, "a"))
    const r = adoptSkill(target(), s, false)
    expect(r.action).toBe("linked")
    expect(realpathSync(join(targetDir, "a"))).toBe(realpathSync(s.dir))
  })

  test("NEVER replaces a real directory without --force", () => {
    const s = makeSkill("a")
    mkdirSync(join(targetDir, "a"), { recursive: true })
    writeFileSync(join(targetDir, "a", "user-edit.md"), "precious")
    const r = adoptSkill(target(), s, false)
    expect(r.action).toBe("skipped")
    expect(lstatSync(join(targetDir, "a")).isDirectory()).toBe(true)
  })

  test("replaces a real directory with --force", () => {
    const s = makeSkill("a")
    mkdirSync(join(targetDir, "a"), { recursive: true })
    writeFileSync(join(targetDir, "a", "SKILL.md"), "old copy")
    const r = adoptSkill(target(), s, true)
    expect(r.action).toBe("replaced-copy")
    expect(lstatSync(join(targetDir, "a")).isSymbolicLink()).toBe(true)
  })

  test("--force NEVER deletes a case-only collision (another author's skill)", () => {
    if (!caseInsensitiveFs()) return
    const s = makeSkill("interceptor")
    mkdirSync(join(targetDir, "Interceptor"), { recursive: true })
    writeFileSync(join(targetDir, "Interceptor", "SKILL.md"), "hand-authored, unstaged")
    const r = adoptSkill(target(), s, true)
    expect(r.action).toBe("skipped")
    expect(r.state).toBe("name-collision")
    // The precious file survives — this is the whole point of the state.
    expect(readFileSync(join(targetDir, "Interceptor", "SKILL.md"), "utf-8")).toBe("hand-authored, unstaged")
  })

  test("skip detail distinguishes a --force-able stale copy from a collision", () => {
    const stale = makeSkill("a")
    mkdirSync(join(targetDir, "a"), { recursive: true })
    expect(adoptSkill(target(), stale, false).detail).toContain("--force")
    if (!caseInsensitiveFs()) return
    const collide = makeSkill("interceptor")
    mkdirSync(join(targetDir, "Interceptor"), { recursive: true })
    expect(adoptSkill(target(), collide, true).detail).toContain("not even with --force")
  })
})

describe("allTargets", () => {
  test("codex honors CODEX_HOME and defaults to ~/.codex/skills", () => {
    const defaults = allTargets("/home/u", {})
    const codex = defaults.find(t => t.id === "codex")!
    expect(codex.dir).toBe(join("/home/u", ".codex", "skills"))
    const overridden = allTargets("/home/u", { CODEX_HOME: "/custom/codex" })
    expect(overridden.find(t => t.id === "codex")!.dir).toBe(join("/custom/codex", "skills"))
  })

  test("claude targets ~/.claude/skills (resolves to %USERPROFILE%\\.claude on Windows)", () => {
    const claude = allTargets("/home/u", {}).find(t => t.id === "claude")!
    expect(claude.dir).toBe(join("/home/u", ".claude", "skills"))
  })
})
