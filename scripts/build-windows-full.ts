#!/usr/bin/env bun
// Builds a signed Interceptor Full Windows installer from a Mac. CI builds only the Browser
// installer; the Full installer needs a Windows host for the sparse-package identity
// (mt.exe/makeappx.exe) and Inno Setup, plus Azure Artifact Signing through scripts/sign-windows.ts.
//   bun scripts/build-windows-full.ts <arm64|x64> --host <user@windows-host> --sdk <Windows SDK bin folder on that host>
//     [--engines <staged engine folder>] [--iscc <ISCC.exe path on that host>]
// Each flag can come from the environment instead: INTERCEPTOR_WINDOWS_BUILD_HOST, INTERCEPTOR_WINDOWS_BUILD_SDK,
// INTERCEPTOR_WINDOWS_ENGINES, INTERCEPTOR_WINDOWS_ISCC. ssh and scp use your ssh config;
// INTERCEPTOR_WINDOWS_BUILD_KEY adds an identity file. The Windows account works in
// %USERPROFILE%\interceptor-dev\full-<arch>; ISCC defaults to the per-user Inno Setup 7 install.
// Inputs (already built on this Mac):
//   dist/windows/<arch>/ (scripts/build.sh --target=windows-<arch>)
//   interceptor-desktop/target/<triple>/release/{interceptor-desktop,interceptor-notification-badge}.exe,
//     built as this package.json version (scripts/build-desktop-windows.ts)
//   optional engines (scripts/stage-desktop-engines.ts); without --engines, .interceptor/desktop-dev/engines/staged-win32-<arch> when present
// Output: dist/release/windows/Interceptor-Full-<version>-windows-<arch>.exe (signed).
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, copyFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { version } from "../package.json"
import { embedsVersion } from "./provider-version"

const argv = process.argv.slice(2)
const arch = argv[0]
const usage = "usage: build-windows-full.ts <arm64|x64> --host <user@host> --sdk <windows path> [--engines <dir>] [--iscc <windows path>]"
if (!["arm64", "x64"].includes(arch)) throw new Error(usage)
const opt = (name: string, env: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : process.env[env] }
const host = opt("--host", "INTERCEPTOR_WINDOWS_BUILD_HOST"), sdk = opt("--sdk", "INTERCEPTOR_WINDOWS_BUILD_SDK")
if (!host || !sdk) throw new Error(`${usage}\nSet --host (or INTERCEPTOR_WINDOWS_BUILD_HOST) and --sdk (or INTERCEPTOR_WINDOWS_BUILD_SDK).`)
const isccPath = opt("--iscc", "INTERCEPTOR_WINDOWS_ISCC") ?? "$env:LOCALAPPDATA\\Programs\\Inno Setup 7\\ISCC.exe"
const repo = resolve(import.meta.dir, ".."), triple = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
const stage = join(repo, "dist", "windows", arch), work = join(repo, ".interceptor", "windows-full", arch)
// Remote paths stay relative to the Windows account's home: scp and the ssh session start there,
// and every PowerShell script sets $remote from $env:USERPROFILE.
const remoteUnix = `interceptor-dev/full-${arch}`, remote = "$remote"
const remoteRoot = `$remote = Join-Path $env:USERPROFILE 'interceptor-dev\\full-${arch}'`
const jar = join(repo, ".interceptor", "toolchain", "jsign-7.5.jar")
const key = [...(process.env.INTERCEPTOR_WINDOWS_BUILD_KEY ? ["-i", process.env.INTERCEPTOR_WINDOWS_BUILD_KEY] : []), "-o", "BatchMode=yes", "-o", "ConnectTimeout=90"]
// macOS tar otherwise adds AppleDouble `._*` entries (even one for the root) to every archive.
process.env.COPYFILE_DISABLE = "1"

