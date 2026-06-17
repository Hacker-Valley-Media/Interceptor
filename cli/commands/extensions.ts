/**
 * cli/commands/extensions.ts — `interceptor extensions <subcommand>`
 *
 * Extension Fabric operator surface. Filesystem-only; no daemon needed.
 *
 *   extensions list                 show discovered (+ rejected) extensions
 *   extensions sync                 symlink each extension's skill/ into the host
 *                                   agent skill dirs as interceptor-ext-<name>/
 *   extensions sync --remove        remove those symlinks (uninstall step)
 *
 * `sync` is an EXPLICIT, on-demand verb — the core never silently mutates the
 * user's home skill dirs. It mirrors the manual symlink step the
 * installer's conclusion screen shows for the shipped skills.
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from "node:fs"
import { discoverExtensions, extensionsRoot, type DiscoveredExtension } from "../../shared/extensions"

/** Host agent-runtime skill directories (the 4-runtime set). */
function skillTargetDirs(): string[] {
  const home = process.env.INTERCEPTOR_HOME_OVERRIDE || process.env.HOME || process.env.USERPROFILE || ""
  if (!home) return []
  return [
    `${home}/.claude/skills`,
    `${home}/.agents/skills`,
    `${home}/.openclaw/skills`,
    `${home}/.config/opencode/skills`,
  ]
}

function extSkillLinkName(name: string): string {
  return `interceptor-ext-${name}`
}

/** Absolute path to an extension's own skill dir, or null if it declares none. */
function extSkillDir(ext: DiscoveredExtension): string | null {
  const rel = ext.manifest.skill
  if (!rel || rel.length === 0) return null
  const abs = rel.startsWith("/") ? rel : `${ext.dir}/${rel.replace(/\/+$/, "")}`
  return existsSync(abs) ? abs : null
}

type SyncEntry = { extension: string; link: string; target: string; action: string }

function syncExtensions(remove: boolean): { changed: SyncEntry[]; skipped: string[] } {
  const { extensions } = discoverExtensions()
  const targets = skillTargetDirs()
  const changed: SyncEntry[] = []
  const skipped: string[] = []
  for (const ext of extensions) {
    const src = extSkillDir(ext)
    if (!src && !remove) { skipped.push(`${ext.name} (no skill/ declared)`); continue }
    const linkName = extSkillLinkName(ext.name)
    for (const dir of targets) {
      const linkPath = `${dir}/${linkName}`
      if (remove) {
        try {
          if (linkExists(linkPath)) { rmSync(linkPath, { force: true }); changed.push({ extension: ext.name, link: linkPath, target: "", action: "removed" }) }
        } catch { /* best-effort */ }
        continue
      }
      try {
        mkdirSync(dir, { recursive: true })
        // Idempotent: replace an existing symlink pointing elsewhere; leave a
        // correct one alone; never clobber a real directory the user owns.
        if (linkExists(linkPath)) {
          if (isSymlink(linkPath) && readlinkSafe(linkPath) === src) { continue }
          if (isSymlink(linkPath)) { unlinkSync(linkPath) }
          else { skipped.push(`${linkPath} (exists, not a symlink — left untouched)`); continue }
        }
        symlinkSync(src as string, linkPath)
        changed.push({ extension: ext.name, link: linkPath, target: src as string, action: "linked" })
      } catch (err) {
        skipped.push(`${linkPath} (${(err as Error).message})`)
      }
    }
  }
  return { changed, skipped }
}

function linkExists(p: string): boolean {
  try { lstatSync(p); return true } catch { return false }
}
function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}
function readlinkSafe(p: string): string | null {
  try { return readlinkSync(p) } catch { return null }
}

export function runExtensionsCommand(filtered: string[], jsonMode: boolean): void {
  const sub = filtered[1]
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(extensionsHelpText())
    return
  }
  switch (sub) {
    case "list": {
      const { extensions, rejected } = discoverExtensions()
      const rows = extensions.map(e => ({
        name: e.name,
        version: e.manifest.version,
        dir: e.dir,
        bridgeDomains: (e.manifest.bridgeDomains ?? []).map(d => d.prefix),
        cliVerbs: (e.manifest.cliVerbs ?? []).map(v => `${v.actionPrefix} ${v.verb}`),
        hasAgent: !!e.manifest.agent,
        skill: e.manifest.skill ?? null,
      }))
      if (jsonMode) { console.log(JSON.stringify({ root: extensionsRoot(), extensions: rows, rejected }, null, 2)); return }
      console.log(`extensions root: ${extensionsRoot()}`)
      if (rows.length === 0) console.log("(no extensions installed)")
      for (const r of rows) {
        console.log(`\n${r.name}@${r.version}`)
        console.log(`  dir:           ${r.dir}`)
        if (r.bridgeDomains.length) console.log(`  bridgeDomains: ${r.bridgeDomains.join(", ")}`)
        if (r.cliVerbs.length) console.log(`  cliVerbs:      ${r.cliVerbs.join(", ")}`)
        console.log(`  agent:         ${r.hasAgent ? "yes" : "no"}`)
        console.log(`  skill:         ${r.skill ?? "none"}`)
      }
      for (const rej of rejected) console.error(`\nREJECTED ${rej.name}: ${rej.error}`)
      return
    }
    case "sync": {
      const remove = filtered.includes("--remove")
      const { changed, skipped } = syncExtensions(remove)
      if (jsonMode) { console.log(JSON.stringify({ changed, skipped }, null, 2)); return }
      for (const c of changed) console.log(`${c.action}: ${c.link}${c.target ? ` -> ${c.target}` : ""}`)
      for (const s of skipped) console.log(`skipped: ${s}`)
      if (changed.length === 0 && skipped.length === 0) console.log("no extension skills to sync")
      return
    }
    default:
      console.error(`error: unknown extensions subcommand '${sub}'. Try: list | sync`)
      process.exit(1)
  }
}

export function extensionsHelpText(): string {
  return `interceptor extensions <subcommand>

  list                  show discovered (and rejected) extensions under the root
  sync                  symlink each extension's skill/ into the host agent skill
                        dirs (~/.claude/skills, ~/.agents/skills, ~/.openclaw/skills,
                        ~/.config/opencode/skills) as interceptor-ext-<name>/
  sync --remove         remove those symlinks (uninstall step)

Extensions are operator-placed under ~/.interceptor/extensions/<name>/ (override
with INTERCEPTOR_EXTENSIONS_DIR). The core discovers them from disk only — it
never fetches an extension over the network. See docs/extensions/authoring.md.`
}
