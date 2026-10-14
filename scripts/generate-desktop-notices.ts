#!/usr/bin/env bun
// Adds the license text of every Rust package the Windows and Linux providers link, and that
// interceptor-desktop/THIRD-PARTY-NOTICES.txt does not list yet. Existing entries are left as
// they are; run it after a dependency is added. The file ships to users, so it never names a
// build machine's path: a cargo registry checkout is written as <crate>-<version>/<file>.
//   bun scripts/generate-desktop-notices.ts [--check]
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

const root = resolve(import.meta.dir, ".."), manifest = join(root, "interceptor-desktop", "Cargo.toml"), notices = join(root, "interceptor-desktop", "THIRD-PARTY-NOTICES.txt")
const cargo = (args: string[]) => {
  const run = Bun.spawnSync(["cargo", ...args, "--manifest-path", manifest, "--locked"], { stdout: "pipe", stderr: "pipe" })
  if (run.exitCode !== 0) throw new Error(`cargo ${args[0]} failed: ${run.stderr.toString().slice(-600)}`)
  return run.stdout.toString()
}
// Everything in the normal and build dependency graph of each shipped target.
const linked = new Set<string>()
for (const target of ["aarch64-pc-windows-msvc", "x86_64-pc-windows-msvc", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]) {
  for (const line of cargo(["tree", "--target", target, "--edges", "normal,build", "--prefix", "none", "--format", "{p}"]).split("\n")) {
    const match = line.match(/^(\S+) v(\S+)/)
    if (match && match[1] !== "interceptor-desktop") linked.add(`${match[1]} ${match[2]}`)
  }
}
const packages = JSON.parse(cargo(["metadata", "--format-version", "1"])).packages as { name: string; version: string; license?: string; manifest_path: string }[]
const neutral = (text: string) => text.replace(/(?:[A-Za-z]:)?[\\/]\S*?[\\/]registry[\\/]src[\\/][^\\/\s]+[\\/]/g, "")
const original = readFileSync(notices, "utf8")
let text = neutral(original)
const listed = new Set([...text.matchAll(/^(\S+ \S+) \(.*\)$/gm)].map(m => m[1]))
const added: string[] = []
for (const key of [...linked].sort()) {
  if (listed.has(key)) continue
  const found = packages.find(p => `${p.name} ${p.version}` === key)
  if (!found) throw new Error(`no cargo metadata for ${key}`)
  const folder = dirname(found.manifest_path)
  const files = readdirSync(folder).filter(name => /^(licen[sc]e|copying|notice|unlicense)/i.test(name)).sort()
  // A few packages publish only the SPDX expression in Cargo.toml and no license file.
  const body = files.length ? files.map(name => `\n${name}\n${readFileSync(join(folder, name), "utf8").trimEnd()}\n`).join("") : "\nThis package includes no license file; it is licensed under the SPDX expression above.\n"
  text += neutral(`\n${key} (${found.license ?? "see license text"})\n` + body)
  added.push(key)
}
const local = [homedir(), root].find(path => text.includes(path))
if (local) throw new Error(`THIRD-PARTY-NOTICES.txt would name a local path (${local}); remove it from the entry`)
if (process.argv.includes("--check")) {
  if (added.length || text !== original) { console.error(added.length ? `missing from THIRD-PARTY-NOTICES.txt: ${added.join(", ")}` : "THIRD-PARTY-NOTICES.txt names a build-machine path; run without --check"); process.exit(1) }
  console.log(`notices cover all ${linked.size} linked packages`)
}
else { if (added.length || text !== original) writeFileSync(notices, text); console.log(JSON.stringify({ linked: linked.size, added, neutralized: neutral(original) !== original })) }