function step(name: string, cmd: string[], tries = 1, timeout = 1_200_000): string {
  for (let i = 1; ; i++) {
    const p = Bun.spawnSync(cmd, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout })
    const out = p.stdout.toString() + p.stderr.toString()
    if (p.exitCode === 0) { console.log(`ok   ${name}`); return out }
    // ssh/scp to a busy VM can time out at the banner; those retry, real failures do not.
    if (i >= tries || !/timed out|Connection (reset|closed)|banner/i.test(out)) throw new Error(`${name} failed (${p.exitCode}):\n${out.slice(-3000)}`)
    Bun.sleepSync(15_000)
  }
}
const ssh = (name: string, command: string, timeout?: number) => step(name, ["ssh", ...key, host, command], 6, timeout)
const scp = (name: string, ...args: string[]) => step(name, ["scp", ...key, ...args], 6)
// Each remote step is a .ps1 file run with -File: no cmd.exe quoting of PowerShell text.
let scriptCount = 0
const ps = (name: string, script: string, timeout?: number) => {
  const file = `step-${++scriptCount}.ps1`, local = join(work, file)
  writeFileSync(local, `$ErrorActionPreference = 'Stop'\r\n${remoteRoot}\r\n` + script + "\r\nexit $LASTEXITCODE\r\n")
  scp(`${name} (script)`, local, `${host}:interceptor-dev/${file}`)
  return ssh(name, `powershell -NoProfile -ExecutionPolicy Bypass -File interceptor-dev\\${file}`, timeout)
}
const sign = (...files: string[]) => step(`sign ${files.length} file(s)`, ["bun", join(repo, "scripts", "sign-windows.ts"), jar, ...files], 2)

// 1. Local stage: CLI/daemon/extension from build.sh plus the unsigned native payloads.
for (const f of ["interceptor.exe", "daemon/interceptor-daemon.exe", "daemon/com.interceptor.host.json", "interceptor.ico"]) if (!existsSync(join(stage, f))) throw new Error(`missing ${stage}/${f}; run scripts/build.sh --target=windows-${arch}`)
const provider = join(repo, "interceptor-desktop", "target", triple, "release", "interceptor-desktop.exe")
// The provider reports the version it was built as (CARGO_PKG_VERSION); package only this release's.
if (!embedsVersion(readFileSync(provider), version)) throw new Error(`${provider} was not built as version ${version}; run bun scripts/build-desktop-windows.ts ${arch}`)
rmSync(join(stage, "desktop"), { recursive: true, force: true }); mkdirSync(join(stage, "desktop"), { recursive: true })
for (const f of ["interceptor-desktop.exe", "interceptor-notification-badge.exe"]) copyFileSync(join(repo, "interceptor-desktop", "target", triple, "release", f), join(stage, "desktop", f))
// Engines are optional. stage-desktop-engines.ts copies only the declared files and refuses a bundle
// for another provider version, host or architecture.
const enginesFlag = opt("--engines", "INTERCEPTOR_WINDOWS_ENGINES")
const engines = enginesFlag ? resolve(enginesFlag) : join(repo, ".interceptor", "desktop-dev", "engines", `staged-win32-${arch}`)
if (enginesFlag || existsSync(join(engines, "manifest.json"))) step("stage engines", ["bun", join(repo, "scripts", "stage-desktop-engines.ts"), engines, "win32", arch, join(stage, "desktop", "engines")])
rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true })

// 2. Remote build root that mirrors the repo paths interceptor.iss references.
const tree = join(work, "tree")
for (const f of ["scripts/installer/interceptor.iss", "scripts/installer/desktop-ownership.iss", "scripts/installer/post-install.txt", "scripts/installer/windows-notification-identity.ps1",
  "scripts/installer/build-windows-notification-identity.ps1", "assets/windows/interceptor.ico", "interceptor-desktop/THIRD-PARTY-NOTICES.txt"]) {
  mkdirSync(join(tree, f, ".."), { recursive: true }); copyFileSync(join(repo, f), join(tree, f))
}
cpSync(stage, join(tree, "dist", "windows", arch), { recursive: true })
step("pack build root", ["tar", "--no-xattrs", "-czf", join(work, "tree.tgz"), "-C", tree, "."], 1)
ssh("prepare remote folder", `powershell -NoProfile -Command "New-Item -ItemType Directory -Force interceptor-dev | Out-Null"`)
// rd through \\?\ also removes names Win32 rejects, such as a trailing-dot `._.` left by an older archive.
ps("prepare remote root", `if (Test-Path "${remote}") { cmd /c rd /s /q "\\\\?\\${remote}" }; New-Item -ItemType Directory -Force "${remote}" | Out-Null`)
scp("copy build root", join(work, "tree.tgz"), `${host}:${remoteUnix}/tree.tgz`)
ps("unpack build root", `tar -xzf "${remote}\\tree.tgz" -C "${remote}"; Get-ChildItem "${remote}" -Recurse -Force -Filter '._*' | Remove-Item -Force -ErrorAction SilentlyContinue`)

