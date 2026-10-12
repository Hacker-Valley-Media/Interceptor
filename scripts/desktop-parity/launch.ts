#!/usr/bin/env bun
// Runs the parity batch on a host from this Mac and copies the results into
// <PARITY_EVIDENCE_DIR, default .interceptor/parity>/<host>-<stamp>/. The host-side scratch folder
// and the local staging copy are deleted once the results are collected.
//   bun scripts/desktop-parity/launch.ts windows|linux|mac [--families a,b] [--cases <regex>]
// Windows: compiled runner + fixtures are copied to the VM and run in the console
// session (session 1) through an Interactive scheduled task; ssh itself lands in Session 0.
// The VM works in %USERPROFILE%\interceptor-dev\parity of the ssh account.
// Linux: compiled runner runs through `systemd-run --user`, which attaches to the GUI login.
// Settings come from the environment (keep them in an untracked file such as .interceptor/parity.env):
//   windows: PARITY_WINDOWS_HOST (user@host), optional PARITY_WINDOWS_KEY and PARITY_WINDOWS_ARCH (default arm64)
//   linux:   PARITY_LINUX_HOST (user@host), PARITY_WAYLAND_DISPLAY (the GUI login's display, e.g. wayland-1),
//            optional PARITY_LINUX_KEY and PARITY_LINUX_ARCH (default arm64)
// Without a *_KEY, ssh and scp use your ssh config.
import { mkdirSync, cpSync, existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

// MediaPipe test photos (Apache-2.0) for the vision cases with known content.
const PHOTOS = ["burger.jpg", "left_hands.jpg", "pose.jpg"]
const repo = join(import.meta.dir, "..", "..")
const [target, ...rest] = process.argv.slice(2)
const passed = ["--families", "--cases", "--cli"]
const pass = rest.filter((a, i) => passed.includes(a) || passed.includes(rest[i - 1]))
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const evidence = join(process.env.PARITY_EVIDENCE_DIR ?? join(repo, ".interceptor", "parity"), `${target}-${stamp}`)
const work = join(repo, ".interceptor", "desktop-dev", "parity")
mkdirSync(work, { recursive: true })

function sh(cmd: string[], opts: { quiet?: boolean; allowFail?: boolean; timeoutMs?: number } = {}): string {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: opts.timeoutMs ?? 600_000 })
  const out = p.stdout.toString() + p.stderr.toString()
  if (p.exitCode !== 0 && !opts.allowFail) throw new Error(`${cmd.join(" ")} -> ${p.exitCode}\n${out.slice(-2000)}`)
  if (!opts.quiet) process.stdout.write(out)
  return out
}
/** ssh/scp to the Windows VM retry: Defender load makes the banner exchange time out. */
function retry(cmd: string[], tries = 6): string {
  for (let i = 1; ; i++) {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: 600_000 })
    const out = p.stdout.toString() + p.stderr.toString()
    if (p.exitCode === 0) return out
    if (i >= tries || !/timed out|Connection reset|closed by remote|banner/i.test(out)) throw new Error(`${cmd.slice(0, 6).join(" ")} -> ${p.exitCode}\n${out.slice(-1500)}`)
    Bun.sleepSync(15_000)
  }
}
function setting(name: string): string {
  const value = process.env[name]
  if (!value) { console.error(`${name} is not set. Export it (for example in .interceptor/parity.env) and run again.`); process.exit(2) }
  return value
}
const identity = (name: string) => process.env[name] ? ["-i", process.env[name]!] : []
function compile(bunTarget: string, outfile: string) {
  sh(["bun", "build", "--compile", `--target=${bunTarget}`, join(import.meta.dir, "run.ts"), "--outfile", outfile], { quiet: true })
}
function collect(from: string) {
  mkdirSync(evidence, { recursive: true })
  for (const f of ["summary.md", "summary.json", "results.jsonl", "capabilities.json", "run.log"]) if (existsSync(join(from, f))) cpSync(join(from, f), join(evidence, f))
  if (existsSync(join(from, "summary.md"))) console.log(readFileSync(join(from, "summary.md"), "utf8").split("\n").slice(0, 200).join("\n"))
  rmSync(from, { recursive: true, force: true })
  console.log(`\nevidence: ${evidence}`)
}

