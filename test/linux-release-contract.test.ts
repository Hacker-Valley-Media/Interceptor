import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const build = readFileSync(resolve(root, "scripts/build.sh"), "utf8")
const release = readFileSync(resolve(root, "scripts/release-linux.sh"), "utf8")
const verify = readFileSync(resolve(root, "scripts/test-linux-release.sh"), "utf8")

describe("Linux release archive contract", () => {
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
})
