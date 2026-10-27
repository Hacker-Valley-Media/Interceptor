#!/usr/bin/env bun
// Publishes the Windows and Linux automatic-update feeds beside Sparkle's appcast on the
// update host. Each feed names one Full installer per architecture with its SHA-256 and length and is
// signed with the Sparkle Ed25519 key, which the provider pins (interceptor-desktop/src/update.rs).
//   bun scripts/publish-desktop-updates.ts [--version X.Y.Z] --assets <dir> [--host-dir <dir>] [--dry-run]
//   bun scripts/publish-desktop-updates.ts [--version X.Y.Z] --verify-live
// Run after the GitHub release is public (the artifact URLs redirect to its assets) and before
// deploying the host; then run --verify-live against the deployed host.
import { createHash, createPublicKey, verify } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

export const HOST = "https://updates.hackervalley.media"
export const ARCHES = ["arm64", "x64"] as const
export type Os = "windows" | "linux"
export type Artifact = { file: string; url: string; sha256: string; length: number }
export type Payload = { schema: "interceptor.update.latest/1"; os: Os; version: string; issuedAt: string; notes?: string; notesSha256?: string; artifacts: Record<string, Artifact> }
/** The release notes page the update window shows; the feed pins its digest, as Sparkle signs releaseNotesLink. */
export type Notes = { url: string; sha256: string }

const root = resolve(import.meta.dir, "..")
export const fileName = (version: string, os: Os, arch: string) => `Interceptor-Full-${version}-${os}-${arch}.${os === "windows" ? "exe" : "tar.gz"}`

