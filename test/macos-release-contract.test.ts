import { describe, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const read = (path: string) => readFileSync(resolve(root, path), "utf-8")

describe("macOS release contract", () => {
  test("a Mac build rejects a compiler that differs from the pin before it starts compiling", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "interceptor-compiler-"))
    try {
      mkdirSync(resolve(dir, "scripts"))
      copyFileSync(resolve(root, "scripts/build.sh"), resolve(dir, "scripts/build.sh"))
      writeFileSync(resolve(dir, ".bun-version"), "1.4.4\n")
      writeFileSync(resolve(dir, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 })
      writeFileSync(resolve(dir, "bun"), '#!/bin/sh\n[ "$1" = --version ] || exit 88\necho 1.3.14\n', { mode: 0o755 })
      const result = Bun.spawnSync(["bash", "scripts/build.sh"], {
        cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 5000,
      })
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain("1.4.4")
      expect(result.stderr.toString()).toContain("1.3.14")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  for (const [edition, file, floor] of [
    ["Full", "distribution.xml", "15.0"],
    ["Browser", "distribution-browser.xml", "13.0"],
  ]) {
    test(`${edition} checks the host and explains its macOS minimum before destination selection`, () => {
      const xml = read(`scripts/release/${file}`).replace(/<!--[\s\S]*?-->/g, "")
      expect(xml.match(/<os-version min="([^"]+)"/)?.[1]).toBe(floor)
      const call = xml.match(/<installation-check\s+script="([^"]+)"/)?.[1]
      const script = xml.match(/<script>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/script>/)?.[1]
      expect(call).toBeDefined()
      expect(script).toBeDefined()
      const check = new Function("system", "my", `${script}\nreturn ${call}`)
      for (const version of ["12.7", "13.0", "14.6.1", "15.0", "27.0"]) {
        const result = { type: "", message: "" }
        const compareVersions = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true })
        const eligible = compareVersions(version, floor) >= 0
        expect(check({ version: { ProductVersion: version }, compareVersions }, { result })).toBe(eligible)
        if (!eligible) {
          expect(result.type).toBe("Fatal")
          for (const word of [edition, version, floor]) expect(result.message).toContain(word)
          if (edition === "Full") expect(result.message).toContain("Browser")
        }
      }
    })
  }

  test("the Browser Sparkle item advertises the package's deployment target", () => {
    expect(read("scripts/publish-sparkle.sh")).toMatch(/browser-only\)\s+echo "13\.0"/)
  })

  // release.sh runs build.sh for the release host, and the macOS packages are
  // built on Apple silicon, so the CLI, daemon, and bridge they install are
  // arm64-only. hostArchitectures is what Installer checks before it installs:
  // with x86_64 listed, an Intel Mac installs binaries that cannot run there.
  // release.sh --universal adds x86_64 to copies of these files, after
  // checking that every binary carries both slices.
  test.each(["scripts/release/distribution.xml", "scripts/release/distribution-browser.xml"])(
    "%s lets Installer run only on Apple silicon",
    (path) => {
      // Read the attribute on <options>; the comment above it names the same attribute.
      const xml = read(path).replace(/<!--[\s\S]*?-->/g, "")
      const hostArchitectures = xml.match(/<options\b[^>]*\bhostArchitectures="([^"]*)"/)?.[1]
      expect(hostArchitectures).toBe("arm64")
    },
  )

  // XML forbids "--" inside a comment; productbuild and Installer would get a
  // Distribution that does not parse. Flags like --universal are easy to slip in.
  test.each(["scripts/release/distribution.xml", "scripts/release/distribution-browser.xml"])(
    "%s keeps double hyphens out of its comments",
    (path) => {
      const comments = [...read(path).matchAll(/<!--([\s\S]*?)-->/g)].map((match) => match[1] ?? "")
      expect(comments.length).toBeGreaterThan(0)
      for (const comment of comments) expect(comment).not.toContain("--")
    },
  )
})