if (target === "mac") {
  const out = join(work, `mac-${stamp}`)
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "run.ts"), "--out", out, ...pass], { stdout: "inherit", stderr: "inherit" })
  collect(out)
  process.exit(p.exitCode ?? 1)
}

if (target === "windows") {
  const host = setting("PARITY_WINDOWS_HOST"), arch = process.env.PARITY_WINDOWS_ARCH ?? "arm64"
  const ssh = ["ssh", ...identity("PARITY_WINDOWS_KEY"), "-o", "BatchMode=yes", "-o", "ConnectTimeout=90", host]
  const scp = ["scp", ...identity("PARITY_WINDOWS_KEY"), "-o", "BatchMode=yes", "-o", "ConnectTimeout=90"]
  const exe = join(work, "parity-runner.exe")
  compile(`bun-windows-${arch}`, exe)
  // The scheduled task runs as the console user, so its scripts use the ssh account's absolute folder.
  const profile = retry([...ssh, "echo %USERPROFILE%"]).trim().split(/\r?\n/).pop() ?? ""
  if (!/^[A-Za-z]:\\\S/.test(profile)) throw new Error(`could not read the Windows profile folder on ${host}: ${profile}`)
  const remote = `${profile}\\interceptor-dev\\parity`, runs = `${remote}\\runs\\${stamp}`
  const cmd = join(work, "run-parity.cmd"), ps = join(work, "run-parity.ps1")
  await Bun.write(cmd, [`@echo off`, `cd /d ${remote}`, `"${remote}\\parity-runner.exe" --fixtures "${remote}\\fixtures" --out "${runs}" ${pass.map(a => `"${a}"`).join(" ")} > "${runs}.log" 2>&1`, `echo done> "${runs}.done"`].join("\r\n") + "\r\n")
  await Bun.write(ps, [
    `$ErrorActionPreference='Stop'`,
    `New-Item -ItemType Directory -Force '${remote}\\runs' | Out-Null`,
    `$p=New-ScheduledTaskPrincipal -UserId ((Get-CimInstance Win32_ComputerSystem).UserName) -LogonType Interactive -RunLevel Limited`,
    `$a=New-ScheduledTaskAction -Execute '${remote}\\run-parity.cmd' -WorkingDirectory '${remote}'`,
    `$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 4)`,
    `Register-ScheduledTask -TaskName 'InterceptorParity' -Principal $p -Action $a -Settings $s -Force | Out-Null`,
    `Start-ScheduledTask -TaskName 'InterceptorParity'`,
  ].join("\r\n") + "\r\n")
  retry([...ssh, `if not exist "${remote}\\fixtures" mkdir "${remote}\\fixtures"`])
  retry([...scp, exe, cmd, ps, `${host}:interceptor-dev/parity/`])
  retry([...scp, ...["windows-fixture.ps1", "windows-media-fixture.ps1", ...PHOTOS].map(f => join(import.meta.dir, "fixtures", f)), `${host}:interceptor-dev/parity/fixtures/`])
  retry([...ssh, `powershell -NoProfile -ExecutionPolicy Bypass -File "${remote}\\run-parity.ps1"`])
  console.log(`started on ${host} in session 1: ${runs}`)
  let finished = false
  for (const deadline = Date.now() + 4 * 3600_000; Date.now() < deadline;) {
    Bun.sleepSync(60_000)
    const state = Bun.spawnSync([...ssh, `if exist "${runs}.done" (echo DONE) else (tasklist /FI "IMAGENAME eq parity-runner.exe" /NH)`], { stdout: "pipe", stderr: "pipe", timeout: 120_000 }).stdout.toString()
    if (state.includes("DONE")) { finished = true; break }
    // The runner died without writing .done (killed, crashed): stop waiting and collect what it wrote.
    if (state.includes("No tasks are running")) { console.error(`windows runner exited without finishing; collecting partial results from ${runs}`); break }
  }
  if (!finished) console.error(`windows batch did not finish; collecting partial results from ${runs}`)
  retry([...ssh, `schtasks /Delete /TN InterceptorParity /F`])
  const local = join(work, `windows-${stamp}`)
  mkdirSync(local, { recursive: true })
  retry([...scp, "-r", `${host}:interceptor-dev/parity/runs/${stamp}/*`, local + "/"])
  retry([...scp, `${host}:interceptor-dev/parity/runs/${stamp}.log`, join(local, "run.log")])
  collect(local)
  retry([...ssh, `rmdir /s /q "${runs}" & del /q "${runs}.log" "${runs}.done"`])
  process.exit(0)
}