/** Sparkle's SUPublicEDKey: the default in scripts/build-bridge.sh unless the build overrides it. */
export function publicKey(): string {
  const fromEnv = process.env.INTERCEPTOR_SPARKLE_PUBLIC_KEY
  if (fromEnv) return fromEnv
  const match = /INTERCEPTOR_SPARKLE_PUBLIC_KEY:-([A-Za-z0-9+/=]+)/.exec(readFileSync(join(root, "scripts/build-bridge.sh"), "utf8"))
  if (!match) throw new Error("no Sparkle public key in scripts/build-bridge.sh")
  return match[1]
}
/// `base` and `arches` exist for a lab feed (a provider with INTERCEPTOR_UPDATE_FEED); releases use the defaults.
export function buildPayload(os: Os, version: string, assets: Record<string, Buffer>, issuedAt: string, notes?: Notes, base = HOST, arches: readonly string[] = ARCHES): Payload {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version ${version} is not X.Y.Z`)
  const artifacts: Record<string, Artifact> = {}
  for (const arch of arches) {
    const bytes = assets[arch]
    if (!bytes?.length) throw new Error(`${fileName(version, os, arch)} is missing; every architecture publishes together`)
    if (os === "windows" && bytes.subarray(0, 2).toString("latin1") !== "MZ") throw new Error(`${fileName(version, os, arch)} is not a Windows executable`)
    if (os === "linux" && (bytes[0] !== 0x1f || bytes[1] !== 0x8b)) throw new Error(`${fileName(version, os, arch)} is not a gzip archive`)
    const file = fileName(version, os, arch)
    artifacts[arch] = { file, url: `${base}/${os}/${file}`, sha256: createHash("sha256").update(bytes).digest("hex"), length: bytes.length }
  }
  return { schema: "interceptor.update.latest/1", os, version, issuedAt, ...(notes ? { notes: notes.url, notesSha256: notes.sha256 } : {}), artifacts }
}
export function envelope(payload: Buffer, signature: Buffer): string {
  return JSON.stringify({ schema: "interceptor.update.envelope/1", payload: payload.toString("base64"), signature: signature.toString("base64") }) + "\n"
}
/** The provider's check: the Ed25519 signature over the exact payload bytes, with the pinned raw key. */
export function verifyEnvelope(text: string, rawKey: string): Payload {
  const outer = JSON.parse(text)
  if (outer.schema !== "interceptor.update.envelope/1" || Object.keys(outer).length !== 3) throw new Error("not an Interceptor update envelope")
  const payload = Buffer.from(outer.payload, "base64"), signature = Buffer.from(outer.signature, "base64")
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(rawKey, "base64")]), format: "der", type: "spki" })
  if (!verify(null, payload, key, signature)) throw new Error("feed signature does not verify against the Sparkle public key")
  return JSON.parse(payload.toString("utf8"))
}
/** Sparkle's sign_update signs any file with the Ed25519 key in the login keychain. */
export function sparkleSign(bytes: Buffer): Buffer {
  const tools = process.env.INTERCEPTOR_SPARKLE_TOOLS_DIR ?? join(process.env.HOME ?? "", ".cache/interceptor-sparkle", process.env.INTERCEPTOR_SPARKLE_VERSION ?? "2.9.1")
  const signer = join(tools, "bin/sign_update")
  if (!existsSync(signer)) throw new Error(`${signer} is missing; run scripts/publish-sparkle.sh once to cache the Sparkle tools`)
  const scratch = mkdtempSync(join(tmpdir(), "interceptor-feed-"))
  try {
    writeFileSync(join(scratch, "payload.json"), bytes)
    const run = Bun.spawnSync([signer, join(scratch, "payload.json")], { stdout: "pipe", stderr: "pipe" })
    const match = /sparkle:edSignature="([^"]+)"/.exec(run.stdout.toString())
    if (run.exitCode !== 0 || !match) throw new Error(`sign_update failed: ${run.stderr.toString().trim()}`)
    return Buffer.from(match[1], "base64")
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
/** The Linux archives must be the ones the CMS-signed SHA256SUMS lists (verify-release-manifest.sh). */
function checkLinuxManifest(assets: string, version: string): void {
  const run = Bun.spawnSync(["bash", join(root, "scripts/verify-release-manifest.sh"), assets], { stdout: "pipe", stderr: "pipe" })
  if (run.exitCode !== 0) throw new Error(`verify-release-manifest.sh refused ${assets}: ${run.stderr.toString().trim() || run.stdout.toString().trim()}`)
  const sums = readFileSync(join(assets, "SHA256SUMS"), "utf8")
  for (const arch of ARCHES) {
    const file = fileName(version, "linux", arch)
    const digest = createHash("sha256").update(readFileSync(join(assets, file))).digest("hex")
    if (!sums.split("\n").some(line => line.trim() === `${digest}  ${file}`)) throw new Error(`${file} is not in the signed SHA256SUMS`)
  }
}
/** The Windows installers carry Hacker Valley Media's Authenticode signature with an intact digest. */
function checkWindowsSigner(path: string): void {
  const run = Bun.spawnSync(["osslsigncode", "verify", "-in", path], { stdout: "pipe", stderr: "pipe" })
  const out = run.stdout.toString()
  const current = /Current message digest\s*:\s*([0-9A-F]+)/.exec(out)?.[1], calculated = /Calculated message digest\s*:\s*([0-9A-F]+)/.exec(out)?.[1]
  // osslsigncode on macOS lacks the Microsoft identity root, so its exit code reports a chain error; the provider runs WinVerifyTrust.
  if (!current || current !== calculated || !/Subject: CN=Hacker Valley Media LLC,O=Hacker Valley Media LLC/.test(out)) throw new Error(`${path} is not signed by Hacker Valley Media LLC (osslsigncode verify)`)
}
function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }

async function verifyLive(version: string): Promise<void> {
  const key = publicKey()
  for (const os of ["windows", "linux"] as Os[]) {
    const response = await fetch(`${HOST}/${os}/latest.json`, { headers: { "cache-control": "no-cache" } })
    if (!response.ok) throw new Error(`${os}/latest.json: HTTP ${response.status}`)
    if (!/no-store/.test(response.headers.get("cache-control") ?? "")) throw new Error(`${os}/latest.json is cacheable (${response.headers.get("cache-control")})`)
    const payload = verifyEnvelope(await response.text(), key)
    if (payload.version !== version || payload.os !== os) throw new Error(`${os}/latest.json offers ${payload.os} ${payload.version}, not ${version}`)
    if (!payload.notes || !payload.notesSha256) throw new Error(`${os}/latest.json names no release notes for the update window`)
    const notes = Buffer.from(await (await fetch(payload.notes)).arrayBuffer())
    if (createHash("sha256").update(notes).digest("hex") !== payload.notesSha256) throw new Error(`${payload.notes} differs from the signed notesSha256`)
    console.log(`verified ${os} release notes: ${payload.notes}`)
    for (const arch of ARCHES) {
      const artifact = payload.artifacts[arch]
      const download = await fetch(artifact.url, { redirect: "follow" })
      if (!download.ok) throw new Error(`${artifact.url}: HTTP ${download.status}`)
      const bytes = Buffer.from(await download.arrayBuffer())
      const sha = createHash("sha256").update(bytes).digest("hex")
      if (bytes.length !== artifact.length || sha !== artifact.sha256) throw new Error(`${artifact.url}: ${bytes.length} bytes ${sha} differ from the signed ${artifact.length} ${artifact.sha256}`)
      console.log(`verified ${os}/${arch}: ${artifact.file} ${artifact.length} bytes ${sha}`)
      const latest = `${HOST}/latest/${artifact.file.replace(`-${version}-`, "-")}`
      const location = (await fetch(latest, { redirect: "manual" })).headers.get("location") ?? ""
      if (!location.endsWith(`/v${version}/${artifact.file}`)) throw new Error(`${latest} redirects to "${location}", not the ${version} release`)
      console.log(`verified ${latest}`)
    }
  }
}

if (import.meta.main) {
  const version = arg("--version") ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version
  if (process.argv.includes("--verify-live")) { await verifyLive(version); process.exit(0) }
  const assets = arg("--assets")
  if (!assets) throw new Error("usage: bun scripts/publish-desktop-updates.ts [--version X.Y.Z] --assets <dir> [--host-dir <dir>] [--dry-run] | --verify-live")
  const hostDir = arg("--host-dir") ?? process.env.INTERCEPTOR_SPARKLE_HOST_DIR ?? join(root, "../Interceptor-Updates-Sparkle")
  const publicDir = join(hostDir, "public")
  if (!existsSync(publicDir)) throw new Error(`update host public folder missing: ${publicDir}`)
  checkLinuxManifest(assets, version)
  for (const arch of ARCHES) checkWindowsSigner(join(assets, fileName(version, "windows", arch)))
  const key = publicKey(), issuedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z")
  const notesFile = join(publicDir, `release-notes-${version}.html`)
  const notes = existsSync(notesFile) ? { url: `${HOST}/release-notes-${version}.html`, sha256: createHash("sha256").update(readFileSync(notesFile)).digest("hex") } : undefined
  for (const os of ["windows", "linux"] as Os[]) {
    const target = join(publicDir, os, "latest.json")
    if (existsSync(target)) {
      const current = verifyEnvelope(readFileSync(target, "utf8"), key).version
      const [a, b] = [current, version].map(v => v.split(".").map(Number))
      if (a[0] > b[0] || a[0] === b[0] && (a[1] > b[1] || a[1] === b[1] && a[2] > b[2])) throw new Error(`${os} feed already offers ${current}; refusing to publish the older ${version}`)
    }
    const files = Object.fromEntries(ARCHES.map(arch => [arch, readFileSync(join(assets, fileName(version, os, arch)))]))
    const payload = Buffer.from(JSON.stringify(buildPayload(os, version, files, issuedAt, notes)))
    const text = envelope(payload, sparkleSign(payload))
    verifyEnvelope(text, key)
    if (process.argv.includes("--dry-run")) { console.log(`DRY ${target}: ${payload.toString()}`); continue }
    mkdirSync(join(publicDir, os), { recursive: true })
    writeFileSync(`${target}.tmp`, text); renameSync(`${target}.tmp`, target)
    console.log(`wrote ${target} (${statSync(target).size} bytes): ${os} ${version}, ${ARCHES.join(" + ")}`)
  }
  // The host's /latest/Interceptor-{Browser,Full}-<os>-<arch> links redirect to the GitHub release this names.
  if (!process.argv.includes("--dry-run")) {
    mkdirSync(join(publicDir, "latest"), { recursive: true })
    writeFileSync(join(publicDir, "latest", "desktop.txt"), `${version}\n`)
    console.log(`wrote ${join(publicDir, "latest", "desktop.txt")}: ${version}`)
  }
}
