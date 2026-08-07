import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { unadoptSkill, type SkillTarget } from "../cli/commands/skills"

let root: string
let ownedRoot: string
let targetDir: string

function target(): SkillTarget {
  return { id: "codex", label: "Codex", parent: join(root, ".codex"), dir: targetDir }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "interceptor-unadopt-test-"))
  ownedRoot = join(root, "installed", "skills")
  targetDir = join(root, ".codex", "skills")
  mkdirSync(join(ownedRoot, "interceptor"), { recursive: true })
  mkdirSync(targetDir, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("skills unadopt", () => {
  test("removes only a link whose recorded target is the owned skill", () => {
    const destination = join(targetDir, "interceptor")
    symlinkSync(join(ownedRoot, "interceptor"), destination)
    expect(unadoptSkill(target(), "interceptor", ownedRoot).action).toBe("removed")
    expect(() => lstatSync(destination)).toThrow()
    expect(lstatSync(join(ownedRoot, "interceptor")).isDirectory()).toBe(true)
  })

  test("removes a dangling owned link by reading it without following", () => {
    const destination = join(targetDir, "interceptor")
    const ownedTarget = join(ownedRoot, "interceptor")
    rmSync(ownedTarget, { recursive: true })
    symlinkSync(ownedTarget, destination)
    expect(readlinkSync(destination)).toBe(ownedTarget)
    expect(unadoptSkill(target(), "interceptor", ownedRoot).action).toBe("removed")
  })

  test("preserves a foreign link", () => {
    const foreign = join(root, "foreign")
    mkdirSync(foreign)
    const destination = join(targetDir, "interceptor")
    symlinkSync(foreign, destination)
    expect(unadoptSkill(target(), "interceptor", ownedRoot).action).toBe("foreign")
    expect(lstatSync(destination).isSymbolicLink()).toBe(true)
  })

  test("preserves real directories and files", () => {
    const destination = join(targetDir, "interceptor")
    mkdirSync(destination)
    writeFileSync(join(destination, "user.md"), "keep")
    expect(unadoptSkill(target(), "interceptor", ownedRoot).action).toBe("not-link")
    expect(lstatSync(destination).isDirectory()).toBe(true)
  })

  test("is idempotent and rejects traversal", () => {
    expect(unadoptSkill(target(), "interceptor", ownedRoot).action).toBe("missing")
    expect(unadoptSkill(target(), "../interceptor", ownedRoot).action).toBe("error")
  })
})