if (target === "linux") {
  const host = setting("PARITY_LINUX_HOST"), display = setting("PARITY_WAYLAND_DISPLAY"), arch = process.env.PARITY_LINUX_ARCH ?? "arm64"
  if (!/^[A-Za-z0-9._-]+$/.test(display)) throw new Error(`PARITY_WAYLAND_DISPLAY is not a display name: ${display}`)
  const ssh = ["ssh", ...identity("PARITY_LINUX_KEY"), "-o", "BatchMode=yes", "-o", "ConnectTimeout=30", host]
  const scp = ["scp", ...identity("PARITY_LINUX_KEY"), "-o", "BatchMode=yes", "-o", "ConnectTimeout=30"]
  const exe = join(work, "parity-runner-linux")
  compile(`bun-linux-${arch}`, exe)
  sh([...ssh, "mkdir -p ~/interceptor-dev/parity/fixtures ~/interceptor-dev/parity/runs"], { quiet: true })
  sh([...scp, exe, `${host}:interceptor-dev/parity/parity-runner`], { quiet: true })
  sh([...scp, ...["linux-fixture.js", "linux-mpris-fixture.js", ...PHOTOS].map(f => join(import.meta.dir, "fixtures", f)), `${host}:interceptor-dev/parity/fixtures/`], { quiet: true })
  const env = "export XDG_RUNTIME_DIR=/run/user/$(id -u); sig=$(ls -t $XDG_RUNTIME_DIR/hypr | head -1)"
  // Detached unit + done marker, as on Windows: an app a case opens can inherit an ssh pipe and keep
  // a streamed session open long after the run, so the launcher polls instead of streaming.
  const runs = `$HOME/interceptor-dev/parity/runs/${stamp}`
  const unit = `systemd-run --user --quiet --collect --unit=interceptor-parity-${stamp.replace(/[^0-9A-Za-z]/g, "")} --setenv=HYPRLAND_INSTANCE_SIGNATURE=$sig --setenv=WAYLAND_DISPLAY=${display} --working-directory=$HOME/interceptor-dev/parity`
  const runner = `$HOME/interceptor-dev/parity/parity-runner --fixtures $HOME/interceptor-dev/parity/fixtures --out ${runs} ${pass.map(a => `'${a}'`).join(" ")}`
  sh([...ssh, `${env}; mkdir -p ${runs}; ${unit} /bin/sh -c "${runner} > ${runs}.log 2>&1; echo \\$? > ${runs}.done"`], { quiet: true })
  console.log(`started on ${host}: ${runs}.log`)
  let exit = 1
  for (const deadline = Date.now() + 4 * 3600_000; Date.now() < deadline;) {
    Bun.sleepSync(30_000)
    const state = Bun.spawnSync([...ssh, `cat ${runs}.done 2>/dev/null`], { stdout: "pipe", stderr: "pipe", timeout: 120_000 }).stdout.toString().trim()
    if (/^\d+$/.test(state)) { exit = Number(state); break }
  }
  const p = { exitCode: exit }
  const local = join(work, `linux-${stamp}`)
  mkdirSync(local, { recursive: true })
  sh([...scp, `${host}:interceptor-dev/parity/runs/${stamp}.log`, join(local, "run.log")], { quiet: true, allowFail: true })
  sh([...scp, "-r", `${host}:interceptor-dev/parity/runs/${stamp}/.`, local], { quiet: true, allowFail: true })
  collect(local)
  sh([...ssh, `rm -rf ${runs} ${runs}.log ${runs}.done`], { quiet: true, allowFail: true })
  process.exit(p.exitCode ?? 1)
}

console.error("usage: launch.ts windows|linux|mac [--families a,b] [--cases <regex>]")
process.exit(2)