// 3. Embed the sparse-package identity (before signing) and bring the desktop folder back.
ps("embed identity", `& "${remote}\\scripts\\installer\\build-windows-notification-identity.ps1" -StageDir "${remote}\\dist\\windows\\${arch}" -SdkBin '${sdk}' -Version '${version}' -Arch '${arch}'`, 600_000)
ps("pack desktop", `tar -czf "${remote}\\desktop.tgz" -C "${remote}\\dist\\windows\\${arch}" desktop`)
scp("fetch desktop", `${host}:${remoteUnix}/desktop.tgz`, join(work, "desktop.tgz"))
rmSync(join(stage, "desktop"), { recursive: true, force: true })
step("unpack desktop", ["tar", "-xzf", join(work, "desktop.tgz"), "-C", stage], 1)

// 4. Sign every executable payload and the sparse package.
sign(join(stage, "interceptor.exe"), join(stage, "daemon", "interceptor-daemon.exe"), join(stage, "desktop", "interceptor-desktop.exe"),
  join(stage, "desktop", "interceptor-notification-badge.exe"), join(stage, "desktop", "interceptor-contacts-native.exe"), join(stage, "desktop", "notifications", "notification-identity.msix"))
step("pack signed stage", ["tar", "--no-xattrs", "-czf", join(work, "signed.tgz"), "-C", join(repo, "dist", "windows"), arch], 1)
scp("copy signed stage", join(work, "signed.tgz"), `${host}:${remoteUnix}/signed.tgz`)
ps("replace remote stage", `Remove-Item "${remote}\\dist\\windows\\${arch}" -Recurse -Force; tar -xzf "${remote}\\signed.tgz" -C "${remote}\\dist\\windows"; Get-ChildItem "${remote}\\dist" -Recurse -Force -Filter '._*' | Remove-Item -Force -ErrorAction SilentlyContinue`)

// 5. Inno Setup: pass 1 writes the unsigned uninstaller, which is signed here; pass 2 builds setup.
const iscc = `& "${isccPath}" /DAppVersion=${version} /DArtifactArch=${arch} /DFullInstall=1 /DSigningEnabled=1 /DExternalUninstallerSigning=1 "${remote}\\scripts\\installer\\interceptor.iss"`
// Pass 1 may stop for the unsigned uninstaller; it is listed afterwards instead of parsed from output.
writeFileSync(join(work, "pass1.ps1"), `${remoteRoot}\r\n${iscc}\r\nGet-ChildItem "${remote}\\dist\\release\\windows" -Filter 'uninst-*.e64' | ForEach-Object { 'UNINST ' + $_.Name }\r\nexit 0\r\n`)
scp("Inno pass 1 (script)", join(work, "pass1.ps1"), `${host}:interceptor-dev/pass1.ps1`)
const pass1Out = ssh("Inno pass 1", "powershell -NoProfile -ExecutionPolicy Bypass -File interceptor-dev\\pass1.ps1", 1_200_000)
const uninst = /UNINST (uninst-[0-9.]+-[0-9a-f]+\.e64)/.exec(pass1Out)?.[1]
if (!uninst) throw new Error(`Inno pass 1 produced no uninstaller to sign:\n${pass1Out.slice(-3000)}`)
if (uninst) {
  scp("fetch uninstaller", `${host}:${remoteUnix}/dist/release/windows/${uninst}`, join(work, uninst))
  const asExe = join(work, uninst.replace(/\.e64$/, ".exe")); copyFileSync(join(work, uninst), asExe); sign(asExe); copyFileSync(asExe, join(work, uninst))
  scp("return signed uninstaller", join(work, uninst), `${host}:${remoteUnix}/dist/release/windows/${uninst}`)
  ps("Inno pass 2", `${iscc}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`, 1_200_000)
}
const setupName = `Interceptor-Full-${version}-windows-${arch}.exe`, out = join(repo, "dist", "release", "windows")
mkdirSync(out, { recursive: true })
scp("fetch installer", `${host}:${remoteUnix}/dist/release/windows/${setupName}`, join(out, setupName))
sign(join(out, setupName))
console.log(JSON.stringify({ installer: join(out, setupName), sha256: new Bun.CryptoHasher("sha256").update(readFileSync(join(out, setupName))).digest("hex") }))
