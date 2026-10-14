import { describe, expect, test } from "bun:test"
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import { captureShell } from "./helpers/shell-capture"
import { embedsVersion } from "../scripts/provider-version"

const root = resolve(import.meta.dir, "..")
const build = readFileSync(resolve(root, "scripts/build.sh"), "utf8")
const release = readFileSync(resolve(root, "scripts/release-linux.sh"), "utf8")
const verify = readFileSync(resolve(root, "scripts/test-linux-release.sh"), "utf8")

describe("Linux release archive contract", () => {
  test("full archive preflight refuses missing, wrong-version and wrong-architecture native payloads without changing archives", () => {
    const payloadRoot = mkdtempSync(resolve(tmpdir(), "interceptor-linux-payload-"))
    const checksums = resolve(root, "dist/release/linux/SHA256SUMS")
    const before = existsSync(checksums) ? readFileSync(checksums, "utf8") : undefined
    const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version
    const run = (...args: string[]) => captureShell("bash", [resolve(root, "scripts/release-linux.sh"), "--full", "--arch=arm64", ...args], {env:{...process.env, INTERCEPTOR_VERSION:version, INTERCEPTOR_DESKTOP_LINUX_PAYLOAD_ROOT:payloadRoot}})
    try {
      expect(run().status).toBe(1)
      mkdirSync(resolve(payloadRoot, "arm64"))
      expect(run().stderr).toContain("Native Linux arm64 provider missing")
      // A provider carries the version it was built as in its "Interceptor/<version>" User-Agent literal.
      const elf = (machine: number, built: string) => {
        const bytes = Buffer.alloc(64); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes); bytes.writeUInt16LE(machine, 18)
        bytes.write(`Interceptor/${built}local map request`, 24); return bytes
      }
      writeFileSync(resolve(payloadRoot, "arm64/interceptor-desktop"), elf(183, "0.0.0"))
      const stale = run(); expect(stale.status).toBe(1); expect(stale.stderr).toContain(`was not built as version ${version}`)
      writeFileSync(resolve(payloadRoot, "arm64/interceptor-desktop"), elf(62, version))
      const wrongArch = run(); expect(wrongArch.status).toBe(1); expect(wrongArch.stderr).toContain("Linux ELF for arm64")
      const badHeader = elf(183, version); badHeader[0] = 0
      writeFileSync(resolve(payloadRoot, "arm64/interceptor-desktop"), badHeader)
      expect(run().status).toBe(1)
      expect(run("--browser-only").stderr).toContain("Conflicting archive modes")
      expect(run("--sign-identity=").stderr).toContain("Empty --sign-identity value")
      expect(existsSync(checksums) ? readFileSync(checksums, "utf8") : undefined).toBe(before)
    } finally { rmSync(payloadRoot, {recursive:true,force:true}) }
  })

  test("reads the exact version a native provider was built as", () => {
    const binary = (text: string) => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), Buffer.from(text)])
    expect(embedsVersion(binary("Interceptor/2.0.0local map request"), "2.0.0")).toBe(true)
    for (const built of ["2.0.01", "2.0.0.1", "2.0.0-beta.1", "2.0.0+build", "1.0.26"]) {
      expect(embedsVersion(binary(`Interceptor/${built}local`), "2.0.0")).toBe(false)
    }
  })

  test("takes the signing identity from the caller, not a pinned certificate", () => {
    expect(release).toContain('SIGN_IDENTITY="${SIGN_IDENTITY:-${INTERCEPTOR_LINUX_SIGN_IDENTITY:-}}"')
    expect(release).not.toMatch(/\b[0-9A-F]{40}\b/)
    expect(release).toContain('bash "$SCRIPT_DIR/verify-release-manifest.sh" "$RELEASE_DIR"')
  })

  test("a browser-only install refreshes the CLI and daemon a Full install left behind", () => {
    const install = readFileSync(resolve(root, "scripts/install.sh"), "utf8")
    const installer = readFileSync(resolve(root, "scripts/install-desktop-linux.sh"), "utf8")
    expect(install).toContain('if [[ "$MODE" == browser-only && "$DRY_RUN" != 1 ]]; then bash "$ROOT/scripts/install-desktop-linux.sh" --refresh-browser; fi')
    const refresh = installer.slice(installer.indexOf('if [[ "$MODE" == --refresh-browser ]]; then'), installer.indexOf('if [[ -e "$POINTER" || -L "$POINTER"'))
    // The ownership preflight runs first; the refresh replaces both binaries, then records their new hashes.
    expect(installer.indexOf('Refusing modified Linux browser payload')).toBeLessThan(installer.indexOf('if [[ "$MODE" == --refresh-browser ]]; then'))
    for (const step of ['cp "$ROOT/dist/interceptor" "$STAGE/interceptor"', 'cp "$ROOT/daemon/interceptor-daemon" "$STAGE/interceptor-daemon"',
      'mv "$STAGE/interceptor" "$CLI"', 'mv "$STAGE/interceptor-daemon" "$DAEMON"', "stop_owned_daemon", 'mv "$STAGE/browser-state" "$BROWSER_STATE"', "exit 0"]) {
      expect(refresh).toContain(step)
    }
    expect(refresh).not.toContain("interceptor-desktop")
    expect(installer).not.toContain("--check-browser")
  })

  test("builds, packages, hashes, and checks both browser-only architectures", () => {
    expect(build).toContain('bun_target="bun-linux-x64-baseline"')
    expect(build).toContain('bun_target="bun-linux-arm64"')
    for (const path of [
      "dist/interceptor",
      "daemon/interceptor-daemon",
      "daemon/com.interceptor.host.json",
      "extension/dist",
      "scripts/install.sh",
      "scripts/uninstall.sh",
      "README.md",
      "LICENSE",
      "package.json",
      "VERSION",
    ]) expect(release).toContain(path)
    expect(release).toContain("SHA256SUMS")
    expect(verify).toContain("linux/amd64")
    expect(verify).toContain("linux/arm64")
    expect(verify).toContain("mode: browser-only")
  })

  test("ships the agent skills beside the CLI, and the native-app skill only with the Full archive", () => {
    const installer = readFileSync(resolve(root, "scripts/install-desktop-linux.sh"), "utf8")
    const uninstall = readFileSync(resolve(root, "scripts/uninstall.sh"), "utf8")
    // Every archive: the three shared skills, staged where the CLI looks (a `skills` folder beside the binary).
    // build.sh writes the Linux copy (scripts/gen-skills.ts); the raw sources hold every OS's lines.
    expect(build).toContain('bun scripts/gen-skills.ts linux "$stage/skills" interceptor interceptor-browser interceptor-research interceptor-desktop')
    expect(release).not.toContain(".agents/skills")
    expect(release).toContain('for skill in interceptor interceptor-browser interceptor-research; do cp -R "$REPO_ROOT/dist/linux/$arch/skills/$skill" "$stage/dist/skills/$skill"; done')
    // Full only: the Windows/Linux native skill. The Mac and iPhone skills never ship on Linux.
    expect(release).toMatch(/if \[\[ "\$mode" == Full \]\]; then\n[^\n]*\n\s+cp -R "\$REPO_ROOT\/dist\/linux\/\$arch\/skills\/interceptor-desktop" "\$stage\/dist\/skills\/interceptor-desktop"/)
    for (const script of [release, installer]) expect(script).not.toMatch(/interceptor-(macos|ios)/)
    // The Full installer copies them next to the installed CLI and removes them, with their adopted links, on uninstall.
    expect(installer).toContain('SKILLS="$DEST/skills"')
    expect(installer).toContain('for skill in interceptor interceptor-browser interceptor-research interceptor-desktop; do')
    expect(installer).not.toContain('SKILLS_SOURCE="$ROOT/.agents/skills"')
    expect(installer).toContain('mv "$STAGE/skills" "$SKILLS"')
    expect(installer).toContain('skills unadopt interceptor-desktop --owned-root "$SKILLS"')
    expect(installer).toContain('skills unadopt --all --owned-root "$SKILLS"')
    expect(uninstall).toContain('skills unadopt --all --owned-root "$LINUX_ROOT/dist/skills"')
  })
})
